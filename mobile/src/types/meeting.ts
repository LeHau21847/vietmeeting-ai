/**
 * src/types/meeting.ts
 *
 * TypeScript interfaces cho toàn bộ dữ liệu liên quan đến Meeting và AI result.
 * Tương ứng 1-1 với Pydantic schemas bên Backend FastAPI.
 */

// ---------------------------------------------------------------------------
// Trạng thái Meeting (enum tương ứng backend)
// ---------------------------------------------------------------------------
export type MeetingStatus = "created" | "processing" | "completed" | "failed";

// ---------------------------------------------------------------------------
// Trạng thái Task
// ---------------------------------------------------------------------------
export type TaskStatus = "pending" | "in_progress" | "done" | "cancelled";

// ---------------------------------------------------------------------------
// Schema rút gọn cho Meeting trong danh sách (MeetingSummary)
// ---------------------------------------------------------------------------
export interface MeetingSummary {
  id: number;
  title: string;
  status: MeetingStatus;
  audio_file_url: string | null;
  created_at: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Schema đầy đủ cho một Meeting (dùng xem lại lịch sử)
// ---------------------------------------------------------------------------
export interface TaskSummary {
  id: number;
  title: string;
  status: TaskStatus;
  assignee_id: number | null;
  description?: string | null;
}

export interface MeetingRead {
  id: number;
  title: string;
  description: string | null;
  audio_file_url: string | null;
  raw_transcript: string | null;
  final_minutes: string | null;
  status: MeetingStatus;
  created_at: string;
  updated_at: string;
  tasks: TaskSummary[];
}

// ---------------------------------------------------------------------------
// Schema tạo mới Meeting (body của POST /api/v1/meetings)
// ---------------------------------------------------------------------------
export interface MeetingCreateBody {
  title: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Công việc được AI trích xuất từ biên bản
// ---------------------------------------------------------------------------
export interface ExtractedTask {
  /** Tên công việc (bắt buộc) */
  title: string;
  /** Mô tả chi tiết (có thể null) */
  description: string | null;
  /** Tên người được giao – theo transcript, chưa map với User ID (có thể null) */
  assignee_name: string | null;
  /** Deadline dạng chuỗi tự do, ví dụ: "cuối tuần", "15/8" (có thể null) */
  due_date: string | null;
}

// ---------------------------------------------------------------------------
// Kết quả trả về từ endpoint POST /api/v1/audio/{meeting_id}/process
// ---------------------------------------------------------------------------
export interface AIProcessingResult {
  /** ID cuộc họp đã xử lý */
  meeting_id: number;
  /** Đường dẫn file audio đã lưu trên server */
  audio_file_url: string;
  /** Văn bản thô từ Whisper STT */
  raw_transcript: string;
  /** Biên bản họp chính thức (Markdown string) */
  minutes: string;
  /** Danh sách công việc được AI trích xuất */
  tasks: ExtractedTask[];
  /** Metadata xử lý: thời gian, model, số ký tự... */
  processing_metadata: ProcessingMetadata;
}

export interface ProcessingMetadata {
  language_detected?: string;
  audio_duration_seconds?: number;
  transcription_time_seconds?: number;
  segments_count?: number;
  llm_model?: string;
  llm_processing_time_seconds?: number;
  tasks_extracted_count?: number;
  total_pipeline_time_seconds?: number;
  file_size_bytes?: number;
  saved_file_path?: string;
  tasks_saved_to_db?: number;
}

// ---------------------------------------------------------------------------
// Progress Tracking – Response từ GET /api/v1/meetings/{id}/progress
// ---------------------------------------------------------------------------
export type ProgressStatus =
  | "uploading"
  | "transcribing"
  | "summarizing"
  | "completed"
  | "failed"
  | "created"
  | "processing"
  | "unknown"
  | "error";

export interface ProgressData {
  meeting_id: number;
  status: ProgressStatus;
  progress_percent: number;
  current_step_detail: string;
  partial_transcript: string;
}

// ---------------------------------------------------------------------------
// Error response từ Backend
// ---------------------------------------------------------------------------
export interface APIErrorResponse {
  error: string;
  message: string;
  detail: string | null | { message?: string; detail?: string };
}

// ---------------------------------------------------------------------------
// Các state của màn hình ghi âm
// ---------------------------------------------------------------------------
export type RecordingScreenState =
  | "idle"          // Chưa ghi âm
  | "recording"     // Đang ghi âm
  | "processing"    // Đang gửi API và chờ AI
  | "success"       // Đã có kết quả
  | "error";        // Có lỗi

// ---------------------------------------------------------------------------
// Navigation params – thêm meetingStatus để biết cần tải lịch sử hay không
// ---------------------------------------------------------------------------
export type RootStackParamList = {
  Home: undefined;
  Recording: {
    meetingId: number;
    meetingTitle: string;
    meetingStatus?: MeetingStatus; // ✅ truyền status để xử lý xem lại lịch sử
  };
};

// ---------------------------------------------------------------------------
// Cấu hình AI Engine (Google Gemini vs Local AI)
// ---------------------------------------------------------------------------
export interface AIConfigData {
  has_gemini_key: boolean;
  gemini_api_key_masked: string;
  preferred_engine: "gemini" | "local";
  active_engine: "gemini" | "local";
  active_model: string;
  supported_models: string[];
}

// ---------------------------------------------------------------------------
// Typography & Document Studio types
// ---------------------------------------------------------------------------
export type FontFamilyType =
  | "Times New Roman"
  | "Arial"
  | "Roboto"
  | "Georgia"
  | "Tahoma";

export type PaperThemeType = "white" | "sepia" | "dark";

export type TextAlignType = "justify" | "left" | "center";

export type AIRewriteMode =
  | "administrative"
  | "corporate"
  | "news_digest"
  | "concise"
  | "detailed"
  | "custom";

export interface AIRewriteBody {
  mode: AIRewriteMode;
  custom_instruction?: string;
}

