"""
app/routers/meetings.py

Router CRUD cho Meeting (không bao gồm AI processing – xem meeting_audio.py).

Endpoints:
  POST /api/v1/meetings          – Tạo cuộc họp mới, trả về MeetingSummary
  GET  /api/v1/meetings          – Lấy danh sách tất cả cuộc họp (mới nhất trước)
  GET  /api/v1/meetings/{id}     – Lấy chi tiết một cuộc họp
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.models import Meeting, MeetingStatus, Task, TaskStatus
from app.schemas.schemas import (
    AIRewriteRequest,
    ErrorResponse,
    MeetingCreate,
    MeetingRead,
    MeetingSummary,
    MeetingUpdate,
)
from app.services.ai_service import rewrite_meeting_minutes_and_tasks

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/v1/meetings",
    tags=["Meetings"],
)


# ===========================================================================
# POST /api/v1/meetings – Tạo cuộc họp mới
# ===========================================================================
@router.post(
    "",
    response_model=MeetingSummary,
    status_code=status.HTTP_201_CREATED,
    summary="Tạo cuộc họp mới",
    description=(
        "Tạo một bản ghi Meeting mới với trạng thái `created`.\n\n"
        "Sau khi tạo, dùng endpoint `POST /api/v1/audio/{meeting_id}/process` "
        "để upload file ghi âm và kích hoạt pipeline AI."
    ),
    responses={
        201: {"description": "Tạo thành công", "model": MeetingSummary},
        422: {"description": "Dữ liệu không hợp lệ"},
        500: {"description": "Lỗi server", "model": ErrorResponse},
    },
)
async def create_meeting(
    body: MeetingCreate,
    db: AsyncSession = Depends(get_db),
) -> MeetingSummary:
    """
    Tạo Meeting mới với title (bắt buộc) và description (tuỳ chọn).
    """
    try:
        new_meeting = Meeting(
            title=body.title.strip(),
            description=body.description.strip() if body.description else None,
            status=MeetingStatus.CREATED,
        )
        db.add(new_meeting)
        await db.flush()
        await db.refresh(new_meeting)

        logger.info(
            "✅ Tạo meeting mới: id=%d title=%r",
            new_meeting.id,
            new_meeting.title,
        )
        return MeetingSummary.model_validate(new_meeting)

    except Exception as exc:
        logger.error("❌ Lỗi tạo meeting: %s", str(exc), exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "database_error",
                "message": "Không thể tạo cuộc họp. Vui lòng thử lại.",
                "detail": str(exc),
            },
        )


# ===========================================================================
# GET /api/v1/meetings – Danh sách cuộc họp
# ===========================================================================
@router.get(
    "",
    response_model=list[MeetingSummary],
    status_code=status.HTTP_200_OK,
    summary="Danh sách cuộc họp",
    description="Trả về danh sách tất cả cuộc họp, sắp xếp từ mới nhất đến cũ nhất.",
    responses={
        200: {"description": "Thành công", "model": list[MeetingSummary]},
        500: {"description": "Lỗi server", "model": ErrorResponse},
    },
)
async def list_meetings(
    skip: int = Query(default=0, ge=0, description="Số bản ghi bỏ qua (phân trang)"),
    limit: int = Query(default=50, ge=1, le=200, description="Số bản ghi tối đa trả về"),
    db: AsyncSession = Depends(get_db),
) -> list[MeetingSummary]:
    """
    Lấy danh sách Meeting theo thứ tự mới nhất trước.
    """
    try:
        stmt = (
            select(Meeting)
            .order_by(Meeting.created_at.desc())
            .offset(skip)
            .limit(limit)
        )
        result = await db.execute(stmt)
        meetings = result.scalars().all()

        logger.info("📋 Trả về %d meeting(s) (skip=%d, limit=%d)", len(meetings), skip, limit)
        return [MeetingSummary.model_validate(m) for m in meetings]

    except Exception as exc:
        logger.error("❌ Lỗi lấy danh sách meeting: %s", str(exc), exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "database_error",
                "message": "Không thể tải danh sách cuộc họp.",
                "detail": str(exc),
            },
        )


# ===========================================================================
# GET /api/v1/meetings/{meeting_id} – Chi tiết một cuộc họp
# ===========================================================================
@router.get(
    "/{meeting_id}",
    response_model=MeetingRead,
    status_code=status.HTTP_200_OK,
    summary="Chi tiết cuộc họp",
    description="Trả về thông tin đầy đủ của một cuộc họp, bao gồm transcript và biên bản.",
    responses={
        200: {"description": "Thành công", "model": MeetingRead},
        404: {"description": "Không tìm thấy", "model": ErrorResponse},
        500: {"description": "Lỗi server", "model": ErrorResponse},
    },
)
async def get_meeting(
    meeting_id: int,
    db: AsyncSession = Depends(get_db),
) -> MeetingRead:
    """
    Lấy chi tiết một Meeting theo ID.
    """
    try:
        stmt = (
            select(Meeting)
            .options(selectinload(Meeting.tasks))
            .where(Meeting.id == meeting_id)
        )
        result = await db.execute(stmt)
        meeting = result.scalar_one_or_none()
    except Exception as exc:
        logger.error(
            "❌ Lỗi truy vấn meeting_id=%d: %s", meeting_id, str(exc), exc_info=True
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "database_error",
                "message": "Không thể truy vấn cơ sở dữ liệu.",
                "detail": str(exc),
            },
        )

    if meeting is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": "meeting_not_found",
                "message": f"Không tìm thấy cuộc họp với ID={meeting_id}.",
                "detail": None,
            },
        )

    return MeetingRead.model_validate(meeting)


# ===========================================================================
# PUT /api/v1/meetings/{meeting_id} – Cập nhật cuộc họp & nội dung biên bản
# ===========================================================================
@router.put(
    "/{meeting_id}",
    response_model=MeetingRead,
    status_code=status.HTTP_200_OK,
    summary="Cập nhật thông tin cuộc họp và biên bản",
    description="Cho phép chỉnh sửa tiêu đề, mô tả, biên bản họp trực tiếp từ giao diện.",
    responses={
        200: {"description": "Cập nhật thành công", "model": MeetingRead},
        404: {"description": "Không tìm thấy", "model": ErrorResponse},
        500: {"description": "Lỗi server", "model": ErrorResponse},
    },
)
async def update_meeting(
    meeting_id: int,
    body: MeetingUpdate,
    db: AsyncSession = Depends(get_db),
) -> MeetingRead:
    try:
        stmt = (
            select(Meeting)
            .options(selectinload(Meeting.tasks))
            .where(Meeting.id == meeting_id)
        )
        result = await db.execute(stmt)
        meeting = result.scalar_one_or_none()

        if meeting is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": "meeting_not_found", "message": f"Không tìm thấy cuộc họp với ID={meeting_id}."},
            )

        if body.title is not None:
            meeting.title = body.title.strip()
        if body.description is not None:
            meeting.description = body.description.strip() if body.description else None
        if body.final_minutes is not None:
            meeting.final_minutes = body.final_minutes.strip()
        if body.raw_transcript is not None:
            meeting.raw_transcript = body.raw_transcript.strip()
        if body.status is not None:
            meeting.status = body.status

        await db.flush()
        await db.commit()
        await db.refresh(meeting)
        logger.info("💾 Cập nhật meeting id=%d thành công.", meeting_id)
        return MeetingRead.model_validate(meeting)

    except HTTPException:
        raise
    except Exception as exc:
        logger.error("❌ Lỗi cập nhật meeting %d: %s", meeting_id, str(exc), exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "database_error", "message": "Không thể cập nhật cuộc họp.", "detail": str(exc)},
        )


# ===========================================================================
# POST /api/v1/meetings/{meeting_id}/ai-rewrite – AI Tái cấu trúc & Biên tập
# ===========================================================================
@router.post(
    "/{meeting_id}/ai-rewrite",
    response_model=MeetingRead,
    status_code=status.HTTP_200_OK,
    summary="AI Tái cấu trúc văn bản cuộc họp theo nhiều phong cách",
    description=(
        "Sử dụng Google Gemini API (hoặc Local AI fallback) để biến đổi biên bản cuộc họp "
        "thành các phong cách chuyên nghiệp: administrative (hành chính), corporate (doanh nghiệp), "
        "news_digest (bản tin tổng hợp), concise (tóm tắt 1 trang), detailed (chi tiết mở rộng), custom."
    ),
    responses={
        200: {"description": "Biên tập thành công", "model": MeetingRead},
        400: {"description": "Cuộc họp chưa có dữ liệu văn bản", "model": ErrorResponse},
        404: {"description": "Không tìm thấy cuộc họp", "model": ErrorResponse},
        500: {"description": "Lỗi server", "model": ErrorResponse},
    },
)
async def ai_rewrite_meeting(
    meeting_id: int,
    body: AIRewriteRequest,
    db: AsyncSession = Depends(get_db),
) -> MeetingRead:
    try:
        stmt = (
            select(Meeting)
            .options(selectinload(Meeting.tasks))
            .where(Meeting.id == meeting_id)
        )
        result = await db.execute(stmt)
        meeting = result.scalar_one_or_none()

        if meeting is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": "meeting_not_found", "message": f"Không tìm thấy cuộc họp ID={meeting_id}."},
            )

        source_text = (meeting.raw_transcript or meeting.final_minutes or "").strip()
        if not source_text:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "error": "no_text_content",
                    "message": "Cuộc họp chưa có bản gỡ băng hoặc biên bản để AI có thể biên tập lại.",
                },
            )

        logger.info(
            "✨ [AI Rewrite API] Bắt đầu tái cấu trúc meeting %d với mode='%s'",
            meeting_id,
            body.mode,
        )

        rewrite_result = await rewrite_meeting_minutes_and_tasks(
            source_text=source_text,
            mode=body.mode,
            custom_instruction=body.custom_instruction,
        )

        new_minutes = rewrite_result.get("minutes", "")
        if new_minutes:
            meeting.final_minutes = new_minutes

        new_tasks = rewrite_result.get("tasks", [])
        if new_tasks:
            for t_item in new_tasks:
                if isinstance(t_item, dict) and t_item.get("title"):
                    t_title = str(t_item["title"]).strip()
                    t_desc = t_item.get("description") or None
                    t_assignee = t_item.get("assignee_name")
                    if t_assignee and t_desc:
                        t_desc = f"Phụ trách: {t_assignee} | {t_desc}"
                    elif t_assignee:
                        t_desc = f"Phụ trách: {t_assignee}"

                    task_obj = Task(
                        meeting_id=meeting_id,
                        title=t_title,
                        description=t_desc,
                        status=TaskStatus.PENDING,
                        due_date=None,
                    )
                    db.add(task_obj)

        await db.flush()
        await db.commit()
        await db.refresh(meeting)

        logger.info("✅ [AI Rewrite API] Hoàn tất tái cấu trúc meeting %d.", meeting_id)
        return MeetingRead.model_validate(meeting)

    except HTTPException:
        raise
    except Exception as exc:
        logger.error("❌ Lỗi AI rewrite meeting %d: %s", meeting_id, str(exc), exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "ai_rewrite_error", "message": f"Lỗi biên tập AI: {str(exc)}"},
        )


# ===========================================================================
# GET /api/v1/meetings/{meeting_id}/export-doc – Xuất biên bản file Word (.DOC)
# ===========================================================================
@router.get(
    "/{meeting_id}/export-doc",
    status_code=status.HTTP_200_OK,
    summary="Xuất biên bản cuộc họp ra file Word (.DOC)",
    description=(
        "Tải file Word chuẩn thể thức Nghị định 30/2020/NĐ-CP với tùy chỉnh kiểu chữ, "
        "cỡ chữ, giãn dòng và căn lề đồng bộ từ giao diện người dùng."
    ),
    responses={
        200: {"description": "Tải file .doc thành công"},
        404: {"description": "Không tìm thấy cuộc họp", "model": ErrorResponse},
    },
)
async def export_meeting_doc(
    meeting_id: int,
    font_family: str = Query("Times New Roman", description="Tên font chữ"),
    font_size: str = Query("13pt", description="Cỡ chữ"),
    line_height: str = Query("1.35", description="Độ giãn dòng"),
    text_align: str = Query("justify", description="Căn lề"),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Tạo và xuất file Word .doc chuẩn chỉnh từ database."""
    stmt = (
        select(Meeting)
        .options(selectinload(Meeting.tasks))
        .where(Meeting.id == meeting_id)
    )
    result = await db.execute(stmt)
    meeting = result.scalar_one_or_none()

    if meeting is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "meeting_not_found", "message": f"Không tìm thấy cuộc họp ID={meeting_id}."},
        )

    # Chuẩn bị dữ liệu hiển thị
    created_dt = meeting.created_at
    date_str = created_dt.strftime("ngày %d tháng %m năm %Y") if created_dt else "ngày ... tháng ... năm 20..."
    time_str = created_dt.strftime("%H:%M, ngày %d/%m/%Y") if created_dt else "..."

    # Làm sạch nội dung biên bản (bỏ markdown thô)
    raw_minutes = meeting.final_minutes or "Chưa có nội dung biên bản."
    minutes_paragraphs = []
    for line in raw_minutes.split("\n"):
        line_s = line.strip()
        if not line_s:
            continue
        # Bỏ ##, ###
        if line_s.startswith("#"):
            clean_heading = line_s.lstrip("#").strip()
            minutes_paragraphs.append(f"<p class='sec-subhead'><b>{clean_heading}</b></p>")
        elif line_s.startswith("-") or line_s.startswith("*"):
            bullet_text = line_s.lstrip("-* ").strip()
            minutes_paragraphs.append(f"<p class='bullet-item'>• {bullet_text}</p>")
        else:
            minutes_paragraphs.append(f"<p class='normal-para'>{line_s}</p>")

    minutes_html = "\n".join(minutes_paragraphs)

    # Bảng nhiệm vụ
    tasks = meeting.tasks or []
    task_rows = []
    if tasks:
        for idx, t in enumerate(tasks, start=1):
            title = t.title or "Nhiệm vụ"
            desc = f"<br/><span class='task-desc'>{t.description}</span>" if t.description else ""
            assignee = getattr(t, "assignee_name", None) or (t.assignee.full_name if t.assignee else "Các đơn vị liên quan")
            deadline = t.due_date.strftime("%d/%m/%Y") if getattr(t, "due_date", None) and hasattr(t.due_date, "strftime") else (str(t.due_date) if t.due_date else "Trong kế hoạch sắp tới")

            task_rows.append(
                f"<tr>"
                f"<td align='center'>{idx}</td>"
                f"<td><b>{title}</b>{desc}</td>"
                f"<td align='center'>{assignee}</td>"
                f"<td align='center'>{deadline}</td>"
                f"</tr>"
            )
    else:
        task_rows.append(
            "<tr><td colspan='4' align='center' style='padding: 12px; font-style: italic; color: #555;'>"
            "Không có nhiệm vụ hành động cụ thể nào phát sinh trong cuộc họp.</td></tr>"
        )

    task_table_html = "\n".join(task_rows)

    # Chuẩn hóa đơn vị đo cỡ chữ
    font_size_pt = font_size if any(u in font_size.lower() for u in ["pt", "px", "em", "rem"]) else f"{font_size}pt"

    # HTML Document chuẩn Microsoft Word với đầy đủ Namespace
    html_content = f"""<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head>
  <meta charset='utf-8'>
  <title>Biên bản cuộc họp - {meeting.title}</title>
  <!--[if gte mso 9]>
  <xml>
    <w:WordDocument>
      <w:View>Print</w:View>
      <w:Zoom>100</w:Zoom>
      <w:DoNotOptimizeForBrowser/>
    </w:WordDocument>
  </xml>
  <![endif]-->
  <style>
    @page {{
      size: 210mm 297mm;
      margin: 20mm 20mm 20mm 25mm;
      mso-page-orientation: portrait;
    }}
    body {{
      font-family: '{font_family}', 'Times New Roman', Times, Arial, serif;
      font-size: {font_size_pt};
      line-height: {line_height};
      color: #000000;
    }}
    table.header-table {{
      width: 100%;
      border-collapse: collapse;
      border: none;
      margin-bottom: 12px;
    }}
    table.header-table td {{
      border: none;
      vertical-align: top;
      text-align: center;
      padding: 0 4px;
    }}
    .org-name {{
      font-size: 12pt;
      font-weight: bold;
      text-transform: uppercase;
    }}
    .doc-no {{
      font-size: 12pt;
      margin-top: 4px;
    }}
    .nation-name {{
      font-size: 12.5pt;
      font-weight: bold;
      text-transform: uppercase;
    }}
    .motto {{
      font-size: 13pt;
      font-weight: bold;
    }}
    .motto-line {{
      font-size: 11pt;
      letter-spacing: -1px;
    }}
    .date-line {{
      text-align: right;
      font-style: italic;
      font-size: 13pt;
      margin-bottom: 22px;
    }}
    .title-main {{
      text-align: center;
      font-size: 16pt;
      font-weight: bold;
      text-transform: uppercase;
      margin-top: 10px;
      margin-bottom: 4px;
    }}
    .title-sub {{
      text-align: center;
      font-size: 13pt;
      font-weight: bold;
      font-style: italic;
      margin-bottom: 24px;
    }}
    .section-head {{
      font-size: 13pt;
      font-weight: bold;
      text-transform: uppercase;
      margin-top: 18px;
      margin-bottom: 8px;
    }}
    .sec-subhead {{
      font-size: 13pt;
      margin-top: 10px;
      margin-bottom: 4px;
    }}
    .normal-para {{
      text-indent: 1.25cm;
      margin: 4px 0;
      text-align: {text_align};
      font-size: {font_size_pt};
      line-height: {line_height};
    }}
    .bullet-item {{
      margin: 4px 0 4px 1.25cm;
      text-align: {text_align};
      font-size: {font_size_pt};
      line-height: {line_height};
    }}
    table.data-table {{
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      margin-bottom: 18px;
    }}
    table.data-table th, table.data-table td {{
      border: 1px solid #000000;
      padding: 6px 8px;
      font-size: 12pt;
      vertical-align: top;
    }}
    table.data-table th {{
      background-color: #f2f2f2;
      font-weight: bold;
      text-align: center;
    }}
    .task-desc {{
      font-size: 11pt;
      color: #333333;
      font-style: italic;
    }}
    table.sig-table {{
      width: 100%;
      border-collapse: collapse;
      border: none;
      margin-top: 35px;
      page-break-inside: avoid;
    }}
    table.sig-table td {{
      border: none;
      text-align: center;
      vertical-align: top;
      width: 50%;
    }}
    .sig-role {{
      font-size: 13pt;
      font-weight: bold;
      text-transform: uppercase;
    }}
    .sig-note {{
      font-size: 11pt;
      font-style: italic;
      margin-top: 2px;
    }}
    .sig-space {{
      height: 75px;
    }}
  </style>
</head>
<body>

  <!-- Phần Quốc hiệu & Tiêu ngữ chuẩn thể thức Nghị định 30 -->
  <table class="header-table">
    <tr>
      <td style="width: 45%;">
        <div class="org-name">VIETMEETING AI WORKSPACE</div>
        <div class="doc-no">Số: {meeting.id:04d}/BB-CH</div>
      </td>
      <td style="width: 55%;">
        <div class="nation-name">CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</div>
        <div class="motto">Độc lập - Tự do - Hạnh phúc</div>
        <div class="motto-line">-------------------</div>
      </td>
    </tr>
  </table>

  <div class="date-line">Hà Nội, {date_str}</div>

  <div class="title-main">BIÊN BẢN CUỘC HỌP</div>
  <div class="title-sub">{meeting.title}</div>

  <!-- Mục I. THÔNG TIN CHUNG -->
  <div class="section-head">I. THÔNG TIN CHUNG</div>
  <p class="normal-para"><b>1. Thời gian:</b> Bắt đầu lúc {time_str}.</p>
  <p class="normal-para"><b>2. Địa điểm / Hình thức:</b> Họp trực tiếp kết hợp trực tuyến qua VietMeeting AI Studio.</p>
  <p class="normal-para"><b>3. Chủ trì cuộc họp:</b> Lãnh đạo cơ quan / Ban Giám đốc chủ trì.</p>
  <p class="normal-para"><b>4. Thư ký ghi biên bản:</b> Bộ phận Thư ký tổng hợp AI.</p>
  <p class="normal-para"><b>5. Thành phần tham dự:</b> Toàn thể đại biểu, lãnh đạo các phòng ban và thành viên liên quan.</p>

  <!-- Mục II. NỘI DUNG DIỄN BIẾN CUỘC HỌP -->
  <div class="section-head">II. NỘI DUNG DIỄN BIẾN CUỘC HỌP</div>
  {minutes_html}

  <!-- Mục III. BẢNG PHÂN CÔNG NHIỆM VỤ / KẾT LUẬN CHỈ ĐẠO -->
  <div class="section-head">III. BẢNG PHÂN CÔNG NHIỆM VỤ / CHỈ ĐẠO</div>
  <table class="data-table">
    <thead>
      <tr>
        <th style="width: 8%;">STT</th>
        <th style="width: 52%;">Nội dung công việc / Chỉ đạo</th>
        <th style="width: 25%;">Đơn vị / Người phụ trách</th>
        <th style="width: 15%;">Thời hạn</th>
      </tr>
    </thead>
    <tbody>
      {task_table_html}
    </tbody>
  </table>

  <!-- Phần Chữ ký cuối trang -->
  <table class="sig-table">
    <tr>
      <td>
        <div class="sig-role">THƯ KÝ GHI BIÊN BẢN</div>
        <div class="sig-note">(Ký và ghi rõ họ tên)</div>
        <div class="sig-space"></div>
        <div><i>(Đã ký điện tử)</i></div>
      </td>
      <td>
        <div class="sig-role">CHỦ TRÌ CUỘC HỌP</div>
        <div class="sig-note">(Ký và ghi rõ họ tên)</div>
        <div class="sig-space"></div>
        <div><i>(Đã duyệt & ký)</i></div>
      </td>
    </tr>
  </table>

</body>
</html>"""

    import urllib.parse
    ascii_filename = f"Bien_Ban_Cuoc_Hop_{meeting_id}.doc"
    encoded_filename = urllib.parse.quote(f"Bien_Ban_Cuoc_Hop_{meeting.title}.doc")

    return Response(
        content=html_content.encode("utf-8"),
        media_type="application/msword; charset=utf-8",
        headers={
            "Content-Disposition": f"attachment; filename=\"{ascii_filename}\"; filename*=UTF-8''{encoded_filename}",
            "Cache-Control": "no-cache",
        },
    )


# ===========================================================================
# DELETE /api/v1/meetings/{meeting_id} – Xóa một cuộc họp
# ===========================================================================
@router.delete(
    "/{meeting_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    summary="Xóa cuộc họp",
    description="Xóa vĩnh viễn một cuộc họp và tất cả Tasks liên quan.",
    responses={
        404: {"description": "Không tìm thấy", "model": ErrorResponse},
        500: {"description": "Lỗi server", "model": ErrorResponse},
    },
)
async def delete_meeting(
    meeting_id: int,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """
    Xóa Meeting theo ID. Các Task liên quan sẽ bị xóa theo (cascade).
    """
    try:
        stmt = select(Meeting).where(Meeting.id == meeting_id)
        result = await db.execute(stmt)
        meeting = result.scalar_one_or_none()
    except Exception as exc:
        logger.error(
            "❌ Lỗi truy vấn meeting_id=%d để xóa: %s", meeting_id, str(exc), exc_info=True
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "database_error",
                "message": "Không thể truy vấn cơ sở dữ liệu.",
                "detail": str(exc),
            },
        )

    if meeting is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": "meeting_not_found",
                "message": f"Không tìm thấy cuộc họp với ID={meeting_id}.",
                "detail": None,
            },
        )

    try:
        await db.delete(meeting)
        await db.commit()
        logger.info("🗑️  Đã xóa meeting id=%d và tất cả tasks liên quan.", meeting_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except Exception as exc:
        logger.error("❌ Lỗi xóa meeting %d: %s", meeting_id, str(exc), exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "database_error",
                "message": "Không thể xóa cuộc họp.",
                "detail": str(exc),
            },
        )

