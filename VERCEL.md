# Vercel deployment: frontend

This Vercel configuration deploys the React website. The current ML API should run separately on a persistent container host (AWS App Runner/ECS, Render, Railway, or a VM), because model inference, uploaded images, and SQLite are not suitable for a stateless static Vercel deployment.

## Deploy the website

1. Push this project to GitHub and import it into Vercel, or run `vercel` from this project folder.
2. In Vercel's project settings, set the **Root Directory** to `frontend`. The Vercel build commands then run directly inside that folder.
3. Before deploying, add `VITE_API_URL` in Vercel → Project → Settings → Environment Variables. For this project use `https://ai-laundry-assistant.onrender.com/api`.
4. Redeploy. The frontend will send prediction and Firebase requests to that backend.

## Deploy the API

Build and deploy the Docker image using the existing `Dockerfile` to a container host. Give the API its own HTTPS URL and set `CORS_ORIGINS` there to your Vercel URL (for example `https://laundryai.vercel.app`). Set all Firebase variables and the `FIREBASE_SERVICE_ACCOUNT_JSON` secret on the API host.

## Firebase after Vercel

When Vercel gives you `https://your-project.vercel.app`, add `your-project.vercel.app` in Firebase Authentication → Settings → Authorized domains, then enable Google and Email/Password.

To enable the login page before the API is deployed, add these **Production** environment variables in Vercel from Firebase Console → Project settings → Your apps → Web app configuration: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, and `VITE_FIREBASE_APP_ID`. Redeploy after saving them.

Do not put `FIREBASE_SERVICE_ACCOUNT_JSON` in Vercel. It is a private backend-only secret.

## Verify this deployment

Open `https://ai-laundry-assistant.onrender.com/api/health` first. Connect or redeploy the frontend only when it reports `"model_ready": true`. The backend now includes a `model_error` field whenever model validation fails. On Render, set `MODEL_PATH=backend/models/fabric_mobilenetv2.pt`; the API also falls back to the tracked bundled model if a stale configured path does not exist.

Render currently defaults new Python services to Python 3.14, which is incompatible with this TorchScript runtime. This repository pins `backend/.python-version` to `3.11.11`. Also set `PYTHON_VERSION=3.11.11` in the Render service environment so it takes precedence, then rebuild without relying on the old Python 3.14 environment.
