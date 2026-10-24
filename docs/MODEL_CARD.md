# LaundryAI model card — fabric classification (MobileNetV2)

## What it does

Classifies a garment photo into one of cotton, polyester, denim, wool, silk, or
non_fabric, then maps the accepted fabric to wash/dry/iron/bleach care guidance
from `backend/app/knowledge_base.py`. Care guidance is rule-based, not generated
by the model.

## Shipped model

- Architecture: MobileNetV2 transfer learning, 224×224 input, ImageNet mean/std
  normalization (see `backend/models/fabric_mobilenetv2.manifest.json`).
- Weights: `backend/backend/models/fabric_mobilenetv2.pt` (the bundled copy that
  the server actually loads; `backend/models/*.pt` is git-ignored, so the copy
  under `backend/models/` is intentionally absent from the repo).
- Inference (since the 2026-10-24 fix): five-crop average — four corner crops
  plus centre crop, softmax probabilities averaged — instead of one stretched
  resize. This stabilises answers across phone framings.

## Measured results — 2026-10-24 re-evaluation (clean splits)

Evaluated with `backend/scripts/evaluate.py` on the shipped weights, after the
leaked non_fabric images were excluded via the denylist:

| Split | Images | Top-1 accuracy | Macro F1 | Accuracy on accepted answers | Unknown rate |
|---|---|---|---|---|---|
| test | 277 | **83.0%** (was 79.1% single-crop) | 0.828 | 86.8% at gates 0.55/0.10 | 12.3% |
| val | 277 | 83.4% | 0.836 | 87.7% at gates 0.55/0.10 | 11.9% |

Per-class test recall: denim 91.7%, wool 94.8%, silk 83.7%, cotton 75.0%,
polyester 69.6%, non_fabric unmeasured (no held-out images). The main confusion
is cotton↔polyester (7 cotton photos called polyester, 9 polyester photos
called cotton). These numbers now live in the shipped manifest; the old
79.4% / 47-per-class figures were replaced, not kept alongside.

## Decision gates (since the 2026-10-24 fix)

- `min_confidence = 0.55`, `min_margin = 0.10` in the shipped manifest. These
  match the floors that `backend/scripts/train.py` itself applies when it
  generates thresholds. The previous shipped values (0.35 / 0.08) accepted weak
  guesses as answers and were the main reason users saw confidently wrong
  fabrics. Below the gates the API returns `fabric: "unknown"` with the reason
  in `model_decision.reason` instead of a guessed fabric.

## Known limitations — read before quoting any number

1. **Old manifest numbers were stale (fixed 2026-10-24).** It claimed 47 test
   images per class and 79.4% test accuracy, but the shipped test split was
   cotton 60, denim 60, non_fabric 5, polyester 56, silk 43, wool 58. The
   manifest now carries the re-evaluated numbers from the section above.
2. **non_fabric is unmeasured.** All 5 val and all 5 test non_fabric images
   were byte-identical copies of train images; they are denylisted in
   `data/quarantine_leaked/non_fabric/LEAKED_FILES.txt` and excluded by the
   train/evaluate scripts in the 2026-10-24 fix. The class now
   has 46 train images and zero held-out images. Non-fabric rejection in the
   wild is unreliable until fresh non-fabric photos are collected.
3. **Small, narrow training data.** Each fabric has only ~210–280 unique source
   photos (each expanded ×3 by Roboflow augmentation). Photos are mostly
   close-up texture crops; full garments, busy backgrounds, poor lighting and
   dark fabrics are under-represented, so real phone photos score worse than
   any lab number suggests.
4. **Confusable classes.** The stale per-class metrics already showed silk
   recall ~74% and wool recall ~77%; cotton/polyester/silk are the main
   confusion pairs. A low-confidence or "unknown" answer on those fabrics is
   the system working as designed, not a bug to override.
5. **Care guidance is generic.** It comes from documented fabric properties,
   not from the garment's actual care label. The label on the garment always
   wins over this app.

## What would actually improve results (in order)

1. Collect fresh non-fabric photos (rooms, objects, people, food) that have
   never been in training, and rebuild a clean val/test split for that class.
2. Collect more unique source photos per fabric — especially full garments in
   natural light — rather than more augmentations of the same photos.
3. Re-run `backend/scripts/train.py` (it now refuses to train on leaked
   splits) and record the new manifest from the five-crop inference path.
4. Only then update the numbers in this card and in the manifest.
