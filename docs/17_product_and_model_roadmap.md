# LaundryAI product, backend, and model roadmap

## Current system status

The application is split into a React/Vite frontend on Vercel and a FastAPI model API on Render. Firebase Authentication provides email/password and Google sign-in. The backend can use Firebase Realtime Database as the canonical prediction/feedback store and Firebase Storage for private images. It verifies Firebase ID tokens, scopes history by Firebase UID, and grants administrator access only to verified emails in the server-side `ADMIN_EMAILS` allowlist. SQLite and local image folders remain a development/test fallback.

The repository contains a tracked TorchScript model and manifest. Runtime health performs a real CPU load and sample forward pass. The tracked deployment manifest reports 76.24% test accuracy on 282 images. Treat this as an artifact-declared result until the original split and evaluation are independently reproduced; the next candidate must also report macro F1 and stronger per-class/OOD evaluation.

## Implemented active-learning loop

1. A signed-in user uploads a garment image.
2. The API validates the image, runs the TorchScript model, ranks classes, and applies confidence and top-two-margin rejection gates.
3. The result is stored under the authenticated user's UID.
4. The user confirms or corrects the result.
5. The image is copied to `review_pending/<label>` and is not used for training yet.
6. A verified administrator reviews the queue and approves or rejects each item.
7. Approved images move to `train/<label>`.
8. Retraining can run only when `ENABLE_RETRAINING=true` and train/validation/test folders exist.
9. While a job is running, the admin UI polls status every five seconds; polling stops automatically when the job finishes or the page unmounts.
10. Training exports a candidate model. It never replaces the live model automatically. A candidate is promoted only after its held-out metrics, confusion matrix, class balance, latency, and regression checks pass.

This loop protects the dataset from incorrect labels and prevents a weak candidate from silently replacing production inference.

## Production deployment checklist

### Render backend

- Root Directory: `backend`
- Build Command: `pip install -r requirements.txt`
- Start Command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- `PYTHON_VERSION=3.11.11` (prevents Render's Python 3.14 default from breaking TorchScript)
- `MODEL_PATH=backend/models/fabric_mobilenetv2.pt`
- `CORS_ORIGINS=https://ai-laundry-assistant-thunderdoc.vercel.app`
- `ADMIN_EMAILS=<verified-admin-email>` (for this deployment, use the email selected by the project owner)
- Firebase web config: `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_APP_ID`
- `FIREBASE_DATABASE_URL=https://laundry-ai-70989-default-rtdb.asia-southeast1.firebasedatabase.app`
- Backend secret: `FIREBASE_SERVICE_ACCOUNT_JSON` containing the complete service-account JSON on one line
- `PERSISTENCE_BACKEND=firebase` enables durable records and image storage. Set this only after the database URL, bucket, and service-account credential are valid.
- Keep `ENABLE_RETRAINING=false` on the free web service.

After deployment, verify `https://ai-laundry-assistant.onrender.com/api/health`. Required result: `status=ok` and `model_ready=true`. If not, use the returned `model_error`; do not connect the frontend to a degraded model API.

### Vercel frontend

- `VITE_API_URL=https://ai-laundry-assistant.onrender.com/api`
- All `VITE_FIREBASE_*` values, including `VITE_FIREBASE_DATABASE_URL`
- Add every public Vercel hostname actually used by visitors to Firebase Authentication authorized domains.
- Redeploy after any environment-variable change.

## Database and storage evolution

The Firebase persistence adapter removes Render's ephemeral filesystem from the production prediction and feedback path. Render's SQLite/filesystem path remains only for local development when `PERSISTENCE_BACKEND=local`.

Next production architecture:

- Firebase Realtime Database: user profiles, predictions, feedback state, audit events, and lightweight notifications.
- Firebase Storage: private uploads, pending-review images, and approved training contributions.
- A managed PostgreSQL migration remains optional later if reporting/query requirements outgrow Realtime Database.
- Object storage lifecycle: automatically delete raw images after a defined retention period unless the user explicitly opts into training contribution.
- Never store base64 image previews in Realtime Database.

Canonical paths are `users`, `predictions`, `feedback`, `modelVersions`, `trainingJobs`, and `auditEvents`. Each prediction records `owner_uid`; each feedback item records its reviewer, decision, and timestamps. The service account is backend-only, so browser database rules never grant global prediction or feedback access.

## Secure administrator capabilities

The admin console should provide only operational powers:

- View aggregate usage and model health, not other users' passwords or Firebase secrets.
- Approve/reject contributed labels.
- Inspect confidence, class balance, and recent errors.
- Start an offline training job and monitor status.
- Compare candidate and production metrics.
- Promote or roll back a model through an audited release action.
- Disable abusive accounts through a protected backend action if later implemented.

Admin identity must always be decided by verified backend claims or an allowlist after token verification. A frontend email comparison alone is not authorization.

## Model improvement programme

### Phase 1 — trustworthy data

- Collect consented, reviewed images across lighting, folds, colors, cameras, backgrounds, blends, and garment types.
- Preserve separate train/validation/test splits by source or contributor to reduce leakage.
- Balance the six classes, including varied `non_fabric` negatives.
- Add duplicate and near-duplicate detection with perceptual hashes.
- Track label provenance and reviewer agreement.

### Phase 2 — stronger evaluation

- Report per-class precision, recall, F1, confusion matrix, calibration error, abstention rate, and accepted-prediction accuracy.
- Add out-of-distribution sets: leather, lace, rayon, linen, mixed fabrics, labels, people, rooms, and household objects.
- Tune confidence thresholds only on validation data.
- Measure CPU latency and peak memory on the actual Render instance.
- Create regression tests from previously misclassified examples.

### Phase 3 — candidate training

- Train on a GPU worker or notebook, not the 512 MB Render web process.
- Use transfer learning, class-balanced sampling, augmentations, early stopping, learning-rate scheduling, and deterministic seeds.
- Export TorchScript plus a versioned manifest containing class order, normalization, dataset fingerprint, code revision, and metrics.
- Promote only if minimum gates pass and no important class regresses beyond the agreed tolerance.

### Phase 4 — advanced recognition

- Add care-label OCR and symbol recognition as a separate signal.
- Introduce blend/multi-label prediction after collecting genuinely labelled blend data.
- Add image-quality guidance before upload: blur, darkness, distance, and framing.
- Explain uncertainty in plain language and always prioritize the physical care label.

## Backend engineering backlog

- Add indexes/denormalized counters as Realtime Database usage grows; consider PostgreSQL only if advanced reporting later requires it.
- Add request IDs, structured logs, rate limiting, upload-size limits, MIME sniffing, and retention jobs.
- Add queued training jobs rather than an in-process thread.
- Version the API and model response schema.
- Add admin audit logs and two-step confirmation for model promotion.
- Add monitoring for error rate, latency, model rejections, class drift, cold starts, and storage growth.
- Add CI for linting, TypeScript build, API tests, security scanning, and model-smoke tests.

## UI/UX and feature roadmap

- Split the current JavaScript bundle by route to remove the >500 kB build warning.
- Add skeleton states for Render cold starts and a clear backend-waking message.
- Add upload progress, crop/rotate, camera capture, image-quality hints, and retry handling.
- Add accessible focus states, keyboard navigation, screen-reader labels, sufficient contrast, and reduced-motion support.
- Keep animation purposeful: short page fades, upload progress, result reveal, and chart transitions; disable them under `prefers-reduced-motion`.
- Improve mobile navigation with a compact menu and thumb-friendly controls.
- Add scan comparison, favorites, care reminders, downloadable care cards, and multilingual guidance.
- Add a transparent privacy/consent control before an image can enter the training-review queue.

## Definition of fully functional

The system is production-ready only when model health is green, Firebase tokens are verified by the backend, user records are isolated, admin actions are protected and audited, uploads are durable, automated tests pass, candidate promotion has measurable gates, and mobile/accessibility checks pass. A successful deployment alone is not enough.
