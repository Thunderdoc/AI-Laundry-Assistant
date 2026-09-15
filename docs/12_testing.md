# Testing Plan

| Area | Test | Expected result |
|---|---|---|
| Upload | JPG/PNG/WEBP within 10 MB | Accepted |
| Upload | Unsupported or corrupt file | 4xx error |
| Quality | Image below 224 px | Warning, not rejection |
| Model | Missing artifact | 503; no prediction invented |
| Persistence | Completed prediction | Stored SQLite report |
| UI | Mobile viewport | Cards stack and controls remain usable |

Frontend production build has passed. Dataset-based model tests must be run after obtaining data.
