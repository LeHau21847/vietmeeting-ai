"""
app/models/models.py

Định nghĩa các bảng cơ sở dữ liệu sử dụng SQLAlchemy ORM.

Các bảng:
  - User    : Tài khoản người dùng / thành viên cuộc họp
  - Meeting : Cuộc họp (lưu file âm thanh, transcript thô, biên bản)
  - Task    : Công việc được giao từ cuộc họp (gắn với meeting và assignee)

Tất cả bảng đều có cột created_at và updated_at được quản lý tự động.
"""

import enum
from datetime import datetime

from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


# ---------------------------------------------------------------------------
# Enum: Trạng thái Task
# ---------------------------------------------------------------------------
class TaskStatus(str, enum.Enum):
    """Trạng thái vòng đời của một công việc."""
    PENDING    = "pending"      # Chờ thực hiện
    IN_PROGRESS = "in_progress" # Đang thực hiện
    DONE       = "done"         # Hoàn thành
    CANCELLED  = "cancelled"    # Đã huỷ


# ---------------------------------------------------------------------------
# Enum: Trạng thái Meeting
# ---------------------------------------------------------------------------
class MeetingStatus(str, enum.Enum):
    """Trạng thái xử lý của một cuộc họp."""
    CREATED     = "created"     # Vừa tạo, chưa có audio
    PROCESSING  = "processing"  # Đang phân tích AI
    COMPLETED   = "completed"   # Đã có biên bản
    FAILED      = "failed"      # Xử lý thất bại


# ---------------------------------------------------------------------------
# Model: User
# ---------------------------------------------------------------------------
class User(Base):
    """
    Đại diện cho tài khoản người dùng trong hệ thống.

    Columns:
        id          : Khóa chính tự tăng
        full_name   : Họ tên đầy đủ
        email       : Email (unique, dùng để đăng nhập)
        hashed_password: Mật khẩu đã được hash (không lưu plaintext)
        is_active   : Tài khoản có đang hoạt động không
        created_at  : Thời điểm tạo tài khoản
        updated_at  : Thời điểm cập nhật cuối
    """
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True, autoincrement=True)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(512), nullable=False)
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    # Relationships
    assigned_tasks: Mapped[list["Task"]] = relationship(
        "Task",
        back_populates="assignee",
        foreign_keys="Task.assignee_id",
        lazy="select",
    )

    def __repr__(self) -> str:
        return f"<User id={self.id} email={self.email!r}>"


# ---------------------------------------------------------------------------
# Model: Meeting
# ---------------------------------------------------------------------------
class Meeting(Base):
    """
    Lưu thông tin một cuộc họp, bao gồm file âm thanh và kết quả AI.

    Columns:
        id              : Khóa chính tự tăng
        title           : Tên/tiêu đề cuộc họp
        description     : Mô tả ngắn (tuỳ chọn)
        audio_file_url  : Đường dẫn tương đối đến file ghi âm (ví dụ: uploads/audio/xxx.wav)
        raw_transcript  : Văn bản thô được chuyển từ giọng nói (Whisper output)
        final_minutes   : Biên bản họp chính thức (JSON string từ LLM)
        status          : Trạng thái xử lý (MeetingStatus enum)
        created_at      : Thời điểm tạo bản ghi
        updated_at      : Thời điểm cập nhật cuối
    """
    __tablename__ = "meetings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Đường dẫn tương đối từ thư mục gốc dự án
    audio_file_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)

    # Transcript thô từ Whisper (có thể rất dài)
    raw_transcript: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Biên bản họp dạng JSON string được tạo bởi LLM
    final_minutes: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[MeetingStatus] = mapped_column(
        Enum(MeetingStatus),
        default=MeetingStatus.CREATED,
        nullable=False,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    # Relationships
    tasks: Mapped[list["Task"]] = relationship(
        "Task",
        back_populates="meeting",
        cascade="all, delete-orphan",
        lazy="select",
    )

    def __repr__(self) -> str:
        return f"<Meeting id={self.id} title={self.title!r} status={self.status}>"


# ---------------------------------------------------------------------------
# Model: Task
# ---------------------------------------------------------------------------
class Task(Base):
    """
    Công việc được trích xuất từ biên bản họp và giao cho một thành viên.

    Columns:
        id          : Khóa chính tự tăng
        meeting_id  : FK → Meeting.id (cuộc họp phát sinh công việc)
        assignee_id : FK → User.id (người được giao, có thể null nếu chưa xác định)
        title       : Tên công việc (ngắn gọn)
        description : Mô tả chi tiết công việc (tuỳ chọn)
        status      : Trạng thái (TaskStatus enum)
        due_date    : Deadline (tuỳ chọn)
        created_at  : Thời điểm tạo
        updated_at  : Thời điểm cập nhật cuối
    """
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True, autoincrement=True)

    meeting_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("meetings.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    assignee_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    title: Mapped[str] = mapped_column(String(512), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[TaskStatus] = mapped_column(
        Enum(TaskStatus),
        default=TaskStatus.PENDING,
        nullable=False,
    )

    due_date: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    # Relationships
    meeting: Mapped["Meeting"] = relationship(
        "Meeting",
        back_populates="tasks",
    )
    assignee: Mapped["User | None"] = relationship(
        "User",
        back_populates="assigned_tasks",
        foreign_keys=[assignee_id],
    )

    def __repr__(self) -> str:
        return f"<Task id={self.id} title={self.title!r} status={self.status}>"
