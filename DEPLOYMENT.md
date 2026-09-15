# Deploy LaundryAI

## 1. Configure Firebase

1. Create a Firebase project at https://console.firebase.google.com.
2. Add a **Web app** and copy its configuration values to the deployment environment using the names in `.env.example`.
3. Under **Authentication → Sign-in method**, enable **Google** and **Email/Password**.
4. Under **Authentication → Settings → Authorized domains**, add `localhost`, `127.0.0.1`, and your final deployment domain.
5. Create a Firebase Admin SDK service account. Keep its JSON private: set `FIREBASE_SERVICE_ACCOUNT_FILE` to its absolute path locally, or inject the complete JSON into `FIREBASE_SERVICE_ACCOUNT_JSON` from AWS Secrets Manager. Never commit it.

The browser uses Firebase only to sign the user in. The server verifies each Firebase ID token before providing prediction, history, feedback, metrics, or retraining endpoints.

## 2. Build and run locally

Install backend dependencies once:

```powershell
cd backend
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
cd ..
```

Set the Firebase environment variables for the current PowerShell session, then run `run-production.bat`. Open http://127.0.0.1:8000. The production server serves both the built React UI and the API from one origin.

## 3. Container deployment

Build the UI first, then build the image:

```powershell
cd frontend
npm run build
cd ..
docker build -t laundryai .
docker run --rm -p 8000:8000 -v "${PWD}\runtime-data:/data" --env-file .env laundryai
```

Your hosting provider must inject the service-account JSON as a secret (`FIREBASE_SERVICE_ACCOUNT_JSON`) or mount it as a secret file (`FIREBASE_SERVICE_ACCOUNT_FILE`). Configure `CORS_ORIGINS` with the final HTTPS origin if the API is deployed separately.

## 4. AWS checklist

Deploy the image to an AWS service that can run containers, such as ECS/Fargate, App Runner, or Elastic Beanstalk. Store `FIREBASE_SERVICE_ACCOUNT_JSON` in AWS Secrets Manager and inject it into the running service; do not add it to the Docker image or Git repository. Once AWS gives you an HTTPS domain:

1. Firebase Console → Authentication → Settings → **Authorized domains** → add the hostname only (for example, `laundryai.example.com`, without `https://`).
2. Firebase Console → Authentication → Sign-in method → enable **Google** and **Email/Password**.
3. Add the six `FIREBASE_*` web settings and the server secret to the AWS service environment, then redeploy/restart it.

The Firebase web configuration is not a password; it is intentionally sent to the browser. The Firebase service-account JSON is private and must only be available to the backend.
