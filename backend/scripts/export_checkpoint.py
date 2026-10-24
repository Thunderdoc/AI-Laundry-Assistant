"""Export a TorchScript model from a train.py best-weights checkpoint.

Usage:
    python backend/scripts/export_checkpoint.py \
        --checkpoint backend/models/fabric_mobilenetv2.checkpoint.pt \
        --output backend/models/fabric_mobilenetv2.pt

Why this exists: a long CPU retrain can be interrupted (VM restart) before
train.py writes its final .pt. The checkpoint holds the best weights seen so
far, so the run's progress is not lost — export it, then re-measure with
backend/scripts/evaluate.py before shipping. Never ship an exported
checkpoint without that re-measurement: the checkpoint's val_acc is a
training-time number, not a shipped metric.
"""

import argparse

import torch
from torch import nn
from torchvision import models

ORDER = ["cotton", "polyester", "denim", "wool", "silk", "non_fabric"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    ckpt = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    model = models.mobilenet_v2(weights=None)
    model.classifier = nn.Sequential(
        nn.Dropout(p=0.3),
        nn.Linear(model.last_channel, len(ORDER)),
    )
    model.load_state_dict(ckpt["state_dict"])
    model.eval()
    torch.jit.script(model.cpu()).save(args.output)
    print(f"exported {args.output} from {args.checkpoint} "
          f"(epoch {ckpt.get('epoch')}, best_val_acc {ckpt.get('best_val_acc')})")


if __name__ == "__main__":
    main()
