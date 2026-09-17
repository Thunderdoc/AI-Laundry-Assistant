# LaundryAI Modal GPU worker

This worker accepts a small authenticated job request, schedules the existing
`backend/scripts/train.py` on a Modal T4 GPU, preserves candidate artifacts in a
Modal Volume, and POSTs a signed completion/failure event to the backend.

## 1. Install and authenticate

Run from the repository root:

```powershell
py -m pip install -r training/requirements.txt
py -m modal setup
```

## 2. Create the private worker configuration

Generate two independent random values (at least 32 bytes each), then create a
two Modal Secrets. Never commit or put these values in a job payload. Keeping
the public endpoint token separate means its container never receives dataset
or callback credentials.

```powershell
py -m modal secret create laundryai-training-api `
  WORKER_API_TOKEN="<random-api-token>"

py -m modal secret create laundryai-training-runtime `
  CALLBACK_SIGNING_SECRET="<different-random-signing-secret>" `
  CALLBACK_URL="https://your-backend.example/api/admin/training/callback" `
  DATASET_ALLOWED_HOSTS="storage.googleapis.com" `
  DATASET_BEARER_TOKEN="<private-storage-token>" `
  MAX_DATASET_BYTES="8589934592"
```

Omit `DATASET_BEARER_TOKEN` when the archive is public. The submitted
dataset URL must not contain credentials. Restrict `DATASET_ALLOWED_HOSTS` to the
exact object-storage hosts you control.

## 3. Deploy

```powershell
py -m modal deploy training/modal_worker.py
```

Modal prints the permanent `submit_training` URL. Store it and the API token as
secrets in the backend provider.

## 4. Submit a training job

The archive must contain exactly one ImageFolder root with `train`, `val`, and
`test` folders. Each split must contain the six class folders expected by the
repository training script.

```powershell
$headers = @{ Authorization = "Bearer $env:LAUNDRYAI_WORKER_TOKEN" }
$body = @{
  job_id = "release-2026-09-16-001"
  dataset = @{
    url = "https://storage.googleapis.com/your-private-bucket/dataset.zip"
    sha256 = "<64-character-lowercase-sha256>"
    archive = "zip"
  }
  epochs = 20
  batch_size = 32
} | ConvertTo-Json -Depth 4
Invoke-RestMethod -Method Post -Uri $env:LAUNDRYAI_MODAL_URL -Headers $headers -ContentType "application/json" -Body $body
```

The endpoint immediately returns HTTP 200 with `accepted`, `job_id`, and a Modal
`call_id`. The GPU work continues asynchronously.

## Callback verification and artifacts

Verify the exact raw request body with `verify_training_callback` and the
`X-LaundryAI-Timestamp` / `X-LaundryAI-Signature` headers before parsing JSON.
Reject callbacks older than five minutes and deduplicate by
`X-LaundryAI-Event-ID`. The signature input is `timestamp + "." + raw_body` and
uses HMAC-SHA256.

Artifacts remain in the `laundryai-training-artifacts` Volume under
`jobs/<job_id>/candidate/`. A candidate is never promoted automatically; the
backend/admin release gate should compare its metrics before deployment.
