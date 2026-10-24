# Quarantined leaked images — excluded from training and evaluation

`non_fabric/LEAKED_FILES.txt` lists 10 images (5 in `data/val/non_fabric/`,
5 in `data/test/non_fabric/`) that are **byte-identical copies of images
already in `data/train/non_fabric/`**.

Keeping them in val/test made the reported non_fabric metrics meaningless: the
model had already seen those exact photos during training. The files stay on
disk because the GitHub push route used for this fix cannot move binary files
in a single commit — instead, they are excluded by code:

- `backend/scripts/train.py` drops denylisted samples before training and
  then refuses to train if any other split overlap remains.
- `backend/scripts/evaluate.py` skips denylisted files and reports how many
  it skipped.

Consequence, stated honestly: after this quarantine, `non_fabric` has **no
valid held-out images at all** (46 train, 0 val, 0 test). The shipped model's
non-fabric rejection ability is therefore **unmeasured**. Collect fresh,
never-before-seen non-fabric photos before quoting any non-fabric accuracy.
