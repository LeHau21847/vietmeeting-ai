"""
app/core/database.py

Thiết lập kết nối cơ sở dữ liệu SQLite bất đồng bộ (Async) sử dụng
SQLAlchemy 2.x với driver aiosqlite.

Kiến trúc:
  - AsyncEngine: engine kết nối thực sự đến file SQLite
  - async_session_maker: factory tạo ra các phiên làm việc (session)
  - Base: lớp cha cho tất cả các SQLAlchemy models
  - get_db(): dependency injection cho FastAPI endpoints
  - init_db(): hàm khởi tạo schema khi ứng dụng khởi động
"""

import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

# ---------------------------------------------------------------------------
# Logger
# ---------------------------------------------------------------------------
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Cấu hình đường dẫn database
# ---------------------------------------------------------------------------
# File SQLite sẽ được tạo tại thư mục gốc của dự án
DATABASE_URL = "sqlite+aiosqlite:///./vietmeeting.db"

# ---------------------------------------------------------------------------
# Tạo Async Engine
# ---------------------------------------------------------------------------
# echo=False ở production để tránh log SQL ra console
# connect_args: check_same_thread=False bắt buộc với SQLite để hỗ trợ async
engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    connect_args={"check_same_thread": False},
)

# ---------------------------------------------------------------------------
# Session Factory
# ---------------------------------------------------------------------------
# expire_on_commit=False: sau khi commit, đối tượng vẫn giữ nguyên data
# (quan trọng với async vì không thể lazy-load sau khi session đóng)
async_session_maker = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
    autocommit=False,
)

# ---------------------------------------------------------------------------
# Base Class cho tất cả Models
# ---------------------------------------------------------------------------
class Base(DeclarativeBase):
    """
    Lớp cơ sở khai báo metadata cho toàn bộ SQLAlchemy models.
    Tất cả model trong app/models/ phải kế thừa từ lớp này.
    """
    pass


# ---------------------------------------------------------------------------
# Dependency Injection cho FastAPI
# ---------------------------------------------------------------------------
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    FastAPI dependency cung cấp một AsyncSession cho mỗi request.

    Sử dụng với Depends():
        async def endpoint(db: AsyncSession = Depends(get_db)):
            ...

    Session sẽ tự động được đóng sau khi request kết thúc,
    dù có exception hay không.
    """
    async with async_session_maker() as session:
        try:
            yield session
            await session.commit()
        except Exception as exc:
            await session.rollback()
            logger.error(
                "Database session error – đã rollback. Chi tiết: %s",
                str(exc),
                exc_info=True,
            )
            raise
        finally:
            await session.close()


# ---------------------------------------------------------------------------
# Khởi tạo Database Schema
# ---------------------------------------------------------------------------
async def init_db() -> None:
    """
    Tạo tất cả các bảng trong database nếu chưa tồn tại.
    Hàm này được gọi tại startup event trong main.py.

    Lưu ý: Import các models ở đây để đảm bảo SQLAlchemy
    nhận biết metadata trước khi tạo bảng.
    """
    try:
        # Import models để đăng ký metadata vào Base
        from app.models import models  # noqa: F401 – side-effect import

        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        logger.info("✅ Database đã được khởi tạo thành công tại: %s", DATABASE_URL)

    except Exception as exc:
        logger.critical(
            "❌ Không thể khởi tạo database. Ứng dụng sẽ không hoạt động đúng. Chi tiết: %s",
            str(exc),
            exc_info=True,
        )
        raise
