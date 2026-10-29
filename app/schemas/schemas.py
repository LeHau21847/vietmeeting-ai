"""
app/schemas/schemas.py

Định nghĩa các Pydantic schemas (v2) cho request/response validation.

Quy ước đặt tên:
  - <Model>Base   : Các trường chung (dùng để kế thừa)
  - <Model>Create : Schema cho request tạo mới (POST)
  - <Model>Update : Schema cho request cập nhật (PATCH/PUT)
  - <Model>Read   : Schema cho response (đọc dữ liệu từ DB)
  - <Model>Summary: Schema rút gọn dùng trong các response lồng nhau

Tất cả schema dạng Read đều bật from_attributes=True (tương đương
orm_mode của Pydantic v1) để tương thích với SQLAlchemy models.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.models.models import MeetingStatus, TaskStatus


# ===========================================================================
# Helper mixin
# ===========================================================================
class OrmBase(BaseModel):
    """
    Base class chung cho tất cả schema đọc từ ORM.
    Bật from_attributes để Pydantic có thể đọc trực tiếp từ SQLAlchemy model.
    """
    model_config = ConfigDict(from_attributes=True)


# ===========================================================================
# USER schemas
# ===========================================================================
class UserBase(BaseModel):
    """Trường chung cho User."""
    full_name: str = Field(..., min_length=2, max_length=255, examples=["Nguyễn Văn A"])
    email: EmailStr = Field(..., examples=["nva@company.vn"])


class UserCreate(UserBase):
    """
    Schema tạo mới User.
    Nhận plaintext password – service layer sẽ hash trước khi lưu.
    """
    password: str = Field(
        ...,
        min_length=8,
        max_length=128,
        examples=["Secure@123"],
        description="Mật khẩu tối thiểu 8 ký tự.",
    )


class UserUpdate(BaseModel):
    """Schema cập nhật thông tin User (tất cả trường đều optional)."""
    full_name: str | None = Field(None, min_length=2, max_length=255)
    email: EmailStr | None = None
    is_active: bool | None = None


class UserRead(OrmBase):
    """Schema trả về thông tin User (không bao gồm password)."""
    id: int
    full_name: str
    email: EmailStr
    is_active: bool
    created_at: datetime
    updated_at: datetime


class UserSummary(OrmBase):
    """Schema rút gọn, dùng khi nhúng vào Task response."""
    id: int
    full_name: str
    email: EmailStr


# ===========================================================================
# MEETING schemas
# ===========================================================================
class MeetingBase(BaseModel):
    """Trường chung cho Meeting."""
    title: str = Field(
        ...,
        min_length=3,
        max_length=512,
        examples=["Họp kế hoạch Q3/2025"],
    )
    description: str | None = Field(
        None,
        max_length=2048,
        examples=["Thảo luận về roadmap sản phẩm và phân công công việc."],
    )


class MeetingCreate(MeetingBase):
    """Schema tạo mới Meeting (chưa có audio/transcript)."""
    pass


class MeetingUpdate(BaseModel):
    """Schema cập nhật Meeting."""
    title: str | None = Field(None, min_length=3, max_length=512)
    description: str | None = None
    final_minutes: str | None = None
    raw_transcript: str | None = None
    status: MeetingStatus | None = None


class AIRewriteRequest(BaseModel):
    """Schema yêu cầu AI biên tập / tái cấu trúc văn bản cuộc họp."""
    mode: str = Field(
        default="administrative",
        description="Chế độ biên tập: administrative | corporate | news_digest | concise | detailed | custom",
    )
    custom_instruction: str | None = Field(
        default=None,
        description="Chỉ thị riêng tùy chỉnh của người dùng",
    )


class MeetingRead(OrmBase):
    """Schema đầy đủ cho một Meeting (bao gồm transcript và biên bản)."""
    id: int
    title: str
    description: str | None
    audio_file_url: str | None
    raw_transcript: str | None
    final_minutes: str | None
    status: MeetingStatus
    created_at: datetime
    updated_at: datetime

    # Danh sách task con (rút gọn, không đệ quy)
    tasks: list["TaskSummary"] = Field(default_factory=list)


class MeetingSummary(OrmBase):
    """Schema rút gọn cho Meeting, dùng trong danh sách."""
    id: int
    title: str
    status: MeetingStatus
    audio_file_url: str | None
    created_at: datetime


# ===========================================================================
# TASK schemas
# ===========================================================================
class TaskBase(BaseModel):
    """Trường chung cho Task."""
    title: str = Field(
        ...,
        min_length=3,
        max_length=512,
        examples=["Hoàn thành báo cáo tháng 7"],
    )
    description: str | None = Field(
        None,
        max_length=4096,
        examples=["Tổng hợp doanh thu theo từng khu vực và gửi cho ban giám đốc."],
    )
    due_date: datetime | None = Field(
        None,
        examples=["2025-07-31T17:00:00+07:00"],
    )


class TaskCreate(TaskBase):
    """Schema tạo mới Task. Yêu cầu meeting_id; assignee_id tuỳ chọn."""
    meeting_id: int = Field(..., gt=0)
    assignee_id: int | None = Field(None, gt=0)
    status: TaskStatus = Field(default=TaskStatus.PENDING)


class TaskUpdate(BaseModel):
    """Schema cập nhật Task (tất cả trường đều optional)."""
    title: str | None = Field(None, min_length=3, max_length=512)
    description: str | None = None
    assignee_id: int | None = Field(None, gt=0)
    status: TaskStatus | None = None
    due_date: datetime | None = None


class TaskRead(OrmBase):
    """Schema đầy đủ cho một Task."""
    id: int
    meeting_id: int
    assignee_id: int | None
    title: str
    description: str | None
    status: TaskStatus
    due_date: datetime | None
    created_at: datetime
    updated_at: datetime

    # Thông tin người được giao (rút gọn)
    assignee: UserSummary | None = None


class TaskSummary(OrmBase):
    """Schema rút gọn cho Task, dùng khi nhúng trong MeetingRead."""
    id: int
    title: str
    status: TaskStatus
    assignee_id: int | None


# ===========================================================================
# AI PROCESSING schemas
# ===========================================================================
class TaskExtracted(BaseModel):
    """
    Một công việc được AI trích xuất từ biên bản họp.
    Dùng để parse JSON trả về từ LLM (qwen2.5:1.5b).
    """
    title: str = Field(..., description="Tên công việc ngắn gọn")
    description: str | None = Field(None, description="Chi tiết thực hiện")
    assignee_name: str | None = Field(
        None,
        description="Tên người được giao (theo transcript, chưa map với User.id)",
    )
    due_date: str | None = Field(
        None,
        description="Deadline dạng chuỗi tự do từ transcript (ví dụ: 'cuối tuần', '15/8')",
    )


class AIProcessingResult(BaseModel):
    """
    Kết quả tổng hợp từ pipeline AI (Whisper + LLM).
    Đây là schema response cho endpoint POST /api/v1/audio/{meeting_id}/process.
    """
    meeting_id: int = Field(..., description="ID cuộc họp đã được xử lý")
    audio_file_url: str = Field(..., description="Đường dẫn file audio đã lưu")
    raw_transcript: str = Field(..., description="Văn bản thô từ Whisper")
    minutes: str = Field(..., description="Biên bản họp đã định dạng (Markdown)")
    tasks: list[TaskExtracted] = Field(
        default_factory=list,
        description="Danh sách công việc được AI trích xuất",
    )
    processing_metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Thông tin bổ sung: thời gian xử lý, model sử dụng, v.v.",
    )


class ErrorResponse(BaseModel):
    """Schema chuẩn cho phản hồi lỗi."""
    error: str = Field(..., description="Mã lỗi ngắn (snake_case)")
    message: str = Field(..., description="Thông điệp lỗi đọc được cho người dùng")
    detail: Any | None = Field(None, description="Chi tiết kỹ thuật bổ sung (tuỳ chọn)")


# Cập nhật forward references (cần thiết cho model lồng nhau)
MeetingRead.model_rebuild()
TaskRead.model_rebuild()
