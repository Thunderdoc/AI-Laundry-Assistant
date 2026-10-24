# Multi-stage build (fixed 2026-10-24): the old Dockerfile did
# `COPY frontend/dist`, which fails on any fresh build from GitHub because
# dist/ is never committed. This image builds the frontend itself, so a
# Render/Railway deploy from the repo works with no manual pre-build step.
# Stage 1: build the React frontend.
FROM node:20-slim AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY frontend ./
RUN npm run build

# Stage 2: Python API + served frontend (single origin, so the UI calls /api
# relatively and needs no VITE_API_URL at build time).
FROM python:3.11-slim

WORKDIR /app
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

COPY backend /app/backend
COPY --from=frontend-build /build/frontend/dist /app/frontend/dist

ENV PORT=8000
ENV DATA_DIR=/data
ENV DATABASE_PATH=/data/laundryai.db
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port ${PORT}"]
