# Photo Collection Brief — what new photos actually move accuracy

Date: 2026-10-24. Status: the shipped model (five-crop, 83.0% clean test)
is limited by DATA, not by code. Each fabric class has only ~200–280 unique
source photos (every photo was Roboflow-augmented ×3, so file counts look
3× bigger than reality). More augmented copies of the same photos will not
help. Only new, real, varied photos will.

## What the errors say (clean test confusion matrix, 277 images)

- Cotton ↔ polyester confusion is 16 of 47 errors — the single biggest bucket.
  These two fibres look alike in close-up texture shots.
- Silk → polyester is the next bucket (5 errors).
- Denim and wool are already strong (91.7% / 94.8% recall).
- non_fabric is unmeasured: only ~15 unique source photos exist, so the model
  effectively never says "not fabric". Fresh everyday scenes are mandatory
  before that class can be trusted.

## Shot list (real phone photos, no web downloads)

Send photos through the ingest script (`backend/scripts/ingest_photos.py`),
which groups each source photo into train/val/test and skips duplicates.
One source photo = one garment/scene, not 10 near-identical taps of it.

| Class | Need | What to shoot |
|---|---|---|
| non_fabric | 200+ new scenes (highest priority) | Kitchen counters, wood, metal, plastic, paper, skin/hands, pets, walls, food, screens — anything that is NOT cloth. Mixed light, near and far. |
| cotton | 150+ new garments | T-shirts, shirts, bedsheets, towels — hanging, folded, worn, flat. Include plain white/cream cotton (the hardest: low texture). Daylight + indoor light. |
| polyester | 150+ new garments | Sports jerseys, saree blouses, curtains, lining fabric — shiny/smooth pieces especially, since shine is polyester's tell. Same variety as cotton. |
| silk | 80+ new garments | Sarees, silk shirts, scarves — with sheen visible, not just matte close-ups. |
| denim, wool | 50+ each (maintenance) | Jeans/jackets; sweaters/shawls. These are already strong — only fill gaps (dark denim, light wool). |

## How to shoot (matters as much as what)

- Steady hand, tap-to-focus on the fabric. Blurry photos now get a warning
  from the API (Laplacian sharpness check), but a blurry photo still wastes
  a training slot.
- Vary: distance (close texture + full garment), angle (straight + tilted
  ~30°), background (bed, table, hanger, outdoors), light (daylight, room
  light, evening). The model is weakest on rotated (72.9%) and blurry (62.8%)
  photos — variety here is the fix.
- One fabric per photo, fabric filling most of the frame. Label the true
  fabric honestly; a wrong label hurts more than a missing photo.

## What happens after photos arrive

1. Ingest groups them into splits by source photo (no leakage, ever).
2. Retrain on GPU (Modal T4 worker in `training/modal_worker.py` — needs a
   Modal account/token; CPU retraining the same data takes hours and is the
   fallback, not the plan).
3. The new model file is a binary (.pt): it cannot be pushed through the
   GitHub connector, so the owner uploads it via git/GitHub web, then the
   manifest metrics are re-measured honestly before it ships.
4. No retrain ships on the same data alone — augmentation tweaks (rotation
   widened to ±35°, blur + erasing) are already in `train.py`, but without
   new photos they are worth ~1–2%, not a new accuracy tier.
