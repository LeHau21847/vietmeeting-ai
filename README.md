# 🎙️ VietMeeting AI - Trợ Lý Thư Ký Họp & Biên Tập Văn Bản Thông Minh

Hệ thống ghi âm cuộc họp, bóc băng tự động bằng AI, trích xuất biên bản họp chuẩn thể thức Nghị định 30/2020/NĐ-CP và phân công nhiệm vụ tự động.

---

## 🌟 Tính Năng Nổi Bật

1. **Ghi Âm & Bóc Băng Tức Thì (Real-time Speech-to-Text)**: Hỗ trợ ghi âm trực tiếp qua mic hoặc tải lên các định dạng âm thanh phổ biến (`.mp3`, `.wav`, `.m4a`, `.webm`).
2. **Đa Động Cơ AI (Dual AI Engine)**:
   - **Google Gemini Cloud AI**: Tốc độ xử lý siêu tốc (10-20 giây cho file âm thanh dài), bóc tách chuẩn xác tiếng Việt.
   - **Local AI (Offline Fallback)**: Tự động dự phòng khi mất kết nối mạng.
3. **Typography & Formatting Toolbar**:
   - Tùy chỉnh phông chữ chuẩn tiếng Việt: `Times New Roman` (Chuẩn NĐ 30), `Arial`, `Roboto`, `Georgia`, `Tahoma`.
   - Cỡ chữ `A-` / `A+` và chọn nhanh: `11pt`, `12pt`, `13pt`, `14pt`, `15pt`, `16pt`.
   - Giãn dòng: `1.15`, `1.30 (Chuẩn)`, `1.50`, `1.80`.
   - Chế độ màu trang giấy: `📄 Giấy Trắng A4`, `📜 Giấy Ngà Sepia`, `🌙 Tối Studio`.
4. **AI Text Studio**:
   - Biến đổi văn bản biên bản theo nhiều phong cách: `🏛️ Hành chính Chuẩn`, `💼 Doanh nghiệp / Dự án`, `📰 Bản tin / Sự kiện`, `⚡ Tóm tắt 1-Trang`, `🔍 Phân tích Chi tiết`.
   - Tùy biến câu lệnh riêng bằng ô nhập lệnh AI.
5. **Tìm Kiếm Từ Khóa Trong Bản Gỡ Băng**:
   - Tìm kiếm từ khóa theo thời gian thực với hiệu ứng tô sáng màu vàng nổi bật kèm bộ đếm số lần xuất hiện.
   - Cho phép chỉnh sửa và lưu trực tiếp bản gỡ băng.
6. **Đồng Bộ Xuất File Word (`.doc`) & In PDF**:
   - Tải file Word giữ nguyên 100% phông chữ, cỡ chữ, căn lề và định dạng bảng biểu như trên màn hình.

---

## 🚀 Hướng Dẫn Cài Đặt & Chạy Dự Án

### 1. Cấu hình Backend (Python FastAPI)

```bash
# 1. Kích hoạt môi trường ảo Python
venv\Scripts\activate   # Trên Windows
# hoặc: source venv/bin/activate  # Trên macOS/Linux

# 2. Cài đặt các thư viện cần thiết
pip install -r requirements.txt

# 3. Tạo file .env từ file mẫu
copy .env.example .env

# 4. Chạy Backend Server (Cổng 8000)
python main.py
```
> Backend API Swagger Docs có sẵn tại: `http://localhost:8000/docs`

### 2. Cấu hình Frontend (Expo React Native / Web)

```bash
# 1. Di chuyển vào thư mục mobile
cd mobile

# 2. Cài đặt dependencies (nếu chưa có)
npm install

# 3. Khởi chạy giao diện Web (Cổng 8081)
npx expo start --web
```
> Mở trình duyệt tại: `http://localhost:8081`

---

## 🔒 Bản Quyền & Quyền Truy Cập
* Dự án này được quản lý và sở hữu bởi **LeHau21847**.
* Người xem được cấp quyền clone về máy cá nhân để tham khảo, kiểm thử và chạy thử nghiệm.
* Mọi hành vi sửa đổi trực tiếp lên nhánh chính (`main`) đều bị hạn chế để đảm bảo tính toàn vẹn của mã nguồn.
