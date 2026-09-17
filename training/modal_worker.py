"""Secure, asynchronous Modal GPU worker for LaundryAI model training.

Deploy from the repository root with:
    modal deploy training/modal_worker.py

The public endpoint only schedules work. Training runs in a separate T4-backed
Function and reports completion to the callback URL configured in a Modal Secret.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import modal
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field, field_validator


APP_NAME = "laundryai-training"
VOLUME_NAME = "laundryai-training-artifacts"
ARTIFACT_ROOT_MOUNT = "/artifacts"
TRAIN_SCRIPT_IN_IMAGE = "/opt/laundryai/train.py"
JOB_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")

repository_root = Path(__file__).resolve().parents[1]
training_script = repository_root / "backend" / "scripts" / "train.py"
if not training_script.is_file():
    raise RuntimeError(f"Training script not found: {training_script}")

web_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "fastapi>=0.115,<1",
    "pydantic>=2.9,<3",
)
training_image = (
    web_image
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ca-certificates")
    .pip_install(
        "pillow>=10,<13",
        "torch>=2.4,<3",
        "torchvision>=0.19,<1",
    )
    .add_local_file(str(training_script), TRAIN_SCRIPT_IN_IMAGE, copy=True)
)

app = modal.App(APP_NAME)
artifact_volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)
api_secret = modal.Secret.from_name("laundryai-training-api")
runtime_secret = modal.Secret.from_name("laundryai-training-runtime")
bearer_scheme = HTTPBearer(auto_error=False)


class DatasetReference(BaseModel):
    """Credential-free reference to a ZIP or TAR archive."""

    url: str = Field(description="HTTPS archive URL without embedded credentials")
    sha256: str = Field(description="Expected lowercase SHA-256 of the archive")
    archive: Literal["zip", "tar.gz", "tgz"] = "zip"

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname:
            raise ValueError("dataset URL must use HTTPS")
        if parsed.username or parsed.password:
            raise ValueError("credentials must not be embedded in the dataset URL")
        if parsed.fragment:
            raise ValueError("dataset URL fragments are not accepted")
        return value

    @field_validator("sha256")
    @classmethod
    def validate_sha256(cls, value: str) -> str:
        normalized = value.lower()
        if not SHA256_RE.fullmatch(normalized):
            raise ValueError("sha256 must contain exactly 64 hexadecimal characters")
        return normalized


class TrainingJob(BaseModel):
    job_id: str = Field(min_length=1, max_length=80)
    dataset: DatasetReference
    epochs: int = Field(default=20, ge=1, le=100)
    freeze_epochs: int = Field(default=3, ge=0, le=25)
    batch_size: int = Field(default=32, ge=1, le=256)
    learning_rate: float = Field(default=2e-4, gt=0, le=0.1)
    patience: int = Field(default=6, ge=1, le=30)
    seed: int = Field(default=42, ge=0, le=2_147_483_647)

    @field_validator("job_id")
    @classmethod
    def validate_job_id(cls, value: str) -> str:
        if not JOB_ID_RE.fullmatch(value):
            raise ValueError("job_id may only contain letters, numbers, dots, underscores, and hyphens")
        return value


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _require_bearer(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> None:
    expected = os.environ.get("WORKER_API_TOKEN", "")
    supplied = credentials.credentials if credentials else ""
    if not expected or not hmac.compare_digest(supplied, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )


def _allowed_dataset_host(url: str) -> None:
    hostname = (urllib.parse.urlsplit(url).hostname or "").lower().rstrip(".")
    configured = {
        item.strip().lower().rstrip(".")
        for item in os.environ.get("DATASET_ALLOWED_HOSTS", "").split(",")
        if item.strip()
    }
    if not configured:
        raise RuntimeError("DATASET_ALLOWED_HOSTS is not configured")
    if hostname not in configured:
        raise ValueError("dataset host is not allowed")


def _download_dataset(reference: dict, destination: Path) -> None:
    url = str(reference["url"])
    _allowed_dataset_host(url)
    headers = {"User-Agent": "LaundryAI-Modal-Trainer/1.0", "Accept": "application/octet-stream"}
    dataset_token = os.environ.get("DATASET_BEARER_TOKEN", "")
    if dataset_token:
        headers["Authorization"] = f"Bearer {dataset_token}"

    maximum_bytes = int(os.environ.get("MAX_DATASET_BYTES", str(8 * 1024**3)))
    digest = hashlib.sha256()
    downloaded = 0
    request = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as output:
        declared = response.headers.get("Content-Length")
        if declared and int(declared) > maximum_bytes:
            raise ValueError("dataset exceeds MAX_DATASET_BYTES")
        while chunk := response.read(1024 * 1024):
            downloaded += len(chunk)
            if downloaded > maximum_bytes:
                raise ValueError("dataset exceeds MAX_DATASET_BYTES")
            digest.update(chunk)
            output.write(chunk)

    if not hmac.compare_digest(digest.hexdigest(), str(reference["sha256"])):
        destination.unlink(missing_ok=True)
        raise ValueError("dataset SHA-256 verification failed")


def _safe_member_path(root: Path, member_name: str) -> Path:
    target = (root / member_name).resolve()
    if target != root and root not in target.parents:
        raise ValueError("dataset archive contains an unsafe path")
    return target


def _extract_dataset(archive_path: Path, archive_type: str, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    if archive_type == "zip":
        with zipfile.ZipFile(archive_path) as archive:
            for member in archive.infolist():
                _safe_member_path(root, member.filename)
                # Unix symlinks are represented in the high mode bits.
                if (member.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError("dataset ZIP must not contain symbolic links")
            archive.extractall(root)
        return

    with tarfile.open(archive_path, mode="r:gz") as archive:
        members = archive.getmembers()
        for member in members:
            _safe_member_path(root, member.name)
            if member.issym() or member.islnk() or member.isdev():
                raise ValueError("dataset TAR must not contain links or device files")
        archive.extractall(root, members=members)


def _find_dataset_root(extracted: Path) -> Path:
    candidates = [extracted, *(path for path in extracted.rglob("*") if path.is_dir())]
    matches = [path for path in candidates if all((path / split).is_dir() for split in ("train", "val", "test"))]
    if len(matches) != 1:
        raise ValueError("dataset archive must contain exactly one train/val/test ImageFolder root")
    return matches[0]


def _signed_callback(event: dict) -> None:
    callback_url = os.environ.get("CALLBACK_URL", "")
    signing_secret = os.environ.get("CALLBACK_SIGNING_SECRET", "")
    if not callback_url or not signing_secret:
        raise RuntimeError("CALLBACK_URL and CALLBACK_SIGNING_SECRET must be configured")
    parsed = urllib.parse.urlsplit(callback_url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("CALLBACK_URL must be a credential-free HTTPS URL")

    timestamp = str(int(time.time()))
    body = json.dumps(event, separators=(",", ":"), sort_keys=True).encode("utf-8")
    signature = hmac.new(
        signing_secret.encode("utf-8"), timestamp.encode("ascii") + b"." + body, hashlib.sha256
    ).hexdigest()
    request = urllib.request.Request(
        callback_url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "LaundryAI-Modal-Trainer/1.0",
            "X-LaundryAI-Timestamp": timestamp,
            "X-LaundryAI-Signature": f"v1={signature}",
            "X-LaundryAI-Event-ID": str(event["event_id"]),
        },
        method="POST",
    )
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                if 200 <= response.status < 300:
                    return
                raise RuntimeError(f"callback returned HTTP {response.status}")
        except (urllib.error.URLError, TimeoutError, RuntimeError) as exc:
            last_error = exc
            if attempt < 3:
                time.sleep(2**attempt)
    raise RuntimeError("signed callback delivery failed") from last_error


@app.function(
    image=training_image,
    gpu="T4",
    cpu=4,
    memory=16384,
    timeout=6 * 60 * 60,
    secrets=[runtime_secret],
    volumes={ARTIFACT_ROOT_MOUNT: artifact_volume},
)
def train_on_t4(job_payload: dict) -> dict:
    """Download, verify, train, persist candidate artifacts, and notify the backend."""

    job = TrainingJob.model_validate(job_payload)
    artifact_root = Path(ARTIFACT_ROOT_MOUNT)
    job_dir = artifact_root / "jobs" / job.job_id
    work_dir = Path("/tmp/laundryai") / job.job_id
    candidate_dir = job_dir / "candidate"
    event_id = f"training.{job.job_id}"
    started_at = _utc_now()

    if job_dir.exists():
        raise RuntimeError("job_id already exists; use a unique id for every training attempt")
    candidate_dir.mkdir(parents=True, exist_ok=False)
    work_dir.mkdir(parents=True, exist_ok=False)
    artifact_volume.commit()

    result: dict = {
        "event_id": event_id,
        "event_type": "training.failed",
        "job_id": job.job_id,
        "status": "failed",
        "started_at": started_at,
    }
    try:
        archive_suffix = ".zip" if job.dataset.archive == "zip" else ".tar.gz"
        archive_path = work_dir / f"dataset{archive_suffix}"
        extracted_path = work_dir / "dataset"
        _download_dataset(job.dataset.model_dump(), archive_path)
        _extract_dataset(archive_path, job.dataset.archive, extracted_path)
        dataset_root = _find_dataset_root(extracted_path)

        model_path = candidate_dir / "fabric_mobilenetv2.pt"
        log_path = candidate_dir / "training.log"
        command = [
            sys.executable,
            TRAIN_SCRIPT_IN_IMAGE,
            "--data",
            str(dataset_root),
            "--epochs",
            str(job.epochs),
            "--freeze-epochs",
            str(job.freeze_epochs),
            "--batch-size",
            str(job.batch_size),
            "--lr",
            str(job.learning_rate),
            "--seed",
            str(job.seed),
            "--patience",
            str(job.patience),
            "--output",
            str(model_path),
        ]
        with log_path.open("w", encoding="utf-8") as log:
            subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=5.5 * 60 * 60)

        manifest_path = model_path.with_suffix(".manifest.json")
        if not model_path.is_file() or not manifest_path.is_file():
            raise RuntimeError("training completed without producing candidate artifacts")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        result.update(
            {
                "event_type": "training.completed",
                "status": "completed",
                "completed_at": _utc_now(),
                "candidate": {
                    "volume": VOLUME_NAME,
                    "model_path": str(model_path.relative_to(artifact_root)),
                    "manifest_path": str(manifest_path.relative_to(artifact_root)),
                    "sha256": hashlib.sha256(model_path.read_bytes()).hexdigest(),
                    "model_version": manifest.get("model_version"),
                    "metrics": {
                        "val_accuracy": manifest.get("val_accuracy"),
                        "test_accuracy": manifest.get("test_accuracy"),
                        "macro_f1": manifest.get("macro_f1"),
                    },
                },
            }
        )
    except Exception as exc:
        result.update(
            {
                "completed_at": _utc_now(),
                "error": {"type": type(exc).__name__, "message": str(exc)[:500]},
            }
        )
    finally:
        (candidate_dir / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        artifact_volume.commit()
        shutil.rmtree(work_dir, ignore_errors=True)

    # Preserve the result before attempting delivery. A failed callback never
    # destroys the candidate and is visible in result.json for recovery.
    _signed_callback(result)
    if result["status"] != "completed":
        raise RuntimeError(f"training job {job.job_id} failed")
    return result


@app.function(image=web_image, secrets=[api_secret])
@modal.fastapi_endpoint(method="POST", docs=True)
async def submit_training(
    job: TrainingJob,
    request: Request,
    _: None = Depends(_require_bearer),
) -> dict:
    """Authorize and asynchronously schedule a T4 training job."""

    call = train_on_t4.spawn(job.model_dump(mode="json"))
    return {
        "accepted": True,
        "job_id": job.job_id,
        "call_id": call.object_id,
        "status": "queued",
    }
