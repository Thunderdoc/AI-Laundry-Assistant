# LaundryAI operations

LaundryAI is designed to operate without Codex. Vercel serves the browser app,
Render serves the FastAPI inference API, Firebase provides authentication,
Supabase provides durable private storage (Postgres + Storage), and an
administrator controls training releases.

## Image and feedback lifecycle

1. A signed-in user uploads an image to `/api/predict`.
2. The API validates, normalizes, and predicts the image. Supabase Storage saves
   it under `private-uploads/<uid>/<prediction-id>.jpg`; Supabase Postgres stores
   the prediction metadata with the same owner UID.
3. If the user corrects the result, Supabase copies the image to
   `feedback-pending/<confirmed-label>/...`. It is not training data yet.
4. The Admin Review Queue displays pending corrections. Approval copies the
   image to `training-approved/<confirmed-label>/...`; rejection excludes it.
5. A training job uses the fixed baseline train/validation/test splits plus
   reviewed additions. The GPU only holds temporary tensors in VRAM; Supabase
   remains the durable source of truth.
6. Training produces a separate candidate model and manifest. The live model is
   unchanged until the release gates pass and an administrator promotes it.

Concurrent users cannot overwrite one another: prediction IDs are unique and
all history operations are scoped to the authenticated Firebase UID.

## Local RTX GPU training

From the repository root:

```powershell
python backend/scripts/train.py --data data --epochs 20 --freeze-epochs 2 --batch-size 24 --patience 5 --output backend/models/candidates/fabric_candidate.pt
python backend/scripts/promote_candidate.py --candidate backend/models/candidates/fabric_candidate.pt
```

The second command is a dry-run gate. Only if it passes:

```powershell
python backend/scripts/promote_candidate.py --candidate backend/models/candidates/fabric_candidate.pt --apply
git add backend/backend/models/fabric_mobilenetv2.pt backend/backend/models/fabric_mobilenetv2.manifest.json
git commit -m "Promote evaluated fabric model"
git push
```

Render then deploys the versioned model. Never replace it merely because more
images exist; require improved test accuracy and macro-F1 with no material
per-class recall regression.

Ensemble promotion is a manifest + parts change instead: edit
`backend/backend/models/fabric_ensemble.manifest.json` (member list + weights)
and ship the new member's md5-verified parts directory; no code change. The
ensemble activates only when every member's parts are present and verify —
a partial landing keeps the previous single-model chain serving.

## Required Render configuration

- `ADMIN_EMAILS`
- `CORS_ORIGINS` — `https://ai-laundry-assistant-thunderdoc.vercel.app`
- `PERSISTENCE_BACKEND=supabase`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_BUCKET`
- `FIREBASE_SERVICE_ACCOUNT_JSON_B64` (preferred: one-line Base64 of the complete downloaded JSON file)
- `FIREBASE_SERVICE_ACCOUNT_JSON` (raw JSON alternative; do not configure both)
- `PYTHON_VERSION=3.11.11`

The Firebase service-account credential is still required: the server uses it
to verify Firebase ID tokens, even though durable storage is Supabase.
`FIREBASE_DATABASE_URL` and `FIREBASE_STORAGE_BUCKET` are needed only for the
legacy Firebase persistence path (`PERSISTENCE_BACKEND=firebase`).

Do **not** set `MODEL_PATH` on the production service: an explicit `MODEL_PATH`
disables the combo G ensemble and serves a single model instead. With
`MODEL_PATH` unset, the server loads the tracked ensemble (manifest + verified
parts under `backend/backend/models/`). The Python version is pinned to
3.11.11 in `backend/.python-version` and in the `Dockerfile`
(`python:3.11-slim`); Render's newer Python defaults are incompatible with
this TorchScript runtime.

For local training through the API also set `ENABLE_RETRAINING=true`. Render's
free CPU instance should keep this false. For a separate GPU worker use
`EXTERNAL_TRAINING_URL`, `EXTERNAL_TRAINING_TOKEN`, `PUBLIC_API_URL`, and
`TRAINING_CALLBACK_TOKEN`.

## Improvement policy

Collect diverse, correctly labelled examples—especially underrepresented and
difficult classes. Keep validation and test images separate from user training
feedback. Retrain periodically after enough approved samples accumulate, compare
the candidate against the deployed manifest, and promote only a measured win.
