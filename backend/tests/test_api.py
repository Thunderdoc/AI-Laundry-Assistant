import io
import os
import tempfile
import unittest
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
        finally:
            main.ADMIN_EMAILS = original

if __name__ == "__main__":
    unittest.main()
