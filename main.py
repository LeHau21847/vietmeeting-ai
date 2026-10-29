"""
main.py – Entry point của VietMeeting AI Backend

Khởi tạo FastAPI application với:
  - CORS middleware (cho phép frontend gọi API)
  - Lifespan context manager (startup/shutdown)
  - Database initialization tại startup
  - Health check endpoint
  - Include routers

Chạy server:
  uvicorn main:app --reload --host 0.0.0.0 --port 8000

Truy cập tài liệu API:
  - Swagger UI: http://localhost:8000/docs
  - ReDoc     : http://localhost:8000/redoc
"""

from __future__ import annotations

import logging
import sys
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# ---------------------------------------------------------------------------
# Cấu hình logging – phải thiết lập trước khi import các module khác
# ---------------------------------------------------------------------------
if sys.platform == "win32":
    import os
    from pathlib import Path
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    # Tự động nạp thư mục DLL của NVIDIA (cublas, cudnn) trong virtualenv
    try:
        venv_base = Path(sys.executable).parent.parent
        for sub in ["cublas", "cudnn"]:
            bin_dir = venv_base / "Lib" / "site-packages" / "nvidia" / sub / "bin"
            if bin_dir.exists():
                try:
                    os.add_dll_directory(str(bin_dir))
                except Exception:
                    pass
                os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s – %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Import internal modules
# ---------------------------------------------------------------------------
from app.core.database import init_db
from app.routers import ai_config, meeting_audio, meetings, tasks


# ===========================================================================
# Lifespan – thay thế on_event("startup") / on_event("shutdown") deprecated
# ===========================================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Quản lý vòng đời ứng dụng FastAPI.

    STARTUP:
      - Khởi tạo các bảng database (nếu chưa có)
      - Log thông tin khởi động

    SHUTDOWN:
      - Đóng các kết nối, giải phóng tài nguyên
    """
    # ---- STARTUP ----
    logger.info("=" * 60)
    logger.info("🚀 VietMeeting AI Backend đang khởi động...")
    logger.info("=" * 60)

    try:
        logger.info("🗄️  Khởi tạo database...")
        await init_db()
        logger.info("✅ Database đã sẵn sàng.")
    except Exception as exc:
        logger.critical(
            "❌ CRITICAL: Không thể khởi tạo database. "
            "Ứng dụng sẽ không hoạt động đúng.\n"
            "Chi tiết: %s",
            str(exc),
            exc_info=True,
        )
        # Không raise để ứng dụng vẫn khởi động (health check vẫn có thể báo lỗi)

    logger.info("✅ VietMeeting AI Backend đã sẵn sàng nhận request.")
    logger.info("📖 Swagger UI: http://localhost:8000/docs")
    logger.info("📖 ReDoc     : http://localhost:8000/redoc")

    yield  # Ứng dụng đang chạy

    # ---- SHUTDOWN ----
    logger.info("🛑 VietMeeting AI Backend đang tắt...")
    try:
        from app.core.database import engine
        await engine.dispose()
        logger.info("✅ Database engine đã đóng.")
    except Exception as exc:
        logger.warning("⚠️ Lỗi khi đóng database engine: %s", str(exc))

    logger.info("👋 VietMeeting AI Backend đã tắt.")


# ===========================================================================
# Khởi tạo FastAPI Application
# ===========================================================================
app = FastAPI(
    title="VietMeeting AI",
    description=(
        "## 🎙️ Hệ thống Phân tích Cuộc họp Thông minh – 100% Offline\n\n"
        "VietMeeting AI tự động:\n"
        "- **Chuyển đổi giọng nói** thành văn bản bằng faster-whisper (local)\n"
        "- **Tạo biên bản họp** chuyên nghiệp bằng LLM qwen2.5:1.5b (Ollama)\n"
        "- **Trích xuất công việc** từ biên bản và lưu vào database\n\n"
        "Hoạt động 100% Offline, không gửi dữ liệu ra ngoài.\n\n"
        "**Phần cứng tối thiểu:** RAM 16GB, GPU GTX 1650 4GB VRAM"
    ),
    version="1.0.0",
    contact={
        "name": "VietMeeting AI Team",
        "email": "vietmeeting@example.vn",
    },
    license_info={
        "name": "MIT",
    },
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)


# ===========================================================================
# CORS Middleware
# ===========================================================================
# Cho phép frontend (React/Vue/v.v.) gọi API từ các origin khác nhau
# Trong production: thay "*" bằng domain cụ thể của frontend
app.add_middleware(
    CORSMiddleware,
    # ✅ FIX: Dùng ["*"] để không bao giờ bị chặn CORS khi demo
    # Expo Web có thể chạy ở port bất kỳ (8081, 19006, v.v.) hoặc IP LAN
    # Thay bằng origin cụ thể khi deploy production
    allow_origins=["*"],
    allow_credentials=False,  # Phải False khi dùng allow_origins=["*"]
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


# ===========================================================================
# Include Routers
# ===========================================================================
app.include_router(ai_config.router)
app.include_router(meetings.router)
app.include_router(meeting_audio.router)
app.include_router(tasks.router)


# ===========================================================================
# Endpoints chung
# ===========================================================================
@app.get(
    "/",
    summary="Root",
    description="Thông tin cơ bản về API.",
    tags=["System"],
)
async def root() -> JSONResponse:
    """Trả về thông tin cơ bản về service."""
    return JSONResponse(
        content={
            "service": "VietMeeting AI Backend",
            "version": "1.0.0",
            "status": "running",
            "docs": "/docs",
            "redoc": "/redoc",
            "timestamp": datetime.now().isoformat(),
        }
    )


@app.get(
    "/health",
    summary="Health Check",
    description="Kiểm tra trạng thái hoạt động của server và database.",
    tags=["System"],
)
async def health_check() -> JSONResponse:
    """
    Health check endpoint.
    Kiểm tra kết nối database và trả về trạng thái tổng thể.
    """
    db_status = "unknown"
    db_error: str | None = None

    try:
        from sqlalchemy import text
        from app.core.database import async_session_maker

        async with async_session_maker() as session:
            await session.execute(text("SELECT 1"))
        db_status = "healthy"
    except Exception as exc:
        db_status = "unhealthy"
        db_error = str(exc)
        logger.warning("⚠️ Health check: DB không healthy. Chi tiết: %s", db_error)

    overall_status = "healthy" if db_status == "healthy" else "degraded"

    response_body = {
        "status": overall_status,
        "timestamp": datetime.now().isoformat(),
        "components": {
            "database": {
                "status": db_status,
                "error": db_error,
            },
            "ai_services": {
                "whisper": "local (faster-whisper base)",
                "llm": "local (qwen2.5:1.5b via Ollama)",
                "note": "AI services are initialized on first use",
            },
        },
    }

    http_status_code = 200 if overall_status == "healthy" else 503
    return JSONResponse(content=response_body, status_code=http_status_code)


# ===========================================================================
# Entry point khi chạy trực tiếp
# ===========================================================================
if __name__ == "__main__":
    import uvicorn

    logger.info("▶️  Khởi chạy server trực tiếp qua __main__...")
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info",
        access_log=True,
    )
