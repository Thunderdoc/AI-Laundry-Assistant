# 🧺 LaundryAI

AI-powered fabric-care assistant — live at https://ai-laundry-assistant-thunderdoc.vercel.app. Upload or photograph a garment and the app identifies the fabric (cotton, polyester, denim, wool, silk — or non-fabric) and returns wash/dry/iron care guidance from a documented textile knowledge base. No heuristic fallback is used: low-certainty answers return `unknown` instead of a guessed fabric.

## Live

- **App:** https://ai-laundry-assistant-thunderdoc.vercel.app
- **API:** https://ai-laundry-assistant.onrender.com/api (`/api/health` reports `model_ready` and persistence status)
- **Shipped model:** combo G ensemble — `ensemble-g-20261108` (EfficientNet-B2 + EfficientNet-B0 + MobileNetV2, 6 models, weighted probability averaging). Measured: **84.84%** clean test accuracy (277 held-out images), **68.03%** on real phone photos (513 images), **65.11%** in dim light (513 images). Full numbers: `docs/MODEL_CARD.md` and `backend/backend/models/fabric_ensemble.manifest.json`.

## Run

Windows quick start (double-click):

```text
run-laundryai.bat
```

This opens two command windows (backend + frontend) automatically.

```powershell
cd backend; python -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt; .\.venv\Scripts\uvicorn app.main:app --reload
cd frontend; npm install; npm run dev
```

Open `http://localhost:5173`; API documentation is at `http://127.0.0.1:8000/docs`.

Python 3.11.11 (see `backend/.python-version`); Node >= 20.19 (see `frontend/package.json`).

## Architecture

Image validation → combo G ensemble inference (five-crop average) → confidence + top-2 margin gate (`unknown` for low certainty) + explicit `non_fabric` class → documented fabric knowledge base → rule-based care and eco recommendations → history/analytics. Sign-in is Firebase Auth; durable records live in Supabase (Postgres + Storage). SQLite/local folders remain the development fallback.

## Features

- **Analyze** — upload/camera scan, pre-flight image quality checks, confidence + probability distribution, care profile (wash/dry/iron/detergent/bleach), stain guide, smart dosing, active-learning feedback.
- **My Scans** — personal history with search, confidence filters, note editing, favorites, care reminders, CSV export, and a rule-based wash-load planner.
- **Care Guide** — per-fabric spec sheets, comparison matrix, and an ISO 3758 care-symbol reference.
- **Assistant** — optional bring-your-own-key fabric-care chat (any OpenAI-compatible endpoint; the key stays in the browser and goes only to the endpoint you choose).
- **Model transparency** — live KPIs, dataset growth, confusion matrix, per-class metrics.
- **Admin console** — compact 4-tab console: overview (4 KPIs + trends + recent activity), review queue (approve/reject user corrections), user management, model release. Requires a verified Firebase `admin` claim or the server-side `ADMIN_EMAILS` allowlist.
- **°C/°F toggle and EN/ES/DE/FR interface language** for the customer UI.

See `docs/IMPROVEMENT_PLAN.md` for the full research report, feature-gap analysis, and phased roadmap (including deliberately deferred model work: care-label OCR, stain detection, push notifications).

## Persistence

The live backend uses Supabase: set `PERSISTENCE_BACKEND=supabase` together with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_BUCKET`. Firebase Auth stays the sign-in provider either way. The Firebase Realtime Database path (`PERSISTENCE_BACKEND=firebase`) is the legacy alternative — see `docs/18_firebase_persistence_setup.md` before switching it on.

## Shipped model

The trained ensemble ships in this repo — no artifact needs supplying. The serving model is defined by `backend/backend/models/fabric_ensemble.manifest.json` (member parts live beside it in `fabric_ens_*_parts/` and `fabric_v2_parts/`); the server assembles and md5-verifies the members at startup, and falls back to the exp-3 single model, then the bundled v1 MobileNetV2, if any member is missing or corrupt. Do **not** set `MODEL_PATH` in production: an explicit `MODEL_PATH` disables the ensemble and serves a single model instead. `backend/models/` holds only a manifest copy — `.pt` files are git-ignored there, which is why the tracked weights live under `backend/backend/models/`.

## Train a real model

Prepare `data/train`, `data/val`, and `data/test`, each with exactly `cotton`, `polyester`, `denim`, `wool`, `silk`, and `non_fabric` folders. The `non_fabric` class should include objects/scenes that are not cloth so the model can reject cheating inputs. On a PyTorch-supported Python version, run:

```powershell
python backend/scripts/train.py --data data --epochs 8
```

It exports a TorchScript model plus an evaluation manifest. Do not report metrics before this command finishes on a held-out test set.
