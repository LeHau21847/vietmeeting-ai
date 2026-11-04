# MEETING INTELLIGENCE SKILL (VIETMEETING AI)

Tài liệu quy chuẩn chuyên môn và mẫu thiết kế trải nghiệm người dùng (Design & Domain Patterns) cao cấp dành riêng cho hệ thống **VietMeeting AI**. Tổng hợp từ tinh hoa của **Linear, Granola.ai, Otter.ai, Google NotebookLM** và **Hệ thống Quản lý Văn bản & Điều hành (E-Office Hành chính Việt Nam)**.

---

## 1. HIGH-DENSITY SCANNABLE ROW (LINEAR PATTERN)

Mỗi dòng cuộc họp trong danh sách (Meeting Row) không đơn thuần là một liên kết điều hướng, mà là một đơn vị thông tin mật độ cao (High-Density Information Unit), cho phép lãnh đạo và chuyên viên quét nhanh toàn bộ bức tranh cuộc họp chỉ trong 2 giây mà không cần bấm mở chi tiết:

### Cấu trúc 4 lớp thông tin trên một mặt phẳng:
1. **Lớp Nhận diện & Trích yếu (Primary Layer):**
   - Icon trạng thái phiên bản vector (`Feather` nét mảnh: `mic`, `loader`, `check-circle`, `alert-circle`).
   - Tiêu đề cuộc họp chuẩn thể thức hành chính (Semi-bold, 14px, màu Slate-900 / Slate-100).
   - Tóm tắt 1 dòng (`summary_snippet`): Trích xuất 120-140 ký tự phản ánh trực tiếp nội dung trọng tâm hoặc chỉ đạo cốt lõi của cuộc họp.
2. **Lớp Định danh & Thời gian (Metadata Layer):**
   - Mã số định danh biên bản (`#0001/BB-CH`).
   - Mốc thời gian chính xác theo chuẩn hành chính (`DD/MM/YYYY · HH:MM`).
   - Huy hiệu trạng thái xử lý AI dạng pill badge với màu sắc quy chuẩn (Đã có biên bản, Đang xử lý, Chờ ghi âm).
3. **Lớp Tiến độ Nhiệm vụ (Mini Progress Badge):**
   - Hiển thị chỉ số hoàn thành công việc phát sinh từ cuộc họp: `[✓ completed/total]`.
   - Phân màu trực quan: Xanh lá (`#10B981`) khi hoàn thành 100%, Xanh dương (`#2563EB`) khi đang triển khai, Xám trung tính khi chưa có task.
4. **Lớp Thao tác Nhanh 1-Click (Fast Action Hub):**
   - Nút **Xem biên bản / Chi tiết** (chuyển vào AI Studio).
   - Nút **Tải nhanh Word (.doc)**: Tải trực tiếp file biên bản hoàn chỉnh chuẩn Nghị định 30/2020/NĐ-CP mà không cần vào trang soạn thảo.
   - Nút **Xóa cuộc họp** với hộp thoại xác nhận bảo vệ an toàn dữ liệu.

---

## 2. CROSS-MEETING ACTION CENTER (OTTER.AI & E-OFFICE PATTERN)

Thay vì chỉ nhìn thấy danh sách các tệp biên bản rời rạc, giao diện làm việc tối ưu cần kết nối luồng công việc xuyên suốt (Cross-meeting Task Tracking):

### Bố cục 2 cột điều hành (Desktop 70% - 30%):
- **Cột Trái (70% - Meeting Central):**
  - Thanh tìm kiếm tức thời theo từ khóa tiêu đề hoặc nội dung.
  - Bộ lọc trạng thái (Tất cả, Đã xong, Chờ ghi âm, Đang xử lý).
  - Danh sách cuộc họp theo chuẩn Scannable Row.
- **Cột Phải (30% - Executive Action Center):**
  - **1-Click Audio Meeting Creator:** Khu vực thả/chọn file âm thanh ghi sẵn (`.mp3`, `.wav`, `.m4a`, `.aac`) để tạo nhanh cuộc họp và tự động khởi động AI xử lý ngay lập tức.
  - **Urgent Action Items (Nhiệm vụ trọng tâm cần xử lý):** Trích xuất danh sách các đầu việc đang ở trạng thái `pending` hoặc `in_progress` từ các cuộc họp gần nhất, hiển thị tên đơn vị phụ trách và deadline.

---

## 3. GROUNDED MEETING Q&A COPILOT (NOTEBOOKLM PATTERN)

Trợ lý ảo hỏi đáp chuyên sâu (Meeting Copilot) tích hợp trực tiếp trong phòng làm việc của từng cuộc họp:

### Nguyên tắc Vận hành (Grounding Principles):
1. **100% Trung thực với Dữ liệu Gốc (Zero Hallucination):**
   - AI chỉ được phép suy luận và trả lời dựa trên 3 nguồn dữ liệu: `raw_transcript` (bản gỡ băng âm thanh), `final_minutes` (biên bản đã duyệt), và `tasks` (danh sách công việc) của chính cuộc họp hiện tại.
   - Nếu thông tin người dùng hỏi không xuất hiện trong biên bản hoặc bản ghi, AI phải nói rõ một cách lịch sự thay vì bịa đặt số liệu.
2. **Gợi ý Nhanh (Smart Prompt Chips):**
   - "Tóm tắt 3 kết luận quan trọng nhất?"
   - "Ai được giao những việc gì và hạn chót khi nào?"
   - "Có nội dung nào bất đồng ý kiến hoặc cần xin ý kiến cấp trên?"
3. **Định dạng Phản hồi Chuyên nghiệp:**
   - Sử dụng gạch đầu dòng rõ ràng, làm nổi bật nhân sự và mốc thời gian.
   - Cung cấp nút sao chép câu trả lời vào clipboard chỉ bằng 1 cú nhấp chuột.
