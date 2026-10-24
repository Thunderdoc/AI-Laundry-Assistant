"""Honest evaluation of the shipped fabric model on a held-out folder.

Compares the old single-resize inference against the five-crop inference used
by /api/predict, and reports accuracy both overall and on the predictions the
decision gates actually accept. Run from the repo root, e.g.:

    python backend/scripts/evaluate.py --data data/test

The script deliberately reports per-class recall and the unknown rate: a model
that is 90% "accurate" only because it answers "unknown" half the time is not
better than one that answers wrongly with confidence, and vice versa.
"""
import argparse, json, sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "backend"))

parser = argparse.ArgumentParser()
parser.add_argument("--data", default="data/test")
parser.add_argument("--model", default="backend/backend/models/fabric_mobilenetv2.pt")
parser.add_argument("--manifest", default="backend/backend/models/fabric_mobilenetv2.manifest.json")
parser.add_argument("--old-conf", type=float, default=0.35)
parser.add_argument("--old-margin", type=float, default=0.08)
args = parser.parse_args()

manifest = json.loads(Path(args.manifest).read_text())
classes = manifest["classes"]
input_size = manifest.get("input_size", 224)
mean = manifest.get("normalization", {}).get("mean", [0.485, 0.456, 0.406])
std = manifest.get("normalization", {}).get("std", [0.229, 0.224, 0.225])
new_conf, new_margin = manifest.get("min_confidence", 0.55), manifest.get("min_margin", 0.10)

model = torch.jit.load(args.model, map_location="cpu").eval()

def probs_single(im):
    pixels = np.asarray(im.resize((input_size, input_size)), dtype=np.float32) / 255.0
    tensor = torch.from_numpy(pixels).permute(2, 0, 1).unsqueeze(0)
    tensor = (tensor - torch.tensor(mean).view(1, 3, 1, 1)) / torch.tensor(std).view(1, 3, 1, 1)
    with torch.no_grad():
        return torch.softmax(model(tensor), dim=1).squeeze().tolist()

def probs_five_crop(im):
    scale = max(input_size, int(round(input_size * 1.14)))
    w, h = im.size
    if w < input_size or h < input_size:
        crops = [im.resize((input_size, input_size))]
    else:
        resized = im.resize((scale, int(round(h * scale / w)))) if w <= h else im.resize((int(round(w * scale / h)), scale))
        rw, rh = resized.size
        boxes = [(0, 0, input_size, input_size), (rw - input_size, 0, rw, input_size),
                 (0, rh - input_size, input_size, rh), (rw - input_size, rh - input_size, rw, rh),
                 ((rw - input_size) // 2, (rh - input_size) // 2,
                  (rw - input_size) // 2 + input_size, (rh - input_size) // 2 + input_size)]
        crops = [resized.crop(b) for b in boxes]
    tensors = [torch.from_numpy(np.asarray(c, dtype=np.float32) / 255.0).permute(2, 0, 1) for c in crops]
    batch = torch.stack(tensors)
    batch = (batch - torch.tensor(mean).view(1, 3, 1, 1)) / torch.tensor(std).view(1, 3, 1, 1)
    with torch.no_grad():
        return torch.softmax(model(batch), dim=1).mean(dim=0).tolist()

def summarise(name, rows, conf_gate, margin_gate):
    total = len(rows)
    per_class = defaultdict(lambda: [0, 0])
    accepted, accepted_correct = 0, 0
    for true, probs in rows:
        ranked = sorted(range(len(probs)), key=lambda i: probs[i], reverse=True)
        pred = classes[ranked[0]]
        conf, margin = probs[ranked[0]], probs[ranked[0]] - probs[ranked[1]]
        per_class[true][1] += 1
        if pred == true:
            per_class[true][0] += 1
        if conf >= conf_gate and margin >= margin_gate and pred != "non_fabric":
            accepted += 1
            accepted_correct += int(pred == true)
        elif conf >= conf_gate and margin >= margin_gate and pred == "non_fabric":
            accepted += 1
            accepted_correct += int(pred == true)
    overall = sum(v[0] for v in per_class.values()) / max(1, total)
    print(f"\n== {name} (gates conf>={conf_gate}, margin>={margin_gate}) ==")
    print(f"images={total} overall_top1={overall:.4f} accepted={accepted} ({accepted/max(1,total):.1%}) "
          f"accuracy_on_accepted={accepted_correct/max(1,accepted):.4f} unknown_rate={1-accepted/max(1,total):.1%}")
    for cls in classes:
        good, n = per_class[cls]
        print(f"  {cls:12} recall={'n/a (no held-out images)' if n == 0 else f'{good/n:.4f}'}  ({good}/{n})")
    return {"method": name, "images": total, "overall_top1": round(overall, 4),
            "accepted": accepted, "accuracy_on_accepted": round(accepted_correct / max(1, accepted), 4),
            "unknown_rate": round(1 - accepted / max(1, total), 4),
            "per_class_recall": {c: (None if per_class[c][1] == 0 else round(per_class[c][0] / per_class[c][1], 4)) for c in classes}}

rows_single, rows_five = [], []
data = Path(args.data)
denylist_path = data.parent / "quarantine_leaked" / "non_fabric" / "LEAKED_FILES.txt"
denylisted = {line.strip() for line in denylist_path.read_text(encoding="utf-8").splitlines() if line.strip()} if denylist_path.is_file() else set()
skipped = 0
for cls in classes:
    folder = data / cls
    if not folder.is_dir():
        print(f"note: no {folder} (class has no held-out images)")
        continue
    for path in sorted(p for p in folder.iterdir() if p.is_file()):
        if path.name in denylisted:
            skipped += 1
            continue
        im = Image.open(path).convert("RGB")
        rows_single.append((cls, probs_single(im)))
        rows_five.append((cls, probs_five_crop(im)))
if skipped:
    print(f"Quarantine: skipped {skipped} denylisted (leaked) image(s) from evaluation.")

def confusion(rows):
    k = len(classes)
    matrix = [[0] * k for _ in range(k)]
    for true, probs in rows:
        pred = classes[int(np.argmax(probs))]
        matrix[classes.index(true)][classes.index(pred)] += 1
    per_class = {}
    f1s = []
    for i, cls in enumerate(classes):
        tp = matrix[i][i]
        fp = sum(matrix[r][i] for r in range(k) if r != i)
        fn = sum(matrix[i][c] for c in range(k) if c != i)
        support = sum(matrix[i])
        if support == 0:
            per_class[cls] = {"precision": None, "recall": None, "f1_score": None, "support": 0}
            continue
        precision = tp / max(1, tp + fp)
        recall = tp / max(1, tp + fn)
        f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0.0
        f1s.append(f1)
        per_class[cls] = {"precision": round(precision, 4), "recall": round(recall, 4),
                          "f1_score": round(f1, 4), "support": support}
    return {"classes": classes, "matrix": matrix, "per_class_metrics": per_class,
            "macro_f1": round(sum(f1s) / max(1, len(f1s)), 4) if f1s else None}

out = {
    "model": args.model,
    "data": args.data,
    "five_crop_confusion_matrix": confusion(rows_five),
    "old_single_crop_old_gates": summarise("old: single-crop, old gates", rows_single, args.old_conf, args.old_margin),
    "new_five_crop_new_gates": summarise("new: five-crop, new gates", rows_five, new_conf, new_margin),
    "new_five_crop_old_gates": summarise("new: five-crop, old gates (for comparison)", rows_five, args.old_conf, args.old_margin),
}
print("\n" + json.dumps(out, indent=2))
