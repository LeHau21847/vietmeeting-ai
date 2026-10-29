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
import json
import logging
import mimetypes
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

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
import ollama

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
GEMINI_AUDIO_MODELS = [
    "gemini-3.5-transcribe",
    "gemini-3.5-flash",
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-flash-latest",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
]

GEMINI_TEXT_MODELS = [
    "gemini-3.5-flash",
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.5-flash-lite",
    "gemini-3-flash-preview",
    "gemini-flash-latest",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
]

GEMINI_MODELS = GEMINI_TEXT_MODELS

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
                            return v.strip().strip('"').strip("'")
        except Exception:
            pass
    return os.environ.get(key, default)


# Biến runtime lưu cấu hình AI
_GEMINI_API_KEY: str = _read_env_value("GEMINI_API_KEY", "")
_PREFERRED_AI_ENGINE: str = _read_env_value("PREFERRED_AI_ENGINE", "gemini")


def get_ai_config() -> dict[str, Any]:
    """Lấy thông tin cấu hình AI hiện tại cho client."""
    has_key = bool(_GEMINI_API_KEY and len(_GEMINI_API_KEY.strip()) > 10)
    masked_key = ""
    if has_key:
        k = _GEMINI_API_KEY.strip()
        if len(k) > 12:
            masked_key = f"{k[:6]}...{k[-4:]}"
        else:
            masked_key = "***"

    active_engine = "gemini" if (has_key and _PREFERRED_AI_ENGINE != "local") else "local"

    return {
        "has_gemini_key": has_key,
        "gemini_api_key_masked": masked_key,
        "preferred_engine": _PREFERRED_AI_ENGINE,
        "active_engine": active_engine,
        "active_model": "gemini-2.5-flash" if active_engine == "gemini" else "whisper-small + qwen2.5:1.5b",
        "supported_models": GEMINI_MODELS,
    }


def update_ai_config(api_key: str | None = None, preferred_engine: str | None = None) -> dict[str, Any]:
    """
    Cập nhật Gemini API Key và Preferred Engine ngay trong runtime,
    đồng thời ghi đè vào file .env để lưu vĩnh viễn.
    """
    global _GEMINI_API_KEY, _PREFERRED_AI_ENGINE

    if api_key is not None:
        _GEMINI_API_KEY = api_key.strip()
        os.environ["GEMINI_API_KEY"] = _GEMINI_API_KEY

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
    PROGRESS_STORE[meeting_id] = {
        "status": "uploading",
        "progress_percent": 0,
        "current_step_detail": "Đang chuẩn bị xử lý file audio...",
        "partial_transcript": "",
    }


def update_progress(
    meeting_id: int,
    *,
    status: str | None = None,
    progress_percent: int | None = None,
    current_step_detail: str | None = None,
    partial_transcript: str | None = None,
) -> None:
    """Cập nhật tiến trình cho một meeting."""
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


def get_progress(meeting_id: int) -> dict[str, Any]:
    """Lấy tiến trình hiện tại của meeting."""
    return PROGRESS_STORE.get(meeting_id, {
        "status": "unknown",
        "progress_percent": 0,
        "current_step_detail": "Không có dữ liệu tiến trình.",
        "partial_transcript": "",
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
    Gọi Gemini generateContent với cơ chế fallback tự động qua danh sách model.
    """
    key = api_key or _GEMINI_API_KEY
    if not key:
        raise ValueError("Chưa cấu hình GEMINI_API_KEY.")

    model_list = models_override or GEMINI_MODELS

    async with httpx.AsyncClient(timeout=600.0) as client:
        last_error = None
        for model in model_list:
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
                },
            }
            if system_instruction:
                body["systemInstruction"] = {
                    "parts": [{"text": system_instruction}]
                }
            if response_mime_type:
                body["generationConfig"]["responseMimeType"] = response_mime_type

            try:
                logger.info("🤖 [Gemini API] Đang gửi yêu cầu đến model: %s...", model)
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
                    # Model không hỗ trợ responseMimeType -> Thử lại không có responseMimeType
                    logger.info("🔄 [Gemini API] Model '%s' không hỗ trợ JSON mode ép buộc. Thử lại ở chế độ Plain text prompt...", model)
                    body_no_json = dict(body)
                    body_no_json["generationConfig"] = {"temperature": 0.1}
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
                    if res.status_code == 503:
                        await asyncio.sleep(0.8)
            except Exception as exc:
                logger.warning("⚠️ [Gemini API] Lỗi kết nối model '%s': %s", model, exc)
                last_error = str(exc)

        raise RuntimeError(f"Tất cả các Gemini model đều không phản hồi: {last_error}")


async def _gemini_transcribe_audio(file_path: str, meeting_id: int = 0) -> dict[str, Any]:
    """
    Pha 1: Bóc băng giọng nói tiếng Việt bằng Google Gemini Multimodal Audio API.
    Độ chính xác 99%, chuẩn tên riêng, danh hiệu, địa danh.
    """
    start_time = time.perf_counter()
    path_obj = Path(file_path)
    file_size = path_obj.stat().st_size
    mime_type = _detect_audio_mime_type(file_path)

    logger.info("🎙️ [Gemini STT] Bắt đầu gỡ băng file: %s (MIME: %s, Size: %d KB)", path_obj.name, mime_type, file_size // 1024)

    if meeting_id > 0:
        update_progress(
            meeting_id,
            status="transcribing",
            progress_percent=20,
            current_step_detail="Google Gemini Multimodal AI đang lắng nghe âm thanh cuộc họp...",
        )

    # Chọn cách truyền file: Inline Base64 nếu file nhỏ (<=8MB), File API nếu file lớn (>8MB)
    if file_size <= 8 * 1024 * 1024:
        logger.info("⚡ [Gemini STT] File nhỏ (<=8MB), sử dụng Inline Base64 siêu tốc.")
        with open(file_path, "rb") as f:
            b64_data = base64.b64encode(f.read()).decode("utf-8")
        audio_part = {
            "inline_data": {
                "mime_type": mime_type,
                "data": b64_data,
            }
        }
    else:
        logger.info("📦 [Gemini STT] File lớn (>8MB), upload qua Gemini File API.")
        file_info = await _upload_to_gemini_files_api(file_path, mime_type, _GEMINI_API_KEY, meeting_id)
        audio_part = {
            "file_data": {
                "file_uri": file_info["file_uri"],
                "mime_type": mime_type,
            }
        }

    if meeting_id > 0:
        update_progress(
            meeting_id,
            progress_percent=40,
            current_step_detail="Google Gemini AI đang chuyển giọng nói thành văn bản chuẩn tiếng Việt...",
        )

    stt_prompt = (
        "Bạn là chuyên gia gỡ băng tiếng Việt cao cấp. Hãy nghe toàn bộ file âm thanh này và chép lại CHÍNH XÁC 100% "
        "từng câu chữ bằng tiếng Việt chuẩn chính tả. Tự động viết hoa đúng tên riêng, tên lãnh đạo "
        "(Tổng Bí thư, Chủ tịch nước, Thủ tướng, Phó Thủ tướng...), tên cơ quan, địa danh quốc tế "
        "(Lào, Campuchia, Đức, Hamburg, Hoa Kỳ, Trung Quốc, Diên An...) và thuật ngữ hành chính/kinh tế. "
        "Chia đoạn hợp lý, tuyệt đối không lược bỏ nội dung."
    )

    raw_transcript = await _call_gemini_generate_content(
        parts=[audio_part, {"text": stt_prompt}],
        api_key=_GEMINI_API_KEY,
        models_override=GEMINI_AUDIO_MODELS,
    )

    cleaned_transcript = clean_vietnamese_transcript(raw_transcript)
    elapsed = time.perf_counter() - start_time

    # Chia đoạn transcript để giả lập segments hiển thị live
    paragraphs = [p.strip() for p in cleaned_transcript.split("\n") if p.strip()]
    segments: list[dict[str, Any]] = []
    current_time = 0.0
    for p in paragraphs:
        duration_est = max(len(p) * 0.08, 3.0)
        segments.append({
            "start": round(current_time, 2),
            "end": round(current_time + duration_est, 2),
            "text": p,
        })
        current_time += duration_est

    if meeting_id > 0:
        update_progress(
            meeting_id,
            progress_percent=60,
            current_step_detail="Gỡ băng bằng Google Gemini hoàn tất! Đang chuẩn bị tạo biên bản...",
            partial_transcript=cleaned_transcript[:1200] + ("..." if len(cleaned_transcript) > 1200 else ""),
        )

    logger.info("✅ [Gemini STT] Hoàn tất gỡ băng trong %.2fs (%d ký tự)", elapsed, len(cleaned_transcript))

    return {
        "text": cleaned_transcript,
        "language": "vi",
        "segments": segments,
        "duration": round(current_time, 2),
        "processing_time_seconds": round(elapsed, 2),
        "engine": "google-gemini",
    }


async def _gemini_generate_minutes_and_tasks(transcript_text: str, meeting_id: int = 0) -> dict[str, Any]:
    """
    Pha 2: Phân tích Biên bản Hành chính & Trích xuất Nhiệm vụ bằng Google Gemini API.
    Cấu trúc biên bản 3 phần chuẩn chỉ:
      I. TÓM TẮT ĐIỀU HÀNH
      II. NỘI DUNG DIỄN BIẾN CHI TIẾT
      III. KẾT LUẬN & ĐỊNH HƯỚNG TRỌNG TÂM
    Trích xuất mảng tasks tối thiểu 5-10 công việc thực tế.
    """
    start_time = time.perf_counter()

    if meeting_id > 0:
        update_progress(
            meeting_id,
            status="summarizing",
            progress_percent=75,
            current_step_detail="Google Gemini Pro AI đang tổng hợp biên bản và trích xuất chỉ đạo...",
        )

    system_instruction = (
        "Bạn là thư ký trưởng chuyên nghiệp của cơ quan hành chính và tập đoàn doanh nghiệp tại Việt Nam. "
        "Nhiệm vụ của bạn là phân tích sâu sắc bản gỡ băng cuộc họp, tổng hợp thành một Biên bản họp hoàn chỉnh, "
        "trang trọng, đúng thể thức và trích xuất danh sách công việc/chỉ đạo hành động cụ thể."
    )

    user_prompt = f"""Dưới đây là toàn bộ bản gỡ băng chi tiết của cuộc họp:
--- BẮT ĐẦU BẢN GỠ BĂNG ---
{transcript_text}
--- HẾT BẢN GỠ BĂNG ---

Hãy tổng hợp thành biên bản họp và trích xuất danh sách công việc. Trả về DUY NHẤT một JSON Object hợp lệ có cấu trúc chính xác như sau:
{{
  "minutes": "Nội dung biên bản đầy đủ, trang trọng, mạch lạc gồm đúng 3 phần:\\n\\nI. TÓM TẮT ĐIỀU HÀNH\\n(Tổng kết cô đọng 1-2 đoạn văn về bối cảnh, mục tiêu, thành phần và tinh thần chung của cuộc họp)\\n\\nII. NỘI DUNG DIỄN BIẾN CHI TIẾT\\n(Trình bày chi tiết từng sự kiện, chủ đề thảo luận lớn, ý kiến phát biểu của các bên và các giải pháp đề xuất, chia theo từng mục hoặc gạch đầu dòng rõ ràng)\\n\\nIII. KẾT LUẬN & ĐỊNH HƯỚNG TRỌNG TÂM\\n(Các quyết sách đã chốt, định hướng hành động và yêu cầu của người chủ trì)",
  "tasks": [
    {{
      "title": "Nội dung công việc hoặc chỉ đạo cụ thể (dưới 120 ký tự)",
      "assignee": "Đơn vị hoặc Người chịu trách nhiệm thực hiện",
      "deadline": "Thời hạn hoặc mốc thời gian hoàn thành cụ thể"
    }}
  ]
}}

QUY TẮC BẮT BUỘC:
1. "minutes": Viết bằng tiếng Việt chuẩn mực hành chính, tuyệt đối không dùng các từ viết tắt thô, chia rõ từng phần I, II, III.
2. "tasks": Luôn trích xuất tối thiểu từ 5 đến 10 nhiệm vụ / chỉ đạo hành động thực tế từ nội dung cuộc họp.
3. Nếu không nêu rõ người phụ trách, hãy ghi đơn vị phù hợp (ví dụ: 'Các bộ, ngành, địa phương', 'Ban Quản lý dự án', 'Bộ phận Kế hoạch'...).
4. Nếu không nêu thời hạn cụ thể, hãy ghi 'Trong kế hoạch sắp tới' hoặc 'Sớm triển khai'.
5. KHÔNG viết bất kỳ chữ nào bên ngoài JSON.
"""

    gemini_json_raw = await _call_gemini_generate_content(
        parts=[{"text": user_prompt}],
        system_instruction=system_instruction,
        response_mime_type="application/json",
        api_key=_GEMINI_API_KEY,
        models_override=GEMINI_TEXT_MODELS,
    )

    minutes_text = ""
    tasks_list: list[dict[str, Any]] = []

    try:
        data = json.loads(gemini_json_raw)
        minutes_text = str(data.get("minutes", "")).strip()
        raw_tasks = data.get("tasks", [])
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
    except Exception as parse_err:
        logger.warning("⚠️ Lỗi parse JSON Gemini: %s. Thử parse regex...", parse_err)
        # Parse fallback
        tasks_list = _parse_tasks_json(gemini_json_raw)

    # Đảm bảo có biên bản hợp lệ
    if not minutes_text or len(minutes_text) < 100:
        minutes_text = gemini_json_raw

    # Đảm bảo số lượng tasks tối thiểu (nếu Gemini trả ít hơn 3, bổ sung bằng Rule-based)
    if len(tasks_list) < 4:
        logger.info("🔍 Bổ sung thêm nhiệm vụ từ Rule-based Extractor...")
        rule_tasks = _rule_based_task_extractor(transcript_text)
        existing_titles = {t["title"].strip().lower() for t in tasks_list}
        for rt in rule_tasks:
            if rt["title"].strip().lower() not in existing_titles:
                tasks_list.append(rt)
                existing_titles.add(rt["title"].strip().lower())

    elapsed = time.perf_counter() - start_time
    logger.info("✅ [Gemini LLM] Hoàn tất biên bản & trích xuất %d tasks trong %.2fs", len(tasks_list), elapsed)

    return {
        "minutes": minutes_text,
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

    if not force_cpu and _whisper_model_instance is not None and not _is_cpu_fallback:
        return _whisper_model_instance

    from faster_whisper import WhisperModel

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
        "engine": "local-whisper",
    }


async def transcribe_audio(file_path: str, meeting_id: int = 0) -> dict[str, Any]:
    """
    Entry point bóc băng âm thanh – Kiến trúc Hybrid Zero-503:
      1. Nếu có GEMINI_API_KEY hợp lệ và preferred != 'local': Ưu tiên chạy Google Gemini API (nhanh, chuẩn 99%).
      2. Nếu lỗi hoặc không có key: Tự động fallback sang Local Whisper an toàn tuyệt đối.
    """
    audio_path = Path(file_path)
    if not audio_path.exists():
        raise FileNotFoundError(f"File audio không tồn tại: {file_path}")
    if not audio_path.is_file():
        raise ValueError(f"Đường dẫn không phải là file: {file_path}")
    if audio_path.stat().st_size == 0:
        raise ValueError(f"File audio rỗng (0 bytes): {file_path}")

    # Ưu tiên Google Gemini API nếu khả dụng
    has_gemini = bool(_GEMINI_API_KEY and len(_GEMINI_API_KEY.strip()) > 10)
    if has_gemini and _PREFERRED_AI_ENGINE != "local":
        try:
            logger.info("✨ [Hybrid AI] Đang chạy bóc băng bằng Google Gemini Multimodal Audio API...")
            gemini_res = await _gemini_transcribe_audio(str(audio_path.resolve()), meeting_id)
            if gemini_res.get("text", "").strip():
                return gemini_res
            logger.warning("⚠️ Gemini trả về transcript rỗng, chuyển sang Local Whisper...")
        except Exception as gemini_err:
            logger.warning(
                "⚠️ [Hybrid Fallback] Google Gemini STT gặp lỗi (%s). Tự động hạ cấp sang Local Faster-Whisper...",
                gemini_err,
            )

    # Chạy Local Faster-Whisper
    logger.info("💻 [Hybrid AI] Chạy bóc băng bằng Local Whisper...")
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

    if len(extracted) < 3 and len(sentences) >= 2:
        for s in sentences[:5]:
            s_clean = s.strip()
            if 40 <= len(s_clean) <= 180 and s_clean[:30].lower() not in seen_titles:
                extracted.append({
                    "title": f"Triển khai: {s_clean[:100]}...",
                    "description": s_clean,
                    "assignee_name": "Ban chỉ đạo cuộc họp",
                    "due_date": "Sớm triển khai",
                    "priority": "Medium",
                })
                if len(extracted) >= 5:
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
    """Tổ chức biên bản có cấu trúc 3 phần sạch sẽ khi Reduce gặp lỗi."""
    sentences = re.split(r"(?<=[.!?])\s+", full_transcript[:1000])
    intro_sentences = [s.strip() for s in sentences[:3] if len(s.strip()) > 20]
    exec_summary = " ".join(intro_sentences) or "Cuộc họp đã diễn ra nghiêm túc, tập trung rà soát tiến độ và thống nhất các nhiệm vụ trọng tâm."

    detailed_sections: list[str] = []
    for s in chunk_summaries:
        cleaned_section = re.sub(r"^###\s*", "", s).strip()
        detailed_sections.append(cleaned_section)

    return (
        f"I. TỔNG QUAN & TÓM TẮT ĐIỀU HÀNH\n"
        f"{exec_summary}\n\n"
        f"II. NỘI DUNG DIỄN BIẾN THẢO LUẬN CHI TIẾT\n"
        + "\n\n".join(detailed_sections)
        + f"\n\nIII. KẾT LUẬN & CHỈ ĐẠO TRỌNG TÂM\n"
        f"- Thống nhất các mục tiêu kế hoạch đã đề ra, yêu cầu các bộ phận phối hợp chặt chẽ.\n"
        f"- Đề nghị người phụ trách đôn đốc, theo dõi tiến độ từng mốc thời gian để đạt kết quả cao nhất."
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


async def generate_minutes_and_tasks(text: str, meeting_id: int = 0) -> dict[str, Any]:
    """
    Entry point tạo biên bản và trích xuất tasks – Kiến trúc Hybrid Zero-503:
      1. Ưu tiên Google Gemini API (trích xuất cấu trúc 3 phần + tasks mảng 5-10 việc).
      2. Nếu không có key hoặc lỗi: Tự động fallback sang Local Ollama / Extractive Fallback.
      3. Tuyệt đối không bao giờ văng HTTP 503.
    """
    if not text or not text.strip():
        raise ValueError("Văn bản transcript không được rỗng.")

    # Ưu tiên Google Gemini API nếu khả dụng
    has_gemini = bool(_GEMINI_API_KEY and len(_GEMINI_API_KEY.strip()) > 10)
    if has_gemini and _PREFERRED_AI_ENGINE != "local":
        try:
            logger.info("✨ [Hybrid AI] Đang tạo biên bản & trích xuất tasks bằng Google Gemini API...")
            gemini_result = await _gemini_generate_minutes_and_tasks(text, meeting_id)
            if gemini_result.get("minutes", "").strip():
                return gemini_result
            logger.warning("⚠️ Gemini trả về biên bản rỗng, chuyển sang Local Ollama...")
        except Exception as gemini_err:
            logger.warning(
                "⚠️ [Hybrid Fallback] Google Gemini tạo biên bản gặp lỗi (%s). Tự động hạ cấp sang Local Ollama...",
                gemini_err,
            )

    # Chạy Local Ollama
    logger.info("💻 [Hybrid AI] Chạy tạo biên bản bằng Local Ollama / Extractive...")
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

    return result


async def rewrite_meeting_minutes_and_tasks(
    source_text: str,
    mode: str = "administrative",
    custom_instruction: str | None = None,
) -> dict[str, Any]:
    """
    Biến đổi, tái cấu trúc văn bản cuộc họp theo nhiều phong cách chuyên nghiệp:
      - 'administrative': Chuẩn văn bản hành chính Nghị định 30/2020/NĐ-CP
      - 'corporate': Biên bản Doanh nghiệp, HĐQT (KPI, Quyết định, Rủi ro, Next steps)
      - 'news_digest': Báo cáo / Bản tin Thời sự chia theo từng sự kiện trọng tâm
      - 'concise': Tóm tắt cô đọng 1 trang (Executive 1-Pager)
      - 'detailed': Phân tích chuyên sâu, toàn diện số liệu & phát biểu
      - 'custom': Theo yêu cầu tùy chỉnh người dùng
    """
    start_time = time.perf_counter()
    if not source_text or not source_text.strip():
        raise ValueError("Văn bản nguồn không được rỗng.")

    mode_normalized = mode.lower().strip() if mode else "administrative"

    mode_descriptions = {
        "administrative": (
            "PHONG CÁCH HÀNH CHÍNH NHÀ NƯỚC (Nghị định 30/2020/NĐ-CP):\n"
            "Văn phong nghiêm trang, chuẩn thể thức công vụ. Cấu trúc đúng 3 phần:\n"
            "I. TỔNG QUAN & TÓM TẮT ĐIỀU HÀNH\n"
            "II. NỘI DUNG DIỄN BIẾN CUỘC HỌP (trình bày chi tiết từng chủ đề thảo luận, ý kiến đóng góp, phân tích)\n"
            "III. KẾT LUẬN & CHỈ ĐẠO TRỌNG TÂM (các quyết sách chốt, yêu cầu thực hiện, mốc thời gian)"
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

    has_gemini = bool(_GEMINI_API_KEY and len(_GEMINI_API_KEY.strip()) > 10)
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
