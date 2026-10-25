"""Tests for the dormant Supabase fallback store (not wired into main.py).

The fake below implements just enough of PostgREST + Supabase Storage over
an in-memory dict to prove the module's CRUD, scoping, rollback and audit
semantics. No live Supabase project is needed (or touched).
"""
import io
import json
import os
import unittest
from unittest.mock import patch
from urllib import parse as urlparse

from app import supabase_store


class _FakeResponse:
    def __init__(self, payload: bytes):
        self._payload = payload

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeSupabase:
    def __init__(self):
        self.tables = {"predictions": [], "feedback": [], "audit_events": []}
        self.storage = {}
        self.fail_tables = set()

    def _table_and_query(self, url):
        parsed = urlparse.urlparse(url)
        table = parsed.path.split("/rest/v1/")[1]
        query = urlparse.parse_qs(parsed.query)
        return table, query

    def _apply_filters(self, rows, query):
        out = list(rows)
        for key, values in query.items():
            value = values[0]
            if value.startswith("eq."):
                want = urlparse.unquote(value[3:])
                out = [row for row in out if str(row.get(key, "")) == want]
        if query.get("order", [""])[0] == "created_at.desc":
            out.sort(key=lambda row: str(row.get("created_at", "")), reverse=True)
        offset = int(query.get("offset", ["0"])[0])
        if "limit" in query:
            out = out[offset:offset + int(query["limit"][0])]
        elif offset:
            out = out[offset:]
        if query.get("select", [""])[0] == "id":
            out = [{"id": row["id"]} for row in out]
        return out

    def __call__(self, request, timeout=None):
        url = request.full_url
        method = request.get_method()
        body = request.data
        if "/storage/v1/object/remove/" in url:
            prefixes = json.loads(body.decode("utf-8"))["prefixes"]
            for prefix in prefixes:
                self.storage.pop(prefix, None)
            return _FakeResponse(b"{}")
        if "/storage/v1/object/" in url:
            path = url.split("/storage/v1/object/test-bucket/")[1]
            if method == "POST":
                self.storage[path] = body
                return _FakeResponse(b"{}")
            if method == "GET":
                if path not in self.storage:
                    raise RuntimeError("object not found")
                return _FakeResponse(self.storage[path])
        if "/storage/v1/bucket/" in url:
            return _FakeResponse(b"{}")
        table, query = self._table_and_query(url)
        if table in self.fail_tables and method == "POST":
            raise RuntimeError("db down")
        if method == "GET":
            return _FakeResponse(json.dumps(self._apply_filters(self.tables[table], query)).encode("utf-8"))
        if method == "POST":
            row = json.loads(body.decode("utf-8"))
            self.tables[table].append(row)
            return _FakeResponse(json.dumps([row]).encode("utf-8"))
        if method == "PATCH":
            updated = []
            for row in self._apply_filters(self.tables[table], query):
                row.update(json.loads(body.decode("utf-8")))
                updated.append(row)
            return _FakeResponse(json.dumps(updated).encode("utf-8"))
        if method == "DELETE":
            doomed = self._apply_filters(self.tables[table], query)
            self.tables[table] = [row for row in self.tables[table] if row not in doomed]
            return _FakeResponse(b"[]")
        raise AssertionError(f"unhandled {method} {url}")


class TestSupabaseStore(unittest.TestCase):
    def setUp(self):
        # NOTE: env must be patched per-test, NOT at module import — pytest
        # imports every test file up front, and a module-level
        # PERSISTENCE_BACKEND=supabase silently disables firebase_store for
        # the whole process (that broke test_18 in test_api.py).
        env_patcher = patch.dict(os.environ, {
            "SUPABASE_URL": "http://supabase.test",
            "SUPABASE_SERVICE_ROLE_KEY": "test-key",
            "SUPABASE_BUCKET": "test-bucket",
            "PERSISTENCE_BACKEND": "supabase",
        })
        env_patcher.start()
        self.addCleanup(env_patcher.stop)
        self.fake = _FakeSupabase()
        patcher = patch.object(supabase_store.urlrequest, "urlopen", self.fake)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _prediction(self, owner="owner-1"):
        return supabase_store.create_prediction(
            owner,
            {"fabric": "cotton", "confidence": 90.0, "created_at": "2026-10-25T00:00:00Z"},
            b"fake-jpeg",
        )

    def test_configured_and_status_probe(self):
        self.assertTrue(supabase_store.configured())
        self.assertTrue(supabase_store.enabled())
        state = supabase_store.status(probe=True)
        self.assertEqual(state["backend"], "supabase")
        self.assertTrue(state["database_reachable"])
        self.assertTrue(state["storage_reachable"])

    def test_create_list_get_update_delete(self):
        saved = self._prediction()
        self.assertEqual(saved["storage_provider"], "supabase")
        self.assertIn(saved["image_token"], self.fake.storage)
        self.assertEqual(len(supabase_store.list_predictions("owner-1")), 1)
        self.assertEqual(supabase_store.list_predictions("owner-2"), [])
        self.assertEqual(supabase_store.get_prediction(saved["id"], "owner-1")["fabric"], "cotton")
        self.assertIsNone(supabase_store.get_prediction(saved["id"], "owner-2"))
        updated = supabase_store.update_prediction(saved["id"], "owner-1", {"fabric": "denim"})
        self.assertEqual(updated["fabric"], "denim")
        self.assertIsNone(supabase_store.update_prediction(saved["id"], "owner-2", {"fabric": "wool"}))
        self.assertTrue(supabase_store.delete_prediction(saved["id"], "owner-1"))
        self.assertNotIn(saved["image_token"], self.fake.storage)
        self.assertFalse(supabase_store.delete_prediction(saved["id"], "owner-1"))

    def test_create_rolls_back_storage_on_db_failure(self):
        self.fake.fail_tables.add("predictions")
        with self.assertRaises(RuntimeError):
            self._prediction()
        self.assertEqual(self.fake.storage, {})

    def test_feedback_approve_flow(self):
        saved = self._prediction()
        feedback = supabase_store.submit_feedback(saved, "denim", False)
        self.assertEqual(feedback["review_status"], "pending")
        self.assertIn(feedback["storage_path"], self.fake.storage)
        pred = supabase_store.get_prediction(saved["id"], "owner-1")
        self.assertEqual(pred["user_feedback"]["confirmed_fabric"], "denim")
        self.assertEqual(len(supabase_store.list_feedback("pending")), 1)
        reviewed = supabase_store.review_feedback(feedback["id"], "admin-1", True)
        self.assertEqual(reviewed["review_status"], "approved")
        self.assertIn(reviewed["approved_storage_path"], self.fake.storage)
        self.assertNotIn(feedback["storage_path"], self.fake.storage)
        self.assertEqual(supabase_store.approved_counts(), {"denim": 1})
        self.assertEqual(supabase_store.list_feedback("pending"), [])
        self.assertIsNone(supabase_store.review_feedback(feedback["id"], "admin-1", True))

    def test_audit_events(self):
        supabase_store.create_audit_event({
            "action": "test_action", "admin_uid": "admin-1",
            "target_uid": None, "metadata": {}, "created_at": "2026-10-25T00:00:00Z",
        })
        self.assertEqual(supabase_store.count_audit_events(), 1)
        events = supabase_store.list_audit_events()
        self.assertEqual(events[0]["action"], "test_action")


class TestSupabaseSeam(unittest.TestCase):
    """Proves main.py's `store` alias actually routes through Supabase."""

    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        from app.main import app
        cls.client = TestClient(app)

    def setUp(self):
        import app.main as app_main
        from contextlib import ExitStack
        self.fake = _FakeSupabase()
        self.stack = ExitStack()
        self.stack.enter_context(patch.dict(os.environ, {
            "SUPABASE_URL": "http://supabase.test",
            "SUPABASE_SERVICE_ROLE_KEY": "test-key",
            "SUPABASE_BUCKET": "test-bucket",
            "PERSISTENCE_BACKEND": "supabase",
        }))
        self.stack.enter_context(patch.object(app_main, "store", supabase_store))
        self.stack.enter_context(patch.object(supabase_store.urlrequest, "urlopen", self.fake))
        self.addCleanup(self.stack.close)

    def test_health_reports_supabase_backend(self):
        res = self.client.get("/api/health?probe=false")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["persistence"]["backend"], "supabase")

    def test_predict_and_history_via_supabase(self):
        from PIL import Image
        img = Image.new("RGB", (100, 100), color=(128, 128, 128))
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        res = self.client.post(
            "/api/predict",
            files={"image": ("sample.jpg", buf.getvalue(), "image/jpeg")},
            headers={"x-anonymous-id": "seam-test-uid"},
        )
        data = res.json()
        self.assertTrue(data.get("saved"), data)
        self.assertFalse(data.get("saved_local_only"), data)
        hist = self.client.get("/api/history", headers={"x-anonymous-id": "seam-test-uid"})
        self.assertEqual(hist.status_code, 200)
        rows = hist.json()
        self.assertTrue(any(row.get("id") == data.get("id") for row in rows), rows)


if __name__ == "__main__":
    unittest.main()
