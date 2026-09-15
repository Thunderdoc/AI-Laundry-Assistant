"""Download administrator-approved Firebase feedback into an offline dataset.

Run this on the training machine, never in the Render web service:
python backend/scripts/export_approved_feedback.py --output data/train
"""
import argparse
import json
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()
parser=argparse.ArgumentParser()
parser.add_argument("--output", default="data/train")
parser.add_argument("--overwrite", action="store_true")
args=parser.parse_args()

account_json=os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
account_file=os.getenv("FIREBASE_SERVICE_ACCOUNT_FILE", "").strip()
bucket_name=os.getenv("FIREBASE_STORAGE_BUCKET", "").strip()
if not bucket_name or not (account_json or account_file):
    raise SystemExit("Firebase service account and FIREBASE_STORAGE_BUCKET are required.")

import firebase_admin
from firebase_admin import credentials, storage

credential=credentials.Certificate(json.loads(account_json) if account_json else account_file)
app=firebase_admin.initialize_app(credential) if not firebase_admin._apps else firebase_admin.get_app()
bucket=storage.bucket(bucket_name, app=app)
destination=Path(args.output)
downloaded=skipped=0
for blob in bucket.list_blobs(prefix="training-approved/"):
    parts=blob.name.split("/", 2)
    if len(parts) != 3 or not parts[2]: continue
    target=destination / parts[1] / Path(parts[2]).name
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and not args.overwrite:
        skipped+=1
        continue
    blob.download_to_filename(str(target))
    downloaded+=1
print(json.dumps({"downloaded":downloaded,"skipped":skipped,"output":str(destination.resolve())},indent=2))
