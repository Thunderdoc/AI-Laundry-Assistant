# Methodology

1. Collect and split labelled fabric images without leakage.
2. Resize/normalize images using a versioned preprocessing manifest.
3. Fine-tune MobileNetV2, retaining class order with the exported artifact.
4. Evaluate only on held-out images; record accuracy, precision, recall, F1, confusion matrix, inference time and model size.
5. Deploy the artifact only with its label/preprocessing manifest.
6. Translate the verified class through `knowledge_base.py`; present this separately from the AI prediction.

## Eco score

Project-defined, not externally validated: temperature (0–40), drying energy (0–35), and cycle intensity (0–25). The product must display the component values and should not claim scientific validation.
