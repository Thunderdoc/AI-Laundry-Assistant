import base64
import hashlib
import io
import json
import os
import tempfile
import unittest
from unittest.mock import Mock, patch
from PIL import Image
from fastapi.testclient import TestClient

# Keep API tests isolated from the developer's real scan history and training
# folders. These values must be set before importing app.main.
TEST_ROOT = tempfile.TemporaryDirectory()
os.environ["DATABASE_PATH"] = os.path.join(TEST_ROOT.name, "test.db")
os.environ["DATA_DIR"] = os.path.join(TEST_ROOT.name, "data")
os.environ["FIREBASE_SERVICE_ACCOUNT_JSON"] = ""
os.environ["FIREBASE_SERVICE_ACCOUNT_JSON_B64"] = ""
os.environ["FIREBASE_SERVICE_ACCOUNT_FILE"] = ""
os.environ["ENABLE_RETRAINING"] = "false"
from app.main import app, connection, FABRICS, resolve_frontend_file
import app.main as app_main
from app import firebase_store

class TestLaundryAIAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        TEST_ROOT.cleanup()

    def test_01_health(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "ok")
        self.assertTrue(data["model_ready"], data.get("model_error"))
        self.assertEqual(response.headers.get("x-content-type-options"), "nosniff")
        self.assertEqual(response.headers.get("x-frame-options"), "DENY")
        self.assertEqual(response.headers.get("cache-control"), "no-store")

        root = self.client.get("/")
        self.assertEqual(root.status_code, 200)
        self.assertEqual(root.json()["health"], "/api/health")

    def test_service_account_base64_loader(self):
        payload = {
            "type": "service_account",
            "project_id": "test-project",
            "private_key": "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
            "client_email": "firebase@test-project.iam.gserviceaccount.com",
        }
        encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
        with patch.dict(os.environ, {
            "FIREBASE_SERVICE_ACCOUNT_JSON_B64": encoded,
            "FIREBASE_SERVICE_ACCOUNT_JSON": "",
            "FIREBASE_SERVICE_ACCOUNT_FILE": "",
        }):
            self.assertEqual(firebase_store.service_account_credential(), payload)

    def test_service_account_base64_loader_rejects_invalid_value(self):
        with patch.dict(os.environ, {
            "FIREBASE_SERVICE_ACCOUNT_JSON_B64": "not valid base64!",
            "FIREBASE_SERVICE_ACCOUNT_JSON": "",
            "FIREBASE_SERVICE_ACCOUNT_FILE": "",
        }):
            with self.assertRaisesRegex(ValueError, "not valid Base64"):
                firebase_store.service_account_credential()

    def test_02_fabrics_list(self):
        response = self.client.get("/api/fabrics")
        self.assertEqual(response.status_code, 200)
        fabrics = response.json()
        self.assertEqual(len(fabrics), 5)
        names = {f["id"] for f in fabrics}
        self.assertEqual(names, {"cotton", "polyester", "denim", "wool", "silk"})

    def test_03_fabric_detail_valid_and_invalid(self):
        for name in FABRICS:
            res = self.client.get(f"/api/fabrics/{name}")
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertEqual(data["id"], name)
            self.assertIn("wash", data)
            self.assertIn("eco", data)

        res_inv = self.client.get("/api/fabrics/unknown_fabric")
        self.assertEqual(res_inv.status_code, 404)

    def test_04_recommendations(self):
        res = self.client.get("/api/recommendations/denim")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("wash", data)
        self.assertIn("cold", data["wash"]["temperature"].lower())

    def test_05_predict_validation(self):
        # 1. Invalid content type
        res = self.client.post("/api/predict", files={"image": ("test.txt", b"plain text", "text/plain")})
        self.assertEqual(res.status_code, 415)

        # 2. Corrupted image with valid content type
        res = self.client.post("/api/predict", files={"image": ("bad.jpg", b"not an image", "image/jpeg")})
        self.assertEqual(res.status_code, 422)

        # Oversized uploads are rejected while streaming instead of being read
        # into unbounded server memory.
        res = self.client.post("/api/predict", files={"image": ("huge.jpg", b"x" * (10 * 1024 * 1024 + 1), "image/jpeg")})
        self.assertEqual(res.status_code, 413)

        # 3. Valid image should return either accepted fabric or explicit unknown rejection
        img = Image.new("RGB", (100, 100), color=(128, 128, 128))
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        buf.seek(0)
        res = self.client.post("/api/predict", files={"image": ("sample.jpg", buf.getvalue(), "image/jpeg")})
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("model_decision", data)
        decision = data["model_decision"]
        self.assertIn("accepted", decision)
        if decision.get("detected_non_fabric"):
            self.assertEqual(data["fabric"], "non_fabric")
            self.assertIsNone(data.get("recommendation"))
        elif decision["accepted"]:
            self.assertIn(data["fabric"], {"cotton", "polyester", "denim", "wool", "silk"})
            self.assertIsNotNone(data.get("recommendation"))
        else:
            self.assertEqual(data["fabric"], "unknown")
            self.assertIsNone(data.get("recommendation"))
            self.assertTrue(decision.get("reason"))
        self.assertTrue(data["quality"]["warning"])

    def test_06_model_info_and_metrics(self):
        res_info = self.client.get("/api/model/info")
        self.assertEqual(res_info.status_code, 200)
        self.assertIn("classes", res_info.json())

        res_metrics = self.client.get("/api/model/metrics")
        self.assertEqual(res_metrics.status_code, 200)

    def test_07_analytics_and_history(self):
        res_hist = self.client.get("/api/history")
        self.assertEqual(res_hist.status_code, 200)
        self.assertIsInstance(res_hist.json(), list)

        res_ana = self.client.get("/api/analytics")
        self.assertEqual(res_ana.status_code, 200)
        data = res_ana.json()
        self.assertIn("garments_analyzed", data)
        self.assertIn("distribution", data)

    def test_08_model_label_order_matches_manifest(self):
        from app import main
        original = main.load_manifest
        try:
            main.load_manifest = lambda: {"classes": ["cotton", "denim", "polyester", "silk", "wool", "non_fabric"]}
            self.assertEqual(main.labels(), ["cotton", "denim", "polyester", "silk", "wool"])
            self.assertEqual(main.model_labels(), ["cotton", "denim", "polyester", "silk", "wool", "non_fabric"])
        finally:
            main.load_manifest = original

    def test_09_predict_with_note(self):
        img = Image.new("RGB", (100, 100), color=(200, 100, 50))
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        buf.seek(0)
        # 1. Valid note
        res = self.client.post(
            "/api/predict",
            files={"image": ("sample.jpg", buf.getvalue(), "image/jpeg")},
            data={"note": "  Vintage silk blouse with embroidery  "}
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["note"], "Vintage silk blouse with embroidery")
        record_id = data["id"]

        # Check it is in history
        res_one = self.client.get(f"/api/history/{record_id}")
        self.assertEqual(res_one.status_code, 200)
        self.assertEqual(res_one.json()["note"], "Vintage silk blouse with embroidery")

        # 2. Too long note
        buf.seek(0)
        res_long = self.client.post(
            "/api/predict",
            files={"image": ("sample.jpg", buf.getvalue(), "image/jpeg")},
            data={"note": "a" * 241}
        )
        self.assertEqual(res_long.status_code, 422)

    def test_10_patch_history_note(self):
        img = Image.new("RGB", (100, 100), color=(100, 200, 50))
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        buf.seek(0)
        res = self.client.post(
            "/api/predict",
            files={"image": ("sample.jpg", buf.getvalue(), "image/jpeg")}
        )
        self.assertEqual(res.status_code, 200)
        record_id = res.json()["id"]

        # Patch note
        res_patch = self.client.patch(
            f"/api/history/{record_id}/note",
            json={"note": "Updated care note for testing"}
        )
        self.assertEqual(res_patch.status_code, 200)
        self.assertEqual(res_patch.json()["note"], "Updated care note for testing")

    def test_11_export_csv_and_clear_history(self):
        # Test export CSV
        res_csv = self.client.get("/api/history/export/csv")
        self.assertEqual(res_csv.status_code, 200)
        self.assertIn("text/csv", res_csv.headers.get("content-type", ""))
        self.assertIn("ID,Date,Fabric", res_csv.text)

        # Spreadsheet formula prefixes from user-controlled notes are escaped.
        from app import main
        with connection() as db:
            payload={"id":999,"created_at":"2026-01-01T00:00:00Z","fabric":"cotton","confidence":90,"note":"=HYPERLINK(\"https://example.invalid\")","recommendation":None}
            db.execute("INSERT INTO predictions (id,owner_uid,created_at,fabric,confidence,payload) VALUES (?,?,?,?,?,?)",(999,"local-preview",payload["created_at"],"cotton",90,__import__("json").dumps(payload)))
        escaped=self.client.get("/api/history/export/csv")
        self.assertIn("'=HYPERLINK",escaped.text)

        # Test clear all history
        res_clear = self.client.delete("/api/history")
        self.assertEqual(res_clear.status_code, 200)
        self.assertTrue(res_clear.json().get("deleted"))

        # Verify history is now empty
        res_hist = self.client.get("/api/history")
        self.assertEqual(res_hist.status_code, 200)
        self.assertEqual(res_hist.json(), [])

    def test_12_active_learning_feedback_and_dataset_stats(self):
        img = Image.new("RGB", (100, 100), color=(150, 150, 150))
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        buf.seek(0)
        res = self.client.post(
            "/api/predict",
            files={"image": ("silk_sample.jpg", buf.getvalue(), "image/jpeg")}
        )
        self.assertEqual(res.status_code, 200)
        pred = res.json()
        self.assertIn("image_token", pred)

        rejected = self.client.post(
            "/api/feedback",
            json={
                "prediction_id": pred["id"],
                "image_token": "upload_from_another_prediction.jpg",
                "confirmed_fabric": "silk",
                "was_prediction_correct": True,
            },
        )
        self.assertEqual(rejected.status_code, 403)

        # Feedback enters a private review queue; it must never become training
        # data before an administrator checks the label.
        res_fb = self.client.post(
            "/api/feedback",
            json={
                "prediction_id": pred["id"],
                "image_token": pred["image_token"],
                "confirmed_fabric": "silk",
                "was_prediction_correct": True
            }
        )
        self.assertEqual(res_fb.status_code, 200)
        fb_data = res_fb.json()
        self.assertEqual(fb_data["status"], "success")
        self.assertEqual(fb_data["confirmed_fabric"], "silk")
        self.assertFalse(fb_data["saved_to_dataset"])
        self.assertEqual(fb_data["review_status"], "pending")

        # Check dataset stats endpoint
        res_stats = self.client.get("/api/dataset/stats")
        self.assertEqual(res_stats.status_code, 200)
        stats = res_stats.json()
        self.assertIn("total_samples", stats)
        self.assertIn("user_contributed", stats)
        self.assertIn("classes", stats)
        self.assertIn("silk", stats["classes"])

    def test_13_metrics_and_retrain_status(self):
        res_m = self.client.get("/api/model/metrics")
        self.assertEqual(res_m.status_code, 200)
        data_m = res_m.json()
        self.assertTrue(data_m.get("available"))
        metrics = data_m.get("metrics", {})
        self.assertIn("confusion_matrix", metrics)
        self.assertIn("per_class_metrics", metrics)

        # Administrative operations remain closed until Firebase Admin
        # credentials are configured on the backend.
        res_retrain_stat = self.client.get("/api/retrain/status")
        self.assertEqual(res_retrain_stat.status_code, 503)

    def test_14_admin_identity_requires_verified_allowlisted_email(self):
        from app.main import is_admin
        from app import main
        original = main.ADMIN_EMAILS
        try:
            main.ADMIN_EMAILS = {"admin@example.com"}
            self.assertTrue(is_admin({"email": "ADMIN@example.com", "email_verified": True}))
            self.assertFalse(is_admin({"email": "admin@example.com", "email_verified": False}))
            self.assertFalse(is_admin({"email": "user@example.com", "email_verified": True}))
            self.assertTrue(is_admin({"email": "user@example.com", "email_verified": True, "admin": True}))
            self.assertFalse(is_admin({"email": "user@example.com", "email_verified": False, "admin": True}))
        finally:
            main.ADMIN_EMAILS = original

    def test_15_firebase_public_config_has_no_surrounding_whitespace(self):
        from app.main import FIREBASE_CONFIG
        for value in FIREBASE_CONFIG.values():
            self.assertEqual(value, value.strip())

    def test_16_local_persistence_health_contract(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        persistence = response.json()["persistence"]
        self.assertEqual(persistence["backend"], "local")
        self.assertEqual(persistence["database"], "sqlite")
        self.assertTrue(persistence["configured"])

    def test_17_firebase_prediction_write_cleans_up_if_database_fails(self):
        from app import firebase_store
        bucket = Mock()
        blob = Mock()
        bucket.blob.return_value = blob
        database_ref = Mock()
        database_ref.set.side_effect = RuntimeError("database offline")
        with patch.object(firebase_store, "_bucket", return_value=bucket), patch.object(firebase_store, "_root", return_value=database_ref), patch.dict(os.environ, {"FIREBASE_STORAGE_BUCKET": "test-bucket"}):
            with self.assertRaises(RuntimeError):
                firebase_store.create_prediction("uid-1", {"fabric": "silk"}, b"jpeg")
        blob.upload_from_string.assert_called_once_with(b"jpeg", content_type="image/jpeg")
        blob.delete.assert_called_once()

    def test_18_firebase_feedback_uses_atomic_metadata_update(self):
        from app import firebase_store
        bucket = Mock()
        bucket.blob.side_effect = lambda path: Mock(name=path)
        root = Mock()
        prediction = {"id": "prediction-1", "owner_uid": "uid-1", "image_token": "private-uploads/uid-1/prediction-1.jpg", "fabric": "cotton"}
        with patch.object(firebase_store, "_bucket", return_value=bucket), patch.object(firebase_store, "_root", return_value=root):
            result = firebase_store.submit_feedback(prediction, "silk", False)
        bucket.copy_blob.assert_called_once()
        root.update.assert_called_once()
        updates = root.update.call_args.args[0]
        self.assertIn(f"feedback/{result['id']}", updates)
        self.assertIn("predictions/prediction-1/user_feedback", updates)

    def test_19_training_callback_is_token_and_job_bound(self):
        from app import main
        original=dict(main.RETRAIN_STATE)
        try:
            main.RETRAIN_STATE.clear()
            main.RETRAIN_STATE.update({
                "status":"running", "job_id":"job-123", "mode":"external_gpu",
                "started_at":"2026-01-01T00:00:00Z", "completed_at":None,
                "message":"running",
            })
            with patch.dict(os.environ,{"TRAINING_CALLBACK_TOKEN":"callback-secret"}):
                rejected=self.client.post("/api/training/callback",json={"status":"completed","job_id":"job-123"})
                self.assertEqual(rejected.status_code,401)

                mismatch=self.client.post(
                    "/api/training/callback",
                    headers={"x-training-token":"callback-secret"},
                    json={"status":"completed","job_id":"another-job","metrics":{"test_accuracy":0.9}},
                )
                self.assertEqual(mismatch.status_code,409)

                completed=self.client.post(
                    "/api/training/callback",
                    headers={"x-training-token":"callback-secret"},
                    json={
                        "status":"completed", "job_id":"job-123",
                        "message":"do not expose worker internals",
                        "candidate_url":"https://artifacts.example/candidate.pt?temporary_secret=hidden",
                        "metrics":{"test_accuracy":0.91},
                    },
                )
                self.assertEqual(completed.status_code,200)
                self.assertEqual(main.RETRAIN_STATE["status"],"completed")
                self.assertEqual(main.RETRAIN_STATE["metrics"]["test_accuracy"],0.91)
                self.assertEqual(main.RETRAIN_STATE["candidate_url"],"https://artifacts.example/candidate.pt")
                self.assertNotIn("worker internals",main.RETRAIN_STATE["message"])

                replay=self.client.post(
                    "/api/training/callback",
                    headers={"x-training-token":"callback-secret"},
                    json={"status":"running","job_id":"job-123"},
                )
                self.assertEqual(replay.status_code,409)
        finally:
            main.RETRAIN_STATE.clear()
            main.RETRAIN_STATE.update(original)

    def test_20_training_configuration_and_accelerator_contract(self):
        from app import main, firebase_store
        capability=main.local_accelerator_capability()
        self.assertIn("torch_available",capability)
        self.assertIn("cuda_available",capability)
        self.assertIn("device_count",capability)
        self.assertIn("device",capability)

        external_env={
            "EXTERNAL_TRAINING_URL":"https://gpu.example/jobs",
            "PUBLIC_API_URL":"https://api.example",
            "TRAINING_CALLBACK_TOKEN":"callback-secret",
            "ENABLE_RETRAINING":"false",
        }
        with patch.dict(os.environ,external_env), patch.object(
            firebase_store,"training_export_reference",
            return_value={"provider":"firebase-storage","bucket":"test-bucket","prefix":"training-approved/","portable":True},
        ):
            config=main.training_configuration()
        self.assertEqual(config["mode"],"external_gpu")
        self.assertTrue(config["available"])
        self.assertEqual(config["missing"],[])

        with patch.dict(os.environ,{**external_env,"TRAINING_CALLBACK_TOKEN":""}), patch.object(
            firebase_store,"training_export_reference",
            return_value={"provider":"firebase-storage","portable":True},
        ):
            incomplete=main.training_configuration()
        self.assertFalse(incomplete["available"])
        self.assertIn("TRAINING_CALLBACK_TOKEN",incomplete["missing"])

    def test_21_admin_scans(self):
        from app import main
        with patch.object(main, "require_admin", return_value={"uid":"admin-1", "is_admin":True}), patch.object(
            main, "saved_history", return_value=[{"id": 1, "fabric": "cotton", "confidence": 0.95}]
        ):
            res = self.client.get("/api/admin/scans")
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertEqual(data["count"], 1)
            self.assertEqual(data["items"][0]["fabric"], "cotton")

    def test_22_admin_scan_filters_and_pagination(self):
        from app import main
        scans = [
            {"id": 1, "fabric": "cotton", "confidence": 92, "created_at": "2026-09-17T10:00:00Z"},
            {"id": 2, "fabric": "silk", "confidence": 61, "created_at": "2026-09-16T10:00:00Z"},
            {"id": 3, "fabric": "cotton", "confidence": 88, "created_at": "2026-09-15T10:00:00Z"},
        ]
        with patch.object(main, "require_admin", return_value={"uid": "admin-1"}), patch.object(main, "saved_history", return_value=scans):
            res = self.client.get("/api/admin/scans?page=1&page_size=1&fabric=cotton&min_confidence=90")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["count"], 1)
        self.assertEqual(res.json()["items"][0]["id"], 1)

    def test_23_admin_analytics_and_audit_log(self):
        from app import main
        # Dates must stay inside the 30-day analytics window: the old hardcoded
        # September 2026 dates made this test fail once the calendar moved past
        # them (scan_count 0 != 2), even though the endpoint was correct.
        from datetime import datetime, timedelta, timezone
        now = datetime.now(timezone.utc)
        scans = [
            {"fabric": "cotton", "confidence": 92, "created_at": (now - timedelta(days=1)).strftime("%Y-%m-%dT10:00:00Z")},
            {"fabric": "silk", "confidence": 61, "created_at": (now - timedelta(days=2)).strftime("%Y-%m-%dT10:00:00Z")},
        ]
        with patch.object(main, "require_admin", return_value={"uid": "admin-1"}), patch.object(main, "saved_history", return_value=scans):
            analytics = self.client.get("/api/admin/analytics?days=30")
        self.assertEqual(analytics.status_code, 200)
        self.assertEqual(analytics.json()["scan_count"], 2)
        self.assertEqual(analytics.json()["fabric_distribution"]["cotton"], 1)
        self.assertEqual(analytics.json()["confidence"]["buckets"]["90-100"], 1)

        main.record_audit("admin_role_updated", "admin-1", "user-1", {"is_admin": True})
        with patch.object(main, "require_admin", return_value={"uid": "admin-1"}):
            audit = self.client.get("/api/admin/audit-log?page_size=10")
        self.assertEqual(audit.status_code, 200)
        self.assertEqual(audit.json()["count"], 1)
        self.assertEqual(audit.json()["items"][0]["action"], "admin_role_updated")

    def test_24_firebase_history_cache_invalidates_on_writes(self):
        from app import main
        row = {"id": 1, "owner_uid": "u1", "fabric": "cotton", "confidence": 90,
               "created_at": "2026-01-01T00:00:00Z"}
        with patch.object(main.firebase_store, "enabled", return_value=True), \
             patch.object(main.firebase_store, "configured", return_value=True), \
             patch.object(main.firebase_store, "list_predictions", return_value=[row]) as mock_list:
            main._invalidate_history_cache()
            # First read fetches from Firebase once…
            self.assertEqual(main.saved_history(), [row])
            # …and owner-scoped reads within the TTL reuse the cached rows.
            self.assertEqual(main.saved_history("u1")[0]["id"], 1)
            self.assertEqual(main.saved_history("other"), [])
            mock_list.assert_called_once()
            # A write must invalidate the cache so the next read re-fetches.
            main._invalidate_history_cache()
            main.saved_history()
            self.assertEqual(mock_list.call_count, 2)
            main._invalidate_history_cache()

    def test_25_cors_accepts_generated_preview_hosts(self):
        # Branch previews get generated hostnames (ai-laundry-assistant-git-…vercel.app).
        # When /api/auth/config is CORS-blocked there the browser treats the API
        # as unreachable and the login screen can never finish connecting.
        preview = "https://ai-laundry-assistant-git-login-fix-a1b2c3-thunderdoc.vercel.app"
        response = self.client.options(
            "/api/auth/config",
            headers={"Origin": preview, "Access-Control-Request-Method": "GET"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers.get("access-control-allow-origin"), preview)
        # Known production origins keep working…
        production = "https://ai-laundry-assistant-thunderdoc.vercel.app"
        response = self.client.options(
            "/api/auth/config",
            headers={"Origin": production, "Access-Control-Request-Method": "GET"},
        )
        self.assertEqual(response.headers.get("access-control-allow-origin"), production)
        # …while unrelated origins are still refused.
        response = self.client.options(
            "/api/auth/config",
            headers={"Origin": "https://evil.example.com", "Access-Control-Request-Method": "GET"},
        )
        self.assertNotEqual(response.headers.get("access-control-allow-origin"), "https://evil.example.com")

class TestFirebaseTokenVerification(unittest.TestCase):
    """ID-token verification must work without a per-request call to Google.

    google-auth refetches Google's x509 certificates on every verification, so a
    slow or rate-limited certificate endpoint used to make every authenticated
    API request fail right after a successful sign-in.
    """

    PROJECT = "laundry-ai-70989"

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def setUp(self):
        from app import main
        try:
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.primitives.asymmetric import rsa
            import jwt as pyjwt
        except ImportError as exc:  # pragma: no cover - dependency guard
            self.skipTest(f"token signing helpers are unavailable: {exc}")
        self.main = main
        self.pyjwt = pyjwt
        self.serialization = serialization
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.private_key = key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        self.public_key = key.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("utf-8")
        self.key_id = "test-key-id"
        self.rotated_key_id = "rotated-key-id"
        self.certificate_requests = []
        main._certificate_cache["certificates"] = {}
        main._certificate_cache["expires_at"] = 0.0
        self.environment = patch.dict(main.FIREBASE_CONFIG, {
            "apiKey": "test-api-key",
            "authDomain": f"{self.PROJECT}.firebaseapp.com",
            "projectId": self.PROJECT,
            "appId": "1:123:web:test",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def certificate_document(self, *key_ids):
        return json.dumps({key_id: self.public_key for key_id in (key_ids or (self.key_id,))}).encode("utf-8")

    def patch_certificate_endpoint(self, document=None, failure=None):
        main = self.main

        class FakeResponse:
            headers = {"Cache-Control": "public, max-age=3600"}

            def __init__(self, body):
                self._body = body

            def read(self):
                return self._body

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def fake_urlopen(request, timeout=None):
            self.certificate_requests.append(request.full_url)
            if failure is not None:
                raise failure
            if document is not None:
                return FakeResponse(document)
            key_ids = (self.key_id, self.rotated_key_id) if len(self.certificate_requests) > 1 else (self.key_id,)
            return FakeResponse(self.certificate_document(*key_ids))

        return patch.object(main.urlrequest, "urlopen", fake_urlopen)

    def token(self, key_id=None, expires_in=3600, audience=None, issuer=None, with_email=True):
        import time
        issued = int(time.time())
        claims = {
            "iss": issuer or f"https://securetoken.google.com/{self.PROJECT}",
            "aud": audience or self.PROJECT,
            "sub": "firebase-uid-42",
            "iat": issued,
            "exp": issued + expires_in,
        }
        if with_email:
            claims.update({
                "email": "admin@example.com",
                "email_verified": True,
            })
        return self.pyjwt.encode(
            claims,
            self.private_key,
            algorithm="RS256",
            headers={"kid": key_id or self.key_id},
        )

    def test_certificates_are_cached_between_verifications(self):
        with self.patch_certificate_endpoint():
            for _ in range(5):
                token = self.client.post("/api/auth/firebase", json={"id_token": self.token()})
                self.assertEqual(token.status_code, 200)
        self.assertEqual(len(self.certificate_requests), 1)

    def test_verified_token_exposes_the_firebase_uid(self):
        admin_emails = self.main.ADMIN_EMAILS
        try:
            self.main.ADMIN_EMAILS = {"admin@example.com"}
            with self.patch_certificate_endpoint():
                response = self.client.post("/api/auth/firebase", json={"id_token": self.token()})
        finally:
            self.main.ADMIN_EMAILS = admin_emails
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["uid"], "firebase-uid-42")
        self.assertTrue(response.json()["is_admin"])

    def test_signin_without_email_claim_still_returns_an_account(self):
        """Phone-only or anonymous-upgrade accounts carry no email claim.

        Resolving the display name from `email` used to raise on a missing claim
        and turn a valid sign-in verification into a 500 response."""
        with self.patch_certificate_endpoint():
            response = self.client.post("/api/auth/firebase", json={"id_token": self.token(with_email=False)})
        self.assertEqual(response.status_code, 200, response.text)
        account = response.json()
        self.assertEqual(account["uid"], "firebase-uid-42")
        self.assertEqual(account["email"], "")
        self.assertEqual(account["name"], "LaundryAI user")
        self.assertFalse(account["is_admin"])

    def test_rotated_signing_key_triggers_one_refresh(self):
        with self.patch_certificate_endpoint():
            self.assertEqual(self.client.post("/api/auth/firebase", json={"id_token": self.token()}).status_code, 200)
            rotated = self.client.post("/api/auth/firebase", json={"id_token": self.token(self.rotated_key_id)})
        self.assertEqual(rotated.status_code, 200)
        self.assertEqual(len(self.certificate_requests), 2)

    def test_rejected_tokens_never_grant_access(self):
        from fastapi import HTTPException
        cases = {
            "expired": self.token(expires_in=-30),
            "wrong audience": self.token(audience="another-project"),
            "wrong issuer": self.token(issuer="https://securetoken.google.com/attacker"),
            "unknown key": self.token(key_id="never-published"),
            "malformed": "not-a-jwt",
        }
        with self.patch_certificate_endpoint():
            for label, token in cases.items():
                with self.subTest(label):
                    response = self.client.get("/api/history", headers={"Authorization": f"Bearer {token}"})
                    self.assertEqual(response.status_code, 401, response.text)
                    self.assertTrue(response.json()["detail"])

    def test_unreachable_certificate_endpoint_reports_service_unavailable(self):
        with self.patch_certificate_endpoint(failure=OSError("certificate endpoint unreachable")):
            response = self.client.get("/api/history", headers={"Authorization": f"Bearer {self.token()}"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"], "Firebase verification is temporarily unavailable.")

    def test_missing_project_configuration_is_reported(self):
        with patch.dict(self.main.FIREBASE_CONFIG, {"projectId": "", "apiKey": ""}):
            response = self.client.post("/api/auth/firebase", json={"id_token": self.token()})
        self.assertEqual(response.status_code, 503)


class TestTokenSigningDependencies(unittest.TestCase):
    """Regression guard for the silent-skip hole (audit 2026-11-03).

    TestFirebaseTokenVerification skips itself when PyJWT or cryptography is
    missing, and neither package was declared in backend/requirements.txt —
    a requirements-only environment ran the suite "green" while none of the
    seven Firebase token-verification tests executed. This test never skips:
    if the dependencies disappear again, the gate goes red instead of quiet.
    """

    def test_token_signing_dependencies_are_installed(self):
        import jwt  # noqa: F401  (PyJWT — signs the RS256 test tokens)
        from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: F401


class TestFrontendStaticContainment(unittest.TestCase):
    """Regression tests for the 2026-10-24 audit P0 (SPA path traversal).

    The route itself is only registered when frontend/dist exists at import,
    so these tests exercise resolve_frontend_file directly with a patched
    FRONTEND_DIST — the helper is the entire security boundary.
    """

    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.dist = os.path.join(self.root.name, "dist")
        os.makedirs(os.path.join(self.dist, "assets"))
        with open(os.path.join(self.dist, "index.html"), "w") as f:
            f.write("<html>spa</html>")
        with open(os.path.join(self.dist, "assets", "app.js"), "w") as f:
            f.write("console.log(1)")
        with open(os.path.join(self.root.name, "secret.txt"), "w") as f:
            f.write("TOP-SECRET")
        self._old = app_main.FRONTEND_DIST
        app_main.FRONTEND_DIST = self.dist

    def tearDown(self):
        app_main.FRONTEND_DIST = self._old
        self.root.cleanup()

    def test_in_dist_file_resolves(self):
        self.assertEqual(
            resolve_frontend_file("assets/app.js"),
            os.path.join(self.dist, "assets", "app.js"),
        )

    def test_missing_file_returns_none(self):
        self.assertIsNone(resolve_frontend_file("nope.js"))

    def test_empty_path_returns_none(self):
        self.assertIsNone(resolve_frontend_file(""))

    def test_dotdot_escape_returns_none(self):
        self.assertIsNone(resolve_frontend_file("../secret.txt"))
        self.assertIsNone(resolve_frontend_file("assets/../../secret.txt"))
        self.assertIsNone(resolve_frontend_file("../../../etc/hostname"))

    def test_absolute_path_returns_none(self):
        self.assertIsNone(resolve_frontend_file(os.path.join(self.root.name, "secret.txt")))
        self.assertIsNone(resolve_frontend_file("/etc/hostname"))


class TestP1Fixes(unittest.TestCase):
    """Regression tests for the 2026-10-24 audit P1 fixes."""

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def _sample_image(self, color=(128, 128, 128)):
        img = Image.new("RGB", (100, 100), color=color)
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        return buf.getvalue()

    def test_request_uid_scopes_guest_history_per_device(self):
        from types import SimpleNamespace
        from app.main import request_uid
        anon = SimpleNamespace(state=SimpleNamespace(user=None), headers={"x-anonymous-id": "device-abc-123"})
        self.assertEqual(request_uid(anon), "anon:device-abc-123")
        other = SimpleNamespace(state=SimpleNamespace(user=None), headers={"x-anonymous-id": "device-xyz-789"})
        self.assertEqual(request_uid(other), "anon:device-xyz-789")
        bad = SimpleNamespace(state=SimpleNamespace(user=None), headers={"x-anonymous-id": "x"})
        self.assertEqual(request_uid(bad), "local-preview")
        none = SimpleNamespace(state=SimpleNamespace(user=None), headers={})
        self.assertEqual(request_uid(none), "local-preview")

    def test_predict_reports_blur_fields(self):
        res = self.client.post("/api/predict", files={"image": ("sample.jpg", self._sample_image(), "image/jpeg")})
        self.assertEqual(res.status_code, 200)
        quality = res.json().get("quality") or {}
        self.assertIn("blur_score", quality)
        self.assertIn("blurry", quality)
        self.assertIn("blur_warning", quality)

    def test_firebase_failure_falls_back_to_local_save(self):
        from app import main as app_main
        with patch.object(app_main.firebase_store, "enabled", return_value=True), \
             patch.object(app_main.firebase_store, "configured", return_value=True), \
             patch.object(app_main.firebase_store, "call_with_timeout", side_effect=RuntimeError("cloud down")):
            res = self.client.post("/api/predict", files={"image": ("sample.jpg", self._sample_image(), "image/jpeg")})
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data["saved"])
        self.assertTrue(data["saved_local_only"])
        self.assertTrue(data["feedback_available"])
        self.assertIsNotNone(data["id"])
        history = self.client.get("/api/history")
        self.assertTrue(any(str(item["id"]) == str(data["id"]) for item in history.json()))

    def test_upload_failure_raises_instead_of_fake_saved(self):
        from app import firebase_store
        with patch.object(firebase_store, "_candidate_bucket_names", return_value=[]), \
             patch.object(firebase_store, "_supabase_configured", return_value=True), \
             patch.object(firebase_store, "_supabase_upload", side_effect=RuntimeError("storage down")):
            with self.assertRaises(RuntimeError):
                firebase_store.create_prediction("uid-1", {"fabric": "silk"}, b"jpeg")


    def test_thresholds_fail_closed_on_partial_manifest(self):
        from app import main as app_main
        with patch.object(app_main, "load_manifest", return_value={}):
            self.assertEqual(app_main.decision_thresholds(), (0.55, 0.10))
        with patch.object(app_main, "load_manifest", return_value={"min_confidence": "bad", "min_margin": None}):
            self.assertEqual(app_main.decision_thresholds(), (0.55, 0.10))
        with patch.object(app_main, "load_manifest", return_value={"min_confidence": 0.70, "min_margin": 0.20}):
            self.assertEqual(app_main.decision_thresholds(), (0.70, 0.20))

    def test_rate_limit_keys_on_first_forwarded_hop(self):
        headers = {"x-forwarded-for": "10.9.9.1, 5.6.7.8"}
        for _ in range(30):
            res = self.client.post("/api/feedback", json={}, headers=headers)
            self.assertNotEqual(res.status_code, 429)
        limited = self.client.post("/api/feedback", json={}, headers=headers)
        self.assertEqual(limited.status_code, 429)
        other = self.client.post("/api/feedback", json={}, headers={"x-forwarded-for": "10.9.9.2, 5.6.7.8"})
        self.assertNotEqual(other.status_code, 429)


    def test_admin_users_supports_pagination(self):
        from app import main as app_main
        page = Mock()
        page.users = []
        page.next_page_token = "tok-2"
        client = Mock()
        client.list_users.return_value = page
        with patch.object(app_main, "require_admin", return_value={"uid": "admin"}), \
             patch.object(app_main, "firebase_admin_auth_client", return_value=client):
            res = self.client.get("/api/admin/users?page_token=tok-1&max_results=10")
        self.assertEqual(res.status_code, 200)
        client.list_users.assert_called_once_with(max_results=10, page_token="tok-1")
        self.assertEqual(res.json()["next_page_token"], "tok-2")
        self.assertTrue(res.json()["next_page"])


    def test_analytics_excludes_rejected_scans(self):
        from app import main as app_main
        # An earlier test class's teardown deletes the shared temp dir; this
        # test runs first alphabetically in its class, so recreate it.
        os.makedirs(os.path.dirname(app_main.DB_PATH), exist_ok=True)
        accepted = {"id": 9001, "fabric": "cotton", "confidence": 90.0, "model_decision": {"accepted": True}}
        rejected = {"id": 9002, "fabric": "unknown", "confidence": 30.0, "model_decision": {"accepted": False}}
        with app_main.connection() as db:
            for rec in (accepted, rejected):
                db.execute("INSERT INTO predictions (owner_uid,created_at,fabric,confidence,payload) VALUES (?,?,?,?,?)", ("anon:analytics-test-uid", "2026-10-25T00:00:00Z", rec["fabric"], rec["confidence"], json.dumps(rec)))
        res = self.client.get("/api/analytics", headers={"x-anonymous-id": "analytics-test-uid"})
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["garments_analyzed"], 2)
        self.assertEqual(data["average_confidence"], 90.0)
        self.assertEqual(data["eco_recommendations"], 1)
        self.assertEqual(data["distribution"]["unknown"], 1)


class TestStorageFailover(unittest.TestCase):
    """Regression tests for the 2026-10-25 storage rebuild."""

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def _sample_image(self, color=(128, 128, 128)):
        img = Image.new("RGB", (100, 100), color=color)
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        return buf.getvalue()

    def test_firebase_first_success_stamps_firebase(self):
        from app import firebase_store
        bucket = Mock()
        blob = Mock()
        bucket.blob.return_value = blob
        database_ref = Mock()
        with patch.object(firebase_store, "_candidate_bucket_names", return_value=["fb-bucket"]), \
             patch.object(firebase_store, "_bucket", return_value=bucket), \
             patch.object(firebase_store, "_root", return_value=database_ref), \
             patch.object(firebase_store, "_supabase_upload") as sup_upload:
            saved = firebase_store.create_prediction("uid-1", {"fabric": "silk"}, b"jpeg")
        self.assertEqual(saved["storage_provider"], "firebase")
        sup_upload.assert_not_called()
        database_ref.set.assert_called_once()

    def test_firebase_failure_falls_back_to_supabase(self):
        from app import firebase_store
        bucket = Mock()
        blob = Mock()
        bucket.blob.return_value = blob
        blob.upload_from_string.side_effect = RuntimeError("bucket missing")
        database_ref = Mock()
        with patch.object(firebase_store, "_candidate_bucket_names", return_value=["fb-bucket"]), \
             patch.object(firebase_store, "_bucket", return_value=bucket), \
             patch.object(firebase_store, "_root", return_value=database_ref), \
             patch.object(firebase_store, "_supabase_configured", return_value=True), \
             patch.object(firebase_store, "_supabase_upload") as sup_upload:
            saved = firebase_store.create_prediction("uid-1", {"fabric": "silk"}, b"jpeg")
        self.assertEqual(saved["storage_provider"], "supabase")
        sup_upload.assert_called_once()

    def test_all_providers_down_raises(self):
        from app import firebase_store
        with patch.object(firebase_store, "_candidate_bucket_names", return_value=[]), \
             patch.object(firebase_store, "_supabase_configured", return_value=False):
            with self.assertRaises(RuntimeError):
                firebase_store.create_prediction("uid-1", {"fabric": "silk"}, b"jpeg")

    def test_delete_uses_stamped_provider(self):
        from app import firebase_store
        row = {"id": "p1", "owner_uid": "uid-1", "image_token": "private-uploads/uid-1/p1.jpg", "storage_provider": "supabase"}
        ref = Mock()
        ref.get.return_value = row
        with patch.object(firebase_store, "_root", return_value=ref), \
             patch.object(firebase_store, "_supabase_delete") as sup_del, \
             patch.object(firebase_store, "_bucket") as bucket_mock:
            self.assertTrue(firebase_store.delete_prediction("p1", "uid-1"))
        sup_del.assert_called_once_with("private-uploads/uid-1/p1.jpg")
        bucket_mock.assert_not_called()

    def test_local_delete_removes_photo_file(self):
        from app import main as app_main
        res = self.client.post("/api/predict", files={"image": ("sample.jpg", self._sample_image(), "image/jpeg")})
        data = res.json()
        path = os.path.join(app_main.UPLOADS_DIR, data["image_token"])
        self.assertTrue(os.path.isfile(path))
        deleted = self.client.delete(f"/api/history/{data['id']}")
        self.assertEqual(deleted.status_code, 200)
        self.assertFalse(os.path.exists(path))

    def test_history_limit_bounds_response(self):
        for _ in range(3):
            self.client.post("/api/predict", files={"image": ("sample.jpg", self._sample_image(), "image/jpeg")})
        res = self.client.get("/api/history?limit=2")
        self.assertEqual(res.status_code, 200)
        self.assertLessEqual(len(res.json()), 2)

    def test_model_path_prefers_bundled_copy(self):
        from app import main as app_main
        with tempfile.TemporaryDirectory() as tmp:
            bundled = os.path.join(tmp, "bundled.pt")
            local = os.path.join(tmp, "local.pt")
            open(bundled, "wb").close()
            open(local, "wb").close()
            with patch.object(app_main, "_bundled_model_path", bundled), \
                 patch.object(app_main, "_default_model_path", local):
                with patch.dict(os.environ, {}):
                    os.environ.pop("MODEL_PATH", None)
                    self.assertEqual(app_main.resolve_model_path(), bundled)


class TestAudit2026Fixes(unittest.TestCase):
    """Regression tests for the 2026-11-03 audit fixes (M-1..M-4, L-1).

    Each test pins one finding: it fails on the pre-fix code and passes
    after. Behavioural evidence that cannot live in a unit suite (the M-4
    burst timings) is recorded in AUDIT-FIXES-2026-11-03.md.
    """

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    # --- M-1: the CORS regex must trust only this project's own hostnames.
    # Pre-fix, allow_origin_regex matched EVERY *.vercel.app and *.e2b.app
    # origin with credentials (audit evidence: anything-at-all.vercel.app
    # and random.e2b.app were both reflected).

    def _acao(self, origin):
        res = self.client.get("/api/fabrics", headers={"Origin": origin})
        self.assertEqual(res.status_code, 200)
        return res.headers.get("access-control-allow-origin")

    def test_cors_reflects_own_production_origin(self):
        origin = "https://ai-laundry-assistant-psi.vercel.app"
        self.assertEqual(self._acao(origin), origin)

    def test_cors_reflects_own_preview_origin(self):
        origin = "https://ai-laundry-assistant-git-audit-fix-thunderdoc.vercel.app"
        self.assertEqual(self._acao(origin), origin)

    def test_cors_rejects_stranger_vercel_origin(self):
        self.assertIsNone(self._acao("https://anything-at-all.vercel.app"))

    def test_cors_rejects_e2b_origin(self):
        self.assertIsNone(self._acao("https://random.e2b.app"))

    def test_cors_rejects_unrelated_origin(self):
        self.assertIsNone(self._acao("https://evil.example.com"))

    # --- M-2: /api/health must surface the auth state. Pre-fix the payload
    # had no auth field at all, so a silent no-auth degradation (Firebase
    # config incomplete -> middleware off, identity from a client header)
    # was invisible to monitors.

    def test_health_reports_auth_disabled_without_firebase_config(self):
        # The suite imports the app with no Firebase configuration.
        data = self.client.get("/api/health").json()
        self.assertEqual(data.get("auth"), "disabled")

    def test_health_reports_auth_enabled_with_firebase_config(self):
        full = {"apiKey": "test-key", "authDomain": "test.firebaseapp.com",
                "projectId": "test-project", "appId": "1:0:web:test"}
        with patch.dict(app_main.FIREBASE_CONFIG, full):
            data = self.client.get("/api/health").json()
        self.assertEqual(data.get("auth"), "enabled")

    # --- M-3: EXIF orientation must be applied in the predict decode path.
    # Pre-fix, a phone photo (pixels stored rotated, EXIF orientation 6)
    # was scored sideways: the audit measured a real cotton photo dropping
    # from 99.96 upright to 84.13 as stored.

    def _exif_phone_bytes(self):
        """A 300x200 photo (left red / right blue) as a phone stores it:
        pixel matrix rotated 90 CCW (200x300) + EXIF orientation 6."""
        upright = Image.new("RGB", (300, 200), (200, 30, 30))
        upright.paste((30, 30, 200), (150, 0, 300, 200))
        stored = upright.transpose(Image.ROTATE_90)
        exif = Image.Exif()
        exif[274] = 6
        buf = io.BytesIO()
        stored.save(buf, format="JPEG", quality=95, exif=exif.tobytes())
        return buf.getvalue()

    def test_predict_applies_exif_orientation(self):
        res = self.client.post("/api/predict", files={"image": ("phone.jpg", self._exif_phone_bytes(), "image/jpeg")})
        self.assertEqual(res.status_code, 200)
        data = res.json()
        # The decoded image must carry the DISPLAYED dimensions (300x200),
        # not the stored pixel-matrix dimensions (200x300).
        self.assertEqual(data["quality"]["width"], 300)
        self.assertEqual(data["quality"]["height"], 200)
        # The stored upload is the same decoded image: also upright.
        stored_path = os.path.join(app_main.UPLOADS_DIR, data["image_token"])
        with Image.open(stored_path) as saved:
            self.assertEqual(saved.size, (300, 200))

    def test_predict_exif_photo_scores_like_upright(self):
        # Consistency guard on a real held-out photo: the EXIF-stored copy
        # must produce the same top fabric at near-identical confidence.
        data_dir = os.path.join(os.path.dirname(__file__), "..", "..", "data", "test", "cotton")
        path = os.path.join(data_dir, sorted(os.listdir(data_dir))[0])
        with open(path, "rb") as f:
            raw = f.read()
        up = self.client.post("/api/predict", files={"image": ("upright.jpg", raw, "image/jpeg")})
        self.assertEqual(up.status_code, 200)
        src = Image.open(io.BytesIO(raw)).convert("RGB")
        stored = src.transpose(Image.ROTATE_90)
        exif = Image.Exif()
        exif[274] = 6
        buf = io.BytesIO()
        stored.save(buf, format="JPEG", quality=95, exif=exif.tobytes())
        ro = self.client.post("/api/predict", files={"image": ("phone.jpg", buf.getvalue(), "image/jpeg")})
        self.assertEqual(ro.status_code, 200)
        u, r = up.json()["model_decision"], ro.json()["model_decision"]
        self.assertEqual(u["top_fabric"], r["top_fabric"])
        self.assertAlmostEqual(u["top_confidence"], r["top_confidence"], delta=5.0)

    # --- M-4: predict's blocking work (decode, inference, persistence)
    # must not run on the event loop. The handler stays async only to read
    # the upload; everything after runs via run_in_threadpool. Behavioural
    # proof (burst timings) lives in AUDIT-FIXES-2026-11-03.md.

    def test_predict_offloads_blocking_work_to_threadpool(self):
        import inspect
        self.assertTrue(inspect.iscoroutinefunction(app_main.predict))
        self.assertIn("run_in_threadpool", inspect.getsource(app_main.predict))
        self.assertTrue(callable(app_main._predict_from_bytes))

    # --- L-1: unmatched /api/* paths must return a JSON 404, not the SPA.
    # Pre-fix they fell through to the catch-all and returned 200 text/html.

    def test_unknown_api_path_returns_json_404(self):
        res = self.client.get("/api/does-not-exist")
        self.assertEqual(res.status_code, 404)
        self.assertIn("application/json", res.headers.get("content-type", ""))
        self.assertEqual(res.json(), {"detail": "Not Found"})

    def test_unknown_spa_path_still_serves_index_html(self):
        res = self.client.get("/some-spa-route")
        self.assertEqual(res.status_code, 200)
        self.assertIn("text/html", res.headers.get("content-type", ""))


class TestV2ModelParts(unittest.TestCase):
    """The v2 model ships as base64 text parts (the deploy pipeline carries
    text only). Pin the assembly contract: the parts decode to exactly the
    md5 recorded in parts.json, the assembled TorchScript loads and returns
    one score per manifest class, and the app actually resolves to the v2
    model + v2 manifest pair (rollback = removing the parts directory)."""

    def test_parts_assemble_to_verified_model(self):
        from app import main as app_main
        models_dir = os.path.dirname(app_main._bundled_model_path)
        info_path = os.path.join(models_dir, "fabric_v2_parts", "parts.json")
        self.assertTrue(os.path.isfile(info_path), "v2 parts must ship with the backend")
        with open(info_path, encoding="utf-8") as handle:
            info = json.load(handle)
        path = app_main.assemble_v2_model()
        self.assertIsNotNone(path, "present, valid parts must assemble")
        digest = hashlib.md5()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        self.assertEqual(digest.hexdigest(), info["md5"])
        try:
            import torch
        except Exception as exc:
            self.skipTest(f"torch unavailable: {exc}")
        model = torch.jit.load(path, map_location="cpu").eval()
        with torch.no_grad():
            output = model(torch.zeros(1, 3, 224, 224))
        self.assertEqual(tuple(output.shape), (1, 6))

    def test_incomplete_or_corrupt_parts_fall_back_to_none(self):
        """A partial parts landing must never activate v2: assembly refuses
        (returns None) when a part is missing or the decoded bytes fail the
        md5 recorded in parts.json, so resolve_model_path keeps serving the
        bundled v1 model until the complete, verified parts set is present."""
        import shutil
        import tempfile
        from unittest import mock
        from app import main as app_main
        models_dir = os.path.dirname(app_main._bundled_model_path)
        src_parts = os.path.join(models_dir, "fabric_v2_parts")
        with open(os.path.join(src_parts, "parts.json"), encoding="utf-8") as handle:
            info = json.load(handle)
        with tempfile.TemporaryDirectory() as tmp:
            fake_models = os.path.join(tmp, "models")
            fake_parts = os.path.join(fake_models, "fabric_v2_parts")
            os.makedirs(fake_parts)
            shutil.copy(os.path.join(src_parts, "parts.json"), fake_parts)
            # Incomplete set: only the first part present.
            shutil.copy(os.path.join(src_parts, "part-000.txt"), fake_parts)
            with mock.patch.object(app_main, "_bundled_model_path", os.path.join(fake_models, "fabric_mobilenetv2.pt")), \
                 mock.patch.object(app_main.tempfile, "gettempdir", return_value=tmp):
                self.assertIsNone(app_main.assemble_v2_model())
                # Complete set but one part corrupted: md5 must refuse it.
                for index in range(int(info["parts"])):
                    shutil.copy(os.path.join(src_parts, f"part-{index:03d}.txt"), fake_parts)
                last = os.path.join(fake_parts, f"part-{int(info['parts']) - 1:03d}.txt")
                with open(last, encoding="utf-8") as handle:
                    text = handle.read()
                flipped = ("A" if text[0] != "A" else "B") + text[1:]
                with open(last, "w", encoding="utf-8") as handle:
                    handle.write(flipped)
                self.assertIsNone(app_main.assemble_v2_model())

    def test_app_resolves_to_v2_model_and_manifest(self):
        # Since 2026-11-05 the serving manifest is the ensemble's (see
        # TestEnsembleModelShip below). MODEL_PATH still resolves to the
        # v2 (exp-3) model — it is both an ensemble member and the
        # single-model fallback — and the v2 manifest stays on disk,
        # untouched, still declaring its own 0.8087 for rollback.
        from app import main as app_main
        self.assertTrue(app_main.MODEL_PATH.endswith("fabric_mobilenetv2_v2.pt"), app_main.MODEL_PATH)
        manifest = app_main.load_manifest()
        self.assertEqual(manifest.get("model_version"), "ensemble-b-20261105")
        self.assertEqual(manifest.get("test_accuracy"), 0.8303)
        self.assertEqual(manifest.get("min_confidence"), 0.55)
        self.assertEqual(manifest.get("min_margin"), 0.10)
        models_dir = os.path.dirname(app_main._bundled_model_path)
        with open(os.path.join(models_dir, "fabric_mobilenetv2_v2.manifest.json"), encoding="utf-8") as handle:
            v2_manifest = json.load(handle)
        self.assertEqual(v2_manifest.get("test_accuracy"), 0.8087)


class _FixedLogitsModel:
    """Callable stand-in for a TorchScript model: returns the same logits
    row for every crop in the batch, so ensemble maths is deterministic."""

    def __init__(self, logits):
        self.logits = logits

    def __call__(self, batch):
        import torch
        row = torch.tensor([self.logits], dtype=torch.float32)
        return row.repeat(batch.shape[0], 1)


class TestEnsembleModelShip(unittest.TestCase):
    """The 2026-11-05 ensemble ship (combo b): /api/predict serves the
    weighted probability average of exp-12 (distilled EffNet-B0, weight
    0.5) + exp-3 + exp-6 + exp-2 (1/6 each) — measured clean 0.8303 /
    real-photo 0.6569 / dim 0.6296. Pin the whole contract: every member's
    parts assemble md5-verified, a partial or corrupt member disables ONLY
    the ensemble (single-model chain keeps serving), and predict really
    averages the members' probabilities before the unchanged gates."""

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def test_ensemble_parts_assemble_to_verified_models(self):
        from app import main as app_main
        models_dir = os.path.dirname(app_main._bundled_model_path)
        try:
            import torch
        except Exception as exc:
            self.skipTest(f"torch unavailable: {exc}")
        for parts_dir_name, _weight in app_main._ensemble_config():
            info_path = os.path.join(models_dir, parts_dir_name, "parts.json")
            self.assertTrue(os.path.isfile(info_path), f"{parts_dir_name} parts must ship with the backend")
            with open(info_path, encoding="utf-8") as handle:
                info = json.load(handle)
            path = app_main._assemble_parts_model(parts_dir_name)
            self.assertIsNotNone(path, f"present, valid {parts_dir_name} parts must assemble")
            digest = hashlib.md5()
            with open(path, "rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(chunk)
            self.assertEqual(digest.hexdigest(), info["md5"], parts_dir_name)
            model = torch.jit.load(path, map_location="cpu").eval()
            with torch.no_grad():
                output = model(torch.zeros(1, 3, 224, 224))
            self.assertEqual(tuple(output.shape), (1, 6), parts_dir_name)

    def test_ensemble_incomplete_or_corrupt_parts_fall_back_to_none(self):
        """A partial ensemble landing must never activate the ensemble:
        resolution returns None while any member's parts are missing or
        fail their md5, so the single-model chain keeps serving until the
        complete, verified member set is present."""
        import shutil
        import tempfile
        from unittest import mock
        from app import main as app_main
        models_dir = os.path.dirname(app_main._bundled_model_path)
        env = dict(os.environ)
        env.pop("MODEL_PATH", None)
        with tempfile.TemporaryDirectory() as tmp:
            fake_models = os.path.join(tmp, "models")
            os.makedirs(fake_models)
            shutil.copy(os.path.join(models_dir, "fabric_ensemble.manifest.json"), fake_models)
            infos = {}
            for parts_dir_name, _weight in app_main._ensemble_config():
                src_parts = os.path.join(models_dir, parts_dir_name)
                fake_parts = os.path.join(fake_models, parts_dir_name)
                os.makedirs(fake_parts)
                with open(os.path.join(src_parts, "parts.json"), encoding="utf-8") as handle:
                    infos[parts_dir_name] = json.load(handle)
                shutil.copy(os.path.join(src_parts, "parts.json"), fake_parts)
            def copy_parts(parts_dir_name, skip_last=False):
                src_parts = os.path.join(models_dir, parts_dir_name)
                fake_parts = os.path.join(fake_models, parts_dir_name)
                count = int(infos[parts_dir_name]["parts"]) - (1 if skip_last else 0)
                for index in range(count):
                    shutil.copy(os.path.join(src_parts, f"part-{index:03d}.txt"), fake_parts)
            # v2 + exp2 + exp12 complete; exp6 incomplete (first part only).
            copy_parts("fabric_v2_parts")
            copy_parts("fabric_ens_exp2_parts")
            copy_parts("fabric_ens_exp12_parts")
            shutil.copy(os.path.join(models_dir, "fabric_ens_exp6_parts", "part-000.txt"),
                        os.path.join(fake_models, "fabric_ens_exp6_parts"))
            with mock.patch.dict(os.environ, env, clear=True), \
                 mock.patch.object(app_main, "_bundled_model_path", os.path.join(fake_models, "fabric_mobilenetv2.pt")), \
                 mock.patch.object(app_main.tempfile, "gettempdir", return_value=tmp):
                self.assertIsNone(app_main.resolve_ensemble_model_paths())
                # Complete exp6 set but its last part corrupted: md5 refuses.
                copy_parts("fabric_ens_exp6_parts")
                last = os.path.join(fake_models, "fabric_ens_exp6_parts",
                                    f"part-{int(infos['fabric_ens_exp6_parts']['parts']) - 1:03d}.txt")
                with open(last, encoding="utf-8") as handle:
                    text = handle.read()
                flipped = ("A" if text[0] != "A" else "B") + text[1:]
                with open(last, "w", encoding="utf-8") as handle:
                    handle.write(flipped)
                self.assertIsNone(app_main.resolve_ensemble_model_paths())
                # Clean complete set: the ensemble resolves all four members.
                shutil.copy(os.path.join(models_dir, "fabric_ens_exp6_parts", os.path.basename(last)), last)
                paths = app_main.resolve_ensemble_model_paths()
                self.assertIsNotNone(paths)
                self.assertEqual(len(paths), 4)

    def test_ensemble_definition_is_config_driven_from_manifest(self):
        """The member list + weights live ONLY in fabric_ensemble.manifest
        .json: the loader's config mirrors it exactly, in order, and the
        module-level serving resolution aligns paths with weights."""
        from app import main as app_main
        models_dir = os.path.dirname(app_main._bundled_model_path)
        with open(os.path.join(models_dir, "fabric_ensemble.manifest.json"), encoding="utf-8") as handle:
            manifest = json.load(handle)
        declared = [(m["parts_dir"], float(m["weight"])) for m in manifest["ensemble"]["members"]]
        self.assertEqual(app_main._ensemble_config(), declared)
        self.assertEqual(len(declared), 4)
        self.assertAlmostEqual(sum(w for _, w in declared), 1.0, places=9)
        self.assertEqual([os.path.basename(p) for p in app_main.ENSEMBLE_MODEL_PATHS],
                         ["fabric_ens_exp12.pt", "fabric_mobilenetv2_v2.pt", "fabric_ens_exp6.pt", "fabric_ens_exp2.pt"])
        self.assertEqual(app_main.ENSEMBLE_MODEL_WEIGHTS, [w for _, w in declared])

    def test_ensemble_math_honours_manifest_weights(self):
        """Weighted averaging: a 0.75/0.25 weighting must produce the
        weighted blend of the members' probabilities — not the equal
        average and not either member alone (combo decisions like
        exp7 0.5 + triple 0.5 depend on this being exact)."""
        from app import main as app_main
        try:
            import torch
        except Exception as exc:
            self.skipTest(f"torch unavailable: {exc}")
        strong_cotton = _FixedLogitsModel([3.0, 0.0, 0.0, 0.0, 0.0, 0.0])
        strong_polyester = _FixedLogitsModel([0.0, 3.0, 0.0, 0.0, 0.0, 0.0])
        im = Image.new("RGB", (300, 300), color=(120, 90, 60))
        mean, std = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]
        weighted = app_main.ensemble_five_crop_probabilities(
            [strong_cotton, strong_polyester], im, 224, mean, std, weights=[0.75, 0.25])
        pa = torch.softmax(torch.tensor([3.0, 0.0, 0.0, 0.0, 0.0, 0.0]), dim=0)
        pb = torch.softmax(torch.tensor([0.0, 3.0, 0.0, 0.0, 0.0, 0.0]), dim=0)
        expected = 0.75 * pa + 0.25 * pb
        for got, want in zip(weighted, expected.tolist()):
            self.assertAlmostEqual(got, want, places=6)
        equal = app_main.ensemble_five_crop_probabilities(
            [strong_cotton, strong_polyester], im, 224, mean, std)
        self.assertNotAlmostEqual(weighted[0], equal[0], places=4)

    def test_app_serves_ensemble_with_four_loaded_members(self):
        from app import main as app_main
        self.assertTrue(app_main.ENSEMBLE_ACTIVE)
        self.assertEqual(len(app_main.ENSEMBLE_MODEL_PATHS), 4)
        try:
            import torch  # noqa: F401
        except Exception as exc:
            self.skipTest(f"torch unavailable: {exc}")
        models = app_main.load_predict_models()
        self.assertEqual(len(models), 4)
        state = app_main.model_status()
        self.assertTrue(state["ready"], state.get("error"))
        self.assertTrue(state["ensemble"])

    def test_ensemble_load_failure_falls_back_to_single_model(self):
        from unittest import mock
        from app import main as app_main
        sentinel = object()
        with mock.patch.object(app_main, "_PREDICT_MODELS", None), \
             mock.patch.object(app_main, "_load_jit_model", side_effect=RuntimeError("member boom")), \
             mock.patch.object(app_main, "load_model", return_value=sentinel):
            self.assertEqual(app_main.load_predict_models(), [sentinel])

    def test_ensemble_math_averages_per_crop_probabilities(self):
        from app import main as app_main
        try:
            import torch
        except Exception as exc:
            self.skipTest(f"torch unavailable: {exc}")
        strong_cotton = _FixedLogitsModel([3.0, 0.0, 0.0, 0.0, 0.0, 0.0])
        strong_polyester = _FixedLogitsModel([0.0, 3.0, 0.0, 0.0, 0.0, 0.0])
        im = Image.new("RGB", (300, 300), color=(120, 90, 60))
        mean, std = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]
        averaged = app_main.ensemble_five_crop_probabilities(
            [strong_cotton, strong_polyester], im, 224, mean, std)
        top = torch.softmax(torch.tensor([3.0, 0.0, 0.0, 0.0, 0.0, 0.0]), dim=0)
        expected_top = float((top[0] + top[1]) / 2)  # each model tops a different class
        expected_other = float((top[1] + top[2]) / 2)
        self.assertAlmostEqual(max(averaged), expected_top, places=6)
        self.assertAlmostEqual(min(averaged), expected_other, places=6)
        # The averaged distribution is genuinely diluted: below the 0.55 gate
        # even though each member alone clears it with room to spare.
        self.assertLess(max(averaged), 0.55)
        self.assertGreater(float(top[0]), 0.55)
        # A one-member ensemble reduces exactly to the single-model function.
        single = app_main.five_crop_probabilities(strong_cotton, im, 224, mean, std)
        solo = app_main.ensemble_five_crop_probabilities([strong_cotton], im, 224, mean, std)
        for got, want in zip(solo, single):
            self.assertAlmostEqual(got, want, places=7)

    def test_predict_uses_ensemble_average_not_single_model(self):
        """End to end through /api/predict: two members that each confidently
        pick a different fabric must average into a gated 'unknown' — either
        member alone would have been accepted. Fails on the pre-ensemble
        code, which served a single model and had no load_predict_models.
        The fixture pins its own equal serving weights: predict reads the
        module-level ENSEMBLE_MODEL_WEIGHTS of whichever ensemble ships
        (combo b leads with 0.5, which would un-dilute this two-member
        fixture), so the averaging contract is tested independent of the
        shipped combo."""
        from unittest import mock
        from app import main as app_main
        members = [_FixedLogitsModel([3.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
                   _FixedLogitsModel([0.0, 3.0, 0.0, 0.0, 0.0, 0.0])]
        img = Image.new("RGB", (100, 100), color=(128, 128, 128))
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        with mock.patch.object(app_main, "load_predict_models", return_value=members), \
             mock.patch.object(app_main, "ENSEMBLE_MODEL_WEIGHTS", [0.5, 0.5]):
            res = self.client.post("/api/predict", files={"image": ("sample.jpg", buf.getvalue(), "image/jpeg")})
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["fabric"], "unknown")
        self.assertEqual(data["model_decision"]["inference_method"], "five_crop_ensemble_average")
        import math
        p_top = math.exp(3.0) / (math.exp(3.0) + 5.0)
        p_other = 1.0 / (math.exp(3.0) + 5.0)
        expected_conf = (p_top + p_other) / 2 * 100
        self.assertAlmostEqual(data["model_decision"]["top_confidence"], expected_conf, delta=0.5)


if __name__ == "__main__":
    unittest.main()
