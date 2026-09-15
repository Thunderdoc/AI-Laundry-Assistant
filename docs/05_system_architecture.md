# System Architecture

Browser upload/camera → FastAPI validation → TorchScript MobileNetV2 → probability distribution → documented fabric knowledge base → rule-based care/eco guidance → SQLite prediction history → analytics.

The AI output and knowledge-base recommendations are intentionally separate. The API returns no prediction if the trained model is missing or incompatible.
