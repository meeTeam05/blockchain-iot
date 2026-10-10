# Nhật ký công việc: module AI (`components/core/ai`)

Ghi lại việc đã làm, kết quả kiểm chứng và việc còn mở, theo ngày. Chi tiết kỹ thuật nằm trong các tài liệu được dẫn link; file này chỉ tóm tắt.

Nhánh: `feature/ai-gas-ews` (tách từ `feature/ai-sprint2`). Các mục ngày 25–26/9 trước phần "Chuyển sang cấu trúc ai-sprint2" được làm trên `feature/ai-inference`, nơi module còn nằm ở `ai/gas_ews` + `ai/ai_scheduler`. Repo huấn luyện đi kèm: `ungdungdidong/gas_ews/`.

---

## 2026-09-26

### Replay tua nhanh

- Replay không còn lấy 1 mẫu mỗi lần đọc cảm biến trên đồng hồ thật nữa. Task `ai_replay` giờ đưa mẫu thứ `i` vào ở thời điểm mô phỏng `5·i` s, nhanh gấp `SA_AI_REPLAY_SPEED` lần (1–500, mặc định 60). Replay bắt đầu 10 s sau `ai_start`. `ai_feed_sample()` bỏ qua cảm biến thật khi replay.
- Task replay chờ `ai_task` xử lý xong từng bước 10 s rồi mới đưa mẫu tiếp theo, nên tốc độ nào cũng không bỏ bước nào. Cuối kịch bản có thêm 1 mẫu rỗng để chốt bước cuối (433 bước với `co_event`, bằng số dòng của file expected).
- Mỗi bước in một dòng `RS,` (ppm/STEL/TWA/ngoại suy/`p_model`/mức của từng khí). `tools/replay/compare_replay_log.py` so log đó với `replay_<tên>_expected.csv` và báo `PASS`/`FAIL`.
- Phần xử lý mỗi bước của `ai_task` được tách thành `ai_handle_step()`; hành vi khi không replay không đổi.
- Kiểm tra: đã chạy `compare_replay_log.py` với log giả sinh từ file expected (PASS cho cả 2 kịch bản; đổi 1 giá trị và xoá 1 bước thì FAIL đúng chỗ). **Chưa build bằng ESP-IDF và chưa chạy trên board** (máy này không có ESP-IDF hay gcc).

### Test trên board: checklist và replay dữ liệu mô phỏng

- [BOARD_TEST.md](BOARD_TEST.md): checklist test trên board (log boot, mốc thời gian, `ai_set`, `device_mode`, reboot, còi, so sánh board với Python), kèm bảng kết quả.
- Chế độ replay (`SA_AI_REPLAY`, mặc định tắt): AI phát lại kịch bản mô phỏng nhúng trong firmware thay cho cảm biến, mỗi lần đọc 1 mẫu, vẫn giữ đồng hồ thật. `ai/state` có thêm `"replay":<tên>`.
- `ungdungdidong/gas_ews/export_replay.py` cắt 2 kịch bản từ golden mô phỏng:
  - `co_event`: 72 phút; mong đợi mức 1 ở 40:00, mức 2 ở 47:20;
  - `no2_event`: 88 phút, có một lần mất dữ liệu 125 s; mong đợi mức 1 ở 45:10, mức 2 ở 63:40.

  Script sinh `ai_replay_data.h`, đầu vào CSV và kết quả mong đợi (pipeline Python INT8) trong `tools/replay/`.
- Kiểm tra:
  - `gas_ews.c` chạy trên dữ liệu replay khớp kết quả mong đợi (STEL/TWA/ngoại suy lệch ≤ 0.05%, do làm tròn CSV);
  - `ai.c` biên dịch sạch ở 4 cấu hình (tắt, bật, replay 0, replay 1); chọn kịch bản sai thì báo lỗi lúc build;
  - `gas_ews_model.cpp` biên dịch sạch với header thật của `esp-tflite-micro` 1.4.1 (phiên bản khoá trong `dependencies.lock`), `-Wall -Werror=all`.

### Chuyển `gas_ews` sang cấu trúc `feature/ai-sprint2` (nhánh `feature/ai-gas-ews`)

- `feature/ai-inference` và `feature/ai-sprint2` có 34 file conflict: `ai-sprint2` đã xoá `ai/` và gộp thành component `iot_code/components/core/ai`. Vì vậy không rebase nguyên trạng, mà tạo nhánh mới từ `origin/feature/ai-sprint2` rồi chuyển `gas_ews` vào.
- **Thay** model AQI 24 giờ bằng `gas_ews` (model cũ còn trong lịch sử git). Giữ nguyên của `ai-sprint2`:
  - API `ai_start` / `ai_feed_sample` / `ai_set_enabled` / `ai_get_enabled`;
  - lệnh `ai_set`, shadow `ai_enabled`, `SA_ENABLE_AI`, `SA_AI_ENABLED_AT_BOOT`;
  - task theo sự kiện, arena trong PSRAM;
  - phần app/server.
- **Không điều khiển relay**, theo thiết kế của `ai-sprint2`: AI chỉ kêu còi và publish `ai/state`. Logic quyền sở hữu quạt của `ai_scheduler` cũ không được mang theo.
- `ai.c`:
  - `ai_feed_sample()` đánh thức `ai_task` ở mỗi bước 10 s mới;
  - task chạy model, kêu còi khi mức tăng lên, publish `ai/state` khi đổi trạng thái và mỗi 60 s;
  - log thời gian init/suy luận như trước;
  - model lỗi chỉ tắt model, không tắt luật.
- Còi: cảnh báo sớm = 3 tiếng dài (mẫu của `ai-sprint2`); vượt ngưỡng = 4 tiếng rất dài (7 bước). **Sửa lỗi**: mẫu "vượt ngưỡng" 5 tiếng của `ai_scheduler` cũ cần 9 bước, vượt hàng đợi còi 8 bước, nên sẽ bị `buzzer.c` từ chối (còi không kêu).
- Arena model cấp từ PSRAM, không có PSRAM thì lấy từ RAM trong. Arena dùng `SA_AI_TENSOR_ARENA_SIZE`, mặc định giảm từ 24 KB xuống 16 KB.
- Bỏ `SA_AI_WINDOW_BUCKET_SEC`, `SA_AI_SELF_TEST`, `gen_selftest_vectors.py`: self-test giờ luôn chạy, và cửa sổ 20 phút không cần chế độ test nhanh.
- `sensor_task` gửi ppm thô, cờ hợp lệ riêng từng cảm biến và đồng hồ đơn điệu.
- Kiểm tra:
  - golden test đạt ở vị trí mới;
  - `ai.c` biên dịch sạch `-Wall -Wextra -Werror` (header giả lập) với `SA_ENABLE_AI` = 1 và 0;
  - **chưa** `idf.py build`.
- `ungdungdidong/gas_ews/export_firmware.py` ghi ra vị trí mới `iot_code/components/core/ai`.

### Cửa sổ model 20 phút, chạy cho cả CO và NO2

- So sánh cửa sổ 30 / 20 / 15 / 10 phút: cùng seed, chỉ đổi `F.WINDOW`. Chọn **20 phút (120 bước)**. Bảng so sánh ở `ungdungdidong/gas_ews/README.md` mục 5.
- Kết quả hệ thống (model ∨ ngoại suy ∨ luật), tập TEST mô phỏng, so với bản 30 phút:

  | | 30 phút | 20 phút |
  |---|---|---|
  | Model chạy từ (sau khởi động) | phút 40 | **phút 30** |
  | CO báo trước / lead trung vị | 91% / +5.1 phút | 92% / +6.5 phút |
  | NO2 báo trước / báo nhầm mỗi ngày | 100% / 0.25 | 100% / 0.19 |
  | OOD CO báo trước (máy phát điện) | 89% | 92% |
  | Kích thước model | 22.9 KB, 14,234 tham số | 20.9 KB, 12,186 tham số |

- Dữ liệu thật (`eval_real`):
  - EN54 và Kashtan vẫn 0 báo nhầm.
  - Cảnh báo sớm CO ở hội trường giảm từ 0.42 xuống 0.28 lần/ngày.
  - CO ×1.3 (qua mô hình cảm biến) báo trước tăng từ 90% lên 97%.
  - NO2 lead trung vị ngắn hơn (21.5 → 15.7 phút).
- Dữ liệu thiết bị thật (3.2 giờ): model NO2 báo khoảng 5 phút, **nằm trọn trong** khoảng ngoại suy đã báo sẵn, nên không thêm báo nhầm mới.
- **Sửa lỗi ở bước chọn cấu hình trên VAL** (`train.py`): trước đây bước này được phép chọn "chỉ model", trong khi firmware luôn OR ngoại suy. Với cửa sổ 20 phút nó đã chọn đúng cấu hình không có ngoại suy, làm số liệu đánh giá không khớp với thứ chạy trên thiết bị. Giờ chỉ xét các cấu hình có ngoại suy.
- Đã xuất sang firmware (`export_firmware`): model, `gas_ews_contract.h`, `gas_ews_selftest.h`, golden vector. Bản 30 phút cũ được sao lưu ở `ungdungdidong/outputs_gas_ews_w180_backup/` (không nằm trong git).
- Chỉ có 1 seed: chênh lệch vài điểm % chỉ đủ để nói bản 20 phút **không kém đi**.

### Rà soát

- [REVIEW_MODEL.md](REVIEW_MODEL.md): rà riêng phần model và lịch hoạt động của model trên hệ thống.
  - M1: model nhạy với độ ẩm; T < 22.5 °C / RH < 47.9 % bị kẹp bởi dải INT8.
  - M2: model NO2 chưa có ích hơn ngoại suy; giữ lại để hai khí dùng cùng một cơ chế.
  - M3: chưa đo trên chip.
- Trả lời câu hỏi "nạp cửa sổ từ cơ sở dữ liệu":
  - Với cửa sổ model thì không có lợi: 10 phút preheat luôn nằm trong cửa sổ, và dữ liệu thật cho thấy mọi lần khởi động lại đều có đỉnh preheat (CO lên tới 394–5000 ppm).
  - Với **TWA 8 giờ sau mất điện** thì có lợi. Chưa làm.

### Sửa lỗi nhỏ

- (Trên `feature/ai-inference`) `ai_input_reset()` không đặt lại `s_samples_fed`, làm test host của `ai_input` lỗi 1/44. Đã sửa. Ở nhánh này `ai_input` đã bị bỏ cùng model cũ.

---

## 2026-09-25

### Đo và làm rõ thời gian chạy AI

- `ai_scheduler.c` (nay là `ai.c`) thêm đo thời gian bằng `esp_timer`:
  - thời gian `gas_ews_model_init` (AllocateTensors + self-test);
  - lần suy luận đầu tiên: chạy ở giây thứ mấy sau boot và mất bao nhiêu µs;
  - mỗi giờ: thời gian suy luận trung bình và lớn nhất.

  Trước đó README ghi là có đo `Invoke()`, nhưng code chỉ log stack.
- Thêm [tools/sim_gas_ews_timeline.c](tools/sim_gas_ews_timeline.c): chạy `gas_ews.c` thật trên máy tính để lấy mốc thời gian. Các mốc:
  - preheat 0–10 phút;
  - STEL từ ~11 phút;
  - ngoại suy từ ~15 phút;
  - model từ ~30 phút (trước ngày 26/9 là ~40 phút);
  - TWA đủ 8 giờ lịch sử sau ~8 giờ 10 phút.
- [README.md](README.md) thêm mục "Thời gian chạy thực tế": chu kỳ, mốc sau khởi động, phản ứng khi khí tăng đột ngột, chi phí một lần suy luận.

### Rà soát tổng thể

- [REVIEW_HOAT_DONG.md](REVIEW_HOAT_DONG.md): hệ thống đã phù hợp chưa, và giải thích TWA (là gì, vai trò, vì sao "8 giờ mới đủ").
- 4 vấn đề chính, **chưa sửa**:
  - A. Cảnh báo không tới được ai ở cấu hình mặc định.
  - B. `device_mode` OFF làm ngừng giám sát khí.
  - C. Reboot làm mất TWA. Ví dụ mô phỏng: CO 25 ppm, reboot ở giờ 5 → báo trễ 5 giờ.
  - D. QCVN 03:2019 là ngưỡng cho nơi làm việc, không phải nhà ở.

---

## Kiểm chứng hiện có (trên máy tính)

| Kiểm tra | Kết quả |
|---|---|
| Golden test `gas_ews.c` so với Python (8,342 bước, 3 bộ dữ liệu) | 0 sai khác |
| `ai.c` với `-Wall -Wextra -Werror` (header giả lập ESP-IDF) | sạch với `SA_ENABLE_AI` = 1 và 0 |
| INT8 so với float | khớp 99.91% (CO) / 99.995% (NO2) số bước |

**Chưa làm:** `idf.py build`, chạy trên board, đo `Invoke()`/arena/stack thật.

## Việc còn mở

1. Build + flash, đọc log thời gian/arena/stack/self-test ([REVIEW_MODEL.md](REVIEW_MODEL.md) M3).
2. Server lưu `ai/state`, app hiển thị/push; cân nhắc để `ai_set` chỉ tắt model, còn còi của luật QCVN luôn bật (A).
3. Giám sát khí tiếp khi `device_mode` OFF (B).
4. Cờ hiệu chuẩn NO2, chặn còi NO2 khi chưa hiệu chuẩn.
5. Giữ TWA qua reboot (`RTC_NOINIT_ATTR` + DS3231), và/hoặc nạp TWA từ DB sau mất điện (C).
6. Mở rộng dải T/RH khi mô phỏng rồi train lại (M1).
7. Chạy thêm 3–5 seed cho cửa sổ 20 và 30 phút.
8. Chốt môi trường sử dụng (nơi làm việc / nhà ở) và bộ ngưỡng (D).
