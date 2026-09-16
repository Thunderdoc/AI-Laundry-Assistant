"""Promote a locally trained candidate only when it clears release gates."""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path


def load_json(path: Path) -> dict:
    if not path.is_file():
        raise SystemExit(f"Manifest not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


parser = argparse.ArgumentParser()
parser.add_argument("--candidate", required=True, help="Candidate TorchScript .pt file")
parser.add_argument("--deployed-dir", default="backend/backend/models")
parser.add_argument("--max-recall-drop", type=float, default=0.03)
parser.add_argument("--apply", action="store_true", help="Copy the passing candidate into the deploy bundle")
args = parser.parse_args()

candidate = Path(args.candidate).resolve()
candidate_manifest = candidate.with_suffix(".manifest.json")
deploy_dir = Path(args.deployed_dir).resolve()
deployed = deploy_dir / "fabric_mobilenetv2.pt"
deployed_manifest = deployed.with_suffix(".manifest.json")

if not candidate.is_file():
    raise SystemExit(f"Candidate not found: {candidate}")

new = load_json(candidate_manifest)
current = load_json(deployed_manifest)
failures: list[str] = []
for metric in ("test_accuracy", "macro_f1"):
    new_value = float(new.get(metric, 0))
    current_value = float(current.get(metric, 0))
    if new_value < current_value:
        failures.append(f"{metric}: candidate {new_value:.4f} < deployed {current_value:.4f}")

new_classes = new.get("per_class_metrics") or {}
current_classes = current.get("per_class_metrics") or {}
for label, old_metrics in current_classes.items():
    old_recall = float((old_metrics or {}).get("recall", 0))
    new_recall = float((new_classes.get(label) or {}).get("recall", 0))
    if new_recall < old_recall - args.max_recall_drop:
        failures.append(f"{label} recall: candidate {new_recall:.4f} drops more than {args.max_recall_drop:.2%}")

report = {
    "candidate": str(candidate),
    "passes": not failures,
    "candidate_accuracy": new.get("test_accuracy"),
    "deployed_accuracy": current.get("test_accuracy"),
    "candidate_macro_f1": new.get("macro_f1"),
    "deployed_macro_f1": current.get("macro_f1"),
    "failures": failures,
}
print(json.dumps(report, indent=2))

if failures:
    raise SystemExit(2)
if not args.apply:
    print("Release gates passed. Re-run with --apply to update the deploy bundle.")
    raise SystemExit(0)

deploy_dir.mkdir(parents=True, exist_ok=True)
shutil.copy2(candidate, deployed)
shutil.copy2(candidate_manifest, deployed_manifest)
print(f"Promoted candidate into {deploy_dir}. Commit and deploy these two files.")

