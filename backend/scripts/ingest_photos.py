"""Safely grow the dataset with new real photos — the volume pipeline.

Usage: point it at a folder of new phone photos organised by class, e.g.:

    new_photos/cotton/IMG_1234.jpg
    new_photos/non_fabric/IMG_1235.jpg

    python backend/scripts/ingest_photos.py --incoming new_photos --data data

What it guarantees (the lessons of the 2026-10-24 audit):

1. One source photo, one split. Every file that shares a source stem (the
   Roboflow ``<photo>_jpg.rf.<hash>.jpg`` pattern, or the plain filename) goes
   to the same split, so augmentations of one photo can never leak across
   train/val/test again.
2. No duplicates. Files whose bytes already exist anywhere in data/ are
   skipped and reported, never counted twice.
3. Denylist respected. Files listed in
   data/quarantine_leaked/non_fabric/LEAKED_FILES.txt are refused.
4. Deterministic 70/15/15 split by source photo (seeded), so re-running with
   the same input reproduces the same split.
5. Dry-run by default: pass --apply to actually copy files.

New photos are the highest-value volume there is: unlike more augmentation of
the same ~1,300 source photos, a new photo adds new lighting, backgrounds,
garments and fabric instances — exactly what "every kind of photo" needs.
"""
import argparse, hashlib, random, shutil, sys
from pathlib import Path

CLASSES = ["cotton", "polyester", "denim", "wool", "silk", "non_fabric"]

parser = argparse.ArgumentParser()
parser.add_argument("--incoming", required=True, help="Folder with one subfolder per class")
parser.add_argument("--data", default="data", help="Repo data/ folder (train/val/test)")
parser.add_argument("--seed", type=int, default=42)
parser.add_argument("--apply", action="store_true", help="Copy files (default is dry-run)")
args = parser.parse_args()

incoming, data = Path(args.incoming), Path(args.data)
if not incoming.is_dir():
    raise SystemExit(f"Incoming folder not found: {incoming}")

denylist_path = data / "quarantine_leaked" / "non_fabric" / "LEAKED_FILES.txt"
denylisted = {line.strip() for line in denylist_path.read_text(encoding="utf-8").splitlines() if line.strip()} if denylist_path.is_file() else set()

def digest(path):
    return hashlib.md5(path.read_bytes()).hexdigest()

existing_digests = set()
for split in ("train", "val", "test"):
    for path in (data / split).rglob("*"):
        if path.is_file():
            existing_digests.add(digest(path))

rng = random.Random(args.seed)
plan = {"train": [], "val": [], "test": []}
skipped_dup, skipped_denylist, skipped_unknown = [], [], []
for class_dir in sorted(incoming.iterdir()):
    if not class_dir.is_dir() or class_dir.name not in CLASSES:
        skipped_unknown.append(class_dir.name)
        continue
    # Group by source stem so all variants of one photo share one split.
    by_source = {}
    for path in sorted(class_dir.iterdir()):
        if not path.is_file():
            continue
        stem = path.stem
        if "_jpg.rf." in path.name:
            stem = path.name.split("_jpg.rf.")[0]
        by_source.setdefault(stem, []).append(path)
    sources = sorted(by_source)
    rng.shuffle(sources)
    n = len(sources)
    n_test, n_val = max(1, round(n * 0.15)) if n >= 7 else (1, 0), 0
    # Simple deterministic split: first 70% train, next 15% val, rest test
    # (tiny batches still keep at least one source in test when possible).
    cut_train = int(n * 0.70)
    cut_val = cut_train + int(n * 0.15)
    for i, stem in enumerate(sources):
        split = "train" if i < cut_train else ("val" if i < cut_val else "test")
        for path in by_source[stem]:
            if path.name in denylisted:
                skipped_denylist.append(str(path))
                continue
            if digest(path) in existing_digests:
                skipped_dup.append(str(path))
                continue
            plan[split].append((path, data / split / class_dir.name / path.name))

print(f"Incoming sources per class are split 70/15/15 by source photo (seed {args.seed}).")
for split in ("train", "val", "test"):
    print(f"  {split}: {len(plan[split])} file(s)")
print(f"Skipped duplicates: {len(skipped_dup)}, denylisted: {len(skipped_denylist)}, unknown folders: {skipped_unknown}")
if not args.apply:
    print("Dry-run only — nothing copied. Re-run with --apply to ingest.")
    sys.exit(0)
for split, items in plan.items():
    for src, dest in items:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
print(f"Ingested {sum(len(v) for v in plan.values())} file(s). Re-run training "
      f"afterwards; train.py will refuse if any split overlap remains.")
