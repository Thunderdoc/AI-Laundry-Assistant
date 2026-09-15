# Firebase persistence activation

LaundryAI can store production predictions and feedback metadata in Firebase Realtime Database, with private images in Firebase Storage. Local development continues to use SQLite and local folders.

## Before enabling it

Confirm all of the following:

- Firebase Authentication works and the backend service-account key is valid.
- Realtime Database exists at `https://laundry-ai-70989-default-rtdb.asia-southeast1.firebasedatabase.app`.
- Firebase Storage is enabled for the project and the configured bucket exists.
- The exposed service-account key shown previously has been deleted and replaced.

## Render variables

Add these values to the backend service:

```text
FIREBASE_DATABASE_URL=https://laundry-ai-70989-default-rtdb.asia-southeast1.firebasedatabase.app
PERSISTENCE_BACKEND=firebase
```

The following existing variables must also be valid:

```text
FIREBASE_STORAGE_BUCKET=laundry-ai-70989.firebasestorage.app
FIREBASE_SERVICE_ACCOUNT_JSON=<complete private JSON value>
```

Save, rebuild, and deploy. `/api/health` should then contain:

```json
{
  "status": "ok",
  "model_ready": true,
  "persistence": {
    "backend": "firebase",
    "configured": true,
    "reachable": true,
    "database": "realtime-database",
    "image_storage": "firebase-storage"
  }
}
```

## Security rules

The browser needs access only to its own profile path. Predictions, feedback, audit records, and training records are accessed through the authenticated FastAPI backend. Realtime Database rules can remain restrictive:

```json
{
  "rules": {
    "users": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid"
      }
    }
  }
}
```

Firebase Admin SDK bypasses client Security Rules after verifying the server credential. Do not grant public access to `predictions`, `feedback`, or `auditEvents`.

Because all Storage operations now pass through the backend, client Storage rules should deny direct access:

```text
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
```

## Data paths

```text
predictions/{predictionId}
feedback/{feedbackId}
auditEvents/{eventId}
private-uploads/{uid}/{predictionId}.jpg
feedback-pending/{fabric}/{filename}.jpg
training-approved/{fabric}/{filename}.jpg
```

Admin image previews are returned by a protected API endpoint. The browser never receives a public Storage URL.

## Offline training export

After an administrator approves feedback, download it on the trusted training computer:

```text
python backend/scripts/export_approved_feedback.py --output data/train
```

Then review class counts, create source-separated validation/test splits, and run `backend/scripts/train.py`. Training emits a candidate artifact and manifest; it does not replace the deployed model automatically.

## Rollback

If Firebase Database or Storage is not ready, set:

```text
PERSISTENCE_BACKEND=local
```

and redeploy. This restores SQLite/local-folder behavior, but Render-hosted local data is temporary and should not be treated as durable.
