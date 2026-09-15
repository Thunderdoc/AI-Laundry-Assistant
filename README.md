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

Image validation → trained model (when supplied) → confidence + top-2 margin gate (`unknown` for low certainty) + explicit `non_fabric` class → documented fabric knowledge base → rule-based care and eco recommendations → history/analytics.

The current repository contains validated upload handling, a structured five-fabric knowledge base, API contract, responsive analysis interface, and honest model/metrics gates. Add the trained artifact at the configured `MODEL_PATH`, alongside a label-order and preprocessing manifest, before enabling inference.

## Train a real model

Prepare `data/train`, `data/val`, and `data/test`, each with exactly `cotton`, `polyester`, `denim`, `wool`, `silk`, and `non_fabric` folders. The `non_fabric` class should include objects/scenes that are not cloth so the model can reject cheating inputs. On a PyTorch-supported Python version, run:

```powershell
python backend/scripts/train.py --data data --epochs 8
```

It exports a TorchScript model plus an evaluation manifest. Do not report metrics before this command finishes on a held-out test set.
