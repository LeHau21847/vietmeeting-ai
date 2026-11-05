/**
 * src/constants/api.ts
 *
 * Cấu hình tập trung cho mọi lời gọi API đến FastAPI Backend.
 *
 * ✅ Platform & Network detection tự động (Bất tử kết nối IPv4 & Web):
 *   - Web (Expo Web / Laptop): Tự động phát hiện window.location.hostname.
 *     Khi chạy trên localhost, ưu tiên dùng 127.0.0.1 để tránh lỗi phân giải IPv6 ::1 trên Windows.
 *   - Mobile (iOS/Android): Dùng IP mạng LAN nội bộ (hoặc IP cấu hình).
 */

import { Platform } from "react-native";

export const BACKEND_IP = "192.168.1.7";
export const BACKEND_PORT = 8000;

/**
 * Tự động xác định URL Backend tối ưu nhất:
 * Trên Web: Nếu đang chạy trên localhost hoặc 127.0.0.1, ép dùng 127.0.0.1
 * để chắc chắn kết nối tới socket IPv4 của uvicorn 0.0.0.0.
 */
/**
 * Tự động xác định URL Backend tối ưu nhất:
 * - Khi chạy hợp nhất trên cùng cổng 8000 (Local hoặc Public Cloudflare HTTPS):
 *   Dùng chính window.location.origin để gọi thẳng API trên cùng host/port.
 * - Khi chạy qua Expo Dev Server (port 8081 / 19006):
 *   Gọi tới cổng 8000 của máy chủ backend.
 */
function resolveBackendBaseUrl(): string {
  if (Platform.OS === "web") {
    try {
      if (typeof window !== "undefined" && window.location) {
        const { protocol, hostname, origin, port } = window.location;

        // 1. Khi chạy trực tiếp trên cùng server Backend (cổng 8000) hoặc qua HTTPS/Cloudflare Tunnel:
        // Dùng chính origin để đảm bảo Same-Origin 100%, tuyệt đối không bị lỗi CORS/PNA/sai IP.
        if (
          port === String(BACKEND_PORT) ||
          protocol === "https:" ||
          (hostname &&
            hostname.includes(".") &&
            !hostname.startsWith("192.168.") &&
            !hostname.startsWith("10.") &&
            !hostname.startsWith("172.") &&
            !hostname.startsWith("127."))
        ) {
          return origin;
        }

        // 2. Khi chạy qua Expo Dev Server (cổng 8081 / 19006):
        // Trỏ về cổng 8000 với cùng hostname đang truy cập
        if (hostname) {
          return `${protocol}//${hostname}:${BACKEND_PORT}`;
        }
        return `http://127.0.0.1:${BACKEND_PORT}`;
      }
    } catch {
      // Fallback nếu window chưa sẵn sàng
    }
    return `http://127.0.0.1:${BACKEND_PORT}`;
  }
  return `http://${BACKEND_IP}:${BACKEND_PORT}`;
}

export const BASE_URL = resolveBackendBaseUrl();

export const API_ENDPOINTS = {
  /** POST – Tạo cuộc họp mới, body: { title, description? } */
  createMeeting: `${BASE_URL}/api/v1/meetings`,

  /** GET – Danh sách cuộc họp */
  listMeetings: `${BASE_URL}/api/v1/meetings`,

  /** GET – Chi tiết một cuộc họp (bao gồm transcript, biên bản, tasks) */
  getMeeting: (meetingId: number) =>
    `${BASE_URL}/api/v1/meetings/${meetingId}`,

  /** DELETE – Xóa một cuộc họp */
  deleteMeeting: (meetingId: number) =>
    `${BASE_URL}/api/v1/meetings/${meetingId}`,

  /** POST – Upload audio và xử lý AI cho một meeting */
  processAudio: (meetingId: number) =>
    `${BASE_URL}/api/v1/audio/${meetingId}/process`,

  /** GET – Polling tiến trình xử lý AI real-time (mỗi 1.5s) */
  getProgress: (meetingId: number) =>
    `${BASE_URL}/api/v1/meetings/${meetingId}/progress`,

  /** PATCH – Cập nhật trạng thái task (pending ↔ done) */
  updateTask: (taskId: number) =>
    `${BASE_URL}/api/v1/tasks/${taskId}`,

  /** GET – Kiểm tra backend có sống không */
  health: `${BASE_URL}/health`,

  /** GET/POST – Cấu hình Google Gemini API Key & Engine */
  aiConfig: `${BASE_URL}/api/v1/ai-config`,

  /** POST – AI Tái cấu trúc & Biên tập văn bản theo nhiều phong cách */
  aiRewrite: (meetingId: number) =>
    `${BASE_URL}/api/v1/meetings/${meetingId}/ai-rewrite`,

  /** GET – Xuất file Word (.doc) chuẩn thể thức */
  exportDoc: (meetingId: number) =>
    `${BASE_URL}/api/v1/meetings/${meetingId}/export-doc`,

  /** POST – Trợ lý hỏi đáp thông minh với nội dung cuộc họp (Meeting Copilot) */
  askMeeting: (meetingId: number) =>
    `${BASE_URL}/api/v1/meetings/${meetingId}/ask`,
} as const;

/** Timeout dài cho AI processing (15 phút – file 1 tiếng) */
export const API_TIMEOUT_MS = 15 * 60 * 1000;

/** Timeout ngắn cho các request thông thường (không phải AI) */
export const API_TIMEOUT_SHORT_MS = 15 * 1000;

/** Interval polling progress (1.5 giây) */
export const PROGRESS_POLL_INTERVAL_MS = 1500;
