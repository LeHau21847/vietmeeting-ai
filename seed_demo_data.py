#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
seed_demo_data.py – Nạp dữ liệu mẫu chất lượng cao phục vụ báo cáo / demo VietMeeting AI
Tuân thủ chuẩn thể thức hành chính Nghị định 30/2020/NĐ-CP và hệ thống bảng công việc.
Đồng bộ chuẩn SQLAlchemy Enum Name trong SQLite (COMPLETED, PENDING, IN_PROGRESS, DONE).
Không xóa bất kỳ cuộc họp nào đã tạo trước đó.
"""

import sys
import sqlite3
from datetime import datetime

# Đảm bảo in tiếng Việt chuẩn trên Windows
if sys.platform == "win32" and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

DB_PATH = "vietmeeting.db"

MEETING_1_TITLE = "Họp giao ban đánh giá tiến độ Chuyển đổi số & Triển khai phần mềm Quý IV/2026"
MEETING_1_DESC = "Đánh giá toàn diện tiến độ số hóa tài liệu, tích hợp hệ thống ký số điện tử và ứng dụng trợ lý ảo VietMeeting AI vào quy trình xử lý văn bản nội bộ."

MEETING_1_TRANSCRIPT = """[00:00:05] Đ/c Nguyễn Văn An (Chủ trì): Kính thưa các đồng chí lãnh đạo phòng, ban và toàn thể thành viên tham dự cuộc họp. Hôm nay chúng ta tổ chức phiên họp giao ban chuyên đề đánh giá tiến độ thực hiện Đề án Chuyển đổi số và triển khai các phần mềm nghiệp vụ trong Quý IV/2026.
[00:00:32] Đ/c Lê Hoàng Nam (Cục CNTT): Kính báo cáo đồng chí Chủ trì, về tiến độ số hóa hồ sơ giai đoạn 1 đã hoàn thành 92% khối lượng công việc. Đối với phần mềm Trợ lý ảo VietMeeting AI, đơn vị đã thử nghiệm thành công việc bóc băng âm thanh cuộc họp trực tiếp bằng mô hình kết hợp Multimodal Audio và faster-whisper chạy nội bộ. Tỷ lệ chính xác tiếng Việt đạt trên 98%, giảm 70% thời gian tổng hợp biên bản của thư ký.
[00:01:15] Đ/c Trần Thị Mai (Thư ký): Thưa đồng chí, về phía Văn phòng, các chuyên viên đánh giá rất cao tính năng xuất biên bản chuẩn thể thức Nghị định 30/2020/NĐ-CP ra tệp Word. Tuy nhiên, đề nghị bổ sung thêm hướng dẫn phân công nhiệm vụ tự động để các phòng ban tiếp nhận đầu việc nhanh hơn.
[00:01:48] Đ/c Phạm Quốc Huy (Ban ATTT): Báo cáo đồng chí Chủ trì, về mặt an toàn thông tin, hệ thống cơ sở dữ liệu cuộc họp hiện lưu trữ cục bộ trên máy chủ SQLite nội bộ và mã hóa đường truyền. Chúng tôi đã lên kế hoạch kiểm tra đánh giá an toàn thông tin cấp độ 3 trong tháng 11/2026.
[00:02:20] Đ/c Nguyễn Văn An (Chủ trì): Tôi đánh giá cao nỗ lực của Cục CNTT và Văn phòng. Về phương hướng tới: Yêu cầu Cục CNTT hoàn thiện quy chế sử dụng phần mềm trước 15/11. Phòng Quản trị nâng cấp năng lực máy chủ trước 20/11. Văn phòng tổ chức tập huấn toàn diện cho chuyên viên trước 25/11. Ban ATTT hoàn tất kiểm thử trước 30/11. Đề nghị các đồng chí nghiêm túc thực hiện."""

MEETING_1_MINUTES = """I. BỐI CẢNH VÀ NỘI DUNG CHỈ ĐẠO CHUNG
Cuộc họp giao ban chuyên đề đánh giá tiến độ thực hiện Đề án Chuyển đổi số và ứng dụng Trợ lý ảo VietMeeting AI trong toàn cơ quan được tổ chức ngày 03/11/2026 dưới sự chủ trì của đồng chí Lãnh đạo cơ quan. Cuộc họp ghi nhận những kết quả tích cực trong việc ứng dụng công nghệ AI vào quy trình hành chính, đặc biệt là việc tự động hóa bóc băng ghi âm và cấu trúc biên bản họp theo Nghị định số 30/2020/NĐ-CP.

II. KẾT QUẢ THỰC HIỆN VÀ TIẾN ĐỘ CÔNG TÁC
1. Tiến độ số hóa hồ sơ tài liệu:
- Giai đoạn 1 đã số hóa thành công 92% khối lượng tài liệu lưu trữ, đảm bảo đúng quy chuẩn định dạng và siêu dữ liệu (metadata).
- Đang tiến hành đồng bộ dữ liệu vào kho lưu trữ số tập trung để phục vụ tra cứu tức thời.

2. Triển khai phần mềm Trợ lý ảo VietMeeting AI:
- Thử nghiệm bóc băng tiếng Việt trực tiếp đạt độ chính xác trên 98% nhờ cơ chế Hybrid AI (Google Gemini Multimodal Audio kết hợp Whisper int8 nội bộ).
- Khả năng xử lý tự động tệp âm thanh dài trên 60 phút, tự động phân chia bố cục biên bản 3 mục chuẩn mực và trích xuất bảng phân công nhiệm vụ cụ thể.
- Tính năng xuất tệp Word (.doc) giữ nguyên 100% định dạng, phông chữ Times New Roman cỡ 13pt và giãn dòng 1.3 theo đúng Nghị định 30.

3. Công tác bảo đảm an toàn thông tin:
- Hệ thống hoạt động độc lập trên hạ tầng nội bộ, dữ liệu ghi âm và biên bản được bảo mật nghiêm ngặt.
- Ban An toàn Thông tin đã lập phương án kiểm tra, đánh giá an toàn hệ thống cấp độ 3.

III. KẾT LUẬN VÀ CHỈ ĐẠO CỦA ĐỒNG CHÍ CHỦ TRÌ
- Biểu dương tinh thần chủ động, sáng tạo của Cục Công nghệ thông tin và Văn phòng trong việc đưa AI vào ứng dụng thực tiễn.
- Yêu cầu các đơn vị trực thuộc khẩn trương phối hợp hoàn thành các mốc nhiệm vụ đã phân công để chính thức đưa phần mềm vào vận hành đồng bộ."""

MEETING_1_TASKS = [
    {
        "title": "Hoàn thiện quy chế quản lý và sử dụng trợ lý ảo VietMeeting AI",
        "description": "Soạn thảo dự thảo quy chế khai thác, phân quyền tài khoản và trình Lãnh đạo phê duyệt ban hành.",
        "status": "DONE",
        "due_date": "2026-11-15 17:00:00",
        "assignee_name": "Cục CNTT - Đ/c Lê Hoàng Nam",
    },
    {
        "title": "Nâng cấp cụm máy chủ xử lý AI nội bộ phục vụ bóc băng cuộc họp",
        "description": "Bổ sung tài nguyên GPU và bộ nhớ RAM để đảm bảo năng lực xử lý đồng thời nhiều phiên họp.",
        "status": "IN_PROGRESS",
        "due_date": "2026-11-20 17:00:00",
        "assignee_name": "Phòng Quản trị Hạ tầng",
    },
    {
        "title": "Tổ chức tập huấn sử dụng tính năng xuất biên bản chuẩn Nghị định 30",
        "description": "Hướng dẫn thực hành trực tiếp cho 100% chuyên viên tổng hợp và thư ký các phòng ban.",
        "status": "PENDING",
        "due_date": "2026-11-25 17:00:00",
        "assignee_name": "Văn phòng Cơ quan",
    },
    {
        "title": "Kiểm tra đánh giá an toàn thông tin cấp độ 3 cho hệ thống cuộc họp",
        "description": "Rà quét lỗ hổng bảo mật, kiểm thử mã độc và lập hồ sơ đề xuất phê duyệt cấp độ an toàn.",
        "status": "PENDING",
        "due_date": "2026-11-30 17:00:00",
        "assignee_name": "Ban An toàn Thông tin",
    },
    {
        "title": "Tích hợp chữ ký số cá nhân và chứng thư số tổ chức vào tệp văn bản .doc",
        "description": "Phối hợp với Ban Cơ yếu Chính phủ để tích hợp module ký số điện tử trực tiếp trên web.",
        "status": "PENDING",
        "due_date": "2026-12-05 17:00:00",
        "assignee_name": "Trung tâm Dịch vụ Công nghệ",
    },
    {
        "title": "Báo cáo tổng kết hiệu quả tiết kiệm thời gian lập biên bản tháng 11/2026",
        "description": "Đo lường thời gian thực tế giảm được của cán bộ thư ký sau khi đưa phần mềm vào ứng dụng.",
        "status": "PENDING",
        "due_date": "2026-12-10 17:00:00",
        "assignee_name": "Bộ phận Thư ký Tổng hợp",
    },
]

# ---------------------------------------------------------------------------
# MEETING 2
# ---------------------------------------------------------------------------
MEETING_2_TITLE = "Hội nghị rà soát kế hoạch vận hành hệ thống AI nội bộ và bảo mật dữ liệu"
MEETING_2_DESC = "Rà soát năng lực tính toán GPU nội bộ, quy trình sao lưu định kỳ cơ sở dữ liệu và phân quyền bảo mật biên bản mật/tối mật."

MEETING_2_TRANSCRIPT = """[00:00:02] Đ/c Hoàng Minh Tuấn (Chủ trì Hội nghị): Chào các đồng chí. Hôm nay Hội đồng Công nghệ và Tổ Bảo mật họp để rà soát toàn bộ kế hoạch vận hành hệ thống AI nội bộ và bảo mật dữ liệu phục vụ các phiên họp quan trọng của cơ quan.
[00:00:28] Đ/c Đặng Anh Dũng (Trưởng nhóm AI): Báo cáo Hội đồng, hệ thống Local Offline AI hiện vận hành mô hình faster-whisper định dạng int8 kết hợp Silero VAD trên GPU NVIDIA RTX. Chúng tôi đã thử nghiệm cơ chế Map-Reduce chunking xử lý các file ghi âm dài 90 phút mà không gặp tình trạng tràn bộ nhớ (Out-of-Memory). Thời gian xử lý trung bình đạt 1/4 thời gian thực tế của file âm thanh.
[00:01:05] Đ/c Vũ Hải Yến (Tổ Bảo mật Dữ liệu): Về việc lưu trữ dữ liệu, hiện file vietmeeting.db được đặt tại thư mục bảo vệ. Chúng tôi đề xuất cài đặt lịch sao lưu tự động hàng ngày (cron job) lúc 00:00 sang ổ đĩa mạng dự phòng NAS có mã hóa AES-256.
[00:01:38] Đ/c Nguyễn Quốc Toàn (Phòng Tổ chức - Cán bộ): Đối với các cuộc họp mang tính chất nội bộ nhạy cảm, đề nghị hệ thống cần có tính năng phân quyền: chỉ có lãnh đạo chủ trì và thư ký được cấp quyền mới có thể truy cập nội dung bóc băng gốc.
[00:02:10] Đ/c Hoàng Minh Tuấn (Chủ trì Hội nghị): Nhất trí với các ý kiến đề xuất. Giao Đội Kỹ thuật thiết lập ngay lịch sao lưu dữ liệu tự động trước ngày 12/11. Nhóm AI tối ưu hóa tham số mô hình trước ngày 18/11. Phòng Tổ chức cán bộ xây dựng ma trận phân quyền trước 22/11. Đội QA thử nghiệm tải đồng thời 10 phiên ghi âm trước 28/11. Sau khi hoàn thành các mục trên, Thư ký chuẩn bị hồ sơ trình Lãnh đạo phê duyệt Đề án mở rộng."""

MEETING_2_MINUTES = """I. BỐI CẢNH VÀ NỘI DUNG CHỈ ĐẠO CHUNG
Hội nghị rà soát kế hoạch vận hành hệ thống AI nội bộ và bảo mật dữ liệu được tổ chức dưới sự chủ trì của đồng chí Chủ tịch Hội đồng Công nghệ nhằm đánh giá toàn diện tính sẵn sàng, độ tin cậy và mức độ an toàn của hệ thống VietMeeting AI trước khi triển khai trên diện rộng.

II. NỘI DUNG ĐÁNH GIÁ KỸ THUẬT VÀ BẢO MẬT
1. Năng lực tính toán và hiệu năng của mô hình AI:
- Mô hình faster-whisper int8 kết hợp Silero VAD hoạt động ổn định trên phần cứng nội bộ, giải quyết bài toán xử lý âm thanh không cần phụ thuộc Internet.
- Cơ chế Map-Reduce chunking cho phép phân đoạn và tổng hợp thông minh đối với các tệp âm thanh có độ dài trên 60 phút mà vẫn bảo toàn tính mạch lạc của nội dung.
- Tốc độ xử lý nhanh, đáp ứng tốt yêu cầu trả kết quả biên bản sơ bộ ngay sau khi kết thúc cuộc họp.

2. Quy trình sao lưu và bảo mật cơ sở dữ liệu:
- Thống nhất giải pháp sao lưu tự động (auto-backup) cơ sở dữ liệu SQLite định kỳ vào lúc 00:00 hàng ngày sang hệ thống lưu trữ mạng NAS.
- Toàn bộ tệp bản sao lưu được mã hóa bằng thuật toán tiêu chuẩn nhằm phòng ngừa rủi ro mất mát dữ liệu hoặc thâm nhập trái phép.

3. Cơ chế phân quyền và kiểm soát truy cập:
- Thiết lập quy định phân cấp truy cập biên bản và bản gỡ băng gốc tương ứng với thẩm quyền của từng vị trí cán bộ, công chức.
- Ghi nhật ký hệ thống (audit log) đầy đủ đối với mọi thao tác xem, tải về hoặc chỉnh sửa nội dung biên bản cuộc họp.

III. KẾT LUẬN CỦA CHỦ TRÌ HỘI NGHỊ
- Khẳng định chủ trương tự chủ công nghệ AI nội bộ là hướng đi đúng đắn, đáp ứng yêu cầu bảo mật thông tin trong cơ quan nhà nước.
- Yêu cầu các bộ phận chuyên môn bám sát các mốc thời hạn được giao để chuẩn bị đầy đủ hồ sơ nghiệm thu kỹ thuật và đề xuất mở rộng quy mô áp dụng."""

MEETING_2_TASKS = [
    {
        "title": "Thiết lập cơ chế tự động sao lưu dữ liệu SQLite (vietmeeting.db) hàng ngày lúc 00:00",
        "description": "Cấu hình lịch trình tự động nén và sao lưu file dữ liệu sang máy chủ lưu trữ NAS có mã hóa.",
        "status": "DONE",
        "due_date": "2026-11-12 17:00:00",
        "assignee_name": "Đội Kỹ thuật Vận hành",
    },
    {
        "title": "Tối ưu hóa mô hình faster-whisper int8 trên card đồ họa NVIDIA RTX",
        "description": "Cân chỉnh tham số beam_size và Silero VAD threshold để tăng tốc độ nhận diện giọng nói.",
        "status": "IN_PROGRESS",
        "due_date": "2026-11-18 17:00:00",
        "assignee_name": "Nhóm Nghiên cứu Trí tuệ Nhân tạo",
    },
    {
        "title": "Xây dựng ma trận phân quyền theo dõi biên bản cuộc họp theo cấp bậc cán bộ",
        "description": "Xác định danh mục cuộc họp mật/tối mật và danh sách người dùng được cấp quyền truy cập.",
        "status": "PENDING",
        "due_date": "2026-11-22 17:00:00",
        "assignee_name": "Phòng Tổ chức - Cán bộ",
    },
    {
        "title": "Thử nghiệm tải đồng thời 10 phiên ghi âm trực tiếp trên mạng nội bộ LAN",
        "description": "Kiểm tra mức tiêu hao băng thông, độ trễ WebSocket và độ ổn định của tiến trình nền FastAPI.",
        "status": "PENDING",
        "due_date": "2026-11-28 17:00:00",
        "assignee_name": "Phòng Thử nghiệm & QA",
    },
    {
        "title": "Soạn thảo hướng dẫn xử lý sự cố mất kết nối mạng đối với máy ghi âm số",
        "description": "Quy trình chuyển tiếp bộ nhớ đệm âm thanh khi mạng phục hồi để tránh mất mát dữ liệu phiên họp.",
        "status": "PENDING",
        "due_date": "2026-12-02 17:00:00",
        "assignee_name": "Ban Cơ yếu - CNTT",
    },
    {
        "title": "Trình Lãnh đạo phê duyệt Đề án nhân rộng VietMeeting AI trong toàn cơ quan",
        "description": "Tổng hợp hồ sơ báo cáo kết quả thử nghiệm và dự toán kinh phí triển khai giai đoạn 2.",
        "status": "PENDING",
        "due_date": "2026-12-08 17:00:00",
        "assignee_name": "Thư ký Hội đồng Công nghệ",
    },
]


def seed():
    print("=" * 65)
    print("🚀 BẮT ĐẦU ĐỒNG BỘ VÀ NẠP DỮ LIỆU MẪU VIETMEETING AI")
    print("=" * 65)

    # Đảm bảo schema cơ sở dữ liệu đã được khởi tạo
    try:
        import asyncio
        from app.core.database import init_db
        asyncio.run(init_db())
    except Exception as e:
        print(f"⚠️ Khởi tạo schema (init_db): {e}")

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # Bước 1: Chuẩn hóa toàn bộ Enum trong DB theo đúng định nghĩa SQLAlchemy Enum Name (UPPERCASE)
    print("🔧 Chuẩn hóa các giá trị Enum trong SQLite về chuẩn SQLAlchemy Enum Names...")
    try:
        cur.execute("UPDATE meetings SET status = 'COMPLETED' WHERE LOWER(status) = 'completed' OR status = 'COMPLETED'")
        cur.execute("UPDATE meetings SET status = 'CREATED' WHERE LOWER(status) = 'created' OR status = 'CREATED'")
        cur.execute("UPDATE meetings SET status = 'PROCESSING' WHERE LOWER(status) = 'processing' OR status = 'PROCESSING'")
        cur.execute("UPDATE meetings SET status = 'FAILED' WHERE LOWER(status) = 'failed' OR status = 'FAILED'")

        cur.execute("UPDATE tasks SET status = 'PENDING' WHERE LOWER(status) = 'pending' OR status = 'PENDING'")
        cur.execute("UPDATE tasks SET status = 'IN_PROGRESS' WHERE LOWER(status) = 'in_progress' OR status = 'IN_PROGRESS'")
        cur.execute("UPDATE tasks SET status = 'DONE' WHERE LOWER(status) = 'done' OR status = 'DONE'")
        cur.execute("UPDATE tasks SET status = 'CANCELLED' WHERE LOWER(status) = 'cancelled' OR status = 'CANCELLED'")
        conn.commit()
    except Exception as e:
        print(f"ℹ️ Bỏ qua chuẩn hóa enum nếu bảng chưa có dữ liệu: {e}")

    # Bước 2: Kiểm tra số cuộc họp hiện có
    cur.execute("SELECT id, title, status FROM meetings")
    existing_meetings = cur.fetchall()
    print(f"📊 Số lượng cuộc họp hiện có trong cơ sở dữ liệu: {len(existing_meetings)}")
    for m in existing_meetings:
        print(f"   - [ID: #{m[0]}] {m[1]} (Trạng thái: {m[2]})")

    existing_titles = [m[1] for m in existing_meetings]
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Seed Meeting 1
    if MEETING_1_TITLE not in existing_titles:
        print(f"\n➕ Đang thêm cuộc họp mẫu 1: '{MEETING_1_TITLE}'...")
        cur.execute(
            """
            INSERT INTO meetings (title, description, audio_file_url, raw_transcript, final_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                MEETING_1_TITLE,
                MEETING_1_DESC,
                "uploads/audio/demo_chuyen_doi_so.wav",
                MEETING_1_TRANSCRIPT,
                MEETING_1_MINUTES,
                "COMPLETED",
                now_str,
                now_str,
            ),
        )
        meeting_1_id = cur.lastrowid
        print(f"   ✅ Đã tạo cuộc họp ID #{meeting_1_id}")

        for task in MEETING_1_TASKS:
            cur.execute(
                """
                INSERT INTO tasks (meeting_id, title, description, status, due_date, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    meeting_1_id,
                    task["title"],
                    f"{task['description']} (Người phụ trách: {task['assignee_name']})",
                    task["status"],
                    task["due_date"],
                    now_str,
                    now_str,
                ),
            )
        print(f"   ✅ Đã nạp {len(MEETING_1_TASKS)} công việc chi tiết cho cuộc họp 1")
    else:
        print(f"\nℹ️ Cuộc họp 1 đã tồn tại trong DB.")

    # Seed Meeting 2
    if MEETING_2_TITLE not in existing_titles:
        print(f"\n➕ Đang thêm cuộc họp mẫu 2: '{MEETING_2_TITLE}'...")
        cur.execute(
            """
            INSERT INTO meetings (title, description, audio_file_url, raw_transcript, final_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                MEETING_2_TITLE,
                MEETING_2_DESC,
                "uploads/audio/demo_bao_mat_ai.wav",
                MEETING_2_TRANSCRIPT,
                MEETING_2_MINUTES,
                "COMPLETED",
                now_str,
                now_str,
            ),
        )
        meeting_2_id = cur.lastrowid
        print(f"   ✅ Đã tạo cuộc họp ID #{meeting_2_id}")

        for task in MEETING_2_TASKS:
            cur.execute(
                """
                INSERT INTO tasks (meeting_id, title, description, status, due_date, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    meeting_2_id,
                    task["title"],
                    f"{task['description']} (Người phụ trách: {task['assignee_name']})",
                    task["status"],
                    task["due_date"],
                    now_str,
                    now_str,
                ),
            )
        print(f"   ✅ Đã nạp {len(MEETING_2_TASKS)} công việc chi tiết cho cuộc họp 2")
    else:
        print(f"\nℹ️ Cuộc họp 2 đã tồn tại trong DB.")

    conn.commit()

    # Tổng kết lại
    cur.execute("SELECT COUNT(*) FROM meetings")
    total_meetings = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM tasks")
    total_tasks = cur.fetchone()[0]

    cur.execute("SELECT DISTINCT status FROM meetings")
    print(f"✅ Trạng thái Meeting sau chuẩn hóa: {cur.fetchall()}")
    cur.execute("SELECT DISTINCT status FROM tasks")
    print(f"✅ Trạng thái Task sau chuẩn hóa: {cur.fetchall()}")

    conn.close()

    print("\n" + "=" * 65)
    print(f"🎉 HOÀN THÀNH ĐỒNG BỘ DỮ LIỆU MẪU!")
    print(f"   - Tổng số cuộc họp trong cơ sở dữ liệu: {total_meetings}")
    print(f"   - Tổng số nhiệm vụ công việc: {total_tasks}")
    print("=" * 65)


if __name__ == "__main__":
    seed()
