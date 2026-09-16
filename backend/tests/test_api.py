import io
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
os.environ["FIREBASE_SERVICE_ACCOUNT_FILE"] = ""
os.environ["ENABLE_RETRAINING"] = "false"
from app.main import app, connection, FABRICS

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

if __name__ == "__main__":
    unittest.main()
