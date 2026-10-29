"""
app/routers/ai_config.py

Router quản lý cấu hình AI Engine (Google Gemini Cloud API & Local AI Offline).
Endpoints:
  GET  /api/v1/ai-config  – Lấy trạng thái cấu hình AI hiện tại
  POST /api/v1/ai-config  – Cập nhật Gemini API Key và Preferred Engine tức thì
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.services.ai_service import get_ai_config, update_ai_config

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/v1",
    tags=["AI Configuration"],
)


class AIConfigRequest(BaseModel):
    gemini_api_key: str | None = Field(default=None, description="Google Gemini API Key mới")
    preferred_engine: str | None = Field(
        default=None,
        description="Engine ưu tiên: 'gemini' hoặc 'local'",
    )


class AIConfigResponse(BaseModel):
    has_gemini_key: bool
    gemini_api_key_masked: str
    preferred_engine: str
    active_engine: str
    active_model: str
    supported_models: list[str]


@router.get(
    "/ai-config",
    response_model=AIConfigResponse,
    status_code=status.HTTP_200_OK,
    summary="Lấy trạng thái cấu hình AI Engine",
    description="Kiểm tra xem hệ thống đã nạp Gemini API Key chưa và đang chạy Engine nào.",
)
async def get_current_ai_config() -> AIConfigResponse:
    """Trả về trạng thái cấu hình AI hiện tại."""
    cfg = get_ai_config()
    return AIConfigResponse(**cfg)


@router.post(
    "/ai-config",
    response_model=AIConfigResponse,
    status_code=status.HTTP_200_OK,
    summary="Cập nhật Gemini API Key và Engine ưu tiên",
    description="Cập nhật ngay trong runtime và lưu vào .env mà không cần khởi động lại server.",
)
async def set_current_ai_config(body: AIConfigRequest) -> AIConfigResponse:
    """Cập nhật Gemini API Key hoặc chuyển đổi engine."""
    try:
        new_cfg = update_ai_config(
            api_key=body.gemini_api_key,
            preferred_engine=body.preferred_engine,
        )
        logger.info(
            "🔧 Đã cập nhật AI Config: engine=%s, active=%s",
            new_cfg["preferred_engine"],
            new_cfg["active_engine"],
        )
        return AIConfigResponse(**new_cfg)
    except Exception as exc:
        logger.error("❌ Lỗi cập nhật AI Config: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "config_update_error", "message": str(exc)},
        )
