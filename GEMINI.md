# BỘ QUY CHUẨN KỸ THUẬT & KIẾN TRÚC DỰ ÁN (VIETMEETING AI)

Tài liệu quy chuẩn kỹ thuật và định hướng kiến trúc cố định cho toàn bộ dự án **VietMeeting AI**. Mọi tác vụ lập trình (cả Backend và Frontend) phải tuân thủ nghiêm ngặt các nguyên tắc dưới đây.

---

## 1. 4 NGUYÊN TẮC CỐT LÕI (CORE PRINCIPLES)

### 1.1. Think Before Coding (Smart Autonomous)
- **Kiểm tra trước khi viết:** Luôn đọc và nắm vững cấu trúc file hiện có, kiểu dữ liệu (`types`), và các luồng phụ thuộc trước khi sửa đổi.
- **Ưu tiên giải pháp tối giản:** Tránh các giải pháp cồng kềnh hoặc cài thêm thư viện bên ngoài không cần thiết.
- **Tự chủ kỹ thuật (Auto-Pilot):** Khi thực thi ở chế độ tự động, chủ động đưa ra quyết định kỹ thuật an toàn nhất dựa trên nền tảng kiến trúc sẵn có thay vì dừng lại hỏi các chi tiết nhỏ.

### 1.2. Simplicity First
- **Lượng code tối thiểu:** Viết lượng code tối thiểu giải quyết trọn vẹn và tin cậy bài toán được giao.
- **Không suy diễn tương lai:** Tuyệt đối không tạo abstraction thừa thãi, không thiết kế tính năng vượt ngoài yêu cầu hiện tại, không bổ sung cấu hình/tham số không cần thiết.
- **Dễ đọc và bảo trì:** Nếu một hàm có thể viết trong 40 dòng rõ ràng, không kéo dài thành 150 dòng với các lớp trung gian.

### 1.3. Surgical Changes
- **Sửa đúng điểm cần can thiệp:** Chỉ chạm vào đúng vùng code trực tiếp phục vụ yêu cầu. Không tự ý định dạng lại code xung quanh, không đổi cấu trúc các khối code đang chạy ổn định.
- **Bảo toàn các luồng nghiệp vụ cốt lõi:**
  - Gemini File API & Google Gemini Multimodal Audio processing.
  - Local AI fallback (`faster-whisper` int8 & Ollama `qwen2.5:1.5b`).
  - Giao dịch cơ sở dữ liệu SQLite (`db.commit()`, session rollback).
  - Xuất văn bản Word chuẩn thể thức hành chính (`.doc`).
- **Tự dọn dẹp:** Loại bỏ toàn bộ import, biến, kiểu dữ liệu mồ côi do chính thay đổi của mình tạo ra. Không xóa code cũ không liên quan.

### 1.4. Goal-Driven Execution
- **Tiêu chuẩn nghiệm thu định lượng:** Mọi thay đổi phải được kiểm chứng tự động:
  - Backend: `python -m py_compile <file.py>` (0 lỗi cú pháp).
  - Frontend: `npx tsc --noEmit` tại thư mục `mobile` (0 lỗi TypeScript).
- **Vòng lặp tự kiểm tra:** Nếu xuất hiện lỗi biên dịch hoặc kiểu dữ liệu, tự động khắc phục ngay lập tức trước khi bàn giao cho người dùng.

---

## 2. KIẾN TRÚC CỐ ĐỊNH CỦA DỰ ÁN (PROJECT CONTEXT)

### 2.1. Backend Architecture
- **Framework:** FastAPI, Uvicorn, Python 3.12 (môi trường ảo `e:\PTUD\venv`).
- **Cơ sở dữ liệu:** SQLite (`vietmeeting.db`) với schema gồm bảng cuộc họp (`meetings`), công việc (`tasks`), và trạng thái tiến trình xử lý thời gian thực (`progress_tracker`).
- **Hybrid AI Engine:**
  - **Chủ lực (Cloud Primary):** Google Gemini Multimodal Audio thông qua `GEMINI_API_KEY` (Gemini 2.5/Flash), xử lý trực tiếp file âm thanh cuộc họp dài, bóc băng tiếng Việt chuẩn xác và cấu trúc hóa biên bản theo Nghị định 30.
  - **Dự phòng nội bộ (Local Offline Fallback):** `faster-whisper` (chạy định dạng int8 trên CPU/GPU local kết hợp Silero VAD) kết hợp Ollama `qwen2.5:1.5b` theo chiến lược Map-Reduce chunking xử lý âm thanh không giới hạn thời lượng.
  - **AI Text Studio:** Endpoint `POST /api/v1/meetings/{id}/ai-rewrite` hỗ trợ tái cấu trúc văn phong biên bản: Hành chính Nghị định 30, Doanh nghiệp, Tóm tắt báo cáo, Tin tức sự kiện, hoặc lệnh tùy biến.

### 2.2. Frontend Architecture
- **Framework:** Expo React Native & Expo Web (`e:\PTUD\mobile`), TypeScript, React 18, `@expo/vector-icons` (`Feather`, `Ionicons`).
- **Styling:** StyleSheet kết hợp NativeWind/Tailwind.
- **Cấu trúc Thư mục:**
  - `src/screens/HomeScreen.tsx`: Bảng điều khiển quản lý danh sách cuộc họp, tìm kiếm, lọc trạng thái, KPI Bento, chuyển đổi giao diện Sáng/Tối.
  - `src/screens/RecordingScreen.tsx`: AI Studio gồm máy ghi âm số chuyên nghiệp (Sony/Zoom Recorder style), thanh Ribbon định dạng văn bản chuẩn Office, xem trang giấy A4 trực quan, bảng công việc và bản gỡ băng chi tiết.
  - `src/components/AIConfigModal.tsx`: Modal quản lý và chuyển đổi nhanh Cloud Gemini API Key / Local Offline AI.
  - `src/constants/api.ts`: Danh mục endpoint và cấu hình timeout mạng.
  - `src/types/meeting.ts`: Bộ định nghĩa kiểu dữ liệu đồng bộ giữa Frontend và Backend.

---

## 3. TIÊU CHUẨN GIAO DIỆN (UI/UX HUMAN-CRAFTED STANDARDS)
- Tuân thủ bộ quy tắc chi tiết trong `e:\PTUD\UI_HUMAN_CRAFT.md`.
- **Zero-Emoji UI Policy:** 100% icon trên nút bấm, tiêu đề, thanh công cụ sử dụng vector icon nét mảnh (`Feather` hoặc `Ionicons`), tuyệt đối không dùng emoji hệ điều hành trong giao diện ứng dụng.
- **Bảng màu:** Neutral Slate / Zinc tinh tế, màu nhấn Royal Blue / Navy chuyên nghiệp, loại bỏ màu neon tím/xanh lá chói lóa.
- **Văn bản chuẩn nghiệp vụ:** Sử dụng thuật ngữ hành chính văn phòng tiếng Việt chuẩn mực.
