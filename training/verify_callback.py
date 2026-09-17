"""Framework-neutral verification helper for Modal training callbacks."""

from __future__ import annotations

import hashlib
import hmac
import time


def verify_training_callback(
    body: bytes,
    timestamp: str,
    signature_header: str,
    signing_secret: str,
    *,
    tolerance_seconds: int = 300,
) -> bool:
    """Return True only for a fresh callback with a valid v1 HMAC signature."""

    try:
        sent_at = int(timestamp)
    except (TypeError, ValueError):
        return False
    if abs(int(time.time()) - sent_at) > tolerance_seconds:
        return False
    if not signature_header.startswith("v1="):
        return False
    expected = hmac.new(
        signing_secret.encode("utf-8"), timestamp.encode("ascii") + b"." + body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature_header[3:], expected)

