# ==============================================================================
# Dockerfile - VietMeeting AI Cloud Deployment (24/7)
# Tuong thich: Hugging Face Spaces, Render.com, Railway, Fly.io
# Thoi gian build: < 60 giay (Khong keo theo GPU/Torch nang)
# ==============================================================================

FROM python:3.12-slim

WORKDIR /app

# Cai dat curl phuc vu Healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Cai dat cac dependencies gon nhe cho Cloud
COPY requirements-cloud.txt .
RUN pip install --no-cache-dir -r requirements-cloud.txt

# Copy toan bo du an (bao gom mobile/dist da build san)
COPY . /app

# Khoi tao co so du lieu mau chuan Nghi dinh 30
RUN python seed_demo_data.py || true

# Mac dinh: Port 7860 cho Hugging Face Spaces, Render se tu ghi de $PORT
ENV PORT=7860
ENV PYTHONUNBUFFERED=1
ENV PREFERRED_AI_ENGINE=gemini

EXPOSE 7860
EXPOSE 8000

RUN chmod +x /app/start_cloud.sh || true

CMD ["sh", "/app/start_cloud.sh"]
