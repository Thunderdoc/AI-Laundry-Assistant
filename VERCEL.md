# Vercel deployment: frontend

This Vercel configuration deploys the React website. The current ML API should run separately on a persistent container host (AWS App Runner/ECS, Render, Railway, or a VM), because model inference, uploaded images, and SQLite are not suitable for a stateless static Vercel deployment.

The live site is https://ai-laundry-assistant-thunderdoc.vercel.app, served from the `ai-laundry-assistant` Vercel project (GitHub repo `Thunderdoc/AI-Laundry-Assistant`, framework Vite).

## Deploy the website

1. Push this project to GitHub and import it into Vercel, or run `vercel` from this project folder.
2. In Vercel's project settings, set the **Root Directory** to `frontend`. The Vercel build commands then run directly inside that folder.
3. Before deploying, add `VITE_API_URL` in Vercel → Project → Settings → Environment Variables. For this project use `https://ai-laundry-assistant.onrender.com/api`.
4. Redeploy. The frontend will send prediction and Firebase requests to that backend.

## Deploy the API

Build and deploy the Docker image using the existing `Dockerfile` to a container host. Give the API its own HTTPS URL and set `CORS_ORIGINS` there to your Vercel URL (for this project: `https://ai-laundry-assistant-thunderdoc.vercel.app`). Set the Supabase variables (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET`, `PERSISTENCE_BACKEND=supabase`) and the `FIREBASE_SERVICE_ACCOUNT_JSON` secret on the API host. Firebase Auth still verifies sign-ins; only durable storage moved to Supabase.

## Firebase after Vercel

When Vercel gives you `https://your-project.vercel.app`, add `your-project.vercel.app` in Firebase Authentication → Settings → Authorized domains, then enable Google and Email/Password.

To enable the login page before the API is deployed, add these **Production** environment variables in Vercel from Firebase Console → Project settings → Your apps → Web app configuration: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, and `VITE_FIREBASE_APP_ID`. Redeploy after saving them.

Do not put `FIREBASE_SERVICE_ACCOUNT_JSON` in Vercel. It is a private backend-only secret.

## Verify this deployment

Open `https://ai-laundry-assistant.onrender.com/api/health` first. Connect or redeploy the frontend only when it reports `"model_ready": true` and `"persistence": {"backend": "supabase", "configured": true, ...}`. The backend now includes a `model_error` field whenever model validation fails. Do **not** set `MODEL_PATH` on Render: an explicit `MODEL_PATH` disables the combo G ensemble and serves a single model instead. With `MODEL_PATH` unset, the server loads the tracked ensemble (manifest + md5-verified parts under `backend/backend/models/`).

Render currently defaults new Python services to Python 3.14, which is incompatible with this TorchScript runtime. This repository pins `backend/.python-version` to `3.11.11`. Also set `PYTHON_VERSION=3.11.11` in the Render service environment so it takes precedence, then rebuild without relying on the old Python 3.14 environment.

## Persistence: Supabase (live)

The live backend stores predictions in Supabase Postgres and images in Supabase Storage. On Render, set `PERSISTENCE_BACKEND=supabase` with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_BUCKET`. Firebase Auth still handles sign-in; only durable storage moved. If any required value is missing, `/api/health` reports a degraded persistence configuration instead of silently losing records to Render's temporary disk.

The Firebase Realtime Database path (`PERSISTENCE_BACKEND=firebase` with `FIREBASE_DATABASE_URL`, `FIREBASE_STORAGE_BUCKET`, and a service-account credential) is the legacy alternative — see `docs/18_firebase_persistence_setup.md`.
