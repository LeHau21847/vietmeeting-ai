#!/bin/sh
set -e

# Run database seed if needed
python seed_demo_data.py || true

# Start FastAPI server on port provided by Cloud provider (Render/Railway/HF Spaces)
PORT="${PORT:-7860}"
echo "[*] Starting VietMeeting AI Server on port $PORT..."
exec uvicorn main:app --host 0.0.0.0 --port "$PORT"

