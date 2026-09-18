import csv, io, json, os, shutil, sqlite3, threading, time, uuid, warnings
from urllib import request as urlrequest
from urllib.parse import urlsplit, urlunsplit
from collections import defaultdict, deque
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Literal, Optional
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Body, Response, Request
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
from PIL import Image, ImageStat
from .knowledge_base import FABRICS, recommendation
from . import firebase_store

load_dotenv(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".env")))
app = FastAPI(title="LaundryAI API", version="0.1.0", description="Experimental fabric-care service. Predictions require an exported trained model.")
configured_origins={origin.strip().rstrip("/") for origin in os.getenv("CORS_ORIGINS", "").split(",") if origin.strip()}
known_origins={
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://ai-laundry-assistant-thunderdoc.vercel.app",
    "https://ai-laundry-assistant-psi.vercel.app",
}
app.add_middleware(CORSMiddleware, allow_origins=sorted(configured_origins | known_origins), allow_methods=["*"], allow_headers=["*"], allow_credentials=True)
Image.MAX_IMAGE_PIXELS=20_000_000

_rate_events: dict[str, deque[float]] = defaultdict(deque)
_rate_lock=threading.Lock()

def _rate_rule(request: Request):
    path=request.url.path
    if request.method=="POST" and path.startswith("/api/auth/"): return 20,60
    if request.method=="POST" and path in {"/api/predict","/api/feedback"}: return 30,60
    if request.method in {"POST","PATCH","DELETE"} and path.startswith("/api/admin/"): return 60,60
    return None

@app.middleware("http")
async def security_controls(request: Request, call_next):
    rule=_rate_rule(request)
    if rule:
        limit,window=rule
        address=(request.headers.get("x-forwarded-for","").split(",")[-1].strip() or (request.client.host if request.client else "unknown"))
        key=f"{address}:{request.method}:{request.url.path}"
        now=time.monotonic()
        with _rate_lock:
            events=_rate_events[key]
            while events and events[0] <= now-window: events.popleft()
            if len(events)>=limit:
                return Response(status_code=429,content='{"detail":"Too many requests. Try again shortly."}',media_type="application/json",headers={"Retry-After":str(window)})
            events.append(now)
    response=await call_next(request)
    response.headers["X-Content-Type-Options"]="nosniff"
    response.headers["X-Frame-Options"]="DENY"
    response.headers["Referrer-Policy"]="strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"]="camera=(self), microphone=(), geolocation=()"
    response.headers["Cache-Control"]="no-store" if request.url.path.startswith("/api/") else response.headers.get("Cache-Control","no-cache")
    return response

FIREBASE_CONFIG = {
    "apiKey": os.getenv("FIREBASE_API_KEY", "").strip(),
    "authDomain": os.getenv("FIREBASE_AUTH_DOMAIN", "").strip(),
    "projectId": os.getenv("FIREBASE_PROJECT_ID", "").strip(),
    "storageBucket": os.getenv("FIREBASE_STORAGE_BUCKET", "").strip(),
    "messagingSenderId": os.getenv("FIREBASE_MESSAGING_SENDER_ID", "").strip(),
    "appId": os.getenv("FIREBASE_APP_ID", "").strip(),
}
ADMIN_EMAILS = {email.strip().lower() for email in os.getenv("ADMIN_EMAILS", "").split(",") if email.strip()}

class FirebaseCredential(BaseModel):
    id_token: str

class AdminRoleUpdate(BaseModel):
    is_admin: bool

class UserStatusUpdate(BaseModel):
    disabled: bool

class TrainingCallback(BaseModel):
    status: Literal["queued", "running", "completed", "failed"]
    message: str = Field(default="", max_length=500)
    job_id: Optional[str] = Field(default=None, max_length=160)
    candidate_url: Optional[str] = Field(default=None, max_length=2000)
    metrics: Optional[dict] = None

FIREBASE_CERTIFICATES_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"
CERTIFICATE_TTL_SECONDS = 3600
CERTIFICATE_MIN_TTL_SECONDS = 300
CERTIFICATE_MAX_TTL_SECONDS = 21600
_certificate_lock = threading.Lock()
_certificate_cache: dict = {"certificates": {}, "expires_at": 0.0}

def firebase_auth_enabled() -> bool:
    """Token verification needs the Firebase project identity, not a private key."""
    return all(FIREBASE_CONFIG[key] for key in ("apiKey", "authDomain", "projectId", "appId"))

def firebase_token_issuer() -> str:
    return f"https://securetoken.google.com/{FIREBASE_CONFIG['projectId']}"

def _certificate_ttl(response) -> int:
    """Honour Google's Cache-Control max-age so signing-key rotations still arrive."""
    ttl = CERTIFICATE_TTL_SECONDS
    for directive in (response.headers.get("Cache-Control") or "").split(","):
        directive = directive.strip()
        if directive.startswith("max-age="):
            try:
                ttl = int(directive.split("=", 1)[1])
            except ValueError:
                ttl = CERTIFICATE_TTL_SECONDS
    return min(max(ttl, CERTIFICATE_MIN_TTL_SECONDS), CERTIFICATE_MAX_TTL_SECONDS)

def google_signing_certificates(force: bool = False) -> dict:
    """Return Google's Firebase signing certificates, cached in memory.

    google-auth re-fetches these certificates on *every* verification, so a slow,
    blocked, or rate-limited certificate endpoint used to turn every authenticated
    API request into a 503 immediately after a successful browser sign-in. The
    documents are public keys, so they are fetched once per cache lifetime and
    refreshed when Google rotates a key or the cached lifetime expires.
    """
    with _certificate_lock:
        certificates = _certificate_cache["certificates"]
        if certificates and not force and time.monotonic() < _certificate_cache["expires_at"]:
            return certificates
    request = urlrequest.Request(
        FIREBASE_CERTIFICATES_URL,
        headers={"User-Agent": "LaundryAI-API/0.1", "Cache-Control": "no-cache"},
    )
    with urlrequest.urlopen(request, timeout=8) as response:
        document = json.loads(response.read().decode("utf-8"))
        ttl = _certificate_ttl(response)
    if not isinstance(document, dict) or not document:
        raise ValueError("Google returned an unexpected certificate document.")
    with _certificate_lock:
        _certificate_cache["certificates"] = document
        _certificate_cache["expires_at"] = time.monotonic() + ttl
    return document

def certificates_or_unavailable(force: bool = False) -> dict:
    try:
        return google_signing_certificates(force=force)
    except Exception as exc:
        raise HTTPException(503, "Firebase verification is temporarily unavailable.") from exc

def decode_firebase_claims(id_token: str, certificates: dict):
    """Verify the RS256 signature, expiry, and audience against cached certificates."""
    from google.auth import jwt as google_jwt
    return google_jwt.decode(id_token, certs=certificates, audience=FIREBASE_CONFIG["projectId"])

def verify_firebase_token(id_token: str):
    """Verify signature, issuer, audience, and expiry using Google's public certificates."""
    if not firebase_auth_enabled():
        raise HTTPException(503, "Firebase project configuration is missing on the server.")
    from google.auth import exceptions as google_exceptions
    try:
        try:
            claims = decode_firebase_claims(id_token, certificates_or_unavailable())
        except google_exceptions.MalformedError as rotated_key:
            if "key id" not in str(rotated_key):
                raise
            # Google rotated its signing keys: refresh the cache once and retry.
            claims = decode_firebase_claims(id_token, certificates_or_unavailable(force=True))
    except HTTPException:
        raise
    except Exception as exc:
        error_name=type(exc).__name__
        if error_name in {"ExpiredIdTokenError", "RevokedIdTokenError"} or "expired" in str(exc).lower():
            detail="Your sign-in session expired. Sign in again."
        elif error_name in {"MalformedError", "InvalidValue", "InvalidIdTokenError", "InvalidSessionCookieError", "ValueError"}:
            detail="Firebase returned an invalid sign-in token."
        else:
            detail=f"Firebase could not verify sign-in ({error_name})."
        raise HTTPException(401, detail) from exc
    if claims.get("iss") != firebase_token_issuer():
        raise HTTPException(401, "Firebase returned an invalid sign-in token.")
    # Firebase puts the account id in `sub`; the rest of the API (and every
    # stored record) reads `uid`, so without this every signed-in user shared
    # the same "local-preview" history bucket.
    uid = str(claims.get("sub") or claims.get("user_id") or "").strip()
    if not uid:
        raise HTTPException(401, "Firebase returned an invalid sign-in token.")
    return {**claims, "uid": uid}

def is_admin(user: dict | None) -> bool:
    return bool(
        user
        and user.get("email_verified") is True
        and (user.get("admin") is True or (user.get("email") or "").strip().lower() in ADMIN_EMAILS)
    )

def require_admin(request: Request) -> dict:
    if not firebase_auth_enabled():
        raise HTTPException(503, "Secure admin access requires Firebase project configuration.")
    user = getattr(request.state, "user", None)
    if not is_admin(user):
        raise HTTPException(403, "Administrator access is required.")
    return user

def firebase_admin_auth_client():
    import firebase_admin
    from firebase_admin import auth, credentials
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(firebase_store.service_account_credential()))
    return auth

@app.middleware("http")
async def require_firebase_auth(request: Request, call_next):
    path = request.url.path
    # GPU workers authenticate callbacks with the dedicated training token;
    # requiring an end-user Firebase token here would make callbacks impossible.
    public_api = {"/api/health", "/api/auth/config", "/api/auth/firebase", "/api/training/callback"}
    if request.method != "OPTIONS" and firebase_auth_enabled() and path.startswith("/api/") and path not in public_api:
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return Response(status_code=401, content='{"detail":"Sign in is required."}', media_type="application/json")
        try:
            request.state.user = verify_firebase_token(auth_header.removeprefix("Bearer ").strip())
        except HTTPException as exc:
            return Response(status_code=exc.status_code, content=json.dumps({"detail": exc.detail}), media_type="application/json")
    return await call_next(request)

DB_PATH=os.path.abspath(os.getenv("DATABASE_PATH", os.path.join(os.path.dirname(__file__), "..", "laundryai.db")))
DATA_DIR=os.path.abspath(os.getenv("DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "data")))
UPLOADS_DIR=os.path.join(DATA_DIR, "uploads")
os.makedirs(UPLOADS_DIR, exist_ok=True)

NON_FABRIC="non_fabric"

@contextmanager
def connection():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    try:
        db.execute("CREATE TABLE IF NOT EXISTS predictions (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_uid TEXT NOT NULL DEFAULT 'local-preview', created_at TEXT NOT NULL, fabric TEXT NOT NULL, confidence REAL NOT NULL, payload TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, admin_uid TEXT NOT NULL, target_uid TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)")
        columns={row[1] for row in db.execute("PRAGMA table_info(predictions)")}
        if "owner_uid" not in columns:
            db.execute("ALTER TABLE predictions ADD COLUMN owner_uid TEXT NOT NULL DEFAULT 'local-preview'")
        yield db
        db.commit()
    finally:
        db.close()

def record_audit(action: str, admin_uid: str, target_uid: str | None = None, metadata: dict | None = None) -> None:
    event = {
        "action": action,
        "admin_uid": str(admin_uid),
        "target_uid": str(target_uid) if target_uid else None,
        "metadata": metadata or {},
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if firebase_store.enabled():
        try:
            firebase_store.create_audit_event(event)
        except Exception as exc:
            raise HTTPException(503, "Could not write the administrator audit record.") from exc
        return
    with connection() as db:
        db.execute(
            "INSERT INTO audit_events (action,admin_uid,target_uid,metadata,created_at) VALUES (?,?,?,?,?)",
            (event["action"], event["admin_uid"], event["target_uid"], json.dumps(event["metadata"]), event["created_at"]),
        )

def audit_events(limit: int = 100, offset: int = 0) -> list[dict]:
    if firebase_store.enabled():
        try:
            return firebase_store.list_audit_events(limit=limit, offset=offset)
        except Exception as exc:
            raise HTTPException(503, "Cloud audit history is temporarily unavailable.") from exc
    with connection() as db:
        rows = db.execute(
            "SELECT action,admin_uid,target_uid,metadata,created_at FROM audit_events ORDER BY id DESC LIMIT ? OFFSET ?",
            (limit, offset),
        )
        result = []
        for row in rows:
            item = dict(row)
            item["metadata"] = json.loads(item["metadata"] or "{}")
            result.append(item)
        return result

def request_uid(request: Request) -> str:
    user = getattr(request.state, "user", None)
    return str(user.get("uid")) if user and user.get("uid") else "local-preview"

# Production scale: in Firebase mode every read pulls the entire predictions
# node, and the admin endpoints (overview + scans + analytics) do that several
# times on each console visit. A short-lived, write-invalidated cache collapses
# those repeated full fetches. SQLite (development) stays uncached because it is
# cheap locally and the test suite writes to it directly.
_HISTORY_CACHE_TTL_SECONDS = float(os.getenv("HISTORY_CACHE_TTL", "15"))
_RAW_HISTORY_CACHE: dict = {"rows": None, "expires_at": 0.0}

def _invalidate_history_cache() -> None:
    _RAW_HISTORY_CACHE["rows"] = None
    _RAW_HISTORY_CACHE["expires_at"] = 0.0

def _cached_firebase_history() -> list[dict]:
    now = time.monotonic()
    if _RAW_HISTORY_CACHE["rows"] is not None and now < _RAW_HISTORY_CACHE["expires_at"]:
        return _RAW_HISTORY_CACHE["rows"]
    if not firebase_store.configured():
        raise HTTPException(503, "Firebase persistence is selected but not fully configured.")
    try:
        rows = firebase_store.call_with_timeout(firebase_store.list_predictions)
    except Exception as exc:
        raise HTTPException(503, "Cloud database is temporarily unavailable.") from exc
    if _HISTORY_CACHE_TTL_SECONDS > 0:
        _RAW_HISTORY_CACHE["rows"] = rows
        _RAW_HISTORY_CACHE["expires_at"] = now + _HISTORY_CACHE_TTL_SECONDS
    return rows

def saved_history(owner_uid: str | None = None):
    if firebase_store.enabled():
        rows = _cached_firebase_history()
        if owner_uid is not None:
            rows = [row for row in rows if row.get("owner_uid") == owner_uid]
        return rows
    with connection() as db:
        if owner_uid is None:
            rows=db.execute("SELECT payload FROM predictions ORDER BY id DESC")
        else:
            rows=db.execute("SELECT payload FROM predictions WHERE owner_uid=? ORDER BY id DESC",(owner_uid,))
        return [json.loads(row["payload"]) for row in rows]

_default_model_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models", "fabric_mobilenetv2.pt"))
_bundled_model_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend", "models", "fabric_mobilenetv2.pt"))
# Development keeps the model under models/. The repository also bundles a tracked
# deploy copy under backend/models/ so cloud hosts receive the weights.
def resolve_model_path() -> str:
    configured = os.getenv("MODEL_PATH", "").strip()
    candidates = []
    if configured:
        candidates.append(os.path.abspath(configured))
        # Render runs this service with backend/ as its root directory. Accept a
        # repository-relative value as well, so either models/... or
        # backend/models/... works without silently disabling inference.
        candidates.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", configured)))
    candidates.extend((_default_model_path, _bundled_model_path))
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    return candidates[0] if candidates else _bundled_model_path

MODEL_PATH=resolve_model_path()
_MODEL = None
_MODEL_ERROR = None

def load_model():
    global _MODEL, _MODEL_ERROR
    if _MODEL is not None: return _MODEL
    if not os.path.isfile(MODEL_PATH):
        _MODEL_ERROR = f"Model file not found at {MODEL_PATH}"
        raise RuntimeError(_MODEL_ERROR)
    try:
        import torch
        torch.set_num_threads(max(1, int(os.getenv("TORCH_NUM_THREADS", "1"))))
        model=torch.jit.load(MODEL_PATH, map_location="cpu").eval()
        input_size, _, _ = preprocess_config()
        with torch.no_grad(): output=model(torch.zeros(1,3,input_size,input_size))
        if output.ndim != 2 or output.shape[1] != len(model_labels()):
            raise RuntimeError("Model output does not match the manifest classes.")
        _MODEL, _MODEL_ERROR = model, None
        return model
    except Exception as exc:
        _MODEL_ERROR = str(exc)
        raise

def model_status():
    try:
        load_model()
        return {"ready": True, "error": None, "path": os.path.basename(MODEL_PATH)}
    except Exception:
        return {"ready": False, "error": _MODEL_ERROR or "Model validation failed.", "path": os.path.basename(MODEL_PATH)}

def manifest_path(): return os.path.splitext(MODEL_PATH)[0] + ".manifest.json"

def load_manifest():
    path=manifest_path()
    if not os.path.exists(path): return {}
    try:
        with open(path, encoding="utf-8") as f: return json.load(f)
    except Exception: return {}

def model_labels():
    classes=load_manifest().get("classes")
    if isinstance(classes, list):
        allowed={*FABRICS.keys(), NON_FABRIC}
        ordered=[c for c in classes if c in allowed]
        if set(FABRICS).issubset(set(ordered)):
            return ordered
    return list(FABRICS)

def labels():
    ordered=[c for c in model_labels() if c in FABRICS]
    return ordered if len(ordered)==len(FABRICS) else list(FABRICS)

def decision_thresholds():
    manifest=load_manifest()
    min_confidence=manifest.get("min_confidence", 0.35)
    min_margin=manifest.get("min_margin", 0.08)
    try: min_confidence=float(min_confidence)
    except Exception: min_confidence=0.35
    try: min_margin=float(min_margin)
    except Exception: min_margin=0.08
    return max(0.0, min(1.0, min_confidence)), max(0.0, min(1.0, min_margin))

def preprocess_config():
    manifest=load_manifest()
    input_size=manifest.get("input_size", 224)
    normalization=manifest.get("normalization", {})
    mean=normalization.get("mean", [0.485,0.456,0.406])
    std=normalization.get("std", [0.229,0.224,0.225])
    try: input_size=int(input_size)
    except Exception: input_size=224
    if not isinstance(mean, list) or len(mean)!=3: mean=[0.485,0.456,0.406]
    if not isinstance(std, list) or len(std)!=3: std=[0.229,0.224,0.225]
    return max(32, input_size), [float(x) for x in mean], [float(x) for x in std]

@app.get("/")
def root(): return {"service":"LaundryAI API", "health":"/api/health", "docs":"/docs"}

@app.get("/api/health")
def health():
    state=model_status()
    persistence=firebase_store.status(probe=True)
    healthy=state["ready"] and persistence["configured"] and persistence.get("reachable",True)
    return {"status":"ok" if healthy else "degraded", "model_ready":state["ready"], "model_error":state["error"], "persistence":persistence}

@app.get("/api/auth/config")
def firebase_auth_config():
    configured = firebase_auth_enabled()
    return {"enabled": configured, "firebase_config": FIREBASE_CONFIG if configured else None}

@app.post("/api/auth/firebase")
def firebase_login(payload: FirebaseCredential):
    user = verify_firebase_token(payload.id_token)
    return {
        "uid": user.get("uid"),
        "email": user.get("email"),
        "name": user.get("name") or user.get("email", "LaundryAI user").split("@")[0],
        "picture": user.get("picture"),
        "is_admin": is_admin(user),
    }

@app.get("/api/fabrics")
def fabrics(): return [{"id":k, "properties":v["properties"]} for k,v in FABRICS.items()]

@app.get("/api/fabrics/{fabric}")
def fabric(fabric:str):
    if fabric not in FABRICS: raise HTTPException(404,"Unsupported fabric")
    return {"id":fabric, **recommendation(fabric)}

@app.post("/api/predict", summary="Predict fabric from an image")
async def predict(request: Request, image:UploadFile=File(...), note:Optional[str]=Form(None)):
    if note is not None:
        note=note.strip()
        if len(note)>240:
            raise HTTPException(422,"Note cannot exceed 240 characters.")
        if not note:
            note=None
    kind=(image.content_type or "").split(";")[0].strip().lower()
    if kind not in {"image/jpeg","image/png","image/webp","application/octet-stream",""}: raise HTTPException(415,"Upload JPG, PNG, or WEBP.")
    chunks=[]; total=0
    while chunk:=await image.read(1024*1024):
        total+=len(chunk)
        if total>10*1024*1024: raise HTTPException(413,"Image must be between 1 byte and 10 MB.")
        chunks.append(chunk)
    data=b"".join(chunks)
    if not data: raise HTTPException(413,"Image must be between 1 byte and 10 MB.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error",Image.DecompressionBombWarning)
            source=Image.open(io.BytesIO(data))
            source.verify()
            source=Image.open(io.BytesIO(data))
            source.load()
            if source.width>6000 or source.height>6000: raise ValueError("Image dimensions are too large")
            im=source.convert("RGB")
    except (Image.DecompressionBombError,Image.DecompressionBombWarning): raise HTTPException(413,"Image dimensions are too large.")
    except Exception: raise HTTPException(422,"Invalid image.")
    
    # Prepare a normalized JPEG for private feedback storage. In production it
    # is uploaded to Firebase Storage; local development keeps the old folder.
    normalized_image=io.BytesIO()
    im.save(normalized_image, format="JPEG", quality=92, optimize=True)
    normalized_bytes=normalized_image.getvalue()
    image_token = f"upload_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}.jpg"
    if not firebase_store.enabled():
        upload_path = os.path.join(UPLOADS_DIR, image_token)
        try:
            with open(upload_path, "wb") as upload_file:
                upload_file.write(normalized_bytes)
        except Exception:
            pass

    sample=ImageStat.Stat(im.resize((64,64)))
    texture=round(sum(sample.stddev)/3,1)
    quality={"width":im.width,"height":im.height,"brightness":round(sum(sample.mean)/3,1),"texture":texture,"warning": im.width<224 or im.height<224}
    names=model_labels(); preview=False
    try:
        import torch, numpy as np
        model=load_model()
        input_size, mean, std=preprocess_config()
        pixels=np.asarray(im.resize((input_size,input_size)), dtype=np.float32)/255.0
        tensor=torch.from_numpy(pixels).permute(2,0,1).unsqueeze(0)
        tensor=(tensor-torch.tensor(mean).view(1,3,1,1))/torch.tensor(std).view(1,3,1,1)
        with torch.no_grad(): probabilities=torch.softmax(model(tensor),dim=1).squeeze().tolist()
        if len(probabilities)!=len(names): raise ValueError("Model output does not match configured labels")
        probabilities=list(probabilities)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, "Model inference failed.") from exc
    ranked=sorted(zip(names,probabilities), key=lambda x:x[1], reverse=True)
    fabric, confidence=ranked[0]
    second=ranked[1][1] if len(ranked)>1 else 0.0
    margin=confidence-second
    min_confidence, min_margin=decision_thresholds()
    accepted_model=confidence>=min_confidence and margin>=min_margin
    accepted_fabric=accepted_model and fabric in FABRICS
    detected_non_fabric=accepted_model and fabric==NON_FABRIC
    if confidence<min_confidence: decision_reason=f"Low confidence ({round(confidence*100,2)}%) below required {round(min_confidence*100,2)}%."
    elif margin<min_margin: decision_reason=f"Prediction is ambiguous; top-2 margin {round(margin*100,2)}% below required {round(min_margin*100,2)}%."
    elif detected_non_fabric: decision_reason="Detected non-fabric content."
    else: decision_reason=None
    output_fabric=fabric if (accepted_fabric or detected_non_fabric) else "unknown"
    record={
        "created_at":datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "fabric":output_fabric,
        "confidence":round(confidence*100,2),
        "note":note,
        "image_token":image_token,
        "alternatives":[{"fabric":name,"confidence":round(score*100,2)} for name,score in ranked],
        "quality":quality,
        "recommendation":recommendation(fabric) if accepted_fabric else None,
        "preview":preview,
        "model_decision":{
            "accepted":accepted_fabric,
            "detected_non_fabric":detected_non_fabric,
            "reason":decision_reason,
            "top_fabric":fabric,
            "top_confidence":round(confidence*100,2),
            "top2_margin":round(margin*100,2),
            "thresholds":{
                "min_confidence":round(min_confidence*100,2),
                "min_margin":round(min_margin*100,2)
            }
        }
    }
    owner_uid=request_uid(request)
    if firebase_store.enabled():
        persistence_warning=None
        if not firebase_store.configured():
            persistence_warning="Prediction completed, but cloud history is unavailable because Firebase persistence is not configured."
        else:
            try:
                record=firebase_store.call_with_timeout(
                    lambda: firebase_store.create_prediction(owner_uid, record, normalized_bytes)
                )
                _invalidate_history_cache()
            except Exception:
                persistence_warning="Prediction completed, but cloud history could not be saved. Try again later."
        if persistence_warning:
            # Never retain an image token when its protected upload failed.
            record.update({"id":None,"image_token":None,"saved":False,"feedback_available":False,"persistence_warning":persistence_warning})
        else:
            record.update({"saved":True,"feedback_available":True,"persistence_warning":None})
    else:
        with connection() as db:
            cursor=db.execute("INSERT INTO predictions (owner_uid,created_at,fabric,confidence,payload) VALUES (?,?,?,?,?)",(owner_uid,record["created_at"],output_fabric,record["confidence"],json.dumps(record)))
            record["id"]=cursor.lastrowid
            db.execute("UPDATE predictions SET payload=? WHERE id=?",(json.dumps(record),record["id"]))
        _invalidate_history_cache()
        record.update({"saved":True,"feedback_available":True,"persistence_warning":None})
    return record

@app.post("/api/feedback", summary="Human-in-the-loop active learning feedback")
def feedback(request: Request, payload: dict = Body(...)):
    pred_id = payload.get("prediction_id")
    image_token = payload.get("image_token")
    confirmed_fabric = str(payload.get("confirmed_fabric", "")).strip().lower()
    was_correct = bool(payload.get("was_prediction_correct", False))

    if confirmed_fabric not in FABRICS and confirmed_fabric != NON_FABRIC:
        raise HTTPException(422, f"Invalid fabric label: {confirmed_fabric}")

    if not isinstance(pred_id, (int, str)) or not str(pred_id).strip() or not image_token:
        raise HTTPException(422, "Prediction id and image token are required.")
    owner_uid=request_uid(request)
    if firebase_store.enabled():
        try:
            rec=firebase_store.get_prediction(str(pred_id), owner_uid)
        except Exception as exc:
            raise HTTPException(503, "Cloud database is temporarily unavailable.") from exc
    else:
        with connection() as db:
            row = db.execute("SELECT payload FROM predictions WHERE id=? AND owner_uid=?", (pred_id, owner_uid)).fetchone()
        rec=json.loads(row["payload"]) if row else None
    if not rec: raise HTTPException(404, "Prediction not found.")
    if image_token != rec.get("image_token"):
        raise HTTPException(403, "Image token does not belong to this prediction.")

    if firebase_store.enabled():
        try:
            item=firebase_store.submit_feedback(rec, confirmed_fabric, was_correct)
            _invalidate_history_cache()
        except Exception as exc:
            raise HTTPException(503, "Could not store feedback securely.") from exc
        return {
            "status":"success", "confirmed_fabric":confirmed_fabric,
            "was_correct":was_correct, "saved_to_dataset":False,
            "review_status":"pending", "feedback_id":item["id"],
            "message":f"Correction submitted as {confirmed_fabric.capitalize()} for administrator review."
        }

    saved_path = None
    src = os.path.join(UPLOADS_DIR, os.path.basename(image_token))
    if os.path.exists(src):
        target_dir = os.path.join(DATA_DIR, "review_pending", confirmed_fabric)
        os.makedirs(target_dir, exist_ok=True)
        target_name = f"user_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}.jpg"
        dest = os.path.join(target_dir, target_name)
        shutil.copyfile(src, dest)
        saved_path = os.path.relpath(dest, start=os.path.dirname(DATA_DIR))

    rec["user_feedback"] = {
        "confirmed_fabric": confirmed_fabric,
        "was_correct": was_correct,
        "saved_to_dataset": False,
        "saved_path": saved_path,
        "review_status": "pending" if saved_path else "metadata_only",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    }
    with connection() as db:
        db.execute("UPDATE predictions SET payload=? WHERE id=? AND owner_uid=?", (json.dumps(rec), pred_id, owner_uid))
    _invalidate_history_cache()

    return {
        "status": "success",
        "confirmed_fabric": confirmed_fabric,
        "was_correct": was_correct,
        "saved_to_dataset": False,
        "saved_path": saved_path,
        "review_status": "pending" if saved_path else "metadata_only",
        "message": f"Correction submitted as {confirmed_fabric.capitalize()} for administrator review."
    }

def local_dataset_stats():
    train_dir = os.path.join(DATA_DIR, "train")
    stats = {}
    total = 0
    user_contributed = 0
    for item in [*FABRICS.keys(), NON_FABRIC]:
        class_dir = os.path.join(train_dir, item)
        files = [f for f in os.listdir(class_dir) if os.path.isfile(os.path.join(class_dir, f))] if os.path.isdir(class_dir) else []
        count = len(files)
        user_count = sum(1 for f in files if f.startswith("user_"))
        stats[item] = {"total": count, "user_verified": user_count}
        total += count
        user_contributed += user_count
    return {"total_samples":total,"user_contributed":user_contributed,"classes":stats}

@app.get("/api/dataset/stats", summary="Get training dataset sample counts")
def dataset_stats():
    result=local_dataset_stats()
    stats=result["classes"]
    if firebase_store.enabled() and firebase_store.configured():
        try:
            for item, count in firebase_store.approved_counts().items():
                if item in stats:
                    stats[item]["total"] += count
                    stats[item]["user_verified"] += count
                    result["total_samples"] += count
                    result["user_contributed"] += count
        except Exception as exc:
            raise HTTPException(503, "Could not load cloud dataset statistics.") from exc
    return result

@app.get("/api/history")
def get_history(request: Request): return saved_history(request_uid(request))

@app.get("/api/history/{record_id}")
def get_one_history(record_id:str, request: Request):
    for item in saved_history(request_uid(request)):
        if str(item["id"])==record_id: return item
    raise HTTPException(404,"Analysis not found")

@app.patch("/api/history/{record_id}/note")
def update_history_note(record_id:str, request: Request, payload:dict=Body(...)):
    new_note=payload.get("note")
    if new_note is not None:
        new_note=str(new_note).strip()
        if len(new_note)>240: raise HTTPException(422,"Note cannot exceed 240 characters.")
        if not new_note: new_note=None
    owner_uid=request_uid(request)
    if firebase_store.enabled():
        try:
            data=firebase_store.update_prediction(record_id,owner_uid,{"note":new_note})
        except Exception as exc:
            raise HTTPException(503, "Cloud database is temporarily unavailable.") from exc
        if not data: raise HTTPException(404,"Analysis not found")
        _invalidate_history_cache()
        return data
    with connection() as db:
        row=db.execute("SELECT payload FROM predictions WHERE id=? AND owner_uid=?",(record_id,owner_uid)).fetchone()
        if not row: raise HTTPException(404,"Analysis not found")
        data=json.loads(row["payload"])
        data["note"]=new_note
        db.execute("UPDATE predictions SET payload=? WHERE id=? AND owner_uid=?",(json.dumps(data),record_id,owner_uid))
    _invalidate_history_cache()
    return data

@app.delete("/api/history/{record_id}")
def delete_history(record_id:str, request: Request):
    if firebase_store.enabled():
        try:
            deleted=firebase_store.delete_prediction(record_id,request_uid(request))
        except Exception as exc:
            raise HTTPException(503, "Cloud database is temporarily unavailable.") from exc
        if not deleted: raise HTTPException(404,"Analysis not found")
        _invalidate_history_cache()
        return {"deleted":True}
    with connection() as db:
        if not db.execute("DELETE FROM predictions WHERE id=? AND owner_uid=?",(record_id,request_uid(request))).rowcount: raise HTTPException(404,"Analysis not found")
    _invalidate_history_cache()
    return {"deleted":True}

@app.get("/api/history/export/csv")
def export_history_csv(request: Request):
    history=saved_history(request_uid(request))
    output=io.StringIO()
    writer=csv.writer(output)
    writer.writerow(["ID","Date","Fabric","Confidence (%)","Care Note","Wash Temp","Wash Cycle","Dry","Iron","Bleach","Eco Advice"])
    def safe_csv(value):
        if isinstance(value,str) and value.lstrip().startswith(("=","+","-","@")): return "'"+value
        return value
    for item in history:
        rec=item.get("recommendation") or {}
        wash=rec.get("wash",{}) if isinstance(rec.get("wash"),dict) else {}
        eco="; ".join(rec.get("eco",[])) if isinstance(rec.get("eco"),list) else ""
        writer.writerow([safe_csv(value) for value in [
            item.get("id",""),
            item.get("created_at",""),
            item.get("fabric",""),
            item.get("confidence",""),
            item.get("note") or "",
            wash.get("temperature",""),
            wash.get("cycle",""),
            rec.get("dry",""),
            rec.get("iron",""),
            rec.get("bleach",""),
            eco
        ]])
    return Response(
        content=output.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition":"attachment; filename=laundryai_history.csv"}
    )

@app.delete("/api/history")
def clear_history(request: Request):
    if firebase_store.enabled():
        try:
            count=firebase_store.clear_predictions(request_uid(request))
            _invalidate_history_cache()
            return {"deleted":True,"count":count}
        except Exception as exc:
            raise HTTPException(503, "Cloud database is temporarily unavailable.") from exc
    with connection() as db: db.execute("DELETE FROM predictions WHERE owner_uid=?",(request_uid(request),))
    _invalidate_history_cache()
    return {"deleted":True}

@app.get("/api/analytics")
def analytics(request: Request):
    history=saved_history(request_uid(request))
    categories=[*labels(), NON_FABRIC, "unknown"]
    counts={name:sum(item["fabric"]==name for item in history) for name in categories}
    return {"garments_analyzed":len(history),"most_detected_fabric":max(counts,key=counts.get) if history else None,"average_confidence":round(sum(item["confidence"] for item in history)/len(history),2) if history else None,"eco_recommendations":len(history),"distribution":counts,"note":"Analytics are derived only from stored predictions."}

@app.get("/api/admin/overview")
def admin_overview(request: Request):
    admin = require_admin(request)
    state=model_status()
    training=training_configuration()
    # Health already performs the network probe. The admin overview must load
    # promptly even while Firebase is down or credentials are being repaired.
    persistence=firebase_store.status(probe=False)
    warnings_list=[]
    try:
        history=saved_history()
    except HTTPException:
        history=[]
        warnings_list.append("Cloud scan history is currently unavailable.")
    try:
        dataset=dataset_stats()
    except HTTPException:
        dataset=local_dataset_stats()
        warnings_list.append("Cloud-approved training samples could not be counted.")
    if not persistence.get("configured"):
        missing=persistence.get("firebase_missing") or []
        code=persistence.get("configuration_error")
        if missing:
            warnings_list.append("Firebase setup needs attention: " + ", ".join(missing) + ".")
        elif code:
            warnings_list.append("Firebase credentials need attention (" + str(code) + ").")
    feedback_count=sum(1 for item in history if item.get("user_feedback"))
    manifest=load_manifest()
    return {
        "admin_email": admin.get("email"),
        "total_scans": len(history),
        "feedback_records": feedback_count,
        "model_ready": state["ready"],
        "model_error": state["error"],
        "persistence": persistence,
        "auth":{"firebase_project":firebase_auth_enabled(),"admin_allowlist":bool(ADMIN_EMAILS)},
        "dataset": dataset,
        "model_metrics":{
            "test_accuracy":manifest.get("test_accuracy"),
            "macro_f1":manifest.get("macro_f1"),
            "test_images":manifest.get("test_images"),
            "version":manifest.get("model_version") or manifest.get("version") or "deployed",
        },
        "retraining": _training_state(),
        "training_available": training["available"],
        "training_mode":training["mode"],
        "training_configuration":training,
        "warnings":warnings_list,
    }

@app.get("/api/admin/users")
def admin_users(request: Request):
    require_admin(request)
    try:
        page=firebase_admin_auth_client().list_users(max_results=100)
        users=[]
        for account in page.users:
            claims=account.custom_claims or {}
            users.append({
                "uid":account.uid,
                "email":account.email,
                "name":account.display_name,
                "picture":account.photo_url,
                "email_verified":account.email_verified,
                "disabled":account.disabled,
                "is_admin":claims.get("admin") is True or (account.email or "").lower() in ADMIN_EMAILS,
                "providers":[provider.provider_id for provider in account.provider_data],
                "created_at":account.user_metadata.creation_timestamp,
                "last_sign_in_at":account.user_metadata.last_sign_in_timestamp,
            })
        return {"count":len(users),"users":users,"next_page":bool(page.next_page_token)}
    except Exception as exc:
        raise HTTPException(503,"Could not load Firebase users.") from exc

@app.patch("/api/admin/users/{uid}/role")
def update_admin_role(uid: str, payload: AdminRoleUpdate, request: Request):
    admin=require_admin(request)
    if uid == admin.get("uid") and not payload.is_admin:
        raise HTTPException(409,"You cannot remove your own administrator access.")
    try:
        auth_client=firebase_admin_auth_client()
        account=auth_client.get_user(uid)
        claims=dict(account.custom_claims or {})
        if payload.is_admin: claims["admin"]=True
        else: claims.pop("admin",None)
        auth_client.set_custom_user_claims(uid,claims or None)
        record_audit("admin_role_updated", str(admin.get("uid")), uid, {"is_admin": payload.is_admin})
        return {"updated":True,"uid":uid,"is_admin":payload.is_admin,"message":"The user must refresh their sign-in token."}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503,"Could not update the administrator role.") from exc

@app.patch("/api/admin/users/{uid}/status")
def update_user_status(uid: str, payload: UserStatusUpdate, request: Request):
    admin=require_admin(request)
    if uid == admin.get("uid") and payload.disabled:
        raise HTTPException(409,"You cannot disable your own account.")
    try:
        auth_client=firebase_admin_auth_client()
        auth_client.update_user(uid,disabled=payload.disabled)
        if payload.disabled: auth_client.revoke_refresh_tokens(uid)
        record_audit("user_status_updated", str(admin.get("uid")), uid, {"disabled": payload.disabled})
        return {"updated":True,"uid":uid,"disabled":payload.disabled}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503,"Could not update the user status.") from exc

def _paginate(items: list[dict], page: int, page_size: int) -> dict:
    total = len(items)
    start = (page - 1) * page_size
    return {"count": total, "page": page, "page_size": page_size, "pages": (total + page_size - 1) // page_size, "items": items[start:start + page_size]}

@app.get("/api/admin/scans")
def admin_scans(
    request: Request,
    page: int = 1,
    page_size: int = 100,
    fabric: str | None = None,
    min_confidence: float | None = None,
    max_confidence: float | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
    limit: int | None = None,
):
    require_admin(request)
    page = max(1, page)
    if limit is not None:
        page_size = limit
    page_size = max(1, min(page_size, 500))
    try:
        scans = saved_history()
        if fabric:
            scans = [item for item in scans if item.get("fabric") == fabric.strip().lower()]
        if min_confidence is not None:
            scans = [item for item in scans if float(item.get("confidence", 0)) >= min_confidence]
        if max_confidence is not None:
            scans = [item for item in scans if float(item.get("confidence", 0)) <= max_confidence]
        if from_date:
            scans = [item for item in scans if str(item.get("created_at", "")) >= from_date]
        if to_date:
            scans = [item for item in scans if str(item.get("created_at", "")) <= to_date]
        return _paginate(scans, page, page_size)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, "Cloud scan history is temporarily unavailable.") from exc

@app.get("/api/admin/analytics")
def admin_analytics(request: Request, days: int = 30):
    require_admin(request)
    days = max(1, min(days, 366))
    try:
        scans = saved_history()
    except HTTPException:
        raise
    now = datetime.now(timezone.utc)
    cutoff = now.timestamp() - days * 86400
    recent = []
    for item in scans:
        try:
            stamp = datetime.fromisoformat(str(item.get("created_at", "")).replace("Z", "+00:00")).timestamp()
        except (TypeError, ValueError):
            continue
        if stamp >= cutoff:
            recent.append(item)
    distribution = {name: 0 for name in [*labels(), NON_FABRIC, "unknown"]}
    confidence_buckets = {"0-49": 0, "50-74": 0, "75-89": 0, "90-100": 0}
    trends = {}
    for item in recent:
        fabric_name = item.get("fabric")
        if fabric_name in distribution:
            distribution[fabric_name] += 1
        confidence = float(item.get("confidence", 0))
        bucket = "0-49" if confidence < 50 else "50-74" if confidence < 75 else "75-89" if confidence < 90 else "90-100"
        confidence_buckets[bucket] += 1
        day = str(item.get("created_at", ""))[:10]
        if day:
            trends[day] = trends.get(day, 0) + 1
    return {
        "days": days,
        "scan_count": len(recent),
        "fabric_distribution": distribution,
        "confidence": {
            "average": round(sum(float(item.get("confidence", 0)) for item in recent) / len(recent), 2) if recent else None,
            "buckets": confidence_buckets,
        },
        "daily_trend": [{"date": day, "count": trends[day]} for day in sorted(trends)],
    }

@app.get("/api/admin/audit-log")
def admin_audit_log(request: Request, page: int = 1, page_size: int = 100):
    require_admin(request)
    page = max(1, page)
    page_size = max(1, min(page_size, 500))
    offset = (page - 1) * page_size
    items = audit_events(page_size, offset)
    if firebase_store.enabled():
        try:
            total = firebase_store.count_audit_events()
        except Exception as exc:
            raise HTTPException(503, "Cloud audit history is temporarily unavailable.") from exc
    else:
        with connection() as db:
            total = db.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0]
    return {"count": total, "page": page, "page_size": page_size, "pages": (total + page_size - 1) // page_size, "items": items}

@app.get("/api/admin/feedback")
def admin_feedback(request: Request, page: int = 1, page_size: int = 100, status: str = "pending", fabric: str | None = None):
    require_admin(request)
    page = max(1, page)
    page_size = max(1, min(page_size, 500))
    if status not in {"pending", "approved", "rejected", "all"}:
        raise HTTPException(422, "Invalid feedback status.")
    if firebase_store.enabled():
        try:
            items=firebase_store.list_feedback("" if status == "all" else status)
        except Exception as exc:
            raise HTTPException(503, "Cloud feedback queue is temporarily unavailable.") from exc
        if fabric:
            items = [item for item in items if item.get("confirmed_fabric") == fabric.strip().lower()]
        shaped=[{
            "id":item["id"], "fabric":item["confirmed_fabric"],
            "file":item["id"], "filename":item.get("filename"),
            "original_fabric":item.get("original_fabric"),
            "created_at":item.get("created_at"),
            "image_url":f"/api/admin/feedback/{item['confirmed_fabric']}/{item['id']}/image",
            "review_status": item.get("review_status"),
        } for item in items]
        return _paginate(shaped, page, page_size)
    pending=[]
    base=os.path.join(DATA_DIR,"review_pending")
    for fabric_name in [*FABRICS.keys(), NON_FABRIC]:
        folder=os.path.join(base,fabric_name)
        if os.path.isdir(folder):
            pending.extend({"fabric":fabric_name,"file":name} for name in sorted(os.listdir(folder)) if name.lower().endswith((".jpg",".jpeg",".png",".webp")))
    if status != "pending":
        pending = []
    if fabric:
        pending = [item for item in pending if item.get("fabric") == fabric.strip().lower()]
    return _paginate(pending, page, page_size)

@app.get("/api/admin/feedback/{fabric_name}/{filename}/image")
def admin_feedback_image(fabric_name: str, filename: str, request: Request):
    require_admin(request)
    if fabric_name not in FABRICS and fabric_name != NON_FABRIC: raise HTTPException(422,"Invalid fabric label.")
    if firebase_store.enabled():
        try:
            content=firebase_store.feedback_image(os.path.basename(filename))
        except Exception as exc:
            raise HTTPException(503, "Could not load the protected feedback image.") from exc
        if content is None: raise HTTPException(404,"Pending feedback image not found.")
        return Response(content=content,media_type="image/jpeg",headers={"Cache-Control":"private, no-store"})
    source=os.path.join(DATA_DIR,"review_pending",fabric_name,os.path.basename(filename))
    if not os.path.isfile(source): raise HTTPException(404,"Pending feedback image not found.")
    return FileResponse(source,media_type="image/jpeg",headers={"Cache-Control":"private, no-store"})

@app.post("/api/admin/feedback/{fabric_name}/{filename}/approve")
def approve_feedback(fabric_name: str, filename: str, request: Request):
    admin=require_admin(request)
    if fabric_name not in FABRICS and fabric_name != NON_FABRIC: raise HTTPException(422,"Invalid fabric label.")
    safe_name=os.path.basename(filename)
    if firebase_store.enabled():
        try:
            item=firebase_store.review_feedback(safe_name,str(admin.get("uid")),True)
        except Exception as exc:
            raise HTTPException(503, "Could not approve this feedback item.") from exc
        if not item: raise HTTPException(404,"Pending feedback image not found.")
        record_audit("feedback_approved", str(admin.get("uid")), item.get("owner_uid"), {"feedback_id": item.get("id"), "fabric": item.get("confirmed_fabric")})
        return {"approved":True,"fabric":item["confirmed_fabric"],"file":item["filename"]}
    source=os.path.join(DATA_DIR,"review_pending",fabric_name,safe_name)
    if not os.path.isfile(source): raise HTTPException(404,"Pending feedback image not found.")
    target_dir=os.path.join(DATA_DIR,"train",fabric_name)
    os.makedirs(target_dir,exist_ok=True)
    target=os.path.join(target_dir,safe_name)
    shutil.move(source,target)
    record_audit("feedback_approved", str(admin.get("uid")), None, {"file": safe_name, "fabric": fabric_name})
    return {"approved":True,"fabric":fabric_name,"file":safe_name}

@app.delete("/api/admin/feedback/{fabric_name}/{filename}")
def reject_feedback(fabric_name: str, filename: str, request: Request):
    admin=require_admin(request)
    if fabric_name not in FABRICS and fabric_name != NON_FABRIC: raise HTTPException(422,"Invalid fabric label.")
    if firebase_store.enabled():
        try:
            item=firebase_store.review_feedback(os.path.basename(filename),str(admin.get("uid")),False)
        except Exception as exc:
            raise HTTPException(503, "Could not reject this feedback item.") from exc
        if not item: raise HTTPException(404,"Pending feedback image not found.")
        record_audit("feedback_rejected", str(admin.get("uid")), item.get("owner_uid"), {"feedback_id": item.get("id"), "fabric": item.get("confirmed_fabric")})
        return {"rejected":True}
    source=os.path.join(DATA_DIR,"review_pending",fabric_name,os.path.basename(filename))
    if not os.path.isfile(source): raise HTTPException(404,"Pending feedback image not found.")
    os.remove(source)
    record_audit("feedback_rejected", str(admin.get("uid")), None, {"file": os.path.basename(filename), "fabric": fabric_name})
    return {"rejected":True}

@app.get("/api/model/info")
def model_info():
    manifest=load_manifest()
    min_confidence, min_margin=decision_thresholds()
    return {
        "architecture": manifest.get("architecture", "MobileNetV2 transfer learning"),
        "classes": model_labels(),
        "supported_fabrics": labels(),
        "ready": model_status()["ready"],
        "limitation": "Ambiguous or low-confidence inputs are rejected as 'unknown'. Clear non-fabric inputs can be classified as 'non_fabric'. Blends may still be difficult.",
        "acceptance_thresholds": {"min_confidence": round(min_confidence*100,2), "min_margin": round(min_margin*100,2)},
        "manifest": manifest or None
    }

@app.get("/api/model/metrics")
def metrics():
    manifest=load_manifest()
    if manifest: return {"available": True, "metrics": manifest}
    return {"available":False,"message":"No evaluation artifact has been supplied; metrics are not invented."}

@app.get("/api/admin/model/governance")
def model_governance(request: Request):
    require_admin(request)
    manifest=load_manifest()
    dataset=dataset_stats()
    counts={name:data.get("total",0) for name,data in dataset.get("classes",{}).items()}
    largest=max(counts.values(),default=0)
    warnings=[]
    for name,count in counts.items():
        if largest and count < largest * 0.35:
            warnings.append(f"{name} has only {count} samples versus the largest class at {largest}.")
    return {
        "current_model":manifest or None,
        "dataset":dataset,
        "warnings":warnings,
        "promotion_policy":{
            "automatic_promotion":False,
            "required_checks":["held-out test accuracy","macro F1","per-class recall","confusion matrix","manual smoke test"],
            "rule":"A candidate remains separate until an administrator reviews its metrics and explicitly deploys it."
        }
    }

@app.get("/api/recommendations/{fabric}")
def rec(fabric:str):
    if fabric not in FABRICS: raise HTTPException(404,"Unsupported fabric")
    return recommendation(fabric)

RETRAIN_STATE = {
    "status": "idle",
    "started_at": None,
    "completed_at": None,
    "message": "Ready to train on the reviewed dataset.",
    "job_id": None,
    "request_id": None,
    "mode": "review_only",
}
_retrain_lock = threading.Lock()

def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

def _split_image_counts() -> dict[str, int]:
    extensions={".jpg", ".jpeg", ".png", ".webp"}
    counts={}
    for split in ("train", "val", "test"):
        root=os.path.join(DATA_DIR,split)
        counts[split]=sum(
            1 for folder, _, files in os.walk(root)
            for filename in files if os.path.splitext(filename)[1].lower() in extensions
        ) if os.path.isdir(root) else 0
    return counts

def local_accelerator_capability() -> dict:
    """Return operational accelerator facts without exposing host identifiers."""
    capability={"runtime":"python", "torch_available":False, "cuda_available":False, "device_count":0}
    try:
        import torch
        capability["torch_available"]=True
        capability["torch_version"]=str(torch.__version__).split("+")[0]
        capability["cuda_available"]=bool(torch.cuda.is_available())
        capability["device_count"]=int(torch.cuda.device_count()) if capability["cuda_available"] else 0
        capability["cuda_runtime"]=str(torch.version.cuda) if torch.version.cuda else None
        if capability["device_count"]:
            properties=torch.cuda.get_device_properties(0)
            capability["device"]={
                "type":"cuda",
                "name":str(properties.name)[:120],
                "memory_gb":round(int(properties.total_memory)/(1024**3),1),
            }
        else:
            capability["device"]={"type":"cpu"}
    except Exception as exc:
        capability["error_type"]=type(exc).__name__
        capability["device"]={"type":"cpu"}
    return capability

def training_configuration() -> dict:
    external_url=os.getenv("EXTERNAL_TRAINING_URL", "").strip()
    callback_base=os.getenv("PUBLIC_API_URL", "").strip().rstrip("/")
    callback_token=bool(os.getenv("TRAINING_CALLBACK_TOKEN", "").strip())
    local_enabled=os.getenv("ENABLE_RETRAINING", "false").strip().lower()=="true"
    split_counts=_split_image_counts()
    dataset_ready=all(split_counts[split] > 0 for split in ("train", "val", "test"))
    accelerator=local_accelerator_capability()

    if external_url:
        export=firebase_store.training_export_reference()
        missing=[]
        if not callback_base: missing.append("PUBLIC_API_URL")
        if not callback_token: missing.append("TRAINING_CALLBACK_TOKEN")
        if not export.get("portable"): missing.append("portable_dataset_storage")
        return {
            "mode":"external_gpu", "available":not missing, "configured":True,
            "missing":missing, "dataset_ready":bool(export.get("portable")),
            "split_counts":split_counts, "accelerator":accelerator,
        }
    if local_enabled:
        return {
            "mode":"local_cuda" if accelerator["cuda_available"] else "local_cpu",
            "available":dataset_ready, "configured":True,
            "missing":[] if dataset_ready else [f"{name}_dataset" for name,count in split_counts.items() if count == 0],
            "dataset_ready":dataset_ready, "split_counts":split_counts, "accelerator":accelerator,
        }
    return {
        "mode":"review_only", "available":False, "configured":False,
        "missing":["training_worker"], "dataset_ready":dataset_ready,
        "split_counts":split_counts, "accelerator":accelerator,
    }

def training_available():
    return training_configuration()["available"]

def training_mode():
    return training_configuration()["mode"]

def _training_state() -> dict:
    with _retrain_lock:
        return dict(RETRAIN_STATE)

def _update_training_state(**updates) -> None:
    with _retrain_lock:
        RETRAIN_STATE.update(updates)

def _public_artifact_url(value: str | None) -> str | None:
    if not value:
        return None
    parsed=urlsplit(value)
    if parsed.scheme != "https" or not parsed.netloc:
        raise HTTPException(422,"Candidate artifacts must use an HTTPS URL.")
    # Signed artifact query strings are credentials; never retain or return them.
    return urlunsplit((parsed.scheme,parsed.netloc,parsed.path,"",""))[:1000]

def _run_training_job():
    import subprocess, sys
    try:
        external_url=os.getenv("EXTERNAL_TRAINING_URL", "").strip()
        if external_url:
            callback_base=os.getenv("PUBLIC_API_URL", "").strip().rstrip("/")
            request_id=str(RETRAIN_STATE.get("job_id") or uuid.uuid4().hex)
            payload=json.dumps({
                "project":"laundryai",
                "request_id":request_id,
                "requested_at":_utc_now(),
                "dataset":firebase_store.training_export_reference(),
                "callback_url":f"{callback_base}/api/training/callback",
                "required_metrics":["test_accuracy","macro_f1","per_class_recall","confusion_matrix"],
            }).encode("utf-8")
            headers={"Content-Type":"application/json"}
            token=os.getenv("EXTERNAL_TRAINING_TOKEN", "").strip()
            if token: headers["Authorization"]=f"Bearer {token}"
            _update_training_state(status="dispatching",message="Securely dispatching the external GPU job.")
            with urlrequest.urlopen(urlrequest.Request(external_url,data=payload,headers=headers,method="POST"),timeout=30) as response:
                response_body=response.read(65_537)
            if len(response_body)>65_536:
                raise ValueError("Training worker response is too large")
            result=json.loads(response_body.decode("utf-8") or "{}")
            if not isinstance(result,dict):
                raise ValueError("Training worker returned a non-object response")
            remote_status=result.get("status","running")
            if remote_status not in {"queued","running"}:
                remote_status="running"
            remote_id=str(result.get("job_id") or request_id)[:160]
            with _retrain_lock:
                # A very fast worker may callback before this request returns.
                # Never reopen a job that already reached a terminal state.
                if RETRAIN_STATE.get("status") not in {"completed","failed"}:
                    RETRAIN_STATE.update(
                        status=remote_status,job_id=remote_id,
                        message="External GPU worker accepted the training job.",
                    )
            return
        script_path = os.path.join(os.path.dirname(__file__), "..", "scripts", "train.py")
        candidate_dir=os.path.join(os.path.dirname(MODEL_PATH),"candidates")
        os.makedirs(candidate_dir,exist_ok=True)
        candidate_path=os.path.join(candidate_dir,f"fabric_candidate_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.pt")
        cmd = [sys.executable, script_path, "--data", DATA_DIR, "--epochs", "5", "--batch-size", "16", "--output", candidate_path]
        _update_training_state(status="running",message="Training MobileNetV2 on the reviewed dataset.")
        proc = subprocess.run(cmd, capture_output=True, text=True, cwd=os.path.join(os.path.dirname(__file__), ".."))
        if proc.returncode == 0:
            _update_training_state(status="completed",completed_at=_utc_now(),message="Candidate model trained. Review held-out metrics before promotion.",candidate_path=os.path.basename(candidate_path))
        else:
            _update_training_state(status="failed",completed_at=_utc_now(),message="Training process failed.",error_type="TrainingProcessError")
    except Exception as exc:
        # Exception messages from HTTP clients can contain URLs or credentials.
        _update_training_state(status="failed",completed_at=_utc_now(),message="Training dispatch failed.",error_type=type(exc).__name__)

@app.post("/api/retrain", summary="Trigger continuous active learning model retraining")
def trigger_retrain(request: Request):
    require_admin(request)
    config=training_configuration()
    if not config["available"]:
        raise HTTPException(409, "Training is not ready. Review the reported training configuration.")
    with _retrain_lock:
        if RETRAIN_STATE["status"] in {"queued","dispatching","running"}:
            raise HTTPException(409, "Model training is already running.")
        request_id=uuid.uuid4().hex
        RETRAIN_STATE.update({
            "status":"queued", "started_at":_utc_now(), "completed_at":None,
            "message":"Training job queued.", "job_id":request_id,
            "request_id":request_id, "mode":config["mode"], "metrics":None, "candidate_url":None,
            "candidate_path":None, "error_type":None,
        })
    worker = threading.Thread(target=_run_training_job, daemon=True)
    worker.start()
    return {
        "status": "started",
        "message": "Asynchronous retraining job dispatched across active learning dataset.",
        "job_id":request_id,
        "started_at": RETRAIN_STATE["started_at"],
    }

@app.get("/api/retrain/status", summary="Get model retraining job status")
def retrain_status(request: Request):
    require_admin(request)
    return {**_training_state(), "configuration":training_configuration()}

@app.post("/api/training/callback", include_in_schema=False)
def training_callback(update: TrainingCallback, request: Request):
    expected=os.getenv("TRAINING_CALLBACK_TOKEN", "").strip()
    supplied=request.headers.get("x-training-token", "")
    if not expected or not supplied or not __import__("hmac").compare_digest(expected,supplied):
        raise HTTPException(401,"Invalid training callback credentials.")
    artifact_url=_public_artifact_url(update.candidate_url)
    if update.status == "completed" and not update.metrics:
        raise HTTPException(422,"Completed training callbacks require evaluation metrics.")
    with _retrain_lock:
        active_job=str(RETRAIN_STATE.get("job_id") or "")
        request_id=str(RETRAIN_STATE.get("request_id") or active_job)
        if not active_job or RETRAIN_STATE.get("mode") != "external_gpu":
            raise HTTPException(409,"No external training job is awaiting updates.")
        if update.job_id:
            supplied_job=str(update.job_id)
            if not (
                __import__("hmac").compare_digest(active_job,supplied_job)
                or __import__("hmac").compare_digest(request_id,supplied_job)
            ):
                raise HTTPException(409,"Training callback does not match the active job.")
        if RETRAIN_STATE.get("status") in {"completed","failed"}:
            raise HTTPException(409,"The training job is already in a terminal state.")
        if RETRAIN_STATE.get("status") == "running" and update.status == "queued":
            raise HTTPException(409,"Training status cannot move backwards.")
        RETRAIN_STATE.update({
            "status":update.status,
            "message":f"External training job {update.status}.",
            "candidate_url":artifact_url,
            "metrics":update.metrics if update.status == "completed" else None,
            "completed_at":_utc_now() if update.status in {"completed","failed"} else None,
        })
    return {"accepted":True,"status":update.status}

# Production deployment: the React build and API share one origin, so `/api`
# requests work without a separate Vite development server or proxy.
FRONTEND_DIST = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist"))
if os.path.isdir(FRONTEND_DIST):
    app.mount("/assets", StaticFiles(directory=os.path.join(FRONTEND_DIST, "assets")), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def frontend_app(path: str):
        requested = os.path.join(FRONTEND_DIST, path)
        if path and os.path.isfile(requested):
            return FileResponse(requested)
        return FileResponse(os.path.join(FRONTEND_DIST, "index.html"))
