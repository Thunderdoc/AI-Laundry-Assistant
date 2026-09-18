import base64
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
from app.main import app, connection, FABRICS
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
        with patch.object(firebase_store, "_bucket", return_value=bucket), patch.object(firebase_store, "_root", return_value=database_ref):
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
        scans = [
            {"fabric": "cotton", "confidence": 92, "created_at": "2026-09-17T10:00:00Z"},
            {"fabric": "silk", "confidence": 61, "created_at": "2026-09-16T10:00:00Z"},
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

    def token(self, key_id=None, expires_in=3600, audience=None, issuer=None):
        import time
        issued = int(time.time())
        return self.pyjwt.encode(
            {
                "iss": issuer or f"https://securetoken.google.com/{self.PROJECT}",
                "aud": audience or self.PROJECT,
                "sub": "firebase-uid-42",
                "iat": issued,
                "exp": issued + expires_in,
                "email": "admin@example.com",
                "email_verified": True,
            },
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


if __name__ == "__main__":
    unittest.main()
