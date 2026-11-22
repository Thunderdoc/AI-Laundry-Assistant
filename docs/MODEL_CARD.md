# LaundryAI model card — fabric classification (combo G ensemble)

## What it does

Classifies a garment photo into one of cotton, polyester, denim, wool, silk, or
non_fabric, then maps the accepted fabric to wash/dry/iron/bleach care guidance
from `backend/app/knowledge_base.py`. Care guidance is rule-based, not generated
by the model.

## Shipped model

- Architecture: EfficientNet-B2 + EfficientNet-B0 + MobileNetV2 ensemble —
  6 TorchScript models, weighted probability averaging, 224×224 input,
  ImageNet mean/std normalization (see
  `backend/backend/models/fabric_ensemble.manifest.json`).
- Version: `ensemble-g-20261108` ("combo G"). Shipped 2026-11-08 on the owner's
  explicit approval; confirmed the FINAL model on 2026-11-10.
- Weights: member parts under `backend/backend/models/` (`fabric_ens_exp15_parts`,
  `fabric_ens_exp14_parts`, `fabric_ens_exp12_parts`, `fabric_ens_exp6_parts`,
  `fabric_ens_exp2_parts`, `fabric_v2_parts`), assembled and md5-verified at
  startup. `backend/models/*.pt` is git-ignored, so the tracked weights live
  under `backend/backend/models/` by design.
- Members (weights are the serving config from the ensemble manifest):

  | Member | Base | Weight | Clean test | Real-photo |
  |---|---|---:|---:|---:|
  | exp15 | EfficientNet-B2 | 0.20 | 81.23% | 67.06% |
  | exp14 | EfficientNet-B2 | 0.32 | 82.67% | 65.89% |
  | exp12 | EfficientNet-B0 | 0.16 | 80.51% | 66.28% |
  | exp3 | MobileNetV2 | 0.1067 | 80.87% | 58.67% |
  | exp6 | — | 0.1067 | 78.70% | 59.65% |
  | exp2 | — | 0.1067 | 77.98% | 59.06% |

  (exp15: distilled from the combo-f ensemble, stage A enriched with 800
  verified garment photos; exp14: distilled from the combo-b ensemble; exp12:
  distilled from the combo-e teachers; exp3: the previously live single model.
  Combo G is exp15 × 0.2 + combo f × 0.8, and beat combo f on all three sets.)
- Inference: five-crop average — four corner crops plus centre crop, softmax
  probabilities averaged across members per crop, then averaged over the five
  crops — instead of one stretched resize. This stabilises answers across phone
  framings.
- Fallback chain: ensemble incomplete or corrupt → exp-3 single model
  (`fabric_v2_parts`) → bundled v1 model. A partial parts landing never
  activates the ensemble and never breaks prediction. An explicit `MODEL_PATH`
  disables the ensemble: do not set it in production.

## Measured results — combo G, evaluated 2026-11-08

Evaluated by the offline ensemble probe (v9) over
`backend/scripts/evaluate.py` semantics — five-crop inference, EXIF transpose,
leaked-file denylist, top-1 with no decision-gate filtering for accuracy.
All single-model control values reproduced the previously recorded numbers
exactly before any ensemble figure was taken.

| Set | Images | Top-1 accuracy | Notes |
|---|---:|---:|---|
| Clean test | 277 | **84.84%** | Macro F1 0.8473; 92.66% accuracy on accepted answers at gates 0.55/0.10; unknown rate 21.3% |
| Real-photo (whole-garment product photos, TextileNet) | 513 | **68.03%** | Held-out, never trained on |
| Dim (dimmed copies of the real-photo set) | 513 | **65.11%** | Same 513 images, dimmed |

No val-split ensemble figure is claimed: the probe cached test/real-photo
probabilities only, so no val number exists — do not quote one.

Per-class test metrics (clean test, 277 images):

| Class | Support | Precision | Recall | F1-score |
|---|---:|---:|---:|---:|
| Cotton | 60 | 85.19% | 76.67% | 80.70% |
| Polyester | 56 | 78.43% | 71.43% | 74.77% |
| Denim | 60 | 85.29% | 96.67% | 90.62% |
| Wool | 58 | 90.00% | 93.10% | 91.53% |
| Silk | 43 | 86.05% | 86.05% | 86.05% |
| Non-fabric | 0 | unmeasured | unmeasured | unmeasured |

The main confusions are cotton↔polyester (5 cotton photos called polyester,
6 polyester photos called cotton) and cotton→denim (6). Full confusion matrix
in the shipped manifest and in `docs/13_results.md`.

For context, the superseded models (kept only as the fallback chain):
v1 MobileNetV2 — 83.03% clean test, 8.19% real-photo
(`fabric_mobilenetv2.manifest.json`); exp-3 single model — 80.87% clean test,
58.67% real-photo (`fabric_mobilenetv2_v2.manifest.json`). The real-photo
accuracy rose from 8% (v1) to 68% (combo G).

## Decision gates (since the 2026-10-24 fix)

- `min_confidence = 0.55`, `min_margin = 0.10` in the shipped manifest. These
  match the floors that `backend/scripts/train.py` itself applies when it
  generates thresholds. The previous shipped values (0.35 / 0.08) accepted weak
  guesses as answers and were the main reason users saw confidently wrong
  fabrics. Below the gates the API returns `fabric: "unknown"` with the reason
  in `model_decision.reason` instead of a guessed fabric.

## Known limitations — read before quoting any number

1. **Old figures were superseded, twice.** The original manifest claimed 47 test
   images per class and 79.4% test accuracy, but the shipped test split was
   cotton 60, denim 60, non_fabric 5, polyester 56, silk 43, wool 58 — and the
   5 non_fabric test images were leaked copies of train images. The 2026-10-24
   re-evaluation (277 images after the denylist) gave the v1 model 83.0%; combo G
   now scores 84.84% on the same 277-image set. Quote combo G numbers only.
2. **non_fabric is unmeasured.** All 5 val and all 5 test non_fabric images
   were byte-identical copies of train images; they are denylisted in
   `data/quarantine_leaked/non_fabric/LEAKED_FILES.txt` and excluded by the
   train/evaluate scripts in the 2026-10-24 fix. The class now
   has 46 train images on disk, of which 36 are actually used (10 denylisted
   as leaked copies), and zero held-out images. Non-fabric rejection in the
   wild is unreliable until fresh non-fabric photos are collected.
3. **Small, narrow training data.** Photos are mostly close-up texture crops;
   full garments, busy backgrounds, poor lighting and dark fabrics are
   under-represented — which is why real phone photos (68.03%) score well below
   the clean-test number (84.84%). The real-photo and dim figures are the
   honest expectation for everyday phone scans, not the clean-test figure.
4. **Confusable classes.** Current five-crop test recall is cotton 76.67% and
   polyester 71.43% against denim 96.67% and wool 93.10%; cotton/polyester/silk
   are the main confusion pairs. A low-confidence or "unknown" answer on those
   fabrics is the system working as designed, not a bug to override.
5. **Care guidance is generic.** It comes from documented fabric properties,
   not from the garment's actual care label. The label on the garment always
   wins over this app.

## What would actually improve results (in order)

1. Collect fresh non-fabric photos (rooms, objects, people, food) that have
   never been in training, and rebuild a clean val/test split for that class.
2. Collect more unique source photos per fabric — especially full garments in
   natural light — rather than more augmentations of the same photos.
3. Train a new candidate (single model or ensemble member), evaluate it with
   the five-crop path on all three sets, and promote only a measured win on
   clean test AND real-photo accuracy. Changing the ensemble is a manifest +
   parts change (`fabric_ensemble.manifest.json` and the new member's verified
   parts directory), never a code change.
4. Only then update the numbers in this card and in the manifest.
