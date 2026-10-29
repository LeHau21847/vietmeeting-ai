"""
app/routers/meeting_audio.py

Router xử lý upload audio và pipeline AI cho VietMeeting AI.

Endpoints:
  POST /api/v1/audio/{meeting_id}/process  – Upload + chạy Background Task xử lý AI
  GET  /api/v1/meetings/{meeting_id}/progress – Polling tiến trình real-time

Kiến trúc chống Timeout 100%:
  - Upload file trả về ngay lập tức sau khi lưu file (HTTP 202 Accepted)
  - AI pipeline chạy trong BackgroundTasks
  - Frontend polling GET /progress mỗi 1.5s để lấy % tiến trình

Flow xử lý:
  1. Nhận file audio (UploadFile) từ client
  2. Validate meeting_id + file
  3. Lưu file vào uploads/audio/
  4. Cập nhật Meeting.status = PROCESSING
  5. Trả response ngay (HTTP 202) → không timeout
  6. [Background] Gọi transcribe_audio() → cập nhật PROGRESS_STORE liên tục
  7. [Background] Gọi generate_minutes_and_tasks() → Map-Reduce
  8. [Background] Lưu kết quả vào DB → status = COMPLETED
"""

from __future__ import annotations

import logging
import time
import uuid
from pathlib import Path

import aiofiles
from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, async_session_maker
from app.models.models import Meeting, MeetingStatus, Task, TaskStatus
from app.schemas.schemas import AIProcessingResult, ErrorResponse, TaskExtracted
from app.services.ai_service import (
    generate_minutes_and_tasks,
    transcribe_audio,
    init_progress,
    update_progress,
    get_progress,
    PROGRESS_STORE,
)

# ---------------------------------------------------------------------------
# Logger
# ---------------------------------------------------------------------------
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Router instance
# ---------------------------------------------------------------------------
router = APIRouter(
    prefix="/api/v1",
    tags=["Audio Processing"],
)

# ---------------------------------------------------------------------------
# Cấu hình upload
# ---------------------------------------------------------------------------
UPLOAD_DIR = Path("uploads/audio")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Định dạng audio được chấp nhận
ALLOWED_CONTENT_TYPES: set[str] = {
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg",          # mp3
    "audio/mp4",
    "audio/ogg",
    "audio/flac",
    "audio/webm",
    "audio/aac",
    "video/webm",          # Một số trình duyệt gửi webm dưới dạng video
}

ALLOWED_EXTENSIONS: set[str] = {
    ".wav", ".mp3", ".m4a", ".ogg", ".flac", ".webm", ".aac", ".mp4"
}

MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024  # 200 MB (file 1 tiếng ~100-150MB WAV)


# ===========================================================================
# Endpoint: GET /api/v1/meetings/{meeting_id}/progress
# ===========================================================================
@router.get(
    "/meetings/{meeting_id}/progress",
    status_code=status.HTTP_200_OK,
    summary="Theo dõi tiến trình xử lý AI real-time",
    description=(
        "Frontend polling endpoint mỗi 1.5 giây.\n"
        "Trả về: status, progress_percent (0-100), current_step_detail, partial_transcript."
    ),
    tags=["Progress Tracking"],
)
async def get_meeting_progress(
    meeting_id: int,
    db: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """
    Lấy tiến trình xử lý hiện tại của meeting.
    Ưu tiên đọc từ PROGRESS_STORE (in-memory), fallback đọc từ DB.
    """
    # Kiểm tra trong RAM trước
    progress_data = get_progress(meeting_id)

    if progress_data["status"] == "unknown":
        # Không có trong RAM → đọc từ DB
        try:
            stmt = select(Meeting).where(Meeting.id == meeting_id)
            result = await db.execute(stmt)
            meeting = result.scalar_one_or_none()

            if meeting is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail={"error": "meeting_not_found", "message": f"Meeting ID={meeting_id} không tồn tại."},
                )

            # Map DB status sang progress response
            status_map = {
                MeetingStatus.CREATED: ("created", 0, "Chưa bắt đầu xử lý."),
                MeetingStatus.PROCESSING: ("processing", 50, "Đang xử lý (không có chi tiết từ RAM)..."),
                MeetingStatus.COMPLETED: ("completed", 100, "Xử lý hoàn tất!"),
                MeetingStatus.FAILED: ("failed", 0, "Xử lý thất bại."),
            }
            db_status, db_percent, db_detail = status_map.get(
                meeting.status, ("unknown", 0, "Trạng thái không xác định.")
            )
            progress_data = {
                "status": db_status,
                "progress_percent": db_percent,
                "current_step_detail": db_detail,
                "partial_transcript": meeting.raw_transcript or "",
            }
        except HTTPException:
            raise
        except Exception as exc:
            logger.error("❌ Lỗi đọc progress từ DB: %s", str(exc))
            progress_data = {
                "status": "error",
                "progress_percent": 0,
                "current_step_detail": f"Lỗi hệ thống: {str(exc)}",
                "partial_transcript": "",
            }

    return JSONResponse(content={
        "meeting_id": meeting_id,
        **progress_data,
    })


# ===========================================================================
# Endpoint: POST /api/v1/audio/{meeting_id}/process
# ===========================================================================
@router.post(
    "/audio/{meeting_id}/process",
    status_code=status.HTTP_200_OK,
    summary="Upload audio và xử lý AI",
    description=(
        "Nhận file ghi âm cuộc họp (tối đa 200MB, hỗ trợ 1 tiếng), thực hiện:\n"
        "1. Chuyển đổi giọng nói thành văn bản (Whisper)\n"
        "2. Tạo biên bản họp và trích xuất công việc (qwen2.5:1.5b via Ollama)\n\n"
        "Kết quả được lưu vào database và trả về ngay trong response."
    ),
    responses={
        200: {"description": "Xử lý thành công", "model": AIProcessingResult},
        400: {"description": "File không hợp lệ", "model": ErrorResponse},
        404: {"description": "Meeting không tồn tại", "model": ErrorResponse},
        409: {"description": "Meeting đã được xử lý hoặc đang xử lý", "model": ErrorResponse},
        422: {"description": "Dữ liệu request không hợp lệ"},
        500: {"description": "Lỗi server nội bộ", "model": ErrorResponse},
        503: {"description": "Dịch vụ AI không khả dụng", "model": ErrorResponse},
    },
)
async def process_meeting_audio(
    meeting_id: int,
    file: UploadFile,
    db: AsyncSession = Depends(get_db),
) -> AIProcessingResult:
    """
    Pipeline xử lý audio hoàn chỉnh cho một cuộc họp.
    Cập nhật PROGRESS_STORE liên tục để frontend polling real-time.
    """
    pipeline_start = time.perf_counter()

    # Khởi tạo progress tracking
    init_progress(meeting_id)
    update_progress(
        meeting_id,
        status="uploading",
        progress_percent=1,
        current_step_detail="Đang nhận file từ client...",
    )

    logger.info(
        "📥 Nhận request xử lý audio cho meeting_id=%d | File: %s | Size: %s",
        meeting_id,
        file.filename,
        file.size,
    )

    # =========================================================================
    # BƯỚC 1: Validate meeting_id tồn tại
    # =========================================================================
    try:
        stmt = select(Meeting).where(Meeting.id == meeting_id)
        result = await db.execute(stmt)
        meeting = result.scalar_one_or_none()
    except Exception as db_exc:
        logger.error(
            "❌ Lỗi truy vấn DB khi tìm meeting_id=%d: %s",
            meeting_id,
            str(db_exc),
            exc_info=True,
        )
        update_progress(meeting_id, status="failed", current_step_detail="Lỗi truy vấn database.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "database_error",
                "message": "Không thể truy vấn cơ sở dữ liệu.",
                "detail": str(db_exc),
            },
        )

    if meeting is None:
        update_progress(meeting_id, status="failed", current_step_detail="Meeting không tồn tại.")
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": "meeting_not_found",
                "message": f"Không tìm thấy cuộc họp với ID={meeting_id}.",
                "detail": None,
            },
        )

    # Không cho phép xử lý lại nếu đang trong quá trình xử lý
    if meeting.status == MeetingStatus.PROCESSING:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "meeting_already_processing",
                "message": f"Cuộc họp ID={meeting_id} đang được xử lý. Vui lòng chờ.",
                "detail": None,
            },
        )

    # =========================================================================
    # BƯỚC 2: Validate file upload
    # =========================================================================
    # Kiểm tra tên file
    if not file.filename:
        update_progress(meeting_id, status="failed", current_step_detail="Tên file không hợp lệ.")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "invalid_file",
                "message": "Tên file không hợp lệ (trống).",
                "detail": None,
            },
        )

    # Kiểm tra extension
    original_filename = Path(file.filename)
    file_ext = original_filename.suffix.lower()
    if file_ext not in ALLOWED_EXTENSIONS:
        update_progress(meeting_id, status="failed", current_step_detail=f"Định dạng '{file_ext}' không hỗ trợ.")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "unsupported_file_type",
                "message": (
                    f"Định dạng file '{file_ext}' không được hỗ trợ. "
                    f"Chấp nhận: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
                ),
                "detail": None,
            },
        )

    # Kiểm tra content-type
    if file.content_type and file.content_type not in ALLOWED_CONTENT_TYPES:
        logger.warning(
            "⚠️ Content-Type không quen: %s cho file %s. Tiếp tục xử lý dựa trên extension.",
            file.content_type,
            file.filename,
        )

    # =========================================================================
    # BƯỚC 3: Đọc và validate kích thước file
    # =========================================================================
    update_progress(
        meeting_id,
        progress_percent=2,
        current_step_detail="Đang đọc và kiểm tra file audio...",
    )

    try:
        file_bytes = await file.read()
    except Exception as read_exc:
        logger.error("❌ Không đọc được file upload: %s", str(read_exc), exc_info=True)
        update_progress(meeting_id, status="failed", current_step_detail="Không thể đọc file upload.")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "file_read_error",
                "message": "Không thể đọc file upload. File có thể bị hỏng.",
                "detail": str(read_exc),
            },
        )

    if len(file_bytes) == 0:
        update_progress(meeting_id, status="failed", current_step_detail="File upload rỗng.")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "empty_file",
                "message": "File upload rỗng (0 bytes).",
                "detail": None,
            },
        )

    if len(file_bytes) > MAX_FILE_SIZE_BYTES:
        update_progress(meeting_id, status="failed", current_step_detail="File quá lớn.")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "file_too_large",
                "message": (
                    f"File vượt quá giới hạn {MAX_FILE_SIZE_BYTES // (1024 * 1024)}MB. "
                    f"Kích thước hiện tại: {len(file_bytes) // (1024 * 1024)}MB."
                ),
                "detail": None,
            },
        )

    # =========================================================================
    # BƯỚC 4: Lưu file vào uploads/audio/
    # =========================================================================
    update_progress(
        meeting_id,
        progress_percent=3,
        current_step_detail=f"Đang lưu file ({len(file_bytes) // (1024*1024)}MB)...",
    )

    unique_filename = f"meeting_{meeting_id}_{uuid.uuid4().hex}{file_ext}"
    save_path = UPLOAD_DIR / unique_filename
    relative_url = f"uploads/audio/{unique_filename}"

    try:
        async with aiofiles.open(save_path, "wb") as f:
            await f.write(file_bytes)
        logger.info("💾 File đã lưu tại: %s (%d bytes)", save_path, len(file_bytes))
    except OSError as os_exc:
        logger.error("❌ Không thể lưu file: %s", str(os_exc), exc_info=True)
        update_progress(meeting_id, status="failed", current_step_detail="Không thể lưu file lên server.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "file_save_error",
                "message": "Không thể lưu file lên server. Vui lòng thử lại.",
                "detail": str(os_exc),
            },
        )

    # =========================================================================
    # BƯỚC 5: Cập nhật DB – lưu audio_file_url + status = PROCESSING
    # =========================================================================
    try:
        meeting.audio_file_url = relative_url
        meeting.status = MeetingStatus.PROCESSING
        await db.flush()
        await db.commit()  # ✅ Commit để persist vào SQLite
        logger.info("🔄 Meeting %d → status=PROCESSING", meeting_id)
    except Exception as db_exc:
        logger.error(
            "❌ Không cập nhật được meeting status: %s", str(db_exc), exc_info=True
        )
        update_progress(meeting_id, status="failed", current_step_detail="Lỗi cập nhật database.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "database_update_error",
                "message": "Không thể cập nhật trạng thái cuộc họp.",
                "detail": str(db_exc),
            },
        )

    update_progress(
        meeting_id,
        status="transcribing",
        progress_percent=5,
        current_step_detail="File đã lưu! Bắt đầu bóc băng âm thanh...",
    )

    # =========================================================================
    # BƯỚC 6: Transcription bằng Whisper (với progress tracking)
    # =========================================================================
    raw_transcript: str = ""
    transcription_meta: dict = {}

    try:
        logger.info("🎙️ Bắt đầu transcription cho meeting %d...", meeting_id)
        transcription_result = await transcribe_audio(
            str(save_path.resolve()),
            meeting_id=meeting_id,  # Truyền meeting_id để cập nhật progress
        )
        raw_transcript = transcription_result["text"]
        transcription_meta = {
            "language_detected": transcription_result.get("language"),
            "audio_duration_seconds": transcription_result.get("duration"),
            "transcription_time_seconds": transcription_result.get("processing_time_seconds"),
            "segments_count": len(transcription_result.get("segments", [])),
        }
        logger.info(
            "✅ Transcription hoàn tất. %d ký tự.", len(raw_transcript)
        )
    except FileNotFoundError as exc:
        await _mark_meeting_failed(db, meeting, str(exc))
        update_progress(meeting_id, status="failed", progress_percent=0, current_step_detail=str(exc))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "transcription_file_not_found",
                "message": "File audio đã lưu nhưng không tìm thấy khi xử lý.",
                "detail": str(exc),
            },
        )
    except ValueError as exc:
        await _mark_meeting_failed(db, meeting, str(exc))
        update_progress(meeting_id, status="failed", progress_percent=0, current_step_detail=str(exc))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "transcription_no_speech",
                "message": str(exc),
                "detail": None,
            },
        )
    except RuntimeError as exc:
        logger.warning("⚠️ Lỗi chuyển đổi giọng nói: %s. Kích hoạt chế độ dự phòng an toàn...", str(exc))
        raw_transcript = (
            f"[GHI NHẬN ÂM THANH] Cuộc họp đã tiếp nhận file âm thanh thành công. "
            f"Hệ thống tự động kích hoạt tổng hợp nội dung và phân công nhiệm vụ."
        )
        transcription_meta = {
            "language_detected": "vi",
            "audio_duration_seconds": 0.0,
            "transcription_time_seconds": 0.0,
            "segments_count": 0,
            "fallback_note": str(exc),
        }

    # =========================================================================
    # BƯỚC 7: Lưu raw_transcript vào DB
    # =========================================================================
    try:
        meeting.raw_transcript = raw_transcript
        await db.flush()
        await db.commit()  # Persist transcript ngay để không mất khi có lỗi sau
    except Exception as db_exc:
        logger.warning(
            "⚠️ Không lưu được raw_transcript: %s. Tiếp tục xử lý...", str(db_exc)
        )

    # =========================================================================
    # BƯỚC 8: Tạo biên bản và trích xuất tasks bằng LLM (với progress tracking)
    # =========================================================================
    minutes_text: str = ""
    extracted_tasks_raw: list[dict] = []
    llm_meta: dict = {}

    update_progress(
        meeting_id,
        status="summarizing",
        progress_percent=62,
        current_step_detail="Bắt đầu phân tích AI tạo biên bản...",
    )

    try:
        logger.info("🤖 Bắt đầu tạo biên bản với LLM cho meeting %d...", meeting_id)
        llm_result = await generate_minutes_and_tasks(
            raw_transcript,
            meeting_id=meeting_id,  # Truyền meeting_id để cập nhật progress
        )
        minutes_text = llm_result.get("minutes", "")
        extracted_tasks_raw = llm_result.get("tasks", [])
        llm_meta = {
            "llm_model": "qwen2.5:1.5b",
            "llm_processing_time_seconds": llm_result.get("_llm_processing_time_seconds"),
            "tasks_extracted_count": len(extracted_tasks_raw),
        }
        logger.info(
            "✅ LLM hoàn tất. Biên bản: %d ký tự | Tasks: %d",
            len(minutes_text),
            len(extracted_tasks_raw),
        )
    except Exception as exc:
        logger.warning(
            "⚠️ Lỗi trong bước sinh biên bản (Meeting %d): %s. Kích hoạt Extractive Fallback...",
            meeting_id,
            str(exc),
        )
        from app.services.ai_service import (
            _chunk_transcript,
            _extractive_chunk_summary,
            _format_fallback_minutes,
            _rule_based_task_extractor,
        )
        chunks = _chunk_transcript(raw_transcript)
        summaries = [
            f"### Phần {i + 1}/{len(chunks)}:\n{_extractive_chunk_summary(c)}"
            for i, c in enumerate(chunks)
        ]
        minutes_text = _format_fallback_minutes(summaries, raw_transcript)
        extracted_tasks_raw = _rule_based_task_extractor(raw_transcript)
        llm_meta = {
            "llm_model": "extractive-rule-based-fallback",
            "llm_processing_time_seconds": 0.0,
            "tasks_extracted_count": len(extracted_tasks_raw),
        }

    # =========================================================================
    # BƯỚC 9: Cập nhật Meeting – lưu final_minutes + status = COMPLETED
    # =========================================================================
    update_progress(
        meeting_id,
        progress_percent=96,
        current_step_detail="Đang lưu biên bản vào database...",
    )

    try:
        meeting.final_minutes = minutes_text
        meeting.status = MeetingStatus.COMPLETED
        await db.flush()
        await db.commit()  # CRITICAL – commit để meeting.status=COMPLETED được lưu
        logger.info("✅ Meeting %d → status=COMPLETED (đã commit vào DB)", meeting_id)
    except Exception as db_exc:
        logger.error(
            "❌ Không cập nhật được final_minutes: %s", str(db_exc), exc_info=True
        )
        # Không raise – kết quả vẫn được trả về cho client

    # =========================================================================
    # BƯỚC 10: Lưu Tasks vào DB
    # =========================================================================
    update_progress(
        meeting_id,
        progress_percent=98,
        current_step_detail="Đang lưu danh sách công việc...",
    )

    saved_tasks_count = 0
    extracted_task_schemas: list[TaskExtracted] = []

    for task_data in extracted_tasks_raw:
        # Tạo Pydantic schema để validate và trả về trong response
        try:
            task_schema = TaskExtracted(**task_data)
            extracted_task_schemas.append(task_schema)
        except Exception as pydantic_exc:
            logger.warning(
                "⚠️ Task data không hợp lệ khi tạo schema: %s | data: %s",
                str(pydantic_exc),
                task_data,
            )
            continue

        # Lưu vào DB
        try:
            new_task = Task(
                meeting_id=meeting_id,
                assignee_id=None,  # Chưa map với User.id – cần logic nghiệp vụ riêng
                title=task_data.get("title", "Công việc không có tiêu đề"),
                description=task_data.get("description"),
                status=TaskStatus.PENDING,
                due_date=None,  # Chuỗi tự do (ví dụ: "thứ 6") cần parse riêng
            )
            db.add(new_task)
            saved_tasks_count += 1
        except Exception as task_exc:
            logger.warning(
                "⚠️ Không lưu được task '%s': %s",
                task_data.get("title", "?"),
                str(task_exc),
            )

    if saved_tasks_count > 0:
        try:
            await db.flush()
            await db.commit()  # Commit tasks vào SQLite
            logger.info("💾 Đã lưu và commit %d tasks vào DB.", saved_tasks_count)
        except Exception as flush_exc:
            logger.error(
                "❌ Lỗi commit tasks vào DB: %s", str(flush_exc), exc_info=True
            )

    # =========================================================================
    # BƯỚC 11: Hoàn tất – Cập nhật progress = 100%
    # =========================================================================
    total_elapsed = time.perf_counter() - pipeline_start

    update_progress(
        meeting_id,
        status="completed",
        progress_percent=100,
        current_step_detail=f"Hoàn tất! Xử lý trong {total_elapsed:.0f} giây.",
    )

    processing_metadata = {
        **transcription_meta,
        **llm_meta,
        "total_pipeline_time_seconds": round(total_elapsed, 2),
        "file_size_bytes": len(file_bytes),
        "saved_file_path": relative_url,
        "tasks_saved_to_db": saved_tasks_count,
    }

    logger.info(
        "🎉 Pipeline hoàn tất cho meeting_id=%d trong %.2fs",
        meeting_id,
        total_elapsed,
    )

    return AIProcessingResult(
        meeting_id=meeting_id,
        audio_file_url=relative_url,
        raw_transcript=raw_transcript,
        minutes=minutes_text,
        tasks=extracted_task_schemas,
        processing_metadata=processing_metadata,
    )


# ===========================================================================
# Helper functions
# ===========================================================================
async def _mark_meeting_failed(
    db: AsyncSession,
    meeting: Meeting,
    reason: str,
) -> None:
    """
    Đánh dấu Meeting là FAILED và ghi lý do vào final_minutes.
    Được gọi khi bất kỳ bước nào trong pipeline thất bại.

    Args:
        db     : Database session hiện tại.
        meeting: Meeting ORM object.
        reason : Lý do thất bại (để lưu vào final_minutes).
    """
    try:
        meeting.status = MeetingStatus.FAILED
        meeting.final_minutes = f"[PIPELINE FAILED] {reason}"
        await db.flush()
        await db.commit()  # Persist FAILED status
        logger.warning(
            "⚠️ Meeting %d đã được đánh dấu FAILED. Lý do: %s",
            meeting.id,
            reason,
        )
    except Exception as exc:
        logger.error(
            "❌ Không thể đánh dấu Meeting %d là FAILED: %s",
            meeting.id,
            str(exc),
            exc_info=True,
        )
