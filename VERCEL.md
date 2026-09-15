# Vercel deployment: frontend

This Vercel configuration deploys the React website. The current ML API should run separately on a persistent container host (AWS App Runner/ECS, Render, Railway, or a VM), because model inference, uploaded images, and SQLite are not suitable for a stateless static Vercel deployment.

## Deploy the website

1. Push this project to GitHub and import it into Vercel, or run `vercel` from this project folder.
2. Vercel reads `vercel.json`; do not change the root directory.
3. Before deploying, add `VITE_API_URL` in Vercel → Project → Settings → Environment Variables. Its value must be your backend URL with `/api`, for example `https://laundryai-api.example.com/api`.
4. Redeploy. The frontend will send prediction and Firebase requests to that backend.

## Deploy the API

Build and deploy the Docker image using the existing `Dockerfile` to a container host. Give the API its own HTTPS URL and set `CORS_ORIGINS` there to your Vercel URL (for example `https://laundryai.vercel.app`). Set all Firebase variables and the `FIREBASE_SERVICE_ACCOUNT_JSON` secret on the API host.

## Firebase after Vercel

When Vercel gives you `https://your-project.vercel.app`, add `your-project.vercel.app` in Firebase Authentication → Settings → Authorized domains, then enable Google and Email/Password.

Do not put `FIREBASE_SERVICE_ACCOUNT_JSON` in Vercel. It is a private backend-only secret.
