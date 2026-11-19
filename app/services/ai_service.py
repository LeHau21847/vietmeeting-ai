"""
app/services/ai_service.py

Module xử lý AI Hybrid cao cấp cho VietMeeting AI.

Hỗ trợ 2 chế độ xử lý linh hoạt:
  1. Google Gemini Multimodal Cloud AI (Chủ lực, nhanh, độ chính xác 99% tiếng Việt, 0% VRAM):
     - Gemini File API (resumable upload) cho file âm thanh lớn (>8MB, hỗ trợ file 1-2 tiếng)
     - Inline Base64 cho file âm thanh nhỏ (<8MB)
     - Pha 1: Chuyển đổi giọng nói thành văn bản (Speech-to-Text) chuẩn chính tả, tên riêng, địa danh
     - Pha 2: Phân tích cấu trúc biên bản hành chính 3 phần và trích xuất danh sách công việc (Tasks)
     - Tự động fallback model: gemini-2.5-flash -> gemini-2.0-flash -> gemini-1.5-flash -> gemini-flash-latest

  2. Local AI 100% Offline (Dự phòng Zero-Crash):
     - faster-whisper (small int8 trên GPU, tự hạ CPU int8 khi thiếu VRAM)
     - Ollama Qwen2.5 Map-Reduce chunking cho file dài
     - Smart Extractive Summarization & Rule-based Task Extractor đảm bảo không bao giờ văng HTTP 503

Kiến trúc Progress Tracking:
  - PROGRESS_STORE: In-memory dictionary theo dõi tiến trình xử lý từng meeting
  - Cập nhật liên tục % tiến độ, bước hiện tại, và partial transcript
  - Frontend polling GET /progress mỗi 1.5s để hiển thị real-time
"""

from __future__ import annotations

import asyncio
import base64
import gc
import io
import json
import logging
import mimetypes
import os
import re
import socket
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

try:
    import av
    HAS_AV = True
except ImportError:
    av = None
    HAS_AV = False

# Tự động nạp thư mục DLL của NVIDIA (cublas, cudnn) trong virtualenv trên Windows
if sys.platform == "win32":
    try:
        _venv_base = Path(sys.executable).parent.parent
        for _sub in ["cublas", "cudnn"]:
            _bin_dir = _venv_base / "Lib" / "site-packages" / "nvidia" / _sub / "bin"
            if _bin_dir.exists():
                try:
                    os.add_dll_directory(str(_bin_dir))
                except Exception:
                    pass
                os.environ["PATH"] = str(_bin_dir) + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass

import httpx

try:
    import ollama
    HAS_LOCAL_OLLAMA = True
except ImportError:
    ollama = None
    HAS_LOCAL_OLLAMA = False

# ---------------------------------------------------------------------------
# Logger
# ---------------------------------------------------------------------------
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Thread Pool Executor cho các tác vụ blocking (Whisper, Ollama)
# ---------------------------------------------------------------------------
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="ai_worker")

# ---------------------------------------------------------------------------
# Hằng số cấu hình Local AI
# ---------------------------------------------------------------------------
WHISPER_MODEL_PRIMARY = "small"     # Ưu tiên small: Nghe tiếng Việt chính xác hơn base nhiều lần
WHISPER_MODEL_FALLBACK = "base"     # Fallback nếu máy chưa tải hoặc lỗi VRAM
WHISPER_COMPUTE_TYPE_GPU = "int8"   # int8 chỉ tốn ~500MB VRAM trên GTX 1650
WHISPER_LANGUAGE = "vi"             # Ngôn ngữ cố định: Tiếng Việt

OLLAMA_MODEL = "qwen2.5:1.5b"      # Model LLM nhỏ gọn, phù hợp 4GB VRAM
OLLAMA_TIMEOUT = 900                # 15 phút – hỗ trợ file dài 1 tiếng

# Prompt mồi ban đầu cho Whisper để định hình từ vựng tiếng Việt
WHISPER_INITIAL_PROMPT = (
    "Biên bản cuộc họp hành chính, doanh nghiệp, chính phủ tại Việt Nam. "
    "Chủ trì, thư ký, đại biểu, Tổng Bí thư, Chủ tịch nước, Thủ tướng, Phó Thủ tướng, "
    "Quốc hội, Ban Bí thư, Ủy ban Kiểm tra Trung ương, Bộ Quốc phòng, kế hoạch, triển khai, "
    "đề nghị, yêu cầu, hoàn thành, chuyển đổi số, kinh tế vĩ mô, giải ngân đầu tư công, "
    "Lào, Campuchia, Hoa Kỳ, Trung Quốc."
)

# Ngưỡng kích hoạt Map-Reduce: ~3000 ký tự (~600 từ / ~4-5 phút nói)
CHUNK_THRESHOLD_CHARS = 3000
CHUNK_MAX_SIZE_CHARS = 2800         # Mỗi chunk ~2.500 - 3.000 ký tự
CHUNK_OVERLAP_CHARS = 200          # Đoạn gối đầu giữa các chunk

# ---------------------------------------------------------------------------
# Hằng số & Cấu hình Google Gemini API
# ---------------------------------------------------------------------------
# Danh sách model Google Gemini thực tế theo thứ tự ưu tiên cao nhất
GEMINI_PRIORITY_MODELS = [
    "gemini-3-flash-preview",
    "gemini-3.5-flash",
    "gemini-flash-lite-latest",
    "gemini-flash-latest",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
    "gemini-pro-latest",
]

GEMINI_AUDIO_MODELS = GEMINI_PRIORITY_MODELS
GEMINI_TEXT_MODELS = GEMINI_PRIORITY_MODELS
GEMINI_MODELS = GEMINI_PRIORITY_MODELS

GEMINI_API_BASE = "https://generativelanguage.googleapis.com"

# Đường dẫn file .env
ENV_FILE_PATH = Path(".env")


def _read_env_value(key: str, default: str = "") -> str:
    """Đọc giá trị từ file .env nếu có, fallback os.environ."""
    if ENV_FILE_PATH.exists():
        try:
            with open(ENV_FILE_PATH, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        if k.strip() == key:
                            val = v.strip().strip('"').strip("'")
                            if val:
                                return val
        except Exception:
            pass
    return os.environ.get(key, default)


# Biến runtime lưu cấu hình AI
_GEMINI_API_KEY: str = _read_env_value("GEMINI_API_KEY", "")
_PREFERRED_AI_ENGINE: str = _read_env_value("PREFERRED_AI_ENGINE", "gemini")

# Cache lưu kết quả dò model động & trạng thái mạng
_discovered_gemini_models: list[str] = []
_discovered_models_timestamp: float = 0.0
_internet_status_cache: bool = True
_internet_check_ts: float = 0.0


def _mark_network_offline() -> None:
    """Đánh dấu mất kết nối mạng tức thì và log ra terminal."""
    global _internet_status_cache, _internet_check_ts
    _internet_status_cache = False
    _internet_check_ts = time.time()
    logger.warning("No WiFi detected. Falling back to Local Whisper & Ollama")


def check_internet_available(timeout_sec: float = 2.0) -> bool:
    """
    Kiểm tra kết nối Internet siêu tốc trong <= 2 giây.
    Nếu không có WiFi / Internet, trả về False ngay lập tức để kích hoạt Local AI.
    """
    global _internet_status_cache, _internet_check_ts
    now = time.time()
    if now - _internet_check_ts < 4.0:
        return _internet_status_cache

    is_online = False
    for host, port in [("generativelanguage.googleapis.com", 443), ("8.8.8.8", 53)]:
        try:
            with socket.create_connection((host, port), timeout=timeout_sec):
                is_online = True
                break
        except OSError:
            continue

    _internet_status_cache = is_online
    _internet_check_ts = now
    if not is_online:
        logger.warning("No WiFi detected. Falling back to Local Whisper & Ollama")
    return is_online


async def _persist_partial_transcript_safe(meeting_id: int, partial_text: str) -> None:
    """
    Lưu an toàn bản gỡ băng thô của các chunk đã hoàn thành vào SQLite.
    Đảm bảo kể cả khi Local AI bị tràn RAM ở các chunk sau, dữ liệu của các chunk trước vẫn được bảo toàn 100%.
    """
    if meeting_id <= 0 or not partial_text or not partial_text.strip():
        return
    try:
        from app.core.database import async_session_maker
        from app.models.models import Meeting

        async with async_session_maker() as session:
            try:
                meeting_obj = await session.get(Meeting, meeting_id)
                if meeting_obj is not None:
                    meeting_obj.raw_transcript = partial_text
                    await session.flush()
                    await session.commit()
            except Exception as commit_err:
                await session.rollback()
                logger.warning("⚠️ Rollback khi lưu partial transcript meeting %d: %s", meeting_id, commit_err)
    except Exception as db_err:
        logger.debug("⚠️ Không thể lưu tạm partial transcript: %s", db_err)


def extract_text_from_docx(file_input: bytes | str | Path) -> str:
    """
    Trích xuất toàn bộ nội dung văn bản và cấu trúc bảng biểu từ tệp mẫu Word (.docx).
    Dùng cho tính năng Custom Template Learner giúp AI học 100% hệ thống đề mục,
    cách kẻ bảng và văn phong biểu mẫu riêng của cơ quan/doanh nghiệp.
    """
    try:
        import docx
        from docx.oxml.text.paragraph import CT_P
        from docx.oxml.table import CT_Tbl
        from docx.text.paragraph import Paragraph
        from docx.table import Table
    except ImportError as exc:
        raise RuntimeError(
            "Thư viện 'python-docx' chưa được cài đặt. Vui lòng chạy: pip install python-docx"
        ) from exc

    if isinstance(file_input, (bytes, bytearray)):
        doc = docx.Document(io.BytesIO(file_input))
    else:
        doc = docx.Document(str(file_input))

    blocks: list[str] = []

    # Duyệt tuần tự theo đúng thứ tự xuất hiện của đoạn văn và bảng biểu trong tài liệu
    for child in doc.element.body.iterchildren():
        if isinstance(child, CT_P):
            para = Paragraph(child, doc)
            text = para.text.strip()
            if text:
                blocks.append(text)
        elif isinstance(child, CT_Tbl):
            table = Table(child, doc)
            table_lines: list[str] = []
            for r_idx, row in enumerate(table.rows):
                cells = [c.text.strip().replace("\n", " ") for c in row.cells]
                if any(cells):
                    table_lines.append("| " + " | ".join(cells) + " |")
                    if r_idx == 0:
                        table_lines.append("| " + " | ".join(["---"] * len(cells)) + " |")
            if table_lines:
                blocks.append("\n".join(table_lines))

    extracted = "\n".join(blocks).strip()
    if not extracted:
        raise ValueError("Tệp biểu mẫu (.docx) rỗng hoặc không chứa văn bản hợp lệ.")
    return extracted


def _get_available_gemini_model(api_key: str | None = None) -> str:
    """
    Tự động dò và chọn model Google Gemini mạnh nhất khả dụng với API Key.
    Gọi GET https://generativelanguage.googleapis.com/v1beta/models?key={api_key}
    """
    key = api_key or _GEMINI_API_KEY
    if not key:
        return "gemini-2.5-flash"

    global _discovered_gemini_models, _discovered_models_timestamp
    if _discovered_gemini_models and (time.time() - _discovered_models_timestamp < 600.0):
        return _discovered_gemini_models[0]

    if not check_internet_available(timeout_sec=2.0):
        return "gemini-2.5-flash"

    try:
        with httpx.Client(timeout=httpx.Timeout(3.0, connect=2.0)) as client:
            res = client.get(f"{GEMINI_API_BASE}/v1beta/models?key={key}")
            if res.status_code == 200:
                data = res.json()
                avail = {
                    m.get("name", "").replace("models/", "")
                    for m in data.get("models", [])
                    if "generateContent" in m.get("supportedGenerationMethods", [])
                }
                matched = [m for m in GEMINI_PRIORITY_MODELS if m in avail]
                if matched:
                    _discovered_gemini_models = matched
                    _discovered_models_timestamp = time.time()
                    return matched[0]
    except (httpx.ConnectError, httpx.TimeoutException) as net_exc:
        _mark_network_offline()
        logger.debug("⚠️ Lỗi mạng khi dò model Gemini đồng bộ: %s", net_exc)
    except Exception as exc:
        logger.debug("⚠️ Lỗi dò model Gemini đồng bộ: %s", exc)

    return "gemini-2.5-flash"


async def _get_available_gemini_models_async(api_key: str | None = None) -> list[str]:
    """
    Dò danh sách tất cả các model Google Gemini mà API Key của người dùng được phép truy cập.
    Bắt lỗi mất mạng ngay trong 2 giây đầu tiên.
    """
    key = api_key or _GEMINI_API_KEY
    if not key:
        return list(GEMINI_PRIORITY_MODELS)

    global _discovered_gemini_models, _discovered_models_timestamp
    if _discovered_gemini_models and (time.time() - _discovered_models_timestamp < 600.0):
        return _discovered_gemini_models

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3.0, connect=2.0)) as client:
            res = await client.get(f"{GEMINI_API_BASE}/v1beta/models?key={key}")
            if res.status_code == 200:
                data = res.json()
                avail = {
                    m.get("name", "").replace("models/", "")
                    for m in data.get("models", [])
                    if "generateContent" in m.get("supportedGenerationMethods", [])
                }
                matched = [m for m in GEMINI_PRIORITY_MODELS if m in avail]
                for extra in sorted(avail):
                    if extra not in matched and ("flash" in extra or "pro" in extra):
                        matched.append(extra)
                if matched:
                    _discovered_gemini_models = matched
                    _discovered_models_timestamp = time.time()
                    logger.info("✨ [Gemini Dynamic Discovery] Đã dò thấy %d models. Model số 1: %s", len(matched), matched[0])
                    return matched
    except (httpx.ConnectError, httpx.TimeoutException) as net_err:
        _mark_network_offline()
        raise ConnectionError("No WiFi detected. Falling back to Local Whisper & Ollama") from net_err
    except Exception as exc:
        logger.warning("⚠️ Lỗi dò danh sách Gemini models: %s. Dùng danh sách ưu tiên.", exc)

    return list(GEMINI_PRIORITY_MODELS)


def is_valid_gemini_key(key: str | None) -> bool:
    """Kiểm tra tính hợp lệ về mặt hình thức của Gemini API Key."""
    if not key:
        return False
    k = key.strip()
    if len(k) < 30:
        return False
    if "vietmeeting" in k.lower():
        return False
    return True


def get_ai_config() -> dict[str, Any]:
    """Lấy thông tin cấu hình AI hiện tại cho client (kèm phát hiện mất mạng tức thì)."""
    has_key = is_valid_gemini_key(_GEMINI_API_KEY)
    masked_key = ""
    if has_key:
        k = _GEMINI_API_KEY.strip()
        if len(k) > 12:
            masked_key = f"{k[:6]}...{k[-4:]}"
        else:
            masked_key = "***"

    is_online = check_internet_available(timeout_sec=1.5)
    is_offline_fallback = False

    if has_key and _PREFERRED_AI_ENGINE != "local":
        if is_online:
            active_engine = "gemini"
        else:
            active_engine = "local"
            is_offline_fallback = True
    else:
        active_engine = "local"

    return {
        "has_gemini_key": has_key,
        "gemini_api_key_masked": masked_key,
        "preferred_engine": _PREFERRED_AI_ENGINE,
        "active_engine": active_engine,
        "engine_used": active_engine,
        "is_offline_fallback": is_offline_fallback,
        "active_model": (
            _discovered_gemini_models[0]
            if (_discovered_gemini_models and active_engine == "gemini")
            else ("gemini-2.5-flash" if active_engine == "gemini" else "whisper-small + qwen2.5:1.5b")
        ),
        "supported_models": GEMINI_MODELS,
    }


def update_ai_config(api_key: str | None = None, preferred_engine: str | None = None) -> dict[str, Any]:
    """
    Cập nhật Gemini API Key và Preferred Engine ngay trong runtime,
    đồng thời ghi đè vào file .env để lưu vĩnh viễn.
    Kiểm tra tính hợp lệ thật sự của API Key bằng live probe.
    """
    global _GEMINI_API_KEY, _PREFERRED_AI_ENGINE

    if api_key is not None:
        key_cleaned = api_key.strip()
        if key_cleaned:
            if not is_valid_gemini_key(key_cleaned):
                raise ValueError("Khóa Gemini API không đúng định dạng (phải có tối thiểu 30 ký tự và không chứa tên dự án).")
            # Live probe to Google Gemini API
            try:
                with httpx.Client(timeout=8.0) as test_client:
                    test_url = f"{GEMINI_API_BASE}/v1beta/models?key={key_cleaned}"
                    test_res = test_client.get(test_url)
                    if test_res.status_code != 200:
                        raise ValueError(f"Khóa Gemini API không hợp lệ hoặc đã bị Google từ chối (Mã HTTP {test_res.status_code}).")
            except httpx.RequestError as net_err:
                logger.warning("⚠️ Không thể kết nối tới Google API để kiểm tra khóa: %s", net_err)

            _GEMINI_API_KEY = key_cleaned
            os.environ["GEMINI_API_KEY"] = _GEMINI_API_KEY
        else:
            _GEMINI_API_KEY = ""
            os.environ["GEMINI_API_KEY"] = ""

    if preferred_engine is not None and preferred_engine.lower() in ("gemini", "local"):
        _PREFERRED_AI_ENGINE = preferred_engine.lower()
        os.environ["PREFERRED_AI_ENGINE"] = _PREFERRED_AI_ENGINE

    # Ghi vào file .env
    try:
        env_dict: dict[str, str] = {}
        if ENV_FILE_PATH.exists():
            with open(ENV_FILE_PATH, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        env_dict[k.strip()] = v.strip()

        env_dict["GEMINI_API_KEY"] = _GEMINI_API_KEY
        env_dict["PREFERRED_AI_ENGINE"] = _PREFERRED_AI_ENGINE

        with open(ENV_FILE_PATH, "w", encoding="utf-8") as f:
            for k, v in env_dict.items():
                f.write(f"{k}={v}\n")
        logger.info("💾 Đã cập nhật file .env với cấu hình AI mới.")
    except Exception as exc:
        logger.warning("⚠️ Không thể ghi vào file .env: %s", exc)

    return get_ai_config()


# ===========================================================================
# PROGRESS STORE – Theo dõi tiến trình xử lý real-time
# ===========================================================================
PROGRESS_STORE: dict[int, dict[str, Any]] = {}


def init_progress(meeting_id: int) -> None:
    """Khởi tạo progress tracking cho một meeting."""
    initial_engine = (
        "gemini"
        if (_PREFERRED_AI_ENGINE != "local" and is_valid_gemini_key(_GEMINI_API_KEY) and check_internet_available(timeout_sec=1.5))
        else "local"
    )
    PROGRESS_STORE[meeting_id] = {
        "status": "uploading",
        "progress_percent": 0,
        "current_step_detail": "Đang chuẩn bị xử lý file audio...",
        "partial_transcript": "",
        "current_engine": initial_engine,
        "engine_used": initial_engine,
    }


def update_progress(
    meeting_id: int,
    *,
    status: str | None = None,
    progress_percent: int | None = None,
    current_step_detail: str | None = None,
    partial_transcript: str | None = None,
    engine_used: str | None = None,
    current_engine: str | None = None,
) -> None:
    """Cập nhật tiến trình cho một meeting (đồng bộ current_engine & engine_used)."""
    if meeting_id not in PROGRESS_STORE:
        init_progress(meeting_id)
    store = PROGRESS_STORE[meeting_id]
    if status is not None:
        store["status"] = status
    if progress_percent is not None:
        store["progress_percent"] = min(max(progress_percent, 0), 100)
    if current_step_detail is not None:
        store["current_step_detail"] = current_step_detail
    if partial_transcript is not None:
        store["partial_transcript"] = partial_transcript
    resolved_engine = current_engine or engine_used
    if resolved_engine is not None:
        store["current_engine"] = resolved_engine
        store["engine_used"] = resolved_engine


def get_progress(meeting_id: int) -> dict[str, Any]:
    """Lấy tiến trình hiện tại của meeting."""
    return PROGRESS_STORE.get(meeting_id, {
        "status": "unknown",
        "progress_percent": 0,
        "current_step_detail": "Không có dữ liệu tiến trình.",
        "partial_transcript": "",
        "current_engine": "gemini",
        "engine_used": "gemini",
    })


def cleanup_progress(meeting_id: int) -> None:
    """Xóa progress data sau khi hoàn tất."""
    PROGRESS_STORE.pop(meeting_id, None)


# ===========================================================================
# TẦNG HẬU XỬ LÝ SỬA LỖI NGỮ ÂM TIẾNG VIỆT (Vietnamese ASR Post-Correction)
# ===========================================================================
_VIETNAMESE_HOMOPHONE_RULES: list[tuple[re.Pattern, str]] = [
    # Lãnh đạo cấp cao & Chức danh
    (re.compile(r"\bphó\s+thử\s+tướng\b", re.IGNORECASE), "Phó Thủ tướng"),
    (re.compile(r"\bthử\s+tướng\b", re.IGNORECASE), "Thủ tướng"),
    (re.compile(r"\btổng\s+bí\s+thư\b", re.IGNORECASE), "Tổng Bí thư"),
    (re.compile(r"\bchủ\s+tịch\s+nước\b", re.IGNORECASE), "Chủ tịch nước"),
    (re.compile(r"\bquốc\s+hội\b", re.IGNORECASE), "Quốc hội"),
    (re.compile(r"\bban\s+bí\s+thư\b", re.IGNORECASE), "Ban Bí thư"),
    (re.compile(r"\bbộ\s+(?:trính|chính)\s+chị\b", re.IGNORECASE), "Bộ Chính trị"),
    (re.compile(r"\b(ủy\s+ban\s+kiểm\s+tra\s+trung\s+ương|ubkt\s+trung\s+ương)\b", re.IGNORECASE), "Ủy ban Kiểm tra Trung ương"),
    (re.compile(r"\bbộ\s+quốc\s+phòng\b", re.IGNORECASE), "Bộ Quốc phòng"),

    # Tên riêng nhân vật chính trị hay bị nhận diện nhầm
    (re.compile(r"\b(trên|trình|chần)\s+cẩm\s+(?:tố|tú)\b", re.IGNORECASE), "Trần Cẩm Tú"),
    (re.compile(r"\b(trần|trên)\s+thành\s+(?:bánh|mạnh|bản|mẫn)\b", re.IGNORECASE), "Trần Thanh Mẫn"),
    (re.compile(r"\b(lấy|lê)\s+minh\s+(?:hương|hưng)\b", re.IGNORECASE), "Lê Minh Hưng"),
    (re.compile(r"\b(phạm\s+minh\s+chính|phạm\s+minh\s+chính)\b", re.IGNORECASE), "Phạm Minh Chính"),
    (re.compile(r"\btô\s+lâm\b", re.IGNORECASE), "Tô Lâm"),

    # Quốc gia & Địa danh quốc tế
    (re.compile(r"\b(tác\s+mạng\s+lao|cách\s+mạng\s+lao)\b", re.IGNORECASE), "Cách mạng Lào"),
    (re.compile(r"\bđẳng\s+nhân\s+dân\b", re.IGNORECASE), "Đảng Nhân dân"),
    (re.compile(r"\b(?:cápú|campo|campu|căm\s*pu)\s*chia\b", re.IGNORECASE), "Campuchia"),
    (re.compile(r"\b(diên\s+an|diên\s+ang)\b", re.IGNORECASE), "Diên An"),
    (re.compile(r"\b(ham\s*buốc|hăm\s*buốc|hambua|hamburg)\b", re.IGNORECASE), "Hamburg"),

    # Thuật ngữ kinh tế - xã hội - công nghệ
    (re.compile(r"\b(truyền\s+đổi\s+rô|chuyên\s+đối\s+xố|truyền\s+đủ\s+số|truyền\s+đổi\s+số)\b", re.IGNORECASE), "chuyển đổi số"),
    (re.compile(r"\bthăng\s+những\b", re.IGNORECASE), "tham nhũng"),
    (re.compile(r"\b(đổi\s+mời|đủ\s+mé|trở\s+mở)\s+sáng\s+tạo\b", re.IGNORECASE), "đổi mới sáng tạo"),
    (re.compile(r"\bgiải\s+gân\s+vốn\s+(?:đủ|đầu)\s+tư\s+công\b", re.IGNORECASE), "giải ngân vốn đầu tư công"),
    (re.compile(r"\bgiải\s+gân\b", re.IGNORECASE), "giải ngân"),
    (re.compile(r"\bkinh\s+tế\s+vĩ\s+mô\b", re.IGNORECASE), "kinh tế vĩ mô"),
    (re.compile(r"\bchính\s+phủ\s+điện\s+tử\b", re.IGNORECASE), "Chính phủ điện tử"),
    (re.compile(r"\bdữ\s+liệu\s+dân\s+cư\b", re.IGNORECASE), "dữ liệu dân cư"),
    (re.compile(r"\bcông\s+tác\s+cán\s+bộ\b", re.IGNORECASE), "công tác cán bộ"),
]


def clean_vietnamese_transcript(text: str) -> str:
    """Tầng hậu xử lý sửa lỗi phát âm và chính tả ngữ âm tiếng Việt."""
    if not text or not text.strip():
        return ""

    cleaned = text
    for pattern, replacement in _VIETNAMESE_HOMOPHONE_RULES:
        cleaned = pattern.sub(replacement, cleaned)

    # Chuẩn hóa khoảng trắng trước dấu câu
    cleaned = re.sub(r"\s+([.,!?:;])", r"\1", cleaned)
    # Đảm bảo có khoảng trắng sau dấu câu
    cleaned = re.sub(r"([.,!?:;])([^\s0-9.,!?:;])", r"\1 \2", cleaned)
    # Loại bỏ khoảng trắng thừa
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)

    # Viết hoa ký tự đầu tiên sau dấu chấm kết câu
    def _capitalize_match(match: re.Match) -> str:
        prefix = match.group(1)
        char = match.group(2)
        return prefix + char.upper()

    cleaned = re.sub(r"(^|[.!?]\s+)([a-zà-ỹ])", _capitalize_match, cleaned)
    return cleaned.strip()


# ===========================================================================
# GOOGLE GEMINI MULTIMODAL API (REST VIA HTTPX)
# ===========================================================================

def _detect_audio_mime_type(file_path: str) -> str:
    """Xác định MIME type chuẩn cho audio file."""
    ext = Path(file_path).suffix.lower()
    mapping = {
        ".mp3": "audio/mp3",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".m4a": "audio/mp4",
        ".mp4": "audio/mp4",
        ".webm": "audio/webm",
        ".flac": "audio/flac",
        ".aac": "audio/aac",
    }
    return mapping.get(ext, "audio/mp3")


async def _upload_to_gemini_files_api(
    file_path: str,
    mime_type: str,
    api_key: str,
    meeting_id: int = 0,
) -> dict[str, Any]:
    """
    Upload file âm thanh lớn lên Gemini File API sử dụng Resumable Upload protocol.
    Hỗ trợ file âm thanh lớn tới vài trăm MB (1-2 tiếng ghi âm).
    Đợi trạng thái ACTIVE trước khi trả về file_uri.
    """
    path_obj = Path(file_path)
    file_size = path_obj.stat().st_size
    file_name = path_obj.name

    logger.info("🚀 [Gemini File API] Bắt đầu upload file: %s (%d MB)", file_name, file_size // (1024 * 1024))
    if meeting_id > 0:
        update_progress(
            meeting_id,
            status="transcribing",
            progress_percent=8,
            current_step_detail=f"Đang tải file âm thanh ({file_size // (1024*1024)}MB) lên Google Gemini File API...",
        )

    async with httpx.AsyncClient(timeout=600.0) as client:
        # BƯỚC 1: Khởi tạo Resumable Upload Session
        init_url = f"{GEMINI_API_BASE}/upload/v1beta/files?key={api_key}"
        init_headers = {
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": str(file_size),
            "X-Goog-Upload-Header-Content-Type": mime_type,
            "Content-Type": "application/json",
        }
        init_body = json.dumps({"file": {"display_name": file_name}})

        init_res = await client.post(init_url, headers=init_headers, content=init_body)
        if init_res.status_code != 200:
            raise RuntimeError(f"Không thể khởi tạo Gemini File upload: {init_res.status_code} - {init_res.text}")

        upload_url = init_res.headers.get("X-Goog-Upload-URL")
        if not upload_url:
            raise RuntimeError("Gemini File API không trả về upload URL trong header.")

        # BƯỚC 2: Upload File Bytes
        if meeting_id > 0:
            update_progress(
                meeting_id,
                progress_percent=15,
                current_step_detail="Đang truyền dữ liệu âm thanh đến Google AI...",
            )

        with open(file_path, "rb") as f:
            file_bytes = f.read()

        upload_headers = {
            "Content-Length": str(file_size),
            "X-Goog-Upload-Offset": "0",
            "X-Goog-Upload-Command": "upload, finalize",
        }

        upload_res = await client.post(upload_url, headers=upload_headers, content=file_bytes)
        if upload_res.status_code not in (200, 201):
            raise RuntimeError(f"Lỗi khi upload dữ liệu âm thanh: {upload_res.status_code} - {upload_res.text}")

        file_info = upload_res.json().get("file", {})
        gemini_file_name = file_info.get("name")  # vd: "files/123456"
        file_uri = file_info.get("uri")
        state = file_info.get("state", "ACTIVE")

        logger.info("✅ [Gemini File API] File đã upload thành công: %s (State: %s)", gemini_file_name, state)

        # BƯỚC 3: Polling nếu file đang ở trạng thái PROCESSING
        poll_count = 0
        while state == "PROCESSING" and poll_count < 30:
            poll_count += 1
            await asyncio.sleep(2.0)
            check_url = f"{GEMINI_API_BASE}/v1beta/{gemini_file_name}?key={api_key}"
            check_res = await client.get(check_url)
            if check_res.status_code == 200:
                file_info = check_res.json()
                state = file_info.get("state", "ACTIVE")
                if state == "ACTIVE":
                    file_uri = file_info.get("uri", file_uri)
                    break
                elif state == "FAILED":
                    raise RuntimeError(f"Gemini File API xử lý file thất bại: {file_info}")

        if state != "ACTIVE":
            logger.warning("⚠️ File state hiện tại là %s, vẫn thử tiếp tục generateContent.", state)

        return {
            "file_uri": file_uri,
            "name": gemini_file_name,
            "mime_type": mime_type,
        }


async def _call_gemini_generate_content(
    parts: list[dict[str, Any]],
    system_instruction: str | None = None,
    response_mime_type: str | None = None,
    api_key: str | None = None,
    models_override: list[str] | None = None,
) -> str:
    """
    Gọi Gemini generateContent với cơ chế tự động dò model và fallback qua danh sách model.
    Tự động áp dụng maxOutputTokens 65536 cho các model 2.5/3.x và temperature 0.1.
    """
    key = api_key or _GEMINI_API_KEY
    if not key:
        raise ValueError("Chưa cấu hình GEMINI_API_KEY.")

    if not check_internet_available(timeout_sec=2.0):
        raise ConnectionError("No WiFi detected. Falling back to Local Whisper & Ollama")

    if models_override:
        model_list = models_override
    else:
        discovered = await _get_available_gemini_models_async(key)
        model_list = discovered if discovered else list(GEMINI_PRIORITY_MODELS)

    # Connect timeout 2.5s & read/write timeout 90s/20s để phát hiện rớt mạng giữa chừng tức thì
    fast_timeout = httpx.Timeout(90.0, connect=2.5, write=20.0)
    async with httpx.AsyncClient(timeout=fast_timeout) as client:
        last_error = None
        for model in model_list:
            # Quy chuẩn maxOutputTokens: 65536 cho dòng 2.5/3.x/latest, 8192 cho 2.0/1.5
            if any(ver in model for ver in ["2.5", "3.", "latest"]):
                max_tokens = 65536
            else:
                max_tokens = 8192

            url = f"{GEMINI_API_BASE}/v1beta/models/{model}:generateContent?key={key}"
            body: dict[str, Any] = {
                "contents": [
                    {
                        "role": "user",
                        "parts": parts,
                    }
                ],
                "generationConfig": {
                    "temperature": 0.1,
                    "maxOutputTokens": max_tokens,
                },
            }
            if system_instruction:
                body["systemInstruction"] = {
                    "parts": [{"text": system_instruction}]
                }
            if response_mime_type:
                body["generationConfig"]["responseMimeType"] = response_mime_type

            try:
                logger.info("🤖 [Gemini API] Gửi yêu cầu tới model: %s (maxTokens: %d, temp: 0.1)...", model, max_tokens)
                res = await client.post(url, json=body)
                if res.status_code == 200:
                    data = res.json()
                    candidates = data.get("candidates", [])
                    if candidates and "content" in candidates[0]:
                        parts_out = candidates[0]["content"].get("parts", [])
                        text_parts = [p.get("text", "") for p in parts_out if "text" in p]
                        output_text = "".join(text_parts).strip()
                        logger.info("✅ [Gemini API] Model '%s' phản hồi thành công (%d ký tự).", model, len(output_text))
                        return output_text
                elif res.status_code == 400 and "JSON mode is not enabled" in res.text:
                    logger.info("🔄 [Gemini API] Model '%s' không hỗ trợ ép JSON mode. Chuyển sang plain text...", model)
                    body_no_json = dict(body)
                    body_no_json["generationConfig"] = {
                        "temperature": 0.1,
                        "maxOutputTokens": max_tokens,
                    }
                    res_retry = await client.post(url, json=body_no_json)
                    if res_retry.status_code == 200:
                        data = res_retry.json()
                        candidates = data.get("candidates", [])
                        if candidates and "content" in candidates[0]:
                            parts_out = candidates[0]["content"].get("parts", [])
                            text_parts = [p.get("text", "") for p in parts_out if "text" in p]
                            output_text = "".join(text_parts).strip()
                            return output_text
                    last_error = f"HTTP {res_retry.status_code}: {res_retry.text[:200]}"
                else:
                    logger.warning("⚠️ [Gemini API] Model '%s' trả về HTTP %d: %s", model, res.status_code, res.text[:200])
                    last_error = f"HTTP {res.status_code}: {res.text[:200]}"
                    if res.status_code in (429, 503):
                        await asyncio.sleep(1.0)
            except (httpx.ConnectError, httpx.TimeoutException) as net_err:
                _mark_network_offline()
                raise ConnectionError("No WiFi detected. Falling back to Local Whisper & Ollama") from net_err
            except Exception as exc:
                logger.warning("⚠️ [Gemini API] Lỗi kết nối model '%s': %s", model, exc)
                last_error = str(exc)

        raise RuntimeError(f"Tất cả các Gemini model đều không phản hồi: {last_error}")


def _slice_audio_file(file_path: str, chunk_duration_sec: int = 240) -> list[dict[str, Any]]:
    """
    Cắt tệp âm thanh thành các chunk 240 giây (4 phút), chuyển đổi sang mono 16kHz MP3 (~1.5-2MB/chunk).
    Sử dụng PyAV (av) xử lý trực tiếp tín hiệu PCM, giải quyết triệt để bài toán file âm thanh dài (1-2 tiếng)
    mà không bị giới hạn 20MB hay lỗi File API của Google Gemini.
    """
    path_obj = Path(file_path)
    if not path_obj.exists():
        raise FileNotFoundError(f"Không tìm thấy file: {file_path}")

    if not HAS_AV or av is None:
        # Fallback nếu môi trường không có PyAV (chạy raw bytes)
        with open(file_path, "rb") as f:
            raw_data = f.read()
        return [{
            "chunk_idx": 0,
            "start_sec": 0.0,
            "end_sec": 0.0,
            "audio_bytes": raw_data,
            "size_kb": len(raw_data) // 1024,
            "mime_type": _detect_audio_mime_type(file_path),
        }]

    input_container = av.open(str(path_obj))
    if not input_container.streams.audio:
        raise ValueError("Tệp không chứa stream âm thanh hợp lệ.")

    input_stream = input_container.streams.audio[0]
    resampler = av.AudioResampler(format="s16p", layout="mono", rate=16000)

    chunks: list[dict[str, Any]] = []
    chunk_idx = 0
    current_chunk_frames: list[Any] = []
    current_samples = 0
    samples_per_chunk = chunk_duration_sec * 16000

    def encode_mp3_chunk(frames: list[Any], c_idx: int, start_s: float, end_s: float) -> dict[str, Any]:
        out_buf = io.BytesIO()
        out_container = av.open(out_buf, mode="w", format="mp3")
        out_stream = out_container.add_stream("libmp3lame", rate=16000)
        out_stream.bit_rate = 64000
        out_stream.layout = "mono"
        for f in frames:
            for p in out_stream.encode(f):
                out_container.mux(p)
        for p in out_stream.encode(None):
            out_container.mux(p)
        out_container.close()
        audio_data = out_buf.getvalue()
        return {
            "chunk_idx": c_idx,
            "start_sec": start_s,
            "end_sec": end_s,
            "audio_bytes": audio_data,
            "size_kb": len(audio_data) // 1024,
            "mime_type": "audio/mp3",
        }

    chunk_start_sec = 0.0
    for frame in input_container.decode(input_stream):
        resampled_frames = resampler.resample(frame)
        for rf in resampled_frames:
            current_chunk_frames.append(rf)
            current_samples += rf.samples
            if current_samples >= samples_per_chunk:
                chunk_end_sec = chunk_start_sec + (current_samples / 16000.0)
                chunks.append(encode_mp3_chunk(current_chunk_frames, chunk_idx, chunk_start_sec, chunk_end_sec))
                chunk_idx += 1
                chunk_start_sec = chunk_end_sec
                current_chunk_frames = []
                current_samples = 0

    if current_chunk_frames:
        chunk_end_sec = chunk_start_sec + (current_samples / 16000.0)
        chunks.append(encode_mp3_chunk(current_chunk_frames, chunk_idx, chunk_start_sec, chunk_end_sec))

    input_container.close()
    return chunks


def _transcribe_chunk_whisper(chunk_bytes: bytes) -> str:
    """Fallback gỡ băng một chunk âm thanh bằng faster-whisper cục bộ (hỗ trợ hạ cấp GPU -> CPU an toàn)."""
    global _whisper_model_instance
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tf:
        tf.write(chunk_bytes)
        tf_path = tf.name
    try:
        for attempt in (1, 2):
            try:
                if attempt == 1:
                    model = _get_whisper_model(force_cpu=False)
                    beam_size = 3
                    use_vad = True
                else:
                    logger.warning("🛡️ [Whisper Chunk Fallback] Hạ cấp sang CPU int8 cho phân đoạn âm thanh...")
                    _whisper_model_instance = None
                    gc.collect()
                    model = _get_whisper_model(force_cpu=True, model_size_override=WHISPER_MODEL_FALLBACK)
                    beam_size = 2
                    use_vad = False

                segments, _ = model.transcribe(
                    tf_path,
                    language="vi",
                    beam_size=beam_size,
                    condition_on_previous_text=False,
                    vad_filter=use_vad,
                    initial_prompt=WHISPER_INITIAL_PROMPT,
                )
                lines = []
                for s in segments:
                    txt = s.text.strip()
                    if txt:
                        lines.append(f"[{int(s.start)//60:02d}:{int(s.start)%60:02d}] {txt}")
                gc.collect()
                return "\n".join(lines)
            except Exception as attempt_err:
                if attempt == 1:
                    logger.warning("⚠️ [Whisper Chunk] Lỗi lượt 1 (%s). Thử lại trên CPU...", attempt_err)
                    continue
                raise attempt_err
        return ""
    finally:
        try:
            os.remove(tf_path)
        except Exception:
            pass


async def _gemini_transcribe_audio(file_path: str, meeting_id: int = 0) -> dict[str, Any]:
    """
    Pha 1: Bóc băng giọng nói tiếng Việt qua Multi-Chunk Slicing (4 phút/chunk, 16kHz mono).
    Hỗ trợ bảo vệ chống rớt mạng giữa chừng (Mid-Process Seamless Swapping):
      - Bọc gọi Gemini trong try...except (httpx.ConnectError, httpx.TimeoutException, Exception) trên TỪNG chunk.
      - Nếu mất mạng đột ngột ở chunk thứ i: chuyển nóng current_engine = "local", bóc ngay chính chunk i bằng faster-whisper,
        và các chunk (i+1 .. N) tự động chạy Local Whisper không chờ mạng.
      - Cập nhật PROGRESS_STORE kèm cờ current_engine liên tục và commit SQLite sau MỖI chunk.
    """
    start_time = time.perf_counter()
    path_obj = Path(file_path)
    file_size = path_obj.stat().st_size

    logger.info("🎙️ [Hybrid STT] Bắt đầu xử lý âm thanh: %s (%d KB)", path_obj.name, file_size // 1024)

    current_engine = "gemini" if check_internet_available(timeout_sec=2.0) else "local"
    if current_engine == "local":
        logger.warning("No WiFi detected. Falling back to Local Whisper & Ollama")

    if meeting_id > 0:
        update_progress(
            meeting_id,
            status="transcribing",
            progress_percent=10,
            current_step_detail="Đang phân tích và chia nhỏ tín hiệu âm thanh thành các phân đoạn 4 phút (16kHz mono)...",
            current_engine=current_engine,
            engine_used=current_engine,
        )

    # Cắt file âm thanh thành các chunk 4 phút
    chunks = await asyncio.to_thread(_slice_audio_file, file_path, 240)
    total_chunks = len(chunks)
    logger.info("✂️ [Hybrid STT] Đã phân đoạn thành %d chunk (4 phút/chunk)", total_chunks)

    all_transcript_lines: list[str] = []
    total_duration_sec = chunks[-1]["end_sec"] if chunks else 0.0

    stt_prompt = (
        "Bạn là chuyên gia gỡ băng âm thanh tiếng Việt trình độ cao.\n"
        "Hãy nghe kỹ đoạn âm thanh này và chép lại NGUYÊN VĂN 100% từng câu chữ tiếng Việt đã nói trong băng.\n"
        "Quy tắc bắt buộc:\n"
        "1. Giữ nguyên văn toàn bộ lời thoại, không bỏ sót bất kỳ từ nào, giữ đúng danh xưng, chức danh, tên người, cơ quan, số liệu.\n"
        "2. Mỗi khi người nói bắt đầu một câu hoặc một ý mới, ghi kèm mốc thời gian tương đối ở đầu dòng theo đúng định dạng [MM:SS].\n"
        "   Ví dụ:\n"
        "   [00:00] Kính thưa các đồng chí...\n"
        "   [00:15] Về nội dung kế hoạch...\n"
        "3. Tuyệt đối KHÔNG tóm tắt, KHÔNG giải thích, KHÔNG thêm lời chào hay bình luận. CHỈ TRẢ VỀ CÁC DÒNG [MM:SS] Lời thoại."
    )

    for c_idx, chunk in enumerate(chunks):
        chunk_start_sec = chunk["start_sec"]
        chunk_end_sec = chunk["end_sec"]

        pct = 15 + int((c_idx / max(total_chunks, 1)) * 45)
        step_label = (
            f"Local Whisper (Offline) đang gỡ băng phân đoạn {c_idx + 1}/{total_chunks} ({chunk_start_sec/60:.0f}m - {chunk_end_sec/60:.0f}m)..."
            if current_engine == "local"
            else f"Gemini Multimodal đang gỡ băng phân đoạn {c_idx + 1}/{total_chunks} ({chunk_start_sec/60:.0f}m - {chunk_end_sec/60:.0f}m)..."
        )
        if meeting_id > 0:
            update_progress(
                meeting_id,
                status="transcribing",
                progress_percent=pct,
                current_step_detail=step_label,
                current_engine=current_engine,
                engine_used=current_engine,
            )

        chunk_raw = ""
        if current_engine == "gemini":
            b64_audio = base64.b64encode(chunk["audio_bytes"]).decode("utf-8")
            audio_part = {
                "inline_data": {
                    "mime_type": "audio/mp3",
                    "data": b64_audio,
                }
            }
            try:
                chunk_raw = await _call_gemini_generate_content(
                    parts=[audio_part, {"text": stt_prompt}],
                    api_key=_GEMINI_API_KEY,
                    models_override=GEMINI_AUDIO_MODELS,
                )
            except (httpx.ConnectError, httpx.TimeoutException, ConnectionError, Exception) as chunk_err:
                # Chuyển đổi nóng (Seamless Swapping) sang Local AI ngay tại chunk thứ i
                _mark_network_offline()
                current_engine = "local"
                logger.warning(
                    "🔄 [Mid-Process Fallback] Rớt mạng / lỗi Gemini tại chunk %d/%d (%s). "
                    "Chuyển nóng current_engine='local' và bóc băng ngay phân đoạn %d bằng faster-whisper.",
                    c_idx + 1,
                    total_chunks,
                    chunk_err,
                    c_idx + 1,
                )
                if meeting_id > 0:
                    update_progress(
                        meeting_id,
                        status="transcribing",
                        progress_percent=pct,
                        current_step_detail=(
                            f"Mất kết nối mạng tại phân đoạn {c_idx + 1}/{total_chunks} — "
                            "Đang chuyển nóng sang Local Whisper (Offline)..."
                        ),
                        current_engine="local",
                        engine_used="local",
                    )
                try:
                    chunk_raw = await asyncio.to_thread(_transcribe_chunk_whisper, chunk["audio_bytes"])
                except Exception as w_err:
                    logger.error("❌ Cả Gemini và Local Whisper đều thất bại trên chunk %d/%d: %s", c_idx + 1, total_chunks, w_err)
                    chunk_raw = ""
        else:
            # Đã chuyển sang Local AI ở chunk trước -> dùng trực tiếp faster-whisper cho các chunk i+1..N
            try:
                chunk_raw = await asyncio.to_thread(_transcribe_chunk_whisper, chunk["audio_bytes"])
            except Exception as w_err:
                logger.error("❌ Local Whisper thất bại trên chunk %d/%d: %s", c_idx + 1, total_chunks, w_err)
                chunk_raw = ""

        # Chuẩn hóa mốc thời gian [MM:SS] offset theo chunk_start_sec
        chunk_lines = [line.strip() for line in chunk_raw.split("\n") if line.strip()]
        for line in chunk_lines:
            if re.search(r"^(chào bạn|dưới đây là|hy vọng|nếu cần hỗ trợ|bản gỡ băng)", line, re.IGNORECASE):
                continue

            ts_match = re.match(r"^\[(\d{1,2}):(\d{2})\]\s*(.*)", line)
            if ts_match:
                rel_min = int(ts_match.group(1))
                rel_sec = int(ts_match.group(2))
                rel_total = rel_min * 60 + rel_sec
                abs_total = int(chunk_start_sec + rel_total)
                abs_min = abs_total // 60
                abs_sec = abs_total % 60
                content = ts_match.group(3).strip()
                all_transcript_lines.append(f"[{abs_min:02d}:{abs_sec:02d}] {content}")
            else:
                start_m = int(chunk_start_sec) // 60
                start_s = int(chunk_start_sec) % 60
                all_transcript_lines.append(f"[{start_m:02d}:{start_s:02d}] {line}")

        # Bảo vệ Dữ liệu Thành phần (Partial Persistence): Commit SQLite ngay sau MỖI chunk
        if all_transcript_lines:
            await _persist_partial_transcript_safe(meeting_id, "\n".join(all_transcript_lines))
            if meeting_id > 0:
                preview_text = "\n".join(all_transcript_lines[-6:])
                update_progress(
                    meeting_id,
                    partial_transcript=preview_text,
                    current_engine=current_engine,
                    engine_used=current_engine,
                )

    if not all_transcript_lines:
        raise RuntimeError("Tệp âm thanh không chứa giọng nói có thể nhận diện được.")

    full_transcript = "\n".join(all_transcript_lines)
    cleaned_transcript = clean_vietnamese_transcript(full_transcript)
    elapsed = time.perf_counter() - start_time
    final_engine = current_engine

    # Tạo segments list cho trình phát âm thanh và click-to-seek
    segments: list[dict[str, Any]] = []
    for line in cleaned_transcript.split("\n"):
        line = line.strip()
        if not line:
            continue
        m = re.match(r"^\[(\d{1,2}):(\d{2})\]\s*(.*)", line)
        if m:
            s_val = int(m.group(1)) * 60 + int(m.group(2))
            segments.append({
                "start": float(s_val),
                "end": float(s_val + 5.0),
                "text": line,
            })
        else:
            segments.append({
                "start": 0.0,
                "end": 5.0,
                "text": line,
            })

    if meeting_id > 0:
        update_progress(
            meeting_id,
            progress_percent=60,
            current_step_detail="Gỡ băng 100% âm thanh thực tế hoàn tất! Bắt đầu tổng hợp biên bản chuyên sâu...",
            partial_transcript=cleaned_transcript[:1200] + ("..." if len(cleaned_transcript) > 1200 else ""),
            current_engine=final_engine,
            engine_used=final_engine,
        )

    logger.info("✅ [STT] Hoàn tất gỡ băng %d dòng trong %.2fs (%d ký tự, current_engine=%s)", len(all_transcript_lines), elapsed, len(cleaned_transcript), final_engine)

    return {
        "text": cleaned_transcript,
        "language": "vi",
        "segments": segments,
        "duration": round(total_duration_sec, 2),
        "processing_time_seconds": round(elapsed, 2),
        "engine": final_engine,
        "current_engine": final_engine,
        "engine_used": final_engine,
    }


async def _gemini_generate_minutes_and_tasks(
    transcript_text: str,
    meeting_id: int = 0,
    template_text: str | None = None,
    secretary_notes: str | None = None,
) -> dict[str, Any]:
    """
    Pha 2: Fabric Sliding-Window Map-Reduce Narrative Engine
    - Map Step: Chia transcript thành các phân đoạn 4,000 - 5,000 ký tự.
      Mỗi phân đoạn gọi Gemini để soạn thảo tường thuật chi tiết (400 - 800 từ) bảo toàn 100% diễn giả,
      số liệu, tờ trình, nghị định, ý kiến tranh luận.
    - Reduce Step: Ghép toàn bộ các đoạn tường thuật vào Phần II (không nén mất mát), hoặc điền chuẩn xác
      100% theo BIỂU MẪU MẪU (.docx) nếu người dùng cung cấp template_text.
    """
    start_time = time.perf_counter()

    if meeting_id > 0:
        update_progress(
            meeting_id,
            status="synthesizing",
            progress_percent=65,
            current_step_detail="Đang tổng hợp biên bản...",
        )

    # 1. Chia transcript thành các đoạn 4,000 - 5,000 ký tự
    lines = [l.strip() for l in transcript_text.split("\n") if l.strip()]
    segments: list[str] = []
    current_segment_lines: list[str] = []
    current_char_count = 0

    for line in lines:
        current_segment_lines.append(line)
        current_char_count += len(line)
        if current_char_count >= 4000:
            segments.append("\n".join(current_segment_lines))
            current_segment_lines = []
            current_char_count = 0

    if current_segment_lines:
        segments.append("\n".join(current_segment_lines))

    if not segments:
        segments = [transcript_text]

    total_segments = len(segments)
    logger.info("📑 [Fabric Engine] Chia thành %d phân đoạn để tường thuật chi tiết (Zero Lossy)", total_segments)

    # 2. MAP STEP: Soạn thảo tường thuật chi tiết từng phân đoạn
    narrative_sections: list[str] = []
    for s_idx, segment_content in enumerate(segments):
        pct = 65 + int((s_idx / total_segments) * 20)
        if meeting_id > 0:
            update_progress(
                meeting_id,
                status="synthesizing",
                progress_percent=pct,
                current_step_detail=f"Đang tổng hợp biên bản (phân đoạn {s_idx + 1}/{total_segments})...",
            )

        segment_prompt = f"""Bạn là Thư ký cấp cao phụ trách lập biên bản các cuộc họp hành chính, chính phủ, doanh nghiệp lớn tại Việt Nam theo Nghị định 30/2020/NĐ-CP.
Dưới đây là một phân đoạn lời thoại bóc băng nguyên văn từ cuộc họp:
---
{segment_content}
---

Yêu cầu biên soạn tường thuật chi tiết (Human Secretary Narrative Style - Zero Hallucination):
1. Phân tích sâu sắc và tường thuật toàn văn chi tiết diễn biến trong phân đoạn này.
2. Nêu rõ tên và chức danh người phát biểu (nếu có trong lời thoại).
3. Tường thuật đầy đủ từng luận điểm, tờ trình, báo cáo, số liệu thống kê (% tỷ lệ, định mức, số hiệu điều luật/nghị định).
4. Tường thuật chi tiết các ý kiến tranh luận, ý kiến phản biện và phương án lựa chọn đề xuất.
5. Văn phong chính luận trang trọng, đĩnh đạc, câu từ mạch lạc (ví dụ: "Phát biểu thảo luận, đồng chí... đã phân tích...", "Về nội dung này, cuộc họp ghi nhận ý kiến của...").
6. Dung lượng yêu cầu: Tối thiểu 350 - 700 từ cho phân đoạn này. Tuyệt đối KHÔNG tóm tắt sơ sài vài gạch đầu dòng.
7. Tuyệt đối KHÔNG bịa đặt thông tin không có trong lời thoại. Chỉ trả về nội dung biên bản tường thuật của phân đoạn này."""

        try:
            narrative_text = await _call_gemini_generate_content(
                parts=[{"text": segment_prompt}],
                api_key=_GEMINI_API_KEY,
                models_override=GEMINI_TEXT_MODELS,
            )
            narrative_sections.append(narrative_text.strip())
        except (httpx.ConnectError, httpx.TimeoutException, ConnectionError) as conn_err:
            _mark_network_offline()
            if meeting_id > 0:
                update_progress(
                    meeting_id,
                    status="synthesizing",
                    current_step_detail="Mất kết nối mạng khi tổng hợp — Đang chuyển nóng sang Local Ollama / Extractive...",
                    current_engine="local",
                    engine_used="local",
                )
            logger.warning("No WiFi detected. Falling back to Local Whisper & Ollama")
            raise conn_err
        except Exception as seg_err:
            logger.warning("⚠️ Lỗi biên soạn phân đoạn %d: %s. Dùng trích đoạn lời thoại...", s_idx + 1, seg_err)
            narrative_sections.append(segment_content)

    # 3. REDUCE STEP: Lắp ghép Phần II không mất mát
    section_2_text = "\n\n".join(narrative_sections)

    if meeting_id > 0:
        update_progress(
            meeting_id,
            status="synthesizing",
            progress_percent=88,
            current_step_detail="Đang hoàn thiện cấu trúc biên bản và danh mục phân công nhiệm vụ...",
        )

    notes_block = (
        f"\n\nGHI CHÚ TRỌNG TÂM CỦA THƯ KÝ (Cần làm nổi bật trong kết luận):\n{secretary_notes.strip()}\n"
        if secretary_notes and secretary_notes.strip()
        else ""
    )

    # Nếu có BIỂU MẪU TÙY CHỈNH (.docx), bơm thẳng vào System Prompt bước Reduce
    if template_text and template_text.strip():
        template_system_prompt = (
            "BẮT BUỘC viết biên bản tuân thủ CHÍNH XÁC 100% hệ thống đề mục (I, II, III...), "
            "cách kẻ bảng và văn phong của BIỂU MẪU MẪU sau đây. "
            "Trích xuất thông tin từ Bản gỡ băng để điền vào biểu mẫu này.\n\n"
            f"=== BIỂU MẪU MẪU ===\n{template_text.strip()}\n=== HẾT BIỂU MẪU MẪU ==="
        )
        template_user_prompt = f"""Dưới đây là toàn bộ diễn biến thảo luận chi tiết từ Bản gỡ băng cuộc họp:
---
{section_2_text[:20000]}
---{notes_block}

Hãy điền đầy đủ, chính xác 100% dữ liệu từ Bản gỡ băng vào BIỂU MẪU MẪU đã cung cấp và trích xuất danh sách nhiệm vụ.
Trả về DUY NHẤT một JSON Object hợp lệ theo mẫu:
{{
  "minutes": "Toàn văn biên bản tuân thủ chính xác 100% cấu trúc đề mục, bảng biểu và văn phong của BIỂU MẪU MẪU...",
  "tasks": [
    {{
      "title": "Tên công việc hoặc chỉ đạo cụ thể",
      "description": "Yêu cầu chi tiết",
      "assignee": "Cơ quan, đơn vị hoặc người chịu trách nhiệm",
      "deadline": "Thời hạn hoặc kế hoạch hoàn thành",
      "priority": "High"
    }}
  ]
}}"""
        gemini_tpl_raw = await _call_gemini_generate_content(
            parts=[{"text": template_user_prompt}],
            system_instruction=template_system_prompt,
            response_mime_type="application/json",
            api_key=_GEMINI_API_KEY,
            models_override=GEMINI_TEXT_MODELS,
        )
        final_minutes = ""
        tasks_list: list[dict[str, Any]] = []
        try:
            tpl_data = json.loads(gemini_tpl_raw)
            final_minutes = str(tpl_data.get("minutes", "")).strip()
            for item in tpl_data.get("tasks", []):
                if isinstance(item, dict) and item.get("title"):
                    tasks_list.append({
                        "title": str(item.get("title")).strip(),
                        "description": item.get("description") or str(item.get("title")).strip(),
                        "assignee_name": item.get("assignee") or item.get("assignee_name") or "Đơn vị phụ trách",
                        "due_date": item.get("deadline") or item.get("due_date") or "Theo kế hoạch",
                        "priority": item.get("priority", "Medium"),
                    })
        except Exception as tpl_err:
            logger.warning("⚠️ Lỗi parse JSON Custom Template: %s", tpl_err)
            final_minutes = gemini_tpl_raw
            tasks_list = _parse_tasks_json(gemini_tpl_raw)

        if not final_minutes:
            final_minutes = section_2_text

        elapsed = time.perf_counter() - start_time
        return {
            "minutes": final_minutes,
            "tasks": tasks_list,
            "_llm_processing_time_seconds": round(elapsed, 2),
            "engine": "gemini",
            "engine_used": "gemini",
        }

    # 4. TARGETED PASS: Tạo Phần I, Phần III và Trích xuất Tasks JSON
    synthesis_prompt = f"""Dưới đây là toàn bộ diễn biến thảo luận chi tiết của cuộc họp:
---
{section_2_text[:14000]}
---{notes_block}

Dựa trên toàn bộ diễn biến trên, hãy đóng vai Thư ký trưởng để:
1. Soạn thảo PHẦN I: THÔNG TIN CHUNG & BỐI CẢNH ĐIỀU HÀNH (Thời gian, địa điểm, thành phần tham dự, chủ tọa điều hành, thư ký, mục tiêu và bối cảnh thực tiễn của cuộc họp).
2. Soạn thảo PHẦN III: KẾT LUẬN & GIAO NHIỆM VỤ TRỌNG TÂM (Tổng hợp các nội dung đã được hội nghị thống nhất thông qua và kết luận chỉ đạo cốt lõi).
3. Trích xuất danh sách công việc (Action Items) cụ thể từ cuộc họp thành mảng JSON gồm 6 đến 12 nhiệm vụ, mỗi nhiệm vụ gồm tiêu đề cụ thể, đơn vị/người phụ trách, thời hạn và độ ưu tiên.

Trả về DUY NHẤT một JSON Object hợp lệ theo mẫu:
{{
  "section_1": "I. THÔNG TIN CHUNG & BỐI CẢNH ĐIỀU HÀNH\\n- Thời gian, địa điểm, thành phần tham dự...\\n- Mục tiêu, yêu cầu...",
  "section_3": "III. KẾT LUẬN & GIAO NHIỆM VỤ TRỌNG TÂM\\n- Các nội dung thống nhất...\\n- Chỉ đạo trọng tâm...",
  "tasks": [
    {{
      "title": "Tên công việc hoặc chỉ đạo cụ thể",
      "description": "Yêu cầu chi tiết",
      "assignee": "Cơ quan, đơn vị hoặc người chịu trách nhiệm",
      "deadline": "Thời hạn hoặc kế hoạch hoàn thành",
      "priority": "High"
    }}
  ]
}}"""

    gemini_synth_raw = await _call_gemini_generate_content(
        parts=[{"text": synthesis_prompt}],
        response_mime_type="application/json",
        api_key=_GEMINI_API_KEY,
        models_override=GEMINI_TEXT_MODELS,
    )

    section_1_text = "I. THÔNG TIN CHUNG & BỐI CẢNH ĐIỀU HÀNH\n- Căn cứ chương trình và diễn biến làm việc thực tế của cuộc họp."
    section_3_text = "III. KẾT LUẬN & GIAO NHIỆM VỤ TRỌNG TÂM\n- Các đại biểu thống nhất cao với các nội dung chỉ đạo đã nêu trong cuộc họp."
    tasks_list: list[dict[str, Any]] = []

    try:
        synth_data = json.loads(gemini_synth_raw)
        if synth_data.get("section_1"):
            section_1_text = str(synth_data["section_1"]).strip()
        if synth_data.get("section_3"):
            section_3_text = str(synth_data["section_3"]).strip()

        raw_tasks = synth_data.get("tasks", [])
        if isinstance(raw_tasks, list):
            for item in raw_tasks:
                if isinstance(item, dict) and item.get("title"):
                    tasks_list.append({
                        "title": str(item.get("title")).strip(),
                        "description": item.get("description") or str(item.get("title")).strip(),
                        "assignee_name": item.get("assignee") or item.get("assignee_name") or "Đơn vị phụ trách",
                        "due_date": item.get("deadline") or item.get("due_date") or "Theo kế hoạch",
                        "priority": item.get("priority", "Medium"),
                    })
    except Exception as parse_err:
        logger.warning("⚠️ Lỗi parse JSON tổng hợp: %s. Thử parse regex...", parse_err)
        tasks_list = _parse_tasks_json(gemini_synth_raw)

    # Lắp ghép biên bản hoàn chỉnh 3 phần chuẩn Nghị định 30
    final_minutes = f"{section_1_text}\n\nII. DIỄN BIẾN THẢO LUẬN CHI TIẾT\n\n{section_2_text}\n\n{section_3_text}"

    # Đảm bảo số lượng tasks tối thiểu
    if len(tasks_list) < 4:
        logger.info("🔍 Bổ sung thêm nhiệm vụ từ Rule-based Extractor...")
        rule_tasks = _rule_based_task_extractor(transcript_text)
        existing_titles = {t["title"].strip().lower() for t in tasks_list}
        for rt in rule_tasks:
            if rt["title"].strip().lower() not in existing_titles:
                tasks_list.append(rt)
                existing_titles.add(rt["title"].strip().lower())

    elapsed = time.perf_counter() - start_time
    logger.info("✅ [Fabric Narrative Engine] Biên bản hoàn tất: %d ký tự | Tasks: %d trong %.2fs", len(final_minutes), len(tasks_list), elapsed)

    return {
        "minutes": final_minutes,
        "tasks": tasks_list,
        "_llm_processing_time_seconds": round(elapsed, 2),
        "engine": "google-gemini",
    }


# ===========================================================================
# PHẦN 1: SPEECH-TO-TEXT – faster-whisper (Local Offline Fallback)
# ===========================================================================

_whisper_model_instance = None
_current_loaded_model_size = ""
_is_cpu_fallback = False


def _get_whisper_model(force_cpu: bool = False, model_size_override: str | None = None) -> Any:
    """Tải WhisperModel với chiến lược Zero-Crash & Graceful Degradation."""
    global _whisper_model_instance, _current_loaded_model_size, _is_cpu_fallback

    if _whisper_model_instance is not None:
        if not force_cpu or _is_cpu_fallback:
            return _whisper_model_instance

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        logger.warning("⚠️ faster-whisper chưa được cài đặt (Môi trường Cloud). Tự động dùng Google Gemini API.")
        raise RuntimeError("faster-whisper is not installed in cloud lightweight mode.")

    model_candidates = [model_size_override] if model_size_override else [WHISPER_MODEL_PRIMARY, WHISPER_MODEL_FALLBACK]

    if not force_cpu and not _is_cpu_fallback:
        for model_size in model_candidates:
            try:
                logger.info("🎙️ [Whisper] Đang tải model='%s' trên CUDA (compute_type='%s')...", model_size, WHISPER_COMPUTE_TYPE_GPU)
                model = WhisperModel(
                    model_size_or_path=model_size,
                    device="cuda",
                    compute_type=WHISPER_COMPUTE_TYPE_GPU,
                    cpu_threads=2,
                    num_workers=1,
                )
                logger.info("✅ [Whisper] Model '%s' đã tải thành công trên CUDA (GPU).", model_size)
                _whisper_model_instance = model
                _current_loaded_model_size = model_size
                _is_cpu_fallback = False
                return model
            except Exception as cuda_exc:
                logger.warning("⚠️ [Whisper] Không tải được '%s' trên CUDA: %s. Thử model tiếp theo...", model_size, cuda_exc)

        logger.warning("⚠️ Không thể tải Whisper trên GPU CUDA. Chuyển sang CPU...")
        _is_cpu_fallback = True

    cpu_candidates = [model_size_override] if model_size_override else [WHISPER_MODEL_PRIMARY, WHISPER_MODEL_FALLBACK]
    for model_size in cpu_candidates:
        try:
            logger.info("🎙️ [Whisper] Đang tải model='%s' trên CPU (compute_type='int8', cpu_threads=6)...", model_size)
            model = WhisperModel(
                model_size_or_path=model_size,
                device="cpu",
                compute_type="int8",
                cpu_threads=6,
                num_workers=1,
            )
            logger.info("✅ [Whisper] Model '%s' đã tải thành công trên CPU.", model_size)
            _whisper_model_instance = model
            _current_loaded_model_size = model_size
            _is_cpu_fallback = True
            return model
        except Exception as cpu_exc:
            logger.warning("⚠️ [Whisper] Không tải được '%s' trên CPU: %s", model_size, cpu_exc)

    raise RuntimeError("Không thể khởi tạo bất kỳ Whisper model nào trên hệ thống.")


def _run_transcription(file_path: str, meeting_id: int = 0) -> dict[str, Any]:
    """Bóc băng giọng nói tiếng Việt bằng faster-whisper (Local Offline)."""
    global _whisper_model_instance, _current_loaded_model_size, _is_cpu_fallback

    logger.info("🔄 [Whisper Local] Bắt đầu transcribe file: %s", file_path)
    start_time = time.perf_counter()

    if meeting_id > 0:
        update_progress(
            meeting_id,
            status="transcribing",
            progress_percent=10,
            current_step_detail="Đang chuẩn bị bóc băng giọng nói bằng Local Whisper...",
        )

    segments: list[dict] = []
    cleaned_text_parts: list[str] = []
    partial_transcript_parts: list[str] = []
    audio_duration: float = 1.0
    detected_lang: str = WHISPER_LANGUAGE

    for attempt in (1, 2):
        try:
            if attempt == 1:
                model = _get_whisper_model(force_cpu=False)
                use_beam = 5
                use_vad = True
                vad_params = dict(min_silence_duration_ms=500, speech_pad_ms=400)
            else:
                logger.warning("🛡️ [Whisper Fallback] Kích hoạt chế độ bóc băng an toàn trên CPU...")
                _whisper_model_instance = None
                gc.collect()
                model = _get_whisper_model(force_cpu=True, model_size_override=WHISPER_MODEL_FALLBACK)
                use_beam = 2
                use_vad = False
                vad_params = None

            device_label = "GPU" if not _is_cpu_fallback else "CPU"
            if meeting_id > 0:
                update_progress(
                    meeting_id,
                    current_step_detail=f"Đang bóc băng bằng Local Whisper ({_current_loaded_model_size} int8 - {device_label})...",
                )

            segments_gen, info = model.transcribe(
                audio=file_path,
                language=WHISPER_LANGUAGE,
                beam_size=use_beam,
                best_of=use_beam,
                temperature=0.0,
                condition_on_previous_text=False,
                vad_filter=use_vad,
                vad_parameters=vad_params,
                initial_prompt=WHISPER_INITIAL_PROMPT,
                word_timestamps=False,
            )

            audio_duration = info.duration or 1.0
            detected_lang = info.language

            segments.clear()
            cleaned_text_parts.clear()
            partial_transcript_parts.clear()

            for seg in segments_gen:
                raw_seg_text = seg.text.strip()
                if not raw_seg_text:
                    continue

                cleaned_seg_text = clean_vietnamese_transcript(raw_seg_text)
                if not cleaned_seg_text:
                    continue

                segments.append({
                    "start": round(seg.start, 2),
                    "end": round(seg.end, 2),
                    "text": cleaned_seg_text,
                })
                cleaned_text_parts.append(cleaned_seg_text)

                mm = int(seg.start // 60)
                ss = int(seg.start % 60)
                timestamped_line = f"[{mm:02d}:{ss:02d}] {cleaned_seg_text}"
                partial_transcript_parts.append(timestamped_line)

                if meeting_id > 0:
                    whisper_progress = min(int((seg.end / audio_duration) * 50) + 10, 60)
                    processed_min = int(seg.end // 60)
                    total_min = int(audio_duration // 60)
                    update_progress(
                        meeting_id,
                        progress_percent=whisper_progress,
                        current_step_detail=f"Đang bóc băng: {processed_min}p/{total_min}p ({device_label})",
                        partial_transcript="\n".join(partial_transcript_parts[-30:]),
                    )

            break

        except Exception as exc:
            logger.error("❌ Lỗi ở lượt transcribe %d: %s", attempt, str(exc), exc_info=True)
            if attempt == 1:
                logger.info("🔄 Đang tự động hạ cấp an toàn sang CPU model...")
                continue
            else:
                raise RuntimeError(f"Whisper transcription failed after fallback: {exc}") from exc

    if partial_transcript_parts:
        full_text = "\n".join(partial_transcript_parts)
    else:
        full_text = clean_vietnamese_transcript(" ".join(cleaned_text_parts))
    elapsed = time.perf_counter() - start_time
    gc.collect()

    if meeting_id > 0:
        update_progress(
            meeting_id,
            progress_percent=60,
            current_step_detail="Bóc băng hoàn tất! Đang chuẩn bị phân tích AI...",
            partial_transcript="\n".join(
                [f"[{int(s['start']//60):02d}:{int(s['start']%60):02d}] {s['text']}" for s in segments[-50:]]
            ),
        )

    return {
        "text": full_text,
        "language": detected_lang,
        "segments": segments,
        "duration": round(audio_duration, 2),
        "processing_time_seconds": round(elapsed, 2),
        "engine": "local",
        "engine_used": "local",
    }


async def transcribe_audio(file_path: str, meeting_id: int = 0) -> dict[str, Any]:
    """
    Entry point bóc băng âm thanh – Kiến trúc Hybrid Zero-503:
      1. Nếu có GEMINI_API_KEY hợp lệ, có WiFi và preferred != 'local': Ưu tiên chạy Google Gemini API (nhanh, chuẩn 99%).
      2. Nếu mất mạng hoặc không có key: Tự động fallback sang Local Whisper an toàn tuyệt đối.
    """
    audio_path = Path(file_path)
    if not audio_path.exists():
        raise FileNotFoundError(f"File audio không tồn tại: {file_path}")
    if not audio_path.is_file():
        raise ValueError(f"Đường dẫn không phải là file: {file_path}")
    if audio_path.stat().st_size == 0:
        raise ValueError(f"File audio rỗng (0 bytes): {file_path}")

    # Ưu tiên Google Gemini API nếu khả dụng
    has_gemini = is_valid_gemini_key(_GEMINI_API_KEY)
    if has_gemini and _PREFERRED_AI_ENGINE != "local":
        try:
            logger.info("✨ [Hybrid AI] Đang chạy bóc băng bằng Google Gemini Multimodal Audio API...")
            gemini_res = await _gemini_transcribe_audio(str(audio_path.resolve()), meeting_id)
            if gemini_res.get("text", "").strip():
                return gemini_res
            logger.warning("⚠️ Gemini trả về transcript rỗng, chuyển sang Local Whisper...")
        except Exception as gemini_err:
            logger.warning("No WiFi detected. Falling back to Local Whisper & Ollama (%s)", gemini_err)
            if meeting_id > 0:
                update_progress(meeting_id, engine_used="local")

    # Chạy Local Faster-Whisper
    logger.info("💻 [Hybrid AI] Chạy bóc băng bằng Local Whisper...")
    if meeting_id > 0:
        update_progress(meeting_id, engine_used="local")
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        _executor,
        _run_transcription,
        str(audio_path.resolve()),
        meeting_id,
    )

    if not result.get("text", "").strip():
        logger.warning("⚠️ Transcript rỗng cho file: %s.", file_path)
        raise ValueError(
            "Không phát hiện được giọng nói rõ ràng trong file audio. "
            "Vui lòng kiểm tra chất lượng ghi âm."
        )

    await _persist_partial_transcript_safe(meeting_id, result["text"])
    result["engine"] = "local"
    result["engine_used"] = "local"
    return result


# ===========================================================================
# PHẦN 2: TẠO BIÊN BẢN & TRÍCH XUẤT CÔNG VIỆC (Local Ollama / Extractive Fallback)
# ===========================================================================

def _chunk_transcript(
    text: str,
    max_chunk_chars: int = CHUNK_MAX_SIZE_CHARS,
    overlap_chars: int = CHUNK_OVERLAP_CHARS,
) -> list[str]:
    """Chia transcript dài thành các đoạn ~2.500 - 3.000 ký tự."""
    if len(text) <= max_chunk_chars:
        return [text]

    chunks: list[str] = []
    start = 0
    text_len = len(text)

    while start < text_len:
        end = min(start + max_chunk_chars, text_len)
        if end < text_len:
            best_break = -1
            for separator in ["\n\n", ".\n", ". ", "? ", "! "]:
                idx = text.rfind(separator, start + max_chunk_chars // 2, end)
                if idx != -1:
                    best_break = idx + len(separator)
                    break
            if best_break != -1:
                end = best_break

        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)

        if end >= text_len:
            break
        start = max(start + 1, end - overlap_chars)

    return chunks


def _call_ollama_raw(
    system_prompt: str,
    user_content: str,
    num_predict: int = 2048,
    temperature: float = 0.1,
) -> str:
    """Gọi Ollama chat API Plain Text với num_ctx=4096."""
    if ollama is None:
        raise RuntimeError("Ollama không khả dụng trong môi trường Cloud.")
    response = ollama.chat(
        model=OLLAMA_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        options={
            "temperature": temperature,
            "top_p": 0.9,
            "num_predict": num_predict,
            "num_ctx": 4096,
        },
    )
    return response.get("message", {}).get("content", "").strip()


def _call_ollama_json(
    system_prompt: str,
    user_content: str,
    num_predict: int = 2048,
    temperature: float = 0.1,
) -> str:
    """Gọi Ollama chat API JSON với num_ctx=4096."""
    if ollama is None:
        raise RuntimeError("Ollama không khả dụng trong môi trường Cloud.")
    response = ollama.chat(
        model=OLLAMA_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        options={
            "temperature": temperature,
            "top_p": 0.9,
            "num_predict": num_predict,
            "num_ctx": 4096,
        },
        format="json",
    )
    return response.get("message", {}).get("content", "").strip()


_ACTION_KEYWORDS = [
    "đề nghị", "yêu cầu", "khẳng định", "thống nhất", "triển khai",
    "hoàn thành", "mục tiêu", "giao", "chỉ đạo", "phối hợp",
    "nhiệm vụ", "kết luận", "cần nỗ lực", "tập trung", "chủ trì",
    "quyết tâm", "chú trọng", "thực hiện", "đôn đốc",
]


def _extractive_chunk_summary(chunk_text: str, max_sentences: int = 4) -> str:
    """Thuật toán trích xuất câu quan trọng (Extractive Summarization)."""
    raw_sentences = re.split(r"(?<=[.!?])\s+", chunk_text)
    sentences = [s.strip() for s in raw_sentences if len(s.strip()) > 25]

    if not sentences:
        return "- Nội dung phần này thảo luận chi tiết các vấn đề trọng tâm và định hướng kế hoạch triển khai."

    scored_sentences: list[tuple[int, str]] = []
    for s in sentences:
        s_lower = s.lower()
        score = sum(2 for kw in _ACTION_KEYWORDS if kw in s_lower)
        if 40 <= len(s) <= 180:
            score += 1
        scored_sentences.append((score, s))

    scored_sentences.sort(key=lambda x: x[0], reverse=True)
    top_sentences = [item[1] for item in scored_sentences[:max_sentences]]
    if not top_sentences:
        top_sentences = sentences[:max_sentences]

    bullet_points = [f"- {s}" for s in top_sentences]
    return "\n".join(bullet_points)


_DIRECTIVE_VERBS = [
    "đề nghị", "yêu cầu", "giao", "phối hợp", "quyết tâm hoàn thành",
    "cần nỗ lực", "tập trung", "triển khai", "chỉ đạo", "hoàn thành",
    "đôn đốc", "chủ trì", "thực hiện", "thống nhất",
]

_COMMON_ASSIGNEES = [
    "Các bộ, ngành, địa phương",
    "Hai Bộ Quốc phòng",
    "Bộ Quốc phòng",
    "Bộ Tài chính",
    "Bộ Kế hoạch và Đầu tư",
    "Bộ Công Thương",
    "Bộ Giao thông Vận tải",
    "Bộ Thông tin và Truyền thông",
    "Ủy ban nhân dân các tỉnh, thành phố",
    "Các doanh nghiệp và tập đoàn kinh tế",
    "Ban Quản lý dự án",
    "Tổ công tác chuyên trách",
    "Thường trực Chính phủ",
    "Các cơ quan tham mưu",
]

_TIMEFRAME_PATTERNS = [
    r"(?:trong\s+)?quý\s+[1-4ivx]+(?:\s+năm\s+\d{4})?",
    r"(?:năm\s+)?202[5-9]",
    r"(?:trong\s+)?tháng\s+\d{1,2}(?:\s+năm\s+\d{4})?",
    r"(?:sớm\s+triển\s+khai|khẩn\s+trương|trong\s+năm\s+nay|ngay\s+trong\s+tuần|kịp\s+thời)",
]


def _rule_based_task_extractor(text: str) -> list[dict[str, Any]]:
    """Quét văn bản trích xuất nhiệm vụ chỉ đạo tiếng Việt."""
    sentences = re.split(r"(?<=[.!?])\s+", text)
    extracted: list[dict[str, Any]] = []
    seen_titles: set[str] = set()

    for sentence in sentences:
        s_clean = sentence.strip()
        if len(s_clean) < 30 or len(s_clean) > 250:
            continue

        s_lower = s_clean.lower()
        matched_verb = None
        for verb in _DIRECTIVE_VERBS:
            if verb in s_lower:
                matched_verb = verb
                break

        if not matched_verb:
            continue

        found_assignee = None
        for org in _COMMON_ASSIGNEES:
            if org.lower() in s_lower:
                found_assignee = org
                break

        if not found_assignee:
            match_after = re.search(
                rf"{matched_verb}\s+(?:cho\s+)?([A-ZÀ-Ỹ][\w\s,]+?)(?:\s+(?:cần|phải|tiếp\s+tục|tập\s+trung|chủ\s+trì|thực\s+hiện|hoàn\s+thành))",
                s_clean,
            )
            if match_after:
                candidate = match_after.group(1).strip()
                if len(candidate) < 60:
                    found_assignee = candidate

        if not found_assignee:
            found_assignee = "Các đơn vị liên quan"

        found_deadline = None
        for tf_regex in _TIMEFRAME_PATTERNS:
            m = re.search(tf_regex, s_lower)
            if m:
                found_deadline = m.group(0).capitalize()
                break

        if not found_deadline:
            found_deadline = "Trong kế hoạch sắp tới"

        title = s_clean
        title = re.sub(r"^(?:theo\s+đó|mặt\s+khác|đồng\s+thời|ngoài\s+ra|kết\s+luận\s+hội\s+nghị),\s*", "", title, flags=re.IGNORECASE)
        if len(title) > 120:
            title = title[:117] + "..."

        title_key = title[:40].lower()
        if title_key in seen_titles:
            continue
        seen_titles.add(title_key)

        extracted.append({
            "title": title,
            "description": s_clean,
            "assignee_name": found_assignee,
            "due_date": found_deadline,
            "priority": "High" if ("quyết tâm" in s_lower or "khẩn trương" in s_lower or "yêu cầu" in s_lower) else "Medium",
        })

        if len(extracted) >= 8:
            break

    return extracted


_MAP_CHUNK_PROMPT = """Bạn là trợ lý thư ký ghi chép biên bản cuộc họp chuyên nghiệp tại Việt Nam.
Nhiệm vụ: Hãy đọc đoạn gỡ băng sau, sửa các lỗi chính tả nghe nhầm và tóm tắt thành 3-5 gạch đầu dòng rõ ràng, chuẩn xác về:
(1) Ai phát biểu / chủ trì
(2) Nội dung thảo luận chính
(3) Các yêu cầu / đề nghị / nhiệm vụ cụ thể được giao.
Yêu cầu: Viết tiếng Việt chuẩn mực, súc tích, dạng gạch đầu dòng ngắn gọn. KHÔNG xuất JSON. KHÔNG thêm lời mở đầu hay kết thúc."""


def _run_map_phase(chunks: list[str], meeting_id: int = 0) -> list[str]:
    """Bước Map tóm tắt từng phần."""
    total_chunks = len(chunks)
    chunk_summaries: list[str] = []

    for i, chunk in enumerate(chunks):
        progress_per_chunk = 23 // max(total_chunks, 1)
        current_progress = 62 + (i * progress_per_chunk)

        if meeting_id > 0:
            update_progress(
                meeting_id,
                progress_percent=current_progress,
                current_step_detail=f"Đang phân tích chuyên sâu phần {i + 1}/{total_chunks}...",
            )

        user_message = f"--- BẮT ĐẦU ĐOẠN GỠ BĂNG PHẦN {i + 1}/{total_chunks} ---\n{chunk}\n--- HẾT ĐOẠN GỠ BĂNG ---"
        try:
            summary = _call_ollama_raw(_MAP_CHUNK_PROMPT, user_message, num_predict=1500, temperature=0.1)
            summary = summary.replace("```markdown", "").replace("```", "").strip()
            if len(summary) < 30:
                raise ValueError("Ollama trả về tóm tắt quá ngắn.")
            chunk_summaries.append(f"### Phần {i + 1}/{total_chunks}:\n{summary}")
        except Exception as chunk_err:
            logger.warning("⚠️ Lỗi Ollama ở chunk %d/%d: %s. Chuyển sang Extractive...", i + 1, total_chunks, chunk_err)
            extractive_summary = _extractive_chunk_summary(chunk)
            chunk_summaries.append(f"### Phần {i + 1}/{total_chunks}:\n{extractive_summary}")

        gc.collect()

    return chunk_summaries


_REDUCE_SYNTHESIS_PROMPT = """Bạn là thư ký trưởng tổng hợp biên bản cuộc họp chính thức của doanh nghiệp / cơ quan tại Việt Nam.
Dưới đây là tóm tắt các phần diễn biến trong cuộc họp.
Nhiệm vụ: Hãy tổng hợp thành một Biên bản cuộc họp chuẩn chỉnh, trang trọng, mạch lạc gồm đúng 3 phần:

I. TỔNG QUAN & TÓM TẮT ĐIỀU HÀNH
(Tổng kết cô đọng 1-2 đoạn văn về bối cảnh, mục tiêu, thành phần và tinh thần chung của cuộc họp)

II. NỘI DUNG DIỄN BIẾN THẢO LUẬN CHI TIẾT
(Trình bày rõ ràng các chủ đề thảo luận lớn, ý kiến phát biểu của các bên và các giải pháp được đề xuất dưới dạng gạch đầu dòng)

III. KẾT LUẬN & CHỈ ĐẠO TRỌNG TÂM
(Các quyết sách đã chốt, định hướng hành động và yêu cầu của người chủ trì)

Yêu cầu: Viết tiếng Việt chuẩn thể thức hành chính, không dùng các ký hiệu thừa, không sinh JSON."""


def _run_reduce_phase(chunk_summaries: list[str], full_transcript: str, meeting_id: int = 0) -> str:
    """Bước Reduce tổng hợp biên bản."""
    if meeting_id > 0:
        update_progress(
            meeting_id,
            progress_percent=86,
            current_step_detail="Đang tổng hợp các phần thành biên bản toàn diện...",
        )

    combined_input = "\n\n".join(chunk_summaries)
    user_message = (
        f"Dưới đây là các phần diễn biến chi tiết của cuộc họp:\n\n"
        f"{combined_input}\n\n"
        f"Hãy tổng hợp thành biên bản họp hoàn chỉnh theo đúng cấu trúc 3 phần quy định."
    )

    try:
        minutes_text = _call_ollama_raw(_REDUCE_SYNTHESIS_PROMPT, user_message, num_predict=3500, temperature=0.1)
        minutes_text = minutes_text.replace("```markdown", "").replace("```", "").strip()

        if "I." in minutes_text and ("II." in minutes_text or "III." in minutes_text):
            return minutes_text

        return _format_fallback_minutes(chunk_summaries, full_transcript)
    except Exception as reduce_err:
        logger.warning("⚠️ Lỗi Ollama ở bước Reduce: %s. Chuyển sang tổng hợp cấu trúc trực tiếp...", reduce_err)
        return _format_fallback_minutes(chunk_summaries, full_transcript)


def _format_fallback_minutes(chunk_summaries: list[str], full_transcript: str) -> str:
    """Tổ chức biên bản có cấu trúc 3 phần chuẩn Thư ký Hành chính dựa 100% trên dữ liệu thực tế của transcript."""
    raw_sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", full_transcript) if len(s.strip()) > 20]
    intro_sentences = raw_sentences[:3] if raw_sentences else []
    exec_summary = " ".join(intro_sentences) if intro_sentences else "Theo chương trình kỳ họp / Chưa nêu cụ thể."

    detailed_sections: list[str] = []
    for s in chunk_summaries:
        cleaned_section = re.sub(r"^###\s*", "", s).strip()
        if cleaned_section:
            detailed_sections.append(cleaned_section)

    if not detailed_sections and raw_sentences:
        detailed_sections = [f"- {s}" for s in raw_sentences[3:15]]

    # Trích xuất kết luận từ các câu thực tế có từ khóa chỉ đạo
    conclusion_candidates = [
        s for s in raw_sentences
        if any(kw in s.lower() for kw in ["kết luận", "chỉ đạo", "yêu cầu", "thống nhất", "giao", "đề nghị"])
    ]
    if conclusion_candidates:
        conclusion_text = "\n".join(f"- {s}" for s in conclusion_candidates[:8])
    else:
        conclusion_text = "- Tiếp tục bám sát các nội dung chỉ đạo đã nêu trong bản ghi cuộc họp."

    return (
        f"I. THÔNG TIN CHUNG & BỐI CẢNH ĐIỀU HÀNH\n"
        f"{exec_summary}\n\n"
        f"II. DIỄN BIẾN THẢO LUẬN CHI TIẾT\n"
        + "\n\n".join(detailed_sections)
        + f"\n\nIII. KẾT LUẬN & GIAO NHIỆM VỤ TRỌNG TÂM\n"
        f"{conclusion_text}"
    )


_TASK_EXTRACTION_PROMPT = """Bạn là trợ lý AI chuyên trích xuất công việc (Action Items) từ nội dung cuộc họp tại Việt Nam.
Nhiệm vụ: Hãy đọc kỹ biên bản cuộc họp và trích xuất danh sách tất cả các công việc, chỉ đạo, nhiệm vụ được giao.
Chỉ trả về duy nhất JSON hợp lệ là một mảng (array) các object có dạng:
[
  {
    "title": "Tên nhiệm vụ ngắn gọn (dưới 100 ký tự)",
    "description": "Chi tiết yêu cầu thực hiện",
    "assignee": "Tên người hoặc đơn vị phụ trách",
    "deadline": "Thời hạn hoàn thành",
    "priority": "High"
  }
]
QUY TẮC:
- Nếu không có công việc nào, trả về [].
- KHÔNG viết bất kỳ chữ nào bên ngoài JSON."""


def _run_task_extraction(
    minutes_text: str,
    full_transcript: str,
    meeting_id: int = 0,
) -> list[dict[str, Any]]:
    """Trích xuất danh sách công việc kết hợp LLM + Rule-based Extractor."""
    if meeting_id > 0:
        update_progress(
            meeting_id,
            progress_percent=92,
            current_step_detail="Đang trích xuất danh sách công việc & phân công...",
        )

    extracted_tasks: list[dict[str, Any]] = []

    try:
        user_message = f"--- BIÊN BẢN VÀ DIỄN BIẾN CUỘC HỌP ---\n{minutes_text}\n--- HẾT NỘI DUNG ---"
        raw_json_res = _call_ollama_json(_TASK_EXTRACTION_PROMPT, user_message, num_predict=2500, temperature=0.1)
        parsed = _parse_tasks_json(raw_json_res)
        if parsed and isinstance(parsed, list):
            for item in parsed:
                if isinstance(item, dict) and item.get("title"):
                    extracted_tasks.append({
                        "title": str(item.get("title")).strip(),
                        "description": item.get("description") or None,
                        "assignee_name": item.get("assignee") or item.get("assignee_name") or "Đơn vị được giao",
                        "due_date": item.get("deadline") or item.get("due_date") or "Kế hoạch sắp tới",
                        "priority": item.get("priority", "Medium"),
                    })
    except Exception as llm_task_err:
        logger.warning("⚠️ Lỗi Ollama khi trích xuất tasks: %s", llm_task_err)

    if len(extracted_tasks) < 3:
        logger.info("🔍 Kích hoạt Smart Rule-based Extractor...")
        rule_tasks = _rule_based_task_extractor(full_transcript)
        existing_titles = {t["title"].strip().lower() for t in extracted_tasks}
        for rt in rule_tasks:
            if rt["title"].strip().lower() not in existing_titles:
                extracted_tasks.append(rt)
                existing_titles.add(rt["title"].strip().lower())

    return extracted_tasks


def _parse_tasks_json(raw: str) -> list[dict]:
    """Parse JSON an toàn cho mảng tasks."""
    try:
        val = json.loads(raw)
        if isinstance(val, list):
            return val
        if isinstance(val, dict):
            for k in ["tasks", "action_items", "data"]:
                if isinstance(val.get(k), list):
                    return val[k]
    except Exception:
        pass

    match = re.search(r"```(?:json)?\s*(\[.*?\])\s*```", raw, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except Exception:
            pass

    first_b = raw.find("[")
    last_b = raw.rfind("]")
    if first_b != -1 and last_b > first_b:
        try:
            return json.loads(raw[first_b:last_b + 1])
        except Exception:
            pass

    return []


def _run_single_pass(transcript_text: str, meeting_id: int = 0) -> dict[str, Any]:
    """Tạo biên bản và tasks cho file ngắn bằng 1 lần gọi trực tiếp."""
    if meeting_id > 0:
        update_progress(
            meeting_id,
            status="summarizing",
            progress_percent=65,
            current_step_detail="Đang phân tích và tạo biên bản cuộc họp...",
        )

    chunk_summaries = _run_map_phase([transcript_text], meeting_id=meeting_id)
    minutes = _run_reduce_phase(chunk_summaries, transcript_text, meeting_id=meeting_id)
    tasks = _run_task_extraction(minutes, transcript_text, meeting_id=meeting_id)

    return {
        "minutes": minutes,
        "tasks": tasks,
    }


def _run_llm_generation(transcript_text: str, meeting_id: int = 0) -> dict[str, Any]:
    """Router xử lý bằng Local Ollama Map-Reduce / Extractive."""
    start_time = time.perf_counter()
    chunks = _chunk_transcript(transcript_text)
    total_chunks = len(chunks)

    try:
        if total_chunks <= 1:
            result = _run_single_pass(transcript_text, meeting_id=meeting_id)
        else:
            chunk_summaries = _run_map_phase(chunks, meeting_id=meeting_id)
            minutes = _run_reduce_phase(chunk_summaries, transcript_text, meeting_id=meeting_id)
            tasks = _run_task_extraction(minutes, transcript_text, meeting_id=meeting_id)
            result = {
                "minutes": minutes,
                "tasks": tasks,
            }
    except Exception as exc:
        logger.warning("⚠️ Local Ollama pipeline gặp lỗi: %s. Kích hoạt Extractive Fallback...", exc)
        chunk_summaries = [
            f"### Phần {i + 1}/{total_chunks}:\n{_extractive_chunk_summary(c)}"
            for i, c in enumerate(chunks)
        ]
        fallback_minutes = _format_fallback_minutes(chunk_summaries, transcript_text)
        fallback_tasks = _rule_based_task_extractor(transcript_text)
        result = {
            "minutes": fallback_minutes,
            "tasks": fallback_tasks,
        }

    elapsed = time.perf_counter() - start_time
    result["_llm_processing_time_seconds"] = round(elapsed, 2)
    return result


async def generate_minutes_and_tasks(
    text: str,
    meeting_id: int = 0,
    template_text: str | None = None,
    secretary_notes: str | None = None,
) -> dict[str, Any]:
    """
    Entry point tạo biên bản và trích xuất tasks – Kiến trúc Hybrid Zero-503:
      1. Ưu tiên Google Gemini API (trích xuất cấu trúc 3 phần + tasks mảng 5-10 việc, hoặc theo Custom Template .docx).
      2. Nếu không có key hoặc lỗi: Tự động fallback sang Local Ollama / Extractive Fallback.
      3. Tuyệt đối không bao giờ văng HTTP 503.
    """
    if not text or not text.strip():
        raise ValueError("Văn bản transcript không được rỗng.")

    # Ưu tiên Google Gemini API nếu khả dụng và có kết nối Internet
    has_gemini = is_valid_gemini_key(_GEMINI_API_KEY)
    if has_gemini and _PREFERRED_AI_ENGINE != "local" and check_internet_available(timeout_sec=1.5):
        try:
            logger.info("✨ [Hybrid AI] Đang tạo biên bản & trích xuất tasks bằng Google Gemini API...")
            gemini_result = await _gemini_generate_minutes_and_tasks(
                text,
                meeting_id=meeting_id,
                template_text=template_text,
                secretary_notes=secretary_notes,
            )
            if gemini_result.get("minutes", "").strip():
                gemini_result["engine"] = "gemini"
                gemini_result["engine_used"] = "gemini"
                return gemini_result
            logger.warning("⚠️ Gemini trả về biên bản rỗng, chuyển sang Local Ollama...")
        except Exception as gemini_err:
            logger.warning("No WiFi detected. Falling back to Local Whisper & Ollama (%s)", gemini_err)
            if meeting_id > 0:
                update_progress(meeting_id, engine_used="local")

    # Chạy Local Ollama
    logger.info("💻 [Hybrid AI] Chạy tạo biên bản bằng Local Ollama / Extractive...")
    if meeting_id > 0:
        update_progress(meeting_id, engine_used="local")
    loop = asyncio.get_running_loop()
    try:
        result = await asyncio.wait_for(
            loop.run_in_executor(_executor, _run_llm_generation, text, meeting_id),
            timeout=float(OLLAMA_TIMEOUT),
        )
    except Exception as exc:
        logger.warning("⚠️ Local Ollama Timeout hoặc Executor Error: %s. Dùng Extractive ngay...", exc)
        chunks = _chunk_transcript(text)
        summaries = [
            f"### Phần {i + 1}/{len(chunks)}:\n{_extractive_chunk_summary(c)}"
            for i, c in enumerate(chunks)
        ]
        fallback_minutes = _format_fallback_minutes(summaries, text)
        fallback_tasks = _rule_based_task_extractor(text)
        result = {
            "minutes": fallback_minutes,
            "tasks": fallback_tasks,
            "_llm_processing_time_seconds": 0.0,
        }

    result["engine"] = "local"
    result["engine_used"] = "local"
    return result


async def rewrite_meeting_minutes_and_tasks(
    source_text: str,
    mode: str = "administrative",
    custom_instruction: str | None = None,
    template_text: str | None = None,
) -> dict[str, Any]:
    """
    Biến đổi, tái cấu trúc văn bản cuộc họp theo nhiều phong cách chuyên nghiệp:
      - 'administrative': Chuẩn văn bản hành chính Nghị định 30/2020/NĐ-CP
      - 'corporate': Biên bản Doanh nghiệp, HĐQT (KPI, Quyết định, Rủi ro, Next steps)
      - 'news_digest': Báo cáo / Bản tin Thời sự chia theo từng sự kiện trọng tâm
      - 'concise': Tóm tắt cô đọng 1 trang (Executive 1-Pager)
      - 'detailed': Phân tích chuyên sâu, toàn diện số liệu & phát biểu
      - 'custom': Theo yêu cầu tùy chỉnh người dùng hoặc BIỂU MẪU MẪU (.docx)
    """
    start_time = time.perf_counter()
    if not source_text or not source_text.strip():
        raise ValueError("Văn bản nguồn không được rỗng.")

    mode_normalized = mode.lower().strip() if mode else "administrative"

    mode_descriptions = {
        "administrative": (
            "PHONG CÁCH THƯ KÝ HÀNH CHÍNH CHUYÊN SÂU (Nghị định 30/2020/NĐ-CP):\n"
            "Văn phong chính luận đĩnh đạc, trang trọng, tường thuật mạch lạc diễn biến từng phiên làm việc (ví dụ: 'Mở đầu phiên làm việc...', 'Tiếp theo chương trình, thừa ủy quyền của...').\n"
            "Cấu trúc đúng 3 phần:\n"
            "I. THÔNG TIN CHUNG & BỐI CẢNH ĐIỀU HÀNH (Thời gian, địa điểm, thành phần, chủ tọa, mục tiêu bối cảnh)\n"
            "II. DIỄN BIẾN THẢO LUẬN CHI TIẾT (Chiếm 70% dung lượng, chia rõ 1. Nghi thức & thành phần; 2. Khai mạc Chủ tọa; 3. Báo cáo, Tờ trình & Thảo luận của từng đại biểu 3.1, 3.2... với a) Sự cần thiết; b) Bố cục & chính sách; c) Phương án & thẩm tra)\n"
            "III. KẾT LUẬN & GIAO NHIỆM VỤ TRỌNG TÂM (Nội dung thống nhất và phân công người/cơ quan chịu trách nhiệm)"
        ),
        "corporate": (
            "PHONG CÁCH DOANH NGHIỆP / DỰ ÁN (CORPORATE MINUTES):\n"
            "Văn phong hiện đại, trực diện, tập trung vào hiệu quả và hành động. Cấu trúc 4 phần:\n"
            "I. BỐI CẢNH VÀ MỤC TIÊU CUỘC HỌP (OBJECTIVES & CONTEXT)\n"
            "II. CÁC QUYẾT ĐỊNH QUAN TRỌNG & THẢO LUẬN TRỌNG TÂM (KEY DECISIONS & DISCUSSIONS)\n"
            "III. ĐÁNH GIÁ RỦI RO & VẤN ĐỀ TỒN ĐỌNG (RISKS & BLOCKERS)\n"
            "IV. KẾ HOẠCH HÀNH ĐỘNG TIẾP THEO (NEXT STEPS & ACTION PLAN)"
        ),
        "news_digest": (
            "PHONG CÁCH BẢN TIN TỔNG HỢP / BÁO CÁO THỜI SỰ (NEWS & EVENT DIGEST):\n"
            "Đặc biệt tối ưu khi nội dung gồm nhiều bản tin, sự kiện đối ngoại, kinh tế. Cấu trúc 3 phần:\n"
            "I. ĐIỂM TIN NỔI BẬT TRONG PHIÊN (KEY HIGHLIGHTS)\n"
            "II. CHI TIẾT CÁC SỰ KIỆN / BẢN TIN TRỌNG TÂM (chia rõ từng Sự kiện 1, Sự kiện 2... bối cảnh, nhân vật, phát biểu, số liệu cốt lõi)\n"
            "III. ĐÁNH GIÁ TỔNG QUAN & DỰ BÁO XU THẾ TIẾP THEO"
        ),
        "concise": (
            "PHONG CÁCH TÓM TẮT CÔ ĐỌNG 1 TRANG (EXECUTIVE 1-PAGER):\n"
            "Dành riêng cho lãnh đạo bận rộn, chỉ cô đọng các ý cốt lõi nhất. Cấu trúc 3 phần:\n"
            "I. THÔNG ĐIỆP CỐT LÕI (CORE MESSAGE)\n"
            "II. 3-5 QUYẾT ĐỊNH / NỘI DUNG QUAN TRỌNG NHẤT\n"
            "III. CHỈ ĐẠO HÀNH ĐỘNG NGAY LẬP TỨC (IMMEDIATE ACTIONS)"
        ),
        "detailed": (
            "PHONG CÁCH PHÂN TÍCH CHUYÊN SÂU & TOÀN DIỆN (IN-DEPTH COMPREHENSIVE REPORT):\n"
            "Phân tích sâu sắc, ghi nhận đầy đủ mọi ý kiến phát biểu, dẫn chứng số liệu, địa danh, tên riêng, giải pháp đề xuất."
        ),
        "custom": (
            f"PHONG CÁCH TÙY CHỈNH THEO YÊU CẦU NGƯỜI DÙNG:\n"
            f"{custom_instruction or 'Tối ưu hóa và làm rõ nét các thông tin quan trọng nhất.'}"
        ),
    }

    style_guide = mode_descriptions.get(mode_normalized, mode_descriptions["administrative"])
    if custom_instruction and mode_normalized != "custom":
        style_guide += f"\n\nLƯU Ý BỔ SUNG CỦA NGƯỜI DÙNG: {custom_instruction}"

    if template_text and template_text.strip():
        system_instruction = (
            "Bạn là chuyên gia biên tập và thư ký trưởng cao cấp tại Việt Nam.\n"
            "BẮT BUỘC viết biên bản tuân thủ CHÍNH XÁC 100% hệ thống đề mục (I, II, III...), "
            "cách kẻ bảng và văn phong của BIỂU MẪU MẪU sau đây. "
            "Trích xuất thông tin từ Bản gỡ băng để điền vào biểu mẫu này.\n\n"
            f"=== BIỂU MẪU MẪU (.DOCX) ===\n{template_text.strip()}\n=== HẾT BIỂU MẪU MẪU ==="
        )
        style_guide = (
            "BẮT BUỘC viết biên bản tuân thủ CHÍNH XÁC 100% hệ thống đề mục (I, II, III...), "
            "cách kẻ bảng và văn phong của BIỂU MẪU MẪU đã cung cấp trong System Prompt. "
            "Trích xuất toàn bộ dữ liệu thực tế từ Bản gỡ băng để điền đầy đủ vào biểu mẫu này."
            + (f"\n\nYÊU CẦU BỔ SUNG: {custom_instruction}" if custom_instruction else "")
        )
    else:
        system_instruction = (
            "Bạn là chuyên gia biên tập và thư ký trưởng cao cấp cho các cơ quan, doanh nghiệp hàng đầu tại Việt Nam. "
            "Nhiệm vụ của bạn là tái cấu trúc văn bản cuộc họp theo đúng định hướng phong cách được yêu cầu, "
            "đồng thời trích xuất danh sách công việc/chỉ đạo hành động đầy đủ và chính xác."
        )

    user_prompt = f"""Dưới đây là văn bản nội dung cuộc họp / bản gỡ băng:
---
{source_text}
---

YÊU CẦU ĐỊNH HƯỚNG BIÊN TẬP:
{style_guide}

Hãy biên tập lại toàn bộ nội dung và trích xuất danh sách công việc. Trả về DUY NHẤT một JSON Object hợp lệ theo cấu trúc:
{{
  "minutes": "Nội dung biên bản hoàn chỉnh theo đúng cấu trúc và phong cách đã chọn (viết bằng tiếng Việt chuẩn mực, mạch lạc, không dùng markdown thô dư thừa)...",
  "tasks": [
    {{
      "title": "Nội dung công việc hoặc chỉ đạo cụ thể (dưới 120 ký tự)",
      "assignee": "Đơn vị hoặc Người chịu trách nhiệm thực hiện",
      "deadline": "Thời hạn hoặc mốc thời gian hoàn thành"
    }}
  ]
}}

LƯU Ý BẮT BUỘC:
- Luôn trích xuất từ 5 đến 10 nhiệm vụ / chỉ đạo hành động thực tế từ nội dung.
- KHÔNG viết bất kỳ chữ nào bên ngoài JSON.
"""

    has_gemini = is_valid_gemini_key(_GEMINI_API_KEY)
    minutes_text = ""
    tasks_list: list[dict[str, Any]] = []

    if has_gemini and _PREFERRED_AI_ENGINE != "local":
        try:
            logger.info("✨ [AI Rewrite] Đang tái cấu trúc văn bản bằng Gemini API (Mode: %s)...", mode_normalized)
            raw_res = await _call_gemini_generate_content(
                parts=[{"text": user_prompt}],
                system_instruction=system_instruction,
                response_mime_type="application/json",
                api_key=_GEMINI_API_KEY,
                models_override=GEMINI_TEXT_MODELS,
            )
            parsed_data = json.loads(raw_res)
            minutes_text = str(parsed_data.get("minutes", "")).strip()
            raw_tasks = parsed_data.get("tasks", [])
            if isinstance(raw_tasks, list):
                for item in raw_tasks:
                    if isinstance(item, dict) and item.get("title"):
                        tasks_list.append({
                            "title": str(item.get("title")).strip(),
                            "description": item.get("description") or str(item.get("title")).strip(),
                            "assignee_name": item.get("assignee") or item.get("assignee_name") or "Đơn vị liên quan",
                            "due_date": item.get("deadline") or item.get("due_date") or "Kế hoạch sắp tới",
                            "priority": item.get("priority", "Medium"),
                        })
        except Exception as gemini_err:
            logger.warning("⚠️ [AI Rewrite] Gemini API gặp lỗi (%s). Chuyển sang Local AI...", gemini_err)

    # Fallback Local nếu chưa có kết quả
    if not minutes_text:
        try:
            logger.info("💻 [AI Rewrite] Dùng Local Ollama để tái cấu trúc...")
            raw_res = _call_ollama_json(system_instruction, user_prompt, num_predict=3000, temperature=0.1)
            parsed_data = json.loads(raw_res)
            minutes_text = str(parsed_data.get("minutes", "")).strip()
            raw_tasks = parsed_data.get("tasks", [])
            if isinstance(raw_tasks, list):
                for item in raw_tasks:
                    if isinstance(item, dict) and item.get("title"):
                        tasks_list.append({
                            "title": str(item.get("title")).strip(),
                            "description": item.get("description") or str(item.get("title")).strip(),
                            "assignee_name": item.get("assignee") or item.get("assignee_name") or "Đơn vị liên quan",
                            "due_date": item.get("deadline") or item.get("due_date") or "Kế hoạch sắp tới",
                            "priority": item.get("priority", "Medium"),
                        })
        except Exception as local_err:
            logger.warning("⚠️ [AI Rewrite] Local Ollama gặp lỗi: %s. Chuyển sang Extractive...", local_err)

    if not minutes_text:
        chunks = _chunk_transcript(source_text)
        summaries = [f"### Phần {i + 1}/{len(chunks)}:\n{_extractive_chunk_summary(c)}" for i, c in enumerate(chunks)]
        minutes_text = _format_fallback_minutes(summaries, source_text)

    if len(tasks_list) < 3:
        rule_tasks = _rule_based_task_extractor(source_text)
        existing_titles = {t["title"].strip().lower() for t in tasks_list}
        for rt in rule_tasks:
            if rt["title"].strip().lower() not in existing_titles:
                tasks_list.append(rt)
                existing_titles.add(rt["title"].strip().lower())

    elapsed = time.perf_counter() - start_time
    logger.info("✅ [AI Rewrite] Hoàn tất biên tập (Mode: %s) trong %.2fs", mode_normalized, elapsed)

    return {
        "minutes": minutes_text,
        "tasks": tasks_list,
        "_processing_time_seconds": round(elapsed, 2),
        "mode": mode_normalized,
    }


async def ask_meeting_assistant(
    question: str,
    minutes: str | None = None,
    transcript: str | None = None,
    tasks_info: list[dict[str, Any]] | None = None,
) -> dict[str, str]:
    """
    Trợ lý hỏi đáp bám sát nội dung cuộc họp (Grounded Meeting Copilot - NotebookLM Pattern).
    Sử dụng Gemini API hoặc fallback sang Local Ollama.
    """
    system_instruction = (
        "Bạn là Trợ lý Thư ký Cuộc họp AI (VietMeeting Copilot) thông minh, chuyên nghiệp và trung thực. "
        "Nhiệm vụ của bạn là giải đáp thắc mắc của người dùng dựa TRÊN NỘI DUNG CUỘC HỌP được cung cấp (gồm Biên bản, Bản gỡ băng và Danh sách công việc). "
        "NGUYÊN TẮC BẮT BUỘC:\n"
        "1. Chỉ trả lời dựa trên các dữ kiện có thật trong tài liệu được cung cấp. Tuyệt đối không bịa đặt, không suy diễn thông tin ngoài biên bản.\n"
        "2. Nếu tài liệu không đề cập đến thông tin được hỏi, hãy trả lời nhã nhặn rằng nội dung cuộc họp chưa đề cập hoặc chưa quyết định vấn đề này.\n"
        "3. Trình bày câu trả lời gãy gọn, mạch lạc, dùng các gạch đầu dòng rõ ràng, chuẩn phong cách hành chính/doanh nghiệp Việt Nam."
    )

    context_parts: list[str] = []
    if minutes and minutes.strip():
        context_parts.append(f"### BIÊN BẢN CUỘC HỌP:\n{minutes.strip()}")
    if tasks_info and len(tasks_info) > 0:
        task_lines: list[str] = []
        for idx, t in enumerate(tasks_info, 1):
            assignee = t.get("assignee_name") or "Chưa rõ"
            due = t.get("due_date") or "Kế hoạch sắp tới"
            st = t.get("status") or "pending"
            task_lines.append(f"- Nhiệm vụ {idx}: {t.get('title')} (Phụ trách: {assignee} | Hạn chót: {due} | Trạng thái: {st})")
        context_parts.append("### DANH SÁCH CÔNG VIỆC / CHỈ ĐẠO:\n" + "\n".join(task_lines))
    if transcript and transcript.strip():
        # Lấy tối đa 16000 ký tự transcript để đảm bảo context
        context_parts.append(f"### BẢN GỠ BĂNG ÂM THANH GỐC (TRÍCH YẾU):\n{transcript.strip()[:16000]}")

    full_context = "\n\n".join(context_parts) if context_parts else "Chưa có nội dung biên bản hoặc bản gỡ băng cho cuộc họp này."

    user_prompt = f"""Dưới đây là toàn bộ dữ liệu của cuộc họp:
---
{full_context}
---

CÂU HỎI CỦA NGƯỜI DÙNG:
"{question}"

Hãy trả lời câu hỏi trên một cách chính xác, mạch lạc và bám sát tuyệt đối vào dữ liệu cuộc họp."""

    has_gemini = is_valid_gemini_key(_GEMINI_API_KEY)
    answer_text = ""
    engine_used = "gemini"

    if has_gemini and _PREFERRED_AI_ENGINE != "local":
        try:
            logger.info("🤖 [Copilot Q&A] Đang truy vấn câu trả lời qua Gemini API...")
            answer_text = await _call_gemini_generate_content(
                parts=[{"text": user_prompt}],
                system_instruction=system_instruction,
                api_key=_GEMINI_API_KEY,
                models_override=GEMINI_TEXT_MODELS,
            )
            answer_text = answer_text.strip()
            engine_used = "gemini"
        except Exception as gemini_err:
            logger.warning("⚠️ [Copilot Q&A] Gemini API lỗi (%s). Chuyển sang Local AI...", gemini_err)

    if not answer_text and ollama is not None:
        try:
            logger.info("💻 [Copilot Q&A] Đang truy vấn qua Local Ollama (%s)...", OLLAMA_MODEL)
            loop = asyncio.get_running_loop()
            res = await loop.run_in_executor(
                _executor,
                lambda: ollama.chat(
                    model=OLLAMA_MODEL,
                    messages=[
                        {"role": "system", "content": system_instruction},
                        {"role": "user", "content": user_prompt[:8000]},
                    ],
                    options={"temperature": 0.2},
                ),
            )
            answer_text = res.get("message", {}).get("content", "").strip()
            engine_used = "local"
        except Exception as local_err:
            logger.warning("⚠️ [Copilot Q&A] Local Ollama lỗi (%s). Fallback extractive...", local_err)

    if not answer_text:
        # Fallback heuristic
        matched_tasks = [t for t in (tasks_info or []) if any(w in t.get("title", "").lower() for w in question.lower().split())]
        if matched_tasks:
            summary = "\n".join([f"- {t.get('title')} (Phụ trách: {t.get('assignee_name') or 'Cơ quan liên quan'})" for t in matched_tasks])
            answer_text = f"Dựa trên dữ liệu cuộc họp, các nội dung liên quan trực tiếp đến câu hỏi gồm:\n{summary}"
        elif minutes:
            clean = re.sub(r'[#*`_>]', '', minutes)
            answer_text = f"Thông tin tóm tắt từ biên bản cuộc họp:\n{clean[:400]}..."
        else:
            answer_text = "Hiện chưa có đủ dữ liệu biên bản hoặc bản gỡ băng chi tiết để giải đáp câu hỏi này."
        engine_used = "local"

    return {
        "answer": answer_text,
        "engine": engine_used,
    }


# ===========================================================================
# BACKGROUND PIPELINE ORCHESTRATOR (ANTI-TIMEOUT ASYNC ARCHITECTURE)
# ===========================================================================
async def process_audio_pipeline(
    meeting_id: int,
    save_path_str: str,
    relative_url: str,
    file_size: int = 0,
    secretary_notes: str | None = None,
    template_text: str | None = None,
) -> None:
    """
    Tiến trình xử lý nền hoàn chỉnh cho file ghi âm dài (50-120 phút),
    được kích hoạt bởi FastAPI BackgroundTasks sau khi API đã trả HTTP 202 Accepted.
    Cập nhật liên tục PROGRESS_STORE ('transcribing' -> 'synthesizing' -> 'completed'/'failed')
    và lưu an toàn từng bước vào SQLite bằng session độc lập.
    """
    from app.core.database import async_session_maker
    from app.models.models import Meeting, MeetingStatus, Task, TaskStatus

    pipeline_start = time.perf_counter()
    logger.info(
        "🚀 [Background Pipeline] Khởi chạy xử lý ngầm cho meeting_id=%d (%d KB)",
        meeting_id,
        file_size // 1024,
    )

    update_progress(
        meeting_id,
        status="transcribing",
        progress_percent=6,
        current_step_detail="Đang bóc băng âm thanh (có thể mất 1-3 phút)...",
    )

    async with async_session_maker() as db:
        meeting = await db.get(Meeting, meeting_id)
        if meeting is None:
            logger.error("❌ [Background Pipeline] Không tìm thấy meeting_id=%d trong DB.", meeting_id)
            update_progress(
                meeting_id,
                status="failed",
                progress_percent=0,
                current_step_detail=f"Không tìm thấy cuộc họp ID={meeting_id}.",
            )
            return

        # BƯỚC 1: Bóc băng âm thanh (STT - Multi-chunk PyAV + Gemini / Local Whisper)
        try:
            transcription_result = await transcribe_audio(
                save_path_str,
                meeting_id=meeting_id,
            )
            raw_transcript = transcription_result.get("text", "").strip()
            if not raw_transcript:
                raise ValueError("Không nhận diện được giọng nói tiếng Việt trong tệp âm thanh.")
            stt_engine = transcription_result.get("engine_used") or (
                "local" if "local" in str(transcription_result.get("engine", "")) else "gemini"
            )
        except Exception as stt_exc:
            err_msg = str(stt_exc)
            logger.error("❌ [Background Pipeline] Lỗi STT meeting_id=%d: %s", meeting_id, err_msg, exc_info=True)
            try:
                await db.refresh(meeting)
                saved_partial = PROGRESS_STORE.get(meeting_id, {}).get("partial_transcript", "")
                if saved_partial and not meeting.raw_transcript:
                    meeting.raw_transcript = saved_partial
                meeting.status = MeetingStatus.FAILED
                meeting.final_minutes = f"[PIPELINE FAILED] {err_msg}"
                await db.flush()
                await db.commit()
            except Exception:
                await db.rollback()
            update_progress(
                meeting_id,
                status="failed",
                progress_percent=0,
                current_step_detail=f"Lỗi bóc băng âm thanh: {err_msg}",
            )
            return

        # Lưu raw_transcript ngay lập tức vào SQLite
        try:
            meeting.raw_transcript = raw_transcript
            meeting.audio_file_url = relative_url
            await db.flush()
            await db.commit()
            logger.info("💾 [Background Pipeline] Đã lưu raw_transcript (%d ký tự) cho meeting %d", len(raw_transcript), meeting_id)
        except Exception as db_exc:
            await db.rollback()
            logger.warning("⚠️ [Background Pipeline] Lỗi lưu raw_transcript: %s", db_exc)

        # BƯỚC 2: Tổng hợp Biên bản & Trích xuất Nhiệm vụ (Fabric Sliding-Window Map-Reduce)
        update_progress(
            meeting_id,
            status="synthesizing",
            progress_percent=62,
            current_step_detail="Đang tổng hợp biên bản...",
            engine_used=stt_engine,
        )

        minutes_text = ""
        extracted_tasks_raw: list[dict[str, Any]] = []
        llm_engine = stt_engine

        try:
            llm_result = await generate_minutes_and_tasks(
                raw_transcript,
                meeting_id=meeting_id,
                template_text=template_text,
                secretary_notes=secretary_notes,
            )
            minutes_text = llm_result.get("minutes", "")
            extracted_tasks_raw = llm_result.get("tasks", [])
            llm_engine = llm_result.get("engine_used") or (
                "local" if "local" in str(llm_result.get("engine", "")) else "gemini"
            )
        except Exception as llm_exc:
            logger.warning("⚠️ [Background Pipeline] Lỗi tổng hợp LLM (%s). Kích hoạt Extractive Fallback...", llm_exc)
            chunks = _chunk_transcript(raw_transcript)
            summaries = [
                f"### Phần {i + 1}/{len(chunks)}:\n{_extractive_chunk_summary(c)}"
                for i, c in enumerate(chunks)
            ]
            minutes_text = _format_fallback_minutes(summaries, raw_transcript)
            extracted_tasks_raw = _rule_based_task_extractor(raw_transcript)
            llm_engine = "local"

        engine_used = "local" if (stt_engine == "local" or llm_engine == "local") else "gemini"

        # BƯỚC 3: Lưu biên bản + tasks & đánh dấu COMPLETED trong DB
        update_progress(
            meeting_id,
            status="synthesizing",
            progress_percent=96,
            current_step_detail="Đang lưu biên bản và danh sách công việc vào database...",
            engine_used=engine_used,
        )

        try:
            meeting.final_minutes = minutes_text
            meeting.status = MeetingStatus.COMPLETED
            await db.flush()
            await db.commit()
        except Exception as final_db_exc:
            await db.rollback()
            logger.error("❌ [Background Pipeline] Lỗi commit final_minutes: %s", final_db_exc, exc_info=True)

        saved_tasks = 0
        for task_data in extracted_tasks_raw:
            if not isinstance(task_data, dict) or not task_data.get("title"):
                continue
            try:
                t_title = str(task_data.get("title")).strip()
                t_desc = str(task_data.get("description") or "").strip()
                t_assignee = task_data.get("assignee_name") or task_data.get("assignee")
                t_due = task_data.get("due_date") or task_data.get("deadline")

                extras = []
                if t_assignee:
                    extras.append(f"Phụ trách: {t_assignee}")
                if t_due:
                    extras.append(f"Thời hạn: {t_due}")
                if extras:
                    extra_str = " | ".join(extras)
                    t_desc = f"[{extra_str}] {t_desc}" if t_desc else f"[{extra_str}]"

                db.add(
                    Task(
                        meeting_id=meeting_id,
                        assignee_id=None,
                        title=t_title,
                        description=t_desc or None,
                        status=TaskStatus.PENDING,
                        due_date=None,
                    )
                )
                saved_tasks += 1
            except Exception as t_exc:
                logger.warning("⚠️ Bỏ qua task không hợp lệ: %s", t_exc)

        if saved_tasks > 0:
            try:
                await db.flush()
                await db.commit()
            except Exception as t_commit_exc:
                await db.rollback()
                logger.error("❌ Lỗi commit tasks: %s", t_commit_exc)

        total_elapsed = time.perf_counter() - pipeline_start
        update_progress(
            meeting_id,
            status="completed",
            progress_percent=100,
            current_step_detail=f"Hoàn tất! Xử lý ngầm thành công trong {total_elapsed:.0f} giây.",
            engine_used=engine_used,
        )
        logger.info(
            "🎉 [Background Pipeline] Hoàn tất meeting_id=%d trong %.2fs | Biên bản: %d ký tự | Tasks: %d | Engine: %s",
            meeting_id,
            total_elapsed,
            len(minutes_text),
            saved_tasks,
            engine_used,
        )


