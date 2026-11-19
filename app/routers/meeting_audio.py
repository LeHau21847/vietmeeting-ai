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
import re
import uuid
from pathlib import Path

import aiofiles
from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, async_session_maker
from app.models.models import Meeting, MeetingStatus, Task, TaskStatus
from app.schemas.schemas import AIProcessingResult, ErrorResponse, TaskExtracted
from app.services.ai_service import (
    generate_minutes_and_tasks,
    process_audio_pipeline,
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
# Endpoint: GET /api/v1/audio/{meeting_id}/stream - HTTP 206 Partial Content
# ===========================================================================
@router.get(
    "/audio/{meeting_id}/stream",
    summary="Phát âm thanh cuộc họp hỗ trợ HTTP Range 206 Partial Content",
    description=(
        "Endpoint truyền phát âm thanh hỗ trợ tua mượt mà cho các file dung lượng lớn (>50MB). "
        "Hỗ trợ header 'Range: bytes=start-end', trả về HTTP 206 Partial Content, Content-Range, "
        "Accept-Ranges: bytes, Content-Length."
    ),
    tags=["Audio Streaming"],
)
async def stream_meeting_audio(
    meeting_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Truyền phát file âm thanh hỗ trợ tua tức thì và tiết kiệm băng thông.
    Hỗ trợ chuẩn RFC 7233 HTTP Range Requests.
    """
    stmt = select(Meeting).where(Meeting.id == meeting_id)
    result = await db.execute(stmt)
    meeting = result.scalar_one_or_none()

    if meeting is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "meeting_not_found", "message": f"Không tìm thấy cuộc họp ID={meeting_id}."},
        )

    # Tìm đường dẫn file âm thanh thực tế trên đĩa
    file_path: Path | None = None
    if meeting.audio_file_url:
        cleaned_url = meeting.audio_file_url.lstrip("/")
        candidate_paths = [
            Path(cleaned_url),
            Path(__file__).resolve().parent.parent.parent / cleaned_url,
            UPLOAD_DIR / Path(cleaned_url).name,
            Path("uploads") / cleaned_url.replace("uploads/", ""),
        ]
        for cp in candidate_paths:
            if cp.is_file() and cp.stat().st_size > 0:
                file_path = cp
                break

    # Nếu chưa tìm thấy, quét UPLOAD_DIR tìm file khớp meeting_{meeting_id}_
    if not file_path:
        for f in UPLOAD_DIR.glob(f"meeting_{meeting_id}_*.*"):
            if f.is_file() and f.stat().st_size > 0:
                file_path = f
                break

    # Fallback kiểm tra file demo nếu có
    if not file_path:
        demo_candidate = Path("demo.mp3")
        if demo_candidate.is_file():
            file_path = demo_candidate

    if not file_path or not file_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "audio_not_found", "message": "Không tìm thấy tệp âm thanh trên máy chủ."},
        )

    file_size = file_path.stat().st_size
    ext = file_path.suffix.lower()
    mime_types = {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".m4a": "audio/mp4",
        ".mp4": "audio/mp4",
        ".ogg": "audio/ogg",
        ".webm": "audio/webm",
        ".flac": "audio/flac",
        ".aac": "audio/aac",
    }
    content_type = mime_types.get(ext, "audio/mpeg")

    range_header = request.headers.get("range")
    if range_header:
        # Xử lý Range request: bytes=start-end
        range_match = re.match(r"bytes=(\d*)-(\d*)", range_header.strip())
        if not range_match:
            raise HTTPException(
                status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
                detail="Invalid Range header format",
            )
        start_str, end_str = range_match.groups()
        start = int(start_str) if start_str else 0
        end = int(end_str) if end_str else file_size - 1

        if end >= file_size:
            end = file_size - 1
        if start > end or start >= file_size:
            raise HTTPException(
                status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
                headers={"Content-Range": f"bytes */{file_size}"},
                detail="Requested range not satisfiable",
            )

        chunk_size = end - start + 1

        def iter_chunk():
            with open(file_path, "rb") as f:
                f.seek(start)
                bytes_left = chunk_size
                while bytes_left > 0:
                    read_len = min(64 * 1024, bytes_left)
                    data = f.read(read_len)
                    if not data:
                        break
                    bytes_left -= len(data)
                    yield data

        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(chunk_size),
            "Content-Type": content_type,
            "Cache-Control": "public, max-age=3600",
        }
        return StreamingResponse(iter_chunk(), status_code=status.HTTP_206_PARTIAL_CONTENT, headers=headers)

    # Không có Range header -> trả về full file kèm Accept-Ranges
    def iter_full():
        with open(file_path, "rb") as f:
            while chunk := f.read(64 * 1024):
                yield chunk

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(file_size),
        "Content-Type": content_type,
        "Cache-Control": "public, max-age=3600",
    }
    return StreamingResponse(iter_full(), status_code=status.HTTP_200_OK, headers=headers)


# ===========================================================================
# Endpoint: POST /api/v1/audio/{meeting_id}/process (Anti-Timeout Async 202)
# ===========================================================================
@router.post(
    "/audio/{meeting_id}/process",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Upload audio và kích hoạt tiến trình xử lý AI chạy ngầm (HTTP 202)",
    description=(
        "Kiến trúc Anti-Timeout 100% cho file ghi âm dài 50-120 phút:\n"
        "1. Nhận & lưu tệp âm thanh vào uploads/audio/\n"
        "2. Đặt trạng thái Meeting = PROCESSING trong SQLite\n"
        "3. Đẩy pipeline bóc băng + tổng hợp biên bản vào BackgroundTasks\n"
        "4. Trả về ngay lập tức HTTP 202 Accepted trong 1-2 giây."
    ),
    responses={
        202: {"description": "Đã tiếp nhận và đang xử lý ngầm"},
        400: {"description": "File không hợp lệ", "model": ErrorResponse},
        404: {"description": "Meeting không tồn tại", "model": ErrorResponse},
        409: {"description": "Meeting đang được xử lý", "model": ErrorResponse},
        500: {"description": "Lỗi server nội bộ", "model": ErrorResponse},
    },
)
async def process_meeting_audio(
    meeting_id: int,
    file: UploadFile,
    background_tasks: BackgroundTasks,
    notes: str | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """
    Tiếp nhận file audio, lưu nhanh vào ổ đĩa, kích hoạt BackgroundTasks
    và trả về HTTP 202 Accepted ngay lập tức để chống Timeout tuyệt đối.
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
        await db.rollback()
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
        current_step_detail="Đang bóc băng âm thanh (có thể mất 1-3 phút)...",
    )

    # =========================================================================
    # BƯỚC 6: Đẩy toàn bộ pipeline AI vào BackgroundTasks & trả về HTTP 202 ngay!
    # =========================================================================
    background_tasks.add_task(
        process_audio_pipeline,
        meeting_id=meeting_id,
        save_path_str=str(save_path.resolve()),
        relative_url=relative_url,
        file_size=len(file_bytes),
        secretary_notes=notes,
    )

    accept_elapsed = time.perf_counter() - pipeline_start
    logger.info(
        "⚡ [HTTP 202 Accepted] Đã tiếp nhận file cho meeting_id=%d trong %.2fs. Tiến trình AI chạy ngầm.",
        meeting_id,
        accept_elapsed,
    )

    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={
            "status": "processing",
            "meeting_id": meeting_id,
            "audio_file_url": relative_url,
            "message": "Đã tiếp nhận tệp âm thanh. Hệ thống đang bóc băng và tổng hợp biên bản ngầm.",
        },
    )


# ===========================================================================
# Endpoint: POST /api/v1/meetings/upload (Tạo nhanh hoặc đính kèm file -> HTTP 202)
# ===========================================================================
@router.post(
    "/meetings/upload",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Upload audio và xử lý ngầm (HTTP 202 Accepted)",
    description="Tự động khởi tạo cuộc họp (hoặc dùng meeting_id có sẵn), lưu tệp âm thanh và chạy AI trong BackgroundTasks.",
)
async def upload_meeting_audio_async(
    file: UploadFile,
    background_tasks: BackgroundTasks,
    meeting_id: int | None = Form(default=None),
    title: str | None = Form(default=None),
    notes: str | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
) -> JSONResponse:
    target_meeting_id = meeting_id
    if not target_meeting_id:
        clean_title = (title or "").strip() or (
            Path(file.filename).stem.replace("_", " ").replace("-", " ").strip()
            if file.filename
            else "Cuộc họp ghi âm mới"
        )
        new_meeting = Meeting(
            title=clean_title,
            status=MeetingStatus.CREATED,
        )
        db.add(new_meeting)
        await db.flush()
        await db.commit()
        await db.refresh(new_meeting)
        target_meeting_id = new_meeting.id

    return await process_meeting_audio(
        meeting_id=target_meeting_id,
        file=file,
        background_tasks=background_tasks,
        notes=notes,
        db=db,
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
        try:
            await db.refresh(meeting)
        except Exception:
            pass
        saved_partial = PROGRESS_STORE.get(meeting.id, {}).get("partial_transcript", "")
        if saved_partial and not meeting.raw_transcript:
            meeting.raw_transcript = saved_partial
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
        await db.rollback()
        logger.error(
            "❌ Không thể đánh dấu Meeting %d là FAILED: %s",
            meeting.id,
            str(exc),
            exc_info=True,
        )
