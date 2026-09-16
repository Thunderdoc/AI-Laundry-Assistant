"""Durable Firebase persistence for LaundryAI.

The web API uses this repository only when PERSISTENCE_BACKEND=firebase.
SQLite and the local filesystem remain available for local development/tests.
"""
from __future__ import annotations

import base64
import binascii
import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any


def _value(name: str) -> str:
    return os.getenv(name, "").strip()


def _credential_present() -> bool:
    return bool(
        _value("FIREBASE_SERVICE_ACCOUNT_JSON_B64")
        or _value("FIREBASE_SERVICE_ACCOUNT_JSON")
        or _value("FIREBASE_SERVICE_ACCOUNT_FILE")
    )


def service_account_credential() -> dict[str, Any] | str:
    """Load a Firebase credential without logging or returning secret data.

    A one-line Base64 value is preferred on hosting dashboards because it
    avoids multiline JSON/private-key escaping problems.
    """
    encoded = _value("FIREBASE_SERVICE_ACCOUNT_JSON_B64")
    raw_json = _value("FIREBASE_SERVICE_ACCOUNT_JSON")
    account_file = _value("FIREBASE_SERVICE_ACCOUNT_FILE")
    try:
        if encoded:
            raw_json = base64.b64decode(encoded, validate=True).decode("utf-8")
        if raw_json:
            payload = json.loads(raw_json)
            # Gracefully handle a JSON object that was accidentally encoded as
            # a JSON string, while still rejecting Python/single-quoted dicts.
            if isinstance(payload, str):
                payload = json.loads(payload)
            if not isinstance(payload, dict) or payload.get("type") != "service_account":
                raise ValueError("credential is not a Firebase service-account JSON object")
            required = {"project_id", "private_key", "client_email"}
            missing = sorted(required - payload.keys())
            if missing:
                raise ValueError(f"credential is missing required fields: {', '.join(missing)}")
            return payload
    except (binascii.Error, UnicodeDecodeError) as exc:
        raise ValueError("FIREBASE_SERVICE_ACCOUNT_JSON_B64 is not valid Base64-encoded UTF-8") from exc
    except json.JSONDecodeError as exc:
        source = "FIREBASE_SERVICE_ACCOUNT_JSON_B64" if encoded else "FIREBASE_SERVICE_ACCOUNT_JSON"
        raise ValueError(f"{source} does not contain valid JSON") from exc
    if account_file:
        return account_file
    raise ValueError("Firebase service-account credential is missing")


def enabled() -> bool:
    mode = _value("PERSISTENCE_BACKEND").lower()
    if mode:
        return mode == "firebase"
    # Production-safe auto mode: if every Firebase server setting exists, use
    # durable storage instead of silently writing to Render's ephemeral disk.
    return bool(
        _value("FIREBASE_DATABASE_URL")
        and _value("FIREBASE_STORAGE_BUCKET")
        and _credential_present()
    )


def configured() -> bool:
    return bool(
        enabled()
        and _value("FIREBASE_DATABASE_URL")
        and _value("FIREBASE_STORAGE_BUCKET")
        and _credential_present()
    )


def _app():
    if not configured():
        raise RuntimeError(
            "Firebase persistence requires FIREBASE_DATABASE_URL, "
            "FIREBASE_STORAGE_BUCKET, and a service-account credential."
        )
    import firebase_admin
    from firebase_admin import credentials

    if firebase_admin._apps:
        return firebase_admin.get_app()
    credential = credentials.Certificate(service_account_credential())
    return firebase_admin.initialize_app(credential)


def _root(path: str):
    from firebase_admin import db

    return db.reference(path, app=_app(), url=_value("FIREBASE_DATABASE_URL"))


def _bucket():
    from firebase_admin import storage

    return storage.bucket(name=_value("FIREBASE_STORAGE_BUCKET"), app=_app())


def status(probe: bool = False) -> dict[str, Any]:
    requirements = {
        "FIREBASE_DATABASE_URL": bool(_value("FIREBASE_DATABASE_URL")),
        "FIREBASE_STORAGE_BUCKET": bool(_value("FIREBASE_STORAGE_BUCKET")),
        "FIREBASE_SERVICE_ACCOUNT": _credential_present(),
    }
    state: dict[str, Any] = {
        "backend": "firebase" if enabled() else "local",
        "configured": configured() if enabled() else True,
        "database": "realtime-database" if enabled() else "sqlite",
        "image_storage": "firebase-storage" if enabled() else "local-filesystem",
        "selection": _value("PERSISTENCE_BACKEND").lower() or "auto",
    }
    if enabled():
        state["credential_source"] = (
            "base64-json" if _value("FIREBASE_SERVICE_ACCOUNT_JSON_B64")
            else "raw-json" if _value("FIREBASE_SERVICE_ACCOUNT_JSON")
            else "file" if _value("FIREBASE_SERVICE_ACCOUNT_FILE")
            else "none"
        )
    if enabled() and not state["configured"]:
        state["firebase_missing"] = [name for name, present in requirements.items() if not present]
    elif not enabled():
        state["firebase_missing"] = [name for name, present in requirements.items() if not present]
    if probe and enabled() and state["configured"]:
        try:
            _root("system/persistenceProbe").get()
            if not _bucket().exists():
                raise RuntimeError("Configured Firebase Storage bucket does not exist.")
            state["reachable"] = True
        except Exception as exc:
            state["reachable"] = False
            state["error"] = type(exc).__name__
    return state


def training_export_reference() -> dict[str, Any]:
    """Return a non-secret pointer an authorized GPU worker can resolve.

    The worker receives its own least-privilege cloud credentials; the API
    never sends the Firebase service-account private key in a job payload.
    """
    if configured():
        return {
            "provider": "firebase-storage",
            "bucket": _value("FIREBASE_STORAGE_BUCKET"),
            "prefix": "training-approved/",
            "portable": True,
        }
    # Do not disclose an absolute server filesystem path. An external worker
    # cannot resolve Render's ephemeral local disk anyway.
    return {"provider": "local", "path": "data", "portable": False}


def create_prediction(owner_uid: str, record: dict[str, Any], jpeg: bytes) -> dict[str, Any]:
    record_id = uuid.uuid4().hex
    storage_path = f"private-uploads/{owner_uid}/{record_id}.jpg"
    blob = _bucket().blob(storage_path)
    blob.upload_from_string(jpeg, content_type="image/jpeg")
    saved = {**record, "id": record_id, "image_token": storage_path, "owner_uid": owner_uid}
    try:
        _root(f"predictions/{record_id}").set(saved)
    except Exception:
        try:
            blob.delete()
        except Exception:
            pass
        raise
    return saved


def list_predictions(owner_uid: str | None = None) -> list[dict[str, Any]]:
    values = _root("predictions").get() or {}
    rows = list(values.values()) if isinstance(values, dict) else []
    if owner_uid is not None:
        rows = [row for row in rows if row.get("owner_uid") == owner_uid]
    return sorted(rows, key=lambda row: row.get("created_at", ""), reverse=True)


def get_prediction(record_id: str, owner_uid: str | None = None) -> dict[str, Any] | None:
    row = _root(f"predictions/{record_id}").get()
    if not isinstance(row, dict):
        return None
    if owner_uid is not None and row.get("owner_uid") != owner_uid:
        return None
    return row


def update_prediction(record_id: str, owner_uid: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    row = get_prediction(record_id, owner_uid)
    if not row:
        return None
    row.update(updates)
    _root(f"predictions/{record_id}").set(row)
    return row


def delete_prediction(record_id: str, owner_uid: str) -> bool:
    row = get_prediction(record_id, owner_uid)
    if not row:
        return False
    token = row.get("image_token")
    if isinstance(token, str) and token.startswith("private-uploads/"):
        try:
            _bucket().blob(token).delete()
        except Exception:
            pass
    _root(f"predictions/{record_id}").delete()
    return True


def clear_predictions(owner_uid: str) -> int:
    rows = list_predictions(owner_uid)
    for row in rows:
        delete_prediction(str(row["id"]), owner_uid)
    return len(rows)


def submit_feedback(
    prediction: dict[str, Any], confirmed_fabric: str, was_correct: bool
) -> dict[str, Any]:
    feedback_id = uuid.uuid4().hex
    source_path = str(prediction["image_token"])
    filename = f"user_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}_{feedback_id[:6]}.jpg"
    pending_path = f"feedback-pending/{confirmed_fabric}/{filename}"
    bucket = _bucket()
    bucket.copy_blob(bucket.blob(source_path), bucket, pending_path)
    feedback = {
        "id": feedback_id,
        "prediction_id": str(prediction["id"]),
        "owner_uid": prediction["owner_uid"],
        "original_fabric": prediction.get("fabric"),
        "confirmed_fabric": confirmed_fabric,
        "was_correct": was_correct,
        "review_status": "pending",
        "storage_path": pending_path,
        "filename": filename,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    user_feedback = {
        "feedback_id": feedback_id,
        "confirmed_fabric": confirmed_fabric,
        "was_correct": was_correct,
        "saved_to_dataset": False,
        "review_status": "pending",
        "timestamp": feedback["created_at"],
    }
    try:
        _root("/").update({
            f"feedback/{feedback_id}": feedback,
            f"predictions/{prediction['id']}/user_feedback": user_feedback,
        })
    except Exception:
        try:
            bucket.blob(pending_path).delete()
        except Exception:
            pass
        raise
    return feedback


def list_feedback(status_filter: str = "pending") -> list[dict[str, Any]]:
    values = _root("feedback").get() or {}
    rows = list(values.values()) if isinstance(values, dict) else []
    if status_filter:
        rows = [row for row in rows if row.get("review_status") == status_filter]
    return sorted(rows, key=lambda row: row.get("created_at", ""))


def feedback_image(feedback_id: str) -> bytes | None:
    item = _root(f"feedback/{feedback_id}").get()
    if not isinstance(item, dict) or not item.get("storage_path"):
        return None
    return _bucket().blob(item["storage_path"]).download_as_bytes()


def review_feedback(feedback_id: str, reviewer_uid: str, approved: bool) -> dict[str, Any] | None:
    item = _root(f"feedback/{feedback_id}").get()
    if not isinstance(item, dict) or item.get("review_status") != "pending":
        return None
    bucket = _bucket()
    source = bucket.blob(item["storage_path"])
    approved_blob = None
    if approved:
        approved_path = f"training-approved/{item['confirmed_fabric']}/{item['filename']}"
        approved_blob = bucket.copy_blob(source, bucket, approved_path)
        item["approved_storage_path"] = approved_path
    item.update({
        "review_status": "approved" if approved else "rejected",
        "reviewed_by": reviewer_uid,
        "reviewed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    })
    prediction = get_prediction(str(item["prediction_id"]))
    user_feedback = (prediction or {}).get("user_feedback") or {}
    user_feedback.update({
        "review_status": item["review_status"],
        "saved_to_dataset": approved,
        "reviewed_at": item["reviewed_at"],
    })
    audit_id=uuid.uuid4().hex
    audit = {
        "action": "feedback_approved" if approved else "feedback_rejected",
        "feedback_id": feedback_id,
        "admin_uid": reviewer_uid,
        "created_at": item["reviewed_at"],
    }
    updates = {f"feedback/{feedback_id}": item, f"auditEvents/{audit_id}": audit}
    if prediction:
        updates[f"predictions/{item['prediction_id']}/user_feedback"] = user_feedback
    try:
        _root("/").update(updates)
    except Exception:
        if approved_blob:
            try:
                approved_blob.delete()
            except Exception:
                pass
        raise
    try:
        source.delete()
    except Exception:
        pass
    return item


def approved_counts() -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in list_feedback("approved"):
        label = str(item.get("confirmed_fabric", ""))
        counts[label] = counts.get(label, 0) + 1
    return counts
