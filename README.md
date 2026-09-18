# 🧺 LaundryAI

Experimental AI-powered fabric-care assistant. The system deliberately refuses prediction until a trained, exported MobileNetV2 artifact and its preprocessing/class manifest are supplied. No heuristic fallback is used, so inference failures are surfaced instead of returning fabricated classifications.

## Run

Windows quick start (double-click):

```text
run-laundryai.bat (or run-laundraai.bat)
```

This opens two command windows (backend + frontend) automatically.

```powershell
cd backend; python -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt; .\.venv\Scripts\uvicorn app.main:app --reload
cd frontend; npm install; npm run dev
```

Open `http://localhost:5173`; API documentation is at `http://127.0.0.1:8000/docs`.

## Architecture

Image validation → trained model (when supplied) → confidence + top-2 margin gate (`unknown` for low certainty) + explicit `non_fabric` class → documented fabric knowledge base → rule-based care and eco recommendations → history/analytics. Production can use Firebase Realtime Database and Firebase Storage through the backend; SQLite/local folders remain the development fallback.

## Features

- **Analyze** — upload/camera scan, pre-flight image quality checks, confidence + probability distribution, care profile (wash/dry/iron/detergent/bleach), stain guide, smart dosing, active-learning feedback.
- **My Scans** — personal history with search, confidence filters, note editing, favorites, care reminders, CSV export, and a rule-based wash-load planner.
- **Care Guide** — per-fabric spec sheets, comparison matrix, and an ISO 3758 care-symbol reference.
- **Assistant** — optional bring-your-own-key fabric-care chat (any OpenAI-compatible endpoint; the key stays in the browser and goes only to the endpoint you choose).
- **Model transparency** — live KPIs, dataset growth, confusion matrix, per-class metrics.
- **Admin console** — compact 4-tab console: overview (4 KPIs + trends + recent activity), review queue (approve/reject user corrections), user management, model release. Requires a verified Firebase `admin` claim or the server-side `ADMIN_EMAILS` allowlist.
- **°C/°F toggle and EN/ES/DE/FR interface language** for the customer UI.

See `docs/IMPROVEMENT_PLAN.md` for the full research report, feature-gap analysis, and phased roadmap (including deliberately deferred model work: care-label OCR, stain detection, push notifications).

Set `PERSISTENCE_BACKEND=firebase` together with the backend `FIREBASE_DATABASE_URL`, storage bucket, and service-account credential to enable durable cloud records. See `docs/18_firebase_persistence_setup.md` before switching it on.

The current repository contains validated upload handling, a structured five-fabric knowledge base, API contract, responsive analysis interface, and honest model/metrics gates. Add the trained artifact at the configured `MODEL_PATH`, alongside a label-order and preprocessing manifest, before enabling inference.

## Train a real model

Prepare `data/train`, `data/val`, and `data/test`, each with exactly `cotton`, `polyester`, `denim`, `wool`, `silk`, and `non_fabric` folders. The `non_fabric` class should include objects/scenes that are not cloth so the model can reject cheating inputs. On a PyTorch-supported Python version, run:

```powershell
python backend/scripts/train.py --data data --epochs 8
```

It exports a TorchScript model plus an evaluation manifest. Do not report metrics before this command finishes on a held-out test set.
