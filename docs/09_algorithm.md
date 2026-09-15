# Algorithm: Fabric Classification and Care Recommendation

Input garment image `I`; output fabric `F`, confidence `C`, guidance `R`.

1. Validate file and decode image. 2. Resize to 224×224 and normalize. 3. Apply the exported CNN. 4. Softmax logits. 5. Select maximum class probability. 6. Record confidence. 7. Retrieve the matching documented fabric entry. 8. Apply wash, dry, iron, bleach, risk and eco rules. 9. Store output. 10. Display prediction and explanation.
