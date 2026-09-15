# Database Design

`predictions(id, created_at, fabric, confidence, payload)`: persisted prediction report. `payload` is JSON to preserve alternatives, quality checks and the recommendation snapshot used at prediction time. This avoids historical results changing when rules are updated.
