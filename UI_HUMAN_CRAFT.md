# QUY CHUẨN THIẾT KẾ GIAO DIỆN TỰ NHIÊN (HUMAN-CRAFTED UI DESIGN SYSTEM)
## Anti-AI Slop UI Standard – Tuyệt đối không giao diện AI tự động

Tài liệu này định hình phong cách thiết kế sản phẩm phần mềm thương mại cao cấp cho **VietMeeting AI**. Mục tiêu: Giao diện phải toát lên sự đĩnh đạc, chỉn chu, tinh tế và đáng tin cậy như các sản phẩm hàng đầu (Linear, Notion, Apple Pages, Microsoft Word), loại bỏ hoàn toàn các dấu hiệu "AI Slop" (màu tím neon, emoji vô tội vạ, bo góc quá lố, câu từ khoa trương).

---

## 1. NGUYÊN TẮC CỐT LÕI (CORE TENETS)

### 1.1. Zero-Emoji UI Policy (Chính sách Không Emoji trong Giao diện)
- **Quy tắc vàng:** Không sử dụng emoji hệ điều hành (`✨`, `📥`, `🖨️`, `✏️`, `👁️`, `🗑️`, `🏛️`, `💼`, `⚡`, `🔍`, `🎯`, `💾`...) trong bất kỳ nút bấm, nhãn danh mục, thanh công cụ, huy hiệu trạng thái hay thông báo nào.
- **Giải pháp thay thế:** Sử dụng hệ thống **Vector Icon nét mảnh đồng nhất** từ `@expo/vector-icons` (`Feather` hoặc `Ionicons`).
  - Nút ghi âm: `<Feather name="mic" size={16} />`
  - Tải file: `<Feather name="upload" size={16} />`
  - Tải Word: `<Feather name="download" size={16} />`
  - In ấn: `<Feather name="printer" size={16} />`
  - Chỉnh sửa: `<Feather name="edit-3" size={16} />`
  - Xem trước: `<Feather name="eye" size={16} />`
  - Xóa: `<Feather name="trash-2" size={16} />`
  - Cấu hình: `<Feather name="sliders" size={16} />`
  - Tìm kiếm: `<Feather name="search" size={16} />`
  - Lưu trữ: `<Feather name="save" size={16} />`
  - Làm mới / Khôi phục: `<Feather name="rotate-ccw" size={16} />`

---

## 2. BẢNG MÀU TỰ NHIÊN & TRẦM ỔN (SWISS EDITORIAL & LINEAR PALETTE)

### 2.1. Triết lý Màu sắc
- Loại bỏ triệt để dải màu tím neon (`#A855F7`), hồng rực rỡ, hoặc viền xanh lá dạ quang - những màu thường thấy trong các mẫu UI do AI sinh tự động.
- Áp dụng hệ màu trung tính **Neutral Slate / Zinc** kết hợp điểm nhấn **Royal Blue / Navy Hành chính** tạo cảm giác nghiêm cẩn, chuyên nghiệp của cơ quan hành chính nhà nước và doanh nghiệp lớn.

### 2.2. Chi tiết Bảng màu (Hỗ trợ Dark & Light Theme)

| Thành phần | Dark Mode (Than chì sâu) | Light Mode (Văn phòng thanh nhã) |
| :--- | :--- | :--- |
| **Nền ứng dụng (App Canvas)** | `#0C0E12` hoặc `#111318` | `#F8FAFC` hoặc `#F1F5F9` |
| **Bề mặt Thẻ (Card Surface)** | `#161920` (hoặc `#1A1D26`) | `#FFFFFF` |
| **Bề mặt Nâng cao (Elevated Surface)** | `#1F232D` | `#F8FAFC` |
| **Đường viền mảnh (Hairline Border)** | `1px solid #262932` (hoặc `#2D323E`) | `1px solid #E2E8F0` |
| **Chữ chính (Primary Text)** | `#F8FAFC` (Zinc 50) | `#0F172A` (Slate 900) |
| **Chữ phụ (Secondary Text)** | `#94A3B8` (Slate 400) | `#475569` (Slate 600) |
| **Chữ mờ (Muted/Caption)** | `#64748B` (Slate 500) | `#64748B` (Slate 500) |
| **Màu nhấn chính (Primary Accent)** | `#2563EB` (Royal Blue) | `#1D4ED8` (Navy Blue) |
| **Nền nhấn mờ (Accent Subtle)** | `rgba(37, 99, 235, 0.12)` | `rgba(37, 99, 235, 0.08)` |
| **Màu thành công (Success)** | `#10B981` (Emerald) | `#059669` |
| **Màu cảnh báo (Warning)** | `#F59E0B` (Amber) | `#D97706` |
| **Màu lỗi / Hủy (Danger)** | `#EF4444` (Rose Red) | `#DC2626` |

### 2.3. Quy chuẩn Bo góc & Đổ bóng (Border Radius & Shadow)
- **Bo góc vừa phải:** `borderRadius: 8` hoặc `10` đối với nút bấm và thẻ phụ; `borderRadius: 12` đối với thẻ lớn. Tránh dùng góc bo tròn quá đà 20-24px tạo cảm giác đồ chơi.
- **Đổ bóng mờ tự nhiên (Subtle Elevation):**
  - Card: `shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 3` (Dark mode dùng hairline border thay cho bóng đậm).
  - Tờ giấy A4: `shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 16`.

---

## 3. PHÂN CẤP THỊ GIÁC & TYPOGRAPHY (TYPOGRAPHIC HIERARCHY)

- **Trọng số phông chữ (Font Weight):** Giữ độ đậm vừa phải (`500` cho nội dung thông thường, `600` cho tiêu đề nhóm, tối đa `700` cho tiêu đề chính). Tránh dùng `800` hay `900` dày đặc.
- **Khoảng cách chữ (Letter Spacing):**
  - Tiêu đề mục hoặc nhãn viết hoa: `letterSpacing: 0.5` hoặc `1.0` với cỡ chữ `11px` hoặc `12px`.
  - Tiêu đề chính: `letterSpacing: -0.3` để tạo cảm giác gắn kết, hiện đại.
- **Số liệu dạng bảng (Tabular Numerals):** Mọi vị trí hiển thị thời gian (`00:00`), số thứ tự văn bản, ID cuộc họp, phần trăm tiến trình phải dùng `fontVariant: ['tabular-nums']` để các con số không bị nhảy vị trí khi thay đổi.

---

## 4. KHUNG BIÊN TẬP VĂN BẢN CHUẨN OFFICE (OFFICE-GRADE EDITOR)

### 4.1. Thanh công cụ Ribbon thu gọn (Ribbon Bar)
- Bố trí theo hàng ngang chặt chẽ, chia thành các nhóm công cụ rõ ràng bằng đường phân cách mỏng:
  1. **Phông chữ:** `Times New Roman` (Chuẩn Nghị định 30), `Arial`, `Roboto`, `Georgia`.
  2. **Cỡ chữ:** Bước nhảy `11pt`, `12pt`, `13pt` (chuẩn), `14pt`, `16pt` với nút `A-` và `A+`.
  3. **Giãn dòng:** `1.15`, `1.30` (chuẩn văn bản nhà nước), `1.50`.
  4. **Căn lề:** Đều 2 bên (`justify`), Căn trái (`left`), Căn giữa (`center`).
  5. **Văn phong AI:** Segmented Control phẳng lịch thiệp gồm:
     - `Hành chính (NĐ 30)` (icon `<Feather name="file-text" />`)
     - `Doanh nghiệp` (icon `<Feather name="briefcase" />`)
     - `Bản tin / Sự kiện` (icon `<Feather name="calendar" />`)
     - `Tóm tắt 1 trang` (icon `<Feather name="minimize-2" />`)
     - `Tùy biến` (icon `<Feather name="sliders" />`)

### 4.2. Khung Trang Giấy A4 (A4 Paper Surface)
- Tỷ lệ khung nhìn mô phỏng trang A4 tiêu chuẩn (chiều rộng tối đa 820px, canh giữa màn hình).
- Lề giấy chuẩn mực: Lề trái rộng rãi cho việc đóng dấu/ghim bấm, lề trên dưới cân đối.
- Quốc hiệu, Tiêu ngữ và Tên cơ quan ban hành được căn chỉnh 2 cột chuẩn thể thức văn bản hành chính Việt Nam.
- Bảng phân công nhiệm vụ kẻ viền mảnh 1px, tiêu đề cột màu nền xám nhẹ thanh lịch.

---

## 5. BẢNG ĐIỀU KHIỂN THU ÂM CHUYÊN NGHIỆP (STUDIO-GRADE RECORDER)

### 5.1. Thiết kế phong cách Thiết bị Thu âm Chuyên dụng (Sony/Zoom Recorder)
- Màn hình hiển thị thời gian số lớn, sắc sảo, dùng `tabular-nums`.
- Chỉ báo trạng thái nhỏ gọn: Chấm đèn LED tín hiệu thu âm (`#EF4444` khi thu, `#10B981` khi sẵn sàng).
- Cặp nút điều khiển cân đối: Nút Thu âm chính và Nút Tải tệp âm thanh có sẵn với kích thước cân xứng, bố cục gọn gàng.

### 5.2. Tiến trình Xử lý Kỹ thuật (Technical Stepper)
- Không dùng từ ngữ cảm thán hoặc khoa trương (bỏ "siêu nhanh", "thần tốc", "phép màu").
- Hiển thị danh sách bước kỹ thuật rõ ràng:
  - `Bước 1: Bóc băng âm thanh (faster-whisper / Gemini STT)`
  - `Bước 2: Cấu trúc hóa biên bản & Trích xuất nhiệm vụ (Gemini Engine)`
- Vòng xoay tiến độ mảnh mai kết hợp thanh tỷ lệ phần trăm tối giản.

---

## 6. NGÔN NGỮ CHUẨN NGHIỆP VỤ VĂN PHÒNG VIỆT NAM

Rà soát và thay thế toàn bộ từ ngữ dịch thô thành ngôn từ công sở chuẩn mực:

| Thuật ngữ cũ / AI dịch | Thuật ngữ chuẩn xác nghiệp vụ |
| :--- | :--- |
| Action Items / Công việc | **Bảng phân công nhiệm vụ** |
| Minutes / Tóm tắt cuộc họp | **Biên bản cuộc họp** |
| Raw Transcript | **Bản gỡ băng gốc** |
| Upload audio file | **Tải lên tệp ghi âm** |
| Create meeting | **Tạo biên bản mới** |
| Meeting list | **Danh sách cuộc họp** |
| Export Word (.doc) | **Xuất tệp Word (.doc)** |
| Rewrite mode | **Phong cách văn bản** |
| Administrative Decree 30 | **Hành chính (Nghị định 30/2020/NĐ-CP)** |

