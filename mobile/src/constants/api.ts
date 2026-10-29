/**
 * src/constants/api.ts
 *
 * Cấu hình tập trung cho mọi lời gọi API đến FastAPI Backend.
 *
 * ✅ Platform detection tự động:
 *   - Web (Expo Web / Laptop): → http://localhost:8000 (nhanh nhất, không lo đổi IP)
 *   - Mobile (iOS/Android):    → http://<LAN_IP>:8000 (điện thoại cần IP LAN)
 */

import { Platform } from "react-native";

// ✏️ CHỈ cần đổi giá trị này khi dùng Mobile trên điện thoại
export const BACKEND_IP = "192.168.1.7";
export const BACKEND_PORT = 8000;

// ✅ FIX: Web luôn dùng localhost → không sợ đổi WiFi khi mang laptop đi báo cáo
export const BASE_URL =
  Platform.OS === "web"
    ? `http://localhost:${BACKEND_PORT}`
    : `http://${BACKEND_IP}:${BACKEND_PORT}`;

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
} as const;

/** Timeout dài cho AI processing (15 phút – file 1 tiếng) */
export const API_TIMEOUT_MS = 15 * 60 * 1000;

/** Timeout ngắn cho các request thông thường (không phải AI) */
export const API_TIMEOUT_SHORT_MS = 15 * 1000;

/** Interval polling progress (1.5 giây) */
export const PROGRESS_POLL_INTERVAL_MS = 1500;
