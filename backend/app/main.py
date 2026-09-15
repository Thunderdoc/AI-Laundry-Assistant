import io, os, json, sqlite3, csv, uuid, shutil
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Optional
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Body, Response, Request
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
from PIL import Image, ImageStat
from .knowledge_base import FABRICS, recommendation
from . import firebase_store

load_dotenv(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".env")))
app = FastAPI(title="LaundryAI API", version="0.1.0", description="Experimental fabric-care service. Predictions require an exported trained model.")
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(","), allow_methods=["*"], allow_headers=["*"], allow_credentials=True)

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

def firebase_auth_enabled() -> bool:
    """Require login only after both the browser config and server credential exist."""
    has_web_config = all(FIREBASE_CONFIG[key] for key in ("apiKey", "authDomain", "projectId", "appId"))
    has_server_credential = bool(os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "")) or bool(os.getenv("FIREBASE_SERVICE_ACCOUNT_FILE", ""))
    return has_web_config and has_server_credential

def verify_firebase_token(id_token: str):
    """Verify a Firebase ID token using server-only service-account credentials."""
    account_file = os.getenv("FIREBASE_SERVICE_ACCOUNT_FILE", "")
    account_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "")
    if not firebase_auth_enabled():
        raise HTTPException(503, "Firebase authentication is not configured on the server.")
    if account_file and not os.path.isfile(account_file):
        raise HTTPException(503, "Firebase service-account file was not found on the server.")
    try:
        # Signature/audience/expiry verification is sufficient for normal API
        # requests and avoids an additional Identity Toolkit lookup on every
        # call. Disabled accounts have their refresh tokens revoked by the admin
        # endpoint, so their short-lived ID token expires naturally.
        return firebase_admin_auth_client().verify_id_token(id_token)
    except HTTPException:
        raise
    except Exception as exc:
        error_name=type(exc).__name__
        if error_name in {"ExpiredIdTokenError", "RevokedIdTokenError"}:
            detail="Your sign-in session expired. Sign in again."
        elif error_name in {"CertificateFetchError", "TransportError"}:
            raise HTTPException(503, "Firebase verification is temporarily unavailable.") from exc
        elif error_name in {"InvalidIdTokenError", "InvalidSessionCookieError", "ValueError"}:
            detail="Firebase returned an invalid sign-in token."
        else:
            detail=f"Firebase server credentials could not verify sign-in ({error_name})."
        raise HTTPException(401, detail) from exc

def is_admin(user: dict | None) -> bool:
    return bool(
        user
        and user.get("email_verified") is True
        and (user.get("admin") is True or (user.get("email") or "").strip().lower() in ADMIN_EMAILS)
    )

def require_admin(request: Request) -> dict:
    if not firebase_auth_enabled():
        raise HTTPException(503, "Secure admin access requires Firebase server credentials.")
    user = getattr(request.state, "user", None)
    if not is_admin(user):
        raise HTTPException(403, "Administrator access is required.")
    return user

def firebase_admin_auth_client():
    account_file = os.getenv("FIREBASE_SERVICE_ACCOUNT_FILE", "").strip()
    account_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    import firebase_admin
    from firebase_admin import auth, credentials
    if not firebase_admin._apps:
        service_account = json.loads(account_json) if account_json else account_file
        firebase_admin.initialize_app(credentials.Certificate(service_account))
    return auth

@app.middleware("http")
async def require_firebase_auth(request: Request, call_next):
    path = request.url.path
    public_api = {"/api/health", "/api/auth/config", "/api/auth/firebase"}
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
        columns={row[1] for row in db.execute("PRAGMA table_info(predictions)")}
        if "owner_uid" not in columns:
            db.execute("ALTER TABLE predictions ADD COLUMN owner_uid TEXT NOT NULL DEFAULT 'local-preview'")
        yield db
        db.commit()
    finally:
        db.close()

def request_uid(request: Request) -> str:
    user = getattr(request.state, "user", None)
    return str(user.get("uid")) if user and user.get("uid") else "local-preview"

def saved_history(owner_uid: str | None = None):
    if firebase_store.enabled():
        if not firebase_store.configured():
            raise HTTPException(503, "Firebase persistence is selected but not fully configured.")
        try:
            return firebase_store.list_predictions(owner_uid)
        except Exception as exc:
            raise HTTPException(503, f"Cloud database is unavailable: {exc}") from exc
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
    data=await image.read()
    if not data or len(data)>10*1024*1024: raise HTTPException(413,"Image must be between 1 byte and 10 MB.")
    try:
        im=Image.open(io.BytesIO(data)).convert("RGB")
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
        raise HTTPException(500, f"Model inference failed: {str(exc)}")
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
        if not firebase_store.configured():
            raise HTTPException(503, "Firebase persistence is selected but not fully configured.")
        try:
            record=firebase_store.create_prediction(owner_uid, record, normalized_bytes)
        except Exception as exc:
            raise HTTPException(503, f"Could not save the prediction to Firebase: {exc}") from exc
    else:
        with connection() as db:
            cursor=db.execute("INSERT INTO predictions (owner_uid,created_at,fabric,confidence,payload) VALUES (?,?,?,?,?)",(owner_uid,record["created_at"],output_fabric,record["confidence"],json.dumps(record)))
            record["id"]=cursor.lastrowid
            db.execute("UPDATE predictions SET payload=? WHERE id=?",(json.dumps(record),record["id"]))
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
            raise HTTPException(503, f"Cloud database is unavailable: {exc}") from exc
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
        except Exception as exc:
            raise HTTPException(503, f"Could not store feedback in Firebase: {exc}") from exc
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

    return {
        "status": "success",
        "confirmed_fabric": confirmed_fabric,
        "was_correct": was_correct,
        "saved_to_dataset": False,
        "saved_path": saved_path,
        "review_status": "pending" if saved_path else "metadata_only",
        "message": f"Correction submitted as {confirmed_fabric.capitalize()} for administrator review."
    }

@app.get("/api/dataset/stats", summary="Get training dataset sample counts")
def dataset_stats():
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
    if firebase_store.enabled() and firebase_store.configured():
        try:
            for item, count in firebase_store.approved_counts().items():
                if item in stats:
                    stats[item]["total"] += count
                    stats[item]["user_verified"] += count
                    total += count
                    user_contributed += count
        except Exception as exc:
            raise HTTPException(503, f"Could not load cloud dataset statistics: {exc}") from exc
    return {
        "total_samples": total,
        "user_contributed": user_contributed,
        "classes": stats
    }

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
            raise HTTPException(503, f"Cloud database is unavailable: {exc}") from exc
        if not data: raise HTTPException(404,"Analysis not found")
        return data
    with connection() as db:
        row=db.execute("SELECT payload FROM predictions WHERE id=? AND owner_uid=?",(record_id,owner_uid)).fetchone()
        if not row: raise HTTPException(404,"Analysis not found")
        data=json.loads(row["payload"])
        data["note"]=new_note
        db.execute("UPDATE predictions SET payload=? WHERE id=? AND owner_uid=?",(json.dumps(data),record_id,owner_uid))
    return data

@app.delete("/api/history/{record_id}")
def delete_history(record_id:str, request: Request):
    if firebase_store.enabled():
        try:
            deleted=firebase_store.delete_prediction(record_id,request_uid(request))
        except Exception as exc:
            raise HTTPException(503, f"Cloud database is unavailable: {exc}") from exc
        if not deleted: raise HTTPException(404,"Analysis not found")
        return {"deleted":True}
    with connection() as db:
        if not db.execute("DELETE FROM predictions WHERE id=? AND owner_uid=?",(record_id,request_uid(request))).rowcount: raise HTTPException(404,"Analysis not found")
    return {"deleted":True}

@app.get("/api/history/export/csv")
def export_history_csv(request: Request):
    history=saved_history(request_uid(request))
    output=io.StringIO()
    writer=csv.writer(output)
    writer.writerow(["ID","Date","Fabric","Confidence (%)","Care Note","Wash Temp","Wash Cycle","Dry","Iron","Bleach","Eco Advice"])
    for item in history:
        rec=item.get("recommendation") or {}
        wash=rec.get("wash",{}) if isinstance(rec.get("wash"),dict) else {}
        eco="; ".join(rec.get("eco",[])) if isinstance(rec.get("eco"),list) else ""
        writer.writerow([
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
        ])
    return Response(
        content=output.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition":"attachment; filename=laundryai_history.csv"}
    )

@app.delete("/api/history")
def clear_history(request: Request):
    if firebase_store.enabled():
        try:
            return {"deleted":True,"count":firebase_store.clear_predictions(request_uid(request))}
        except Exception as exc:
            raise HTTPException(503, f"Cloud database is unavailable: {exc}") from exc
    with connection() as db: db.execute("DELETE FROM predictions WHERE owner_uid=?",(request_uid(request),))
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
    history = saved_history()
    feedback_count = sum(1 for item in history if item.get("user_feedback"))
    state=model_status()
    return {
        "admin_email": admin.get("email"),
        "total_scans": len(history),
        "feedback_records": feedback_count,
        "model_ready": state["ready"],
        "model_error": state["error"],
        "persistence": firebase_store.status(),
        "dataset": dataset_stats(),
        "retraining": RETRAIN_STATE,
        "training_available": training_available(),
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
        return {"updated":True,"uid":uid,"disabled":payload.disabled}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503,"Could not update the user status.") from exc

@app.get("/api/admin/feedback")
def admin_feedback(request: Request):
    require_admin(request)
    if firebase_store.enabled():
        try:
            items=firebase_store.list_feedback("pending")
        except Exception as exc:
            raise HTTPException(503, f"Cloud feedback queue is unavailable: {exc}") from exc
        return {"count":len(items),"items":[{
            "id":item["id"], "fabric":item["confirmed_fabric"],
            "file":item["id"], "filename":item.get("filename"),
            "original_fabric":item.get("original_fabric"),
            "created_at":item.get("created_at"),
            "image_url":f"/api/admin/feedback/{item['confirmed_fabric']}/{item['id']}/image",
        } for item in items]}
    pending=[]
    base=os.path.join(DATA_DIR,"review_pending")
    for fabric_name in [*FABRICS.keys(), NON_FABRIC]:
        folder=os.path.join(base,fabric_name)
        if os.path.isdir(folder):
            pending.extend({"fabric":fabric_name,"file":name} for name in sorted(os.listdir(folder)) if name.lower().endswith((".jpg",".jpeg",".png",".webp")))
    return {"count":len(pending),"items":pending}

@app.get("/api/admin/feedback/{fabric_name}/{filename}/image")
def admin_feedback_image(fabric_name: str, filename: str, request: Request):
    require_admin(request)
    if fabric_name not in FABRICS and fabric_name != NON_FABRIC: raise HTTPException(422,"Invalid fabric label.")
    if firebase_store.enabled():
        try:
            content=firebase_store.feedback_image(os.path.basename(filename))
        except Exception as exc:
            raise HTTPException(503, f"Could not load feedback image: {exc}") from exc
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
            raise HTTPException(503, f"Could not approve feedback: {exc}") from exc
        if not item: raise HTTPException(404,"Pending feedback image not found.")
        return {"approved":True,"fabric":item["confirmed_fabric"],"file":item["filename"]}
    source=os.path.join(DATA_DIR,"review_pending",fabric_name,safe_name)
    if not os.path.isfile(source): raise HTTPException(404,"Pending feedback image not found.")
    target_dir=os.path.join(DATA_DIR,"train",fabric_name)
    os.makedirs(target_dir,exist_ok=True)
    target=os.path.join(target_dir,safe_name)
    shutil.move(source,target)
    return {"approved":True,"fabric":fabric_name,"file":safe_name}

@app.delete("/api/admin/feedback/{fabric_name}/{filename}")
def reject_feedback(fabric_name: str, filename: str, request: Request):
    admin=require_admin(request)
    if fabric_name not in FABRICS and fabric_name != NON_FABRIC: raise HTTPException(422,"Invalid fabric label.")
    if firebase_store.enabled():
        try:
            item=firebase_store.review_feedback(os.path.basename(filename),str(admin.get("uid")),False)
        except Exception as exc:
            raise HTTPException(503, f"Could not reject feedback: {exc}") from exc
        if not item: raise HTTPException(404,"Pending feedback image not found.")
        return {"rejected":True}
    source=os.path.join(DATA_DIR,"review_pending",fabric_name,os.path.basename(filename))
    if not os.path.isfile(source): raise HTTPException(404,"Pending feedback image not found.")
    os.remove(source)
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
    "message": "Ready to train on active learning dataset."
}

def training_available():
    return os.getenv("ENABLE_RETRAINING", "false").lower() == "true" and all(
        os.path.isdir(os.path.join(DATA_DIR, split)) for split in ("train", "val", "test")
    )

def _run_training_job():
    global RETRAIN_STATE
    import subprocess, sys
    try:
        script_path = os.path.join(os.path.dirname(__file__), "..", "scripts", "train.py")
        candidate_dir=os.path.join(os.path.dirname(MODEL_PATH),"candidates")
        os.makedirs(candidate_dir,exist_ok=True)
        candidate_path=os.path.join(candidate_dir,f"fabric_candidate_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.pt")
        cmd = [sys.executable, script_path, "--data", DATA_DIR, "--epochs", "5", "--batch-size", "16", "--output", candidate_path]
        RETRAIN_STATE["status"] = "running"
        RETRAIN_STATE["started_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        RETRAIN_STATE["message"] = "Retraining MobileNetV2 on verified dataset..."
        proc = subprocess.run(cmd, capture_output=True, text=True, cwd=os.path.join(os.path.dirname(__file__), ".."))
        if proc.returncode == 0:
            RETRAIN_STATE["status"] = "completed"
            RETRAIN_STATE["completed_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            RETRAIN_STATE["message"] = "Candidate model trained. Review its held-out metrics before promotion."
            RETRAIN_STATE["candidate_path"] = os.path.basename(candidate_path)
        else:
            RETRAIN_STATE["status"] = "failed"
            RETRAIN_STATE["completed_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            RETRAIN_STATE["message"] = f"Training failed: {proc.stderr[:200]}"
    except Exception as e:
        RETRAIN_STATE["status"] = "failed"
        RETRAIN_STATE["completed_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        RETRAIN_STATE["message"] = f"Error during training: {str(e)}"

@app.post("/api/retrain", summary="Trigger continuous active learning model retraining")
def trigger_retrain(request: Request):
    require_admin(request)
    import threading
    if not training_available():
        raise HTTPException(409, "Retraining is disabled or the train/val/test dataset is incomplete.")
    if RETRAIN_STATE["status"] == "running":
        raise HTTPException(409, "Model retraining is already running.")
    worker = threading.Thread(target=_run_training_job, daemon=True)
    worker.start()
    return {
        "status": "started",
        "message": "Asynchronous retraining job dispatched across active learning dataset.",
        "started_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    }

@app.get("/api/retrain/status", summary="Get model retraining job status")
def retrain_status(request: Request):
    require_admin(request)
    return RETRAIN_STATE

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
