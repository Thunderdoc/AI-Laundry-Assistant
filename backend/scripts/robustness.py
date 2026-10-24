"""How well does the shipped model handle *every kind of photo*?

Applies phone-realistic corruptions to the clean test set and reports
five-crop top-1 accuracy per corruption, using the same inference path as
/api/predict. This is the baseline for 'har tarah ki photo' handling — any
future model must beat these numbers, not just the clean-set number.

    python backend/scripts/robustness.py --data data/test

Corruptions: darker (0.6x brightness), brighter (1.4x), motion-ish blur,
30-degree rotation, and low resolution (down to 112px, back up).
Denylisted (leaked) files are skipped, like in evaluate.py.
"""
import argparse, json
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageEnhance, ImageFilter

parser = argparse.ArgumentParser()
parser.add_argument("--data", default="data/test")
parser.add_argument("--model", default="backend/backend/models/fabric_mobilenetv2.pt")
parser.add_argument("--manifest", default="backend/backend/models/fabric_mobilenetv2.manifest.json")
args = parser.parse_args()

manifest = json.loads(Path(args.manifest).read_text())
classes = manifest["classes"]
input_size = manifest.get("input_size", 224)
mean = manifest.get("normalization", {}).get("mean", [0.485, 0.456, 0.406])
std = manifest.get("normalization", {}).get("std", [0.229, 0.224, 0.225])
model = torch.jit.load(args.model, map_location="cpu").eval()

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

CORRUPTIONS = {
    "clean": lambda im: im,
    "dark_0.6x": lambda im: ImageEnhance.Brightness(im).enhance(0.6),
    "bright_1.4x": lambda im: ImageEnhance.Brightness(im).enhance(1.4),
    "blur": lambda im: im.filter(ImageFilter.GaussianBlur(radius=2)),
    "rotated_30deg": lambda im: im.rotate(30, expand=True),
    "lowres_112px": lambda im: im.resize((112, 112)).resize(im.size),
}

data = Path(args.data)
denylist_path = data.parent / "quarantine_leaked" / "non_fabric" / "LEAKED_FILES.txt"
denylisted = {line.strip() for line in denylist_path.read_text(encoding="utf-8").splitlines() if line.strip()} if denylist_path.is_file() else set()
items = []
for cls in classes:
    folder = data / cls
    if not folder.is_dir():
        continue
    for path in sorted(p for p in folder.iterdir() if p.is_file() and p.name not in denylisted):
        items.append((cls, Image.open(path).convert("RGB")))
print(f"robustness set: {len(items)} images (denylisted skipped)")
for name, fn in CORRUPTIONS.items():
    good = 0
    for cls, im in items:
        probs = probs_five_crop(fn(im))
        if classes[int(np.argmax(probs))] == cls:
            good += 1
    print(f"  {name:14} accuracy={good / max(1, len(items)):.4f}  ({good}/{len(items)})")
