"""
app/routers/tasks.py

Router CRUD cơ bản cho Task.

Endpoints:
  PATCH /api/v1/tasks/{task_id}  – Cập nhật trạng thái task (Pending ↔ Done)
  GET   /api/v1/tasks/{task_id}  – Lấy chi tiết task
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.models import Task, TaskStatus
from app.schemas.schemas import ErrorResponse, TaskRead, TaskUpdate

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/v1/tasks",
    tags=["Tasks"],
)


# ===========================================================================
# GET /api/v1/tasks/{task_id} – Chi tiết một task
# ===========================================================================
@router.get(
    "/{task_id}",
    response_model=TaskRead,
    status_code=status.HTTP_200_OK,
    summary="Chi tiết task",
    responses={
        200: {"description": "Thành công", "model": TaskRead},
        404: {"description": "Không tìm thấy", "model": ErrorResponse},
    },
)
async def get_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
) -> TaskRead:
    task = await _get_task_or_404(db, task_id)
    return TaskRead.model_validate(task)


# ===========================================================================
# PATCH /api/v1/tasks/{task_id} – Cập nhật trạng thái / thông tin task
# ===========================================================================
@router.patch(
    "/{task_id}",
    response_model=TaskRead,
    status_code=status.HTTP_200_OK,
    summary="Cập nhật task",
    description=(
        "Cập nhật một hoặc nhiều trường của Task.\\n\\n"
        "Thường dùng để đổi trạng thái: `pending` → `done` hoặc ngược lại."
    ),
    responses={
        200: {"description": "Cập nhật thành công", "model": TaskRead},
        404: {"description": "Task không tồn tại", "model": ErrorResponse},
        500: {"description": "Lỗi server", "model": ErrorResponse},
    },
)
async def update_task(
    task_id: int,
    body: TaskUpdate,
    db: AsyncSession = Depends(get_db),
) -> TaskRead:
    """
    Cập nhật Task theo ID. Chỉ các trường được gửi (non-None) sẽ được cập nhật.
    """
    task = await _get_task_or_404(db, task_id)

    try:
        update_data = body.model_dump(exclude_none=True)
        for field, value in update_data.items():
            setattr(task, field, value)

        await db.flush()
        await db.commit()
        await db.refresh(task)

        logger.info("✅ Task %d đã cập nhật: %s", task_id, update_data)
        return TaskRead.model_validate(task)

    except Exception as exc:
        logger.error("❌ Lỗi cập nhật task %d: %s", task_id, str(exc), exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "database_error",
                "message": "Không thể cập nhật task.",
                "detail": str(exc),
            },
        )


# ===========================================================================
# Helper
# ===========================================================================
async def _get_task_or_404(db: AsyncSession, task_id: int) -> Task:
    try:
        stmt = select(Task).where(Task.id == task_id)
        result = await db.execute(stmt)
        task = result.scalar_one_or_none()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "database_error", "message": "Lỗi truy vấn DB.", "detail": str(exc)},
        )
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "task_not_found", "message": f"Task ID={task_id} không tồn tại.", "detail": None},
        )
    return task
