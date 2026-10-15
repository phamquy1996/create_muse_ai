# create_muse_ai

**Muse AI Image Studio** — Công cụ Web tự động hóa tạo và tải ảnh chất lượng gốc từ `https://muse.ai` thông qua Cookie phiên trình duyệt.

## ✨ Tính năng
- **Tạo 1 ảnh hoặc Tạo hàng loạt (Batch Mode):** Hỗ trợ chọn tỷ lệ khung hình (`1:1`, `16:9`, `9:16`) và phong cách (`Photorealistic`, `Cinematic`, `3D Pixar`, `Anime`, `Cyberpunk`...).
- **Đính kèm ảnh tham chiếu:** Hỗ trợ tải ảnh gốc lên kèm câu lệnh (Image-to-Image / Reference).
- **Trích xuất ảnh chất lượng gốc (`blob:`):** Tự động lưu bản gốc (`1920×1280` / `1280×1920` / `1600×1600`) vào thư mục `outputs/`.
- **Cập nhật Cookie / cURL trực tiếp trên giao diện:** Dán lệnh `Copy as cURL` từ DevTools (F12) hoặc chuỗi Cookie, hệ thống tự động tách `hatch_sess`, `hatch_gw`, `hatch_vml`.
- **Chế độ Ẩn / Hiện Chrome:** Cho phép chạy ngầm (Headless) hoặc bật cửa sổ Chrome trực tiếp.

## 🚀 Cách chạy
1. Cài đặt thư viện (nếu chạy độc lập lần đầu):
   ```bash
   npm install
   ```
2. Khởi động công cụ:
   - Nhấp đúp vào `CHAY-TOOL-MUSE-AI.bat`, hoặc chạy:
     ```bash
     npm start
     ```
3. Truy cập **`http://localhost:3456`**, bấm **🔑 Cài đặt Cookie / cURL** để dán Cookie từ `muse.ai` và bắt đầu tạo ảnh.
