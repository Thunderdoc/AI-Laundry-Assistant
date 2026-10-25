"""Supabase persistence for LaundryAI — FALLBACK ONLY, NOT wired into main.py.

Prepared 2026-10-25 under the owner's from-scratch authorization ("chahe
scratch se bnao"). This module is dormant: main.py still uses
firebase_store.py, and nothing here runs in production until the fallback
trigger hits (Firebase Storage fails after being enabled, or Firebase
demands billing) AND a fresh free Supabase project exists. Wiring is then a
small step: point main.py's persistence seam at this module and set
PERSISTENCE_BACKEND=supabase. Auth verification (Supabase JWTs) is
trigger-time work — this module covers data + image storage only.

Stdlib only (urllib), same style as the Supabase storage helpers already in
firebase_store.py. No new dependency, so the module can ship in one push.

Tables to create in the new project's SQL editor (free tier):
  predictions  (id text primary key, owner_uid text, created_at text,
                data jsonb)   -- data holds the full record, same shape as
                                 the RTDB rows, so history/feedback code
                                 sees identical records.
  feedback     (id text primary key, owner_uid text, review_status text,
                created_at text, data jsonb)
  audit_events (id text primary key, created_at text, data jsonb)
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib import parse as urlparse
from urllib import request as urlrequest


def _value(name: str) -> str:
    return os.getenv(name, "").strip()


def configured() -> bool:
    return bool(
        _value("SUPABASE_URL")
        and _value("SUPABASE_SERVICE_ROLE_KEY")
        and _value("SUPABASE_BUCKET")
    )


def call_with_timeout(operation, timeout: float | None = None):
    """Bound a blocking Supabase HTTP operation (same pattern as Firebase).

    Supabase calls are plain urllib requests, so this simply bounds the
    callable; kept so main.py can use one seam for both backends.
    """
    import queue
    import threading

    seconds = timeout if timeout is not None else 10.0
    result: queue.Queue[tuple[bool, Any]] = queue.Queue(maxsize=1)

    def invoke() -> None:
        try:
            result.put((True, operation()))
        except BaseException as exc:  # propagate the original exception
            result.put((False, exc))

    threading.Thread(target=invoke, daemon=True, name="supabase-operation").start()
    try:
        ok, value = result.get(timeout=max(0.1, seconds))
    except queue.Empty as exc:
        raise TimeoutError(f"Supabase operation exceeded {seconds:g} seconds") from exc
    if ok:
        return value
    raise value


def training_export_reference() -> dict[str, Any]:
    """Mirror firebase_store.training_export_reference for Supabase."""
    if configured():
        return {
            "provider": "supabase-storage",
            "bucket": _value("SUPABASE_BUCKET"),
            "prefix": "training-approved/",
            "portable": True,
        }
    return {"provider": "local", "path": "data", "portable": False}


def enabled() -> bool:
    mode = _value("PERSISTENCE_BACKEND").lower()
    if mode:
        return mode == "supabase"
    return configured()


def _rest(method: str, table: str, query: str = "", body: Any = None) -> Any:
    base = _value("SUPABASE_URL").rstrip("/")
    url = f"{base}/rest/v1/{table}"
    if query:
        url += "?" + query
    headers = {
        "apikey": _value("SUPABASE_SERVICE_ROLE_KEY"),
        "Authorization": f"Bearer {_value('SUPABASE_SERVICE_ROLE_KEY')}",
    }
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        headers["Prefer"] = "return=representation"
        data = json.dumps(body).encode("utf-8")
    req = urlrequest.Request(url, data=data, headers=headers, method=method)
    with urlrequest.urlopen(req, timeout=10) as response:
        raw = response.read()
    return json.loads(raw.decode("utf-8")) if raw else None


def _row(table: str, row_id: str) -> dict[str, Any] | None:
    rows = _rest("GET", table, "id=eq." + urlparse.quote(row_id))
    if isinstance(rows, list) and rows:
        return rows[0]
    return None


def _record(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    data = row.get("data")
    return data if isinstance(data, dict) else row


# ---------------------------------------------------------------------------
# Image storage (same endpoints as firebase_store's Supabase leg)
# ---------------------------------------------------------------------------

def _storage(method: str, path: str, body: bytes | None = None, content_type: str | None = None) -> bytes:
    base = _value("SUPABASE_URL").rstrip("/")
    url = f"{base}/storage/v1/{path.lstrip('/')}"
    headers = {
        "apikey": _value("SUPABASE_SERVICE_ROLE_KEY"),
        "Authorization": f"Bearer {_value('SUPABASE_SERVICE_ROLE_KEY')}",
    }
    if content_type:
        headers["Content-Type"] = content_type
    req = urlrequest.Request(url, data=body, headers=headers, method=method)
    with urlrequest.urlopen(req, timeout=10) as response:
        return response.read()


def _storage_upload(path: str, content: bytes) -> None:
    _storage("POST", f"object/{_value('SUPABASE_BUCKET')}/{path}", content, "image/jpeg")


def _storage_download(path: str) -> bytes:
    return _storage("GET", f"object/{_value('SUPABASE_BUCKET')}/{path}")


def _storage_delete(path: str) -> None:
    # Live-verified 2026-10-25: DELETE on the object path (see firebase_store
    # for the two POST forms that do NOT delete).
    _storage("DELETE", f"object/{_value('SUPABASE_BUCKET')}/{path}")


def _storage_copy(source: str, destination: str) -> None:
    _storage_upload(destination, _storage_download(source))


def upload_image(path: str, content: bytes) -> str:
    """Upload image bytes to Supabase Storage. Returns the provider name."""
    _storage_upload(path, content)
    return "supabase"


# ---------------------------------------------------------------------------
# Predictions
# ---------------------------------------------------------------------------

def create_prediction(owner_uid: str, record: dict[str, Any], jpeg: bytes) -> dict[str, Any]:
    record_id = uuid.uuid4().hex
    storage_path = f"private-uploads/{owner_uid}/{record_id}.jpg"
    provider = upload_image(storage_path, jpeg)
    saved = {**record, "id": record_id, "image_token": storage_path, "owner_uid": owner_uid, "storage_provider": provider}
    try:
        _rest("POST", "predictions", "", {
            "id": record_id,
            "owner_uid": owner_uid,
            "created_at": str(saved.get("created_at", "")),
            "data": saved,
        })
    except Exception:
        try:
            _storage_delete(storage_path)
        except Exception:
            pass
        raise
    return saved


def list_predictions(owner_uid: str | None = None) -> list[dict[str, Any]]:
    query = "order=created_at.desc"
    if owner_uid is not None:
        query = "owner_uid=eq." + urlparse.quote(owner_uid) + "&" + query
    rows = _rest("GET", "predictions", query) or []
    return [_record(row) for row in rows if _record(row) is not None]


def get_prediction(record_id: str, owner_uid: str | None = None) -> dict[str, Any] | None:
    rec = _record(_row("predictions", record_id))
    if rec is None:
        return None
    if owner_uid is not None and rec.get("owner_uid") != owner_uid:
        return None
    return rec


def update_prediction(record_id: str, owner_uid: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    row = _row("predictions", record_id)
    rec = _record(row)
    if rec is None or rec.get("owner_uid") != owner_uid:
        return None
    rec.update(updates)
    _rest("PATCH", "predictions", "id=eq." + urlparse.quote(record_id), {"data": rec})
    return rec


def delete_prediction(record_id: str, owner_uid: str) -> bool:
    rec = get_prediction(record_id, owner_uid)
    if rec is None:
        return False
    token = rec.get("image_token")
    if isinstance(token, str) and token.startswith("private-uploads/"):
        try:
            _storage_delete(token)
        except Exception:
            pass
    _rest("DELETE", "predictions", "id=eq." + urlparse.quote(record_id))
    return True


def clear_predictions(owner_uid: str) -> int:
    rows = list_predictions(owner_uid)
    for row in rows:
        delete_prediction(str(row["id"]), owner_uid)
    return len(rows)


# ---------------------------------------------------------------------------
# Feedback
# ---------------------------------------------------------------------------

def submit_feedback(
    prediction: dict[str, Any], confirmed_fabric: str, was_correct: bool
) -> dict[str, Any]:
    feedback_id = uuid.uuid4().hex
    source_path = str(prediction["image_token"])
    filename = f"user_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}_{feedback_id[:6]}.jpg"
    pending_path = f"feedback-pending/{confirmed_fabric}/{filename}"
    _storage_copy(source_path, pending_path)
    created = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    feedback = {
        "id": feedback_id,
        "prediction_id": str(prediction["id"]),
        "owner_uid": prediction["owner_uid"],
        "original_fabric": prediction.get("fabric"),
        "confirmed_fabric": confirmed_fabric,
        "was_correct": was_correct,
        "review_status": "pending",
        "storage_path": pending_path,
        "storage_provider": "supabase",
        "filename": filename,
        "created_at": created,
    }
    user_feedback = {
        "feedback_id": feedback_id,
        "confirmed_fabric": confirmed_fabric,
        "was_correct": was_correct,
        "saved_to_dataset": False,
        "review_status": "pending",
        "timestamp": created,
    }
    try:
        _rest("POST", "feedback", "", {
            "id": feedback_id,
            "owner_uid": prediction["owner_uid"],
            "review_status": "pending",
            "created_at": created,
            "data": feedback,
        })
        row = _row("predictions", str(prediction["id"]))
        rec = _record(row)
        if rec is not None:
            rec["user_feedback"] = user_feedback
            _rest("PATCH", "predictions", "id=eq." + urlparse.quote(str(prediction["id"])), {"data": rec})
    except Exception:
        try:
            _storage_delete(pending_path)
        except Exception:
            pass
        raise
    return feedback


def list_feedback(status_filter: str = "pending") -> list[dict[str, Any]]:
    query = "order=created_at.desc"
    if status_filter:
        query = "review_status=eq." + urlparse.quote(status_filter) + "&" + query
    rows = _rest("GET", "feedback", query) or []
    return [_record(row) for row in rows if _record(row) is not None]


def feedback_image(feedback_id: str) -> bytes | None:
    rec = _record(_row("feedback", feedback_id))
    if rec is None or not rec.get("storage_path"):
        return None
    return _storage_download(str(rec["storage_path"]))


def review_feedback(feedback_id: str, reviewer_uid: str, approved: bool) -> dict[str, Any] | None:
    rec = _record(_row("feedback", feedback_id))
    if rec is None or rec.get("review_status") != "pending":
        return None
    approved_path = None
    if approved:
        approved_path = f"training-approved/{rec['confirmed_fabric']}/{rec['filename']}"
        _storage_copy(str(rec["storage_path"]), approved_path)
        rec["approved_storage_path"] = approved_path
    reviewed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    rec.update({
        "review_status": "approved" if approved else "rejected",
        "reviewed_by": reviewer_uid,
        "reviewed_at": reviewed_at,
    })
    prediction = get_prediction(str(rec["prediction_id"]))
    user_feedback = (prediction or {}).get("user_feedback") or {}
    user_feedback.update({
        "review_status": rec["review_status"],
        "saved_to_dataset": approved,
        "reviewed_at": reviewed_at,
    })
    try:
        _rest("PATCH", "feedback", "id=eq." + urlparse.quote(feedback_id), {
            "review_status": rec["review_status"],
            "data": rec,
        })
        if prediction:
            prediction["user_feedback"] = user_feedback
            _rest("PATCH", "predictions", "id=eq." + urlparse.quote(str(rec["prediction_id"])), {"data": prediction})
        _rest("POST", "audit_events", "", {
            "id": uuid.uuid4().hex,
            "created_at": reviewed_at,
            "data": {
                "action": "feedback_approved" if approved else "feedback_rejected",
                "feedback_id": feedback_id,
                "admin_uid": reviewer_uid,
                "created_at": reviewed_at,
            },
        })
    except Exception:
        if approved_path:
            try:
                _storage_delete(approved_path)
            except Exception:
                pass
        raise
    try:
        _storage_delete(str(rec["storage_path"]))
    except Exception:
        pass
    return rec


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------

def create_audit_event(event: dict[str, Any]) -> str:
    event_id = uuid.uuid4().hex
    payload = {
        "action": str(event["action"]),
        "admin_uid": str(event["admin_uid"]),
        "target_uid": str(event["target_uid"]) if event.get("target_uid") else None,
        "metadata": event.get("metadata") or {},
        "created_at": event["created_at"],
    }
    _rest("POST", "audit_events", "", {
        "id": event_id,
        "created_at": str(event["created_at"]),
        "data": payload,
    })
    return event_id


def list_audit_events(limit: int = 100, offset: int = 0) -> list[dict[str, Any]]:
    rows = _rest(
        "GET", "audit_events",
        f"order=created_at.desc&limit={limit}&offset={offset}",
    ) or []
    return [_record(row) for row in rows if _record(row) is not None]


def count_audit_events() -> int:
    rows = _rest("GET", "audit_events", "select=id") or []
    return len(rows) if isinstance(rows, list) else 0


def approved_counts() -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in list_feedback("approved"):
        label = str(item.get("confirmed_fabric", ""))
        counts[label] = counts.get(label, 0) + 1
    return counts


def status(probe: bool = False) -> dict[str, Any]:
    state: dict[str, Any] = {
        "backend": "supabase" if enabled() else "local",
        "configured": configured(),
        "database": "postgres" if enabled() else "sqlite",
        "image_storage": "supabase-storage" if enabled() else "local-filesystem",
        "selection": _value("PERSISTENCE_BACKEND").lower() or "auto",
    }
    if probe and configured():
        db_ok = False
        storage_ok = False
        try:
            _rest("GET", "predictions", "limit=1")
            db_ok = True
        except Exception:
            pass
        try:
            _storage("GET", f"bucket/{_value('SUPABASE_BUCKET')}")
            storage_ok = True
        except Exception:
            pass
        state["database_reachable"] = db_ok
        state["storage_reachable"] = storage_ok
        state["reachable"] = db_ok
        if not db_ok:
            state["error"] = "supabase_unreachable"
        elif not storage_ok:
            state["storage_warning"] = "storage_bucket_unavailable"
    return state
