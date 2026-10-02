# Rà soát tích hợp module AI (`ai/`) vào hệ thống

> **Cập nhật 2026-09-26 (nhánh `feature/ai-gas-ews`).** Model AQI 24 giờ mô tả trong tài liệu này
> đã được **thay** bằng cảnh báo sớm CO/NO2 theo QCVN 03:2019/BYT (`gas_ews`, xem [README.md](README.md)).
> Tài liệu này giữ lại làm lịch sử. Với luồng mới:
> - #10, #11, #14 (dữ liệu trạm ngoài trời, ngưỡng 0.5, model không phù hợp): không còn áp dụng.
> - `SA_AI_SELF_TEST` và `SA_AI_WINDOW_BUCKET_SEC` đã bỏ: self-test luôn chạy lúc boot, cửa sổ model
>   là 20 phút nên không cần chế độ test nhanh.
> - Vẫn còn mở: #2 (ACL cho thiết bị cũ), #13 (server chưa đọc `ai/state`, schema đã đổi).
> - Rà soát luồng mới: [REVIEW_HOAT_DONG.md](REVIEW_HOAT_DONG.md), [REVIEW_MODEL.md](REVIEW_MODEL.md).

> **Cập nhật 2026-09-24 (nhánh `feature/merge-temp`, theo Task 2).** Tài liệu bên dưới mô tả bản
> gốc của `feature/ai-inference`. Sau khi merge, module đã được sửa lại như sau (chi tiết ở
> [README.md](README.md)):
> - Dời vào `firmware/components/ai/`, gộp thành 1 component `ai`. Kconfig đổi thành
>   `SA_ENABLE_AI` và được map trong `config.h`.
> - **Bỏ toàn bộ điều khiển relay** (ngoài phạm vi task): #5 và #6 không còn áp dụng.
> - Chỉ dùng model **freeze** (recall 82.54%), bỏ ensemble và model `nofreeze`: #12 không còn áp dụng.
> - Buzzer và publish không còn phụ thuộc relay. Khi ALERT thì bíp 3 tiếng dài và publish ngay.
> - Chạy theo sự kiện: `ai_input` báo "vừa chốt 1 giờ" rồi đánh thức task AI, bỏ vòng lặp 30s: #8 đã sửa.
> - Tensor arena cấp trong PSRAM (`MALLOC_CAP_SPIRAM`), interpreter dựng 1 lần lúc boot. Stack task
>   8KB, không còn `now_ms()` 32-bit: #9 đã sửa.
> - Thêm `ai_set_enabled()` / `ai_get_enabled()` cho Task 1, cùng self-test
>   (`SA_AI_SELF_TEST`) và `SA_AI_WINDOW_BUCKET_SEC` để test nhanh.
> - Vẫn còn mở: #2 (ACL cho thiết bị cũ), #10, #11, #13.

Ngày rà soát: 2026-09-23 — nhánh `feature/ai-inference`.

Tài liệu này tổng hợp các vấn đề phát hiện khi đưa module AI (dự báo cảnh báo chất lượng không khí
chạy trên ESP32-S3) vào `aiot-edge`: vấn đề nào **đã sửa**, vấn đề nào **còn mở**, và vì sao chúng
quan trọng. Mô tả kiến trúc chi tiết của module nằm ở [README.md](README.md).

---

## 0. Tóm tắt nhanh

| # | Vấn đề | Mức độ | Trạng thái | Commit |
|---|---|---|---|---|
| 1 | Sai đơn vị CO/NO2 (ppm vs µg/m³) | 🔴 Nghiêm trọng | ✅ Đã sửa | `2c5aff6` |
| 2 | Topic `ai/state` không có trong ACL → EMQX ngắt kết nối thiết bị | 🔴 Nghiêm trọng | 🟡 Sửa một phần | `7441a28` |
| 3 | Sai tên symbol của model nhúng (lỗi link) | 🟠 Lỗi build | ✅ Đã sửa (chưa build thử) | `58a4a6c` |
| 4 | `target_link_libraries(... tflite-lib)` không tồn tại | 🟠 Lỗi build | ✅ Đã sửa (chưa build thử) | `58a4a6c` |
| 5 | AI tranh quyền điều khiển quạt với người dùng | 🟡 Logic / sản phẩm | ❌ Chưa sửa — cần quyết định | — |
| 6 | Nhận nhầm "người dùng can thiệp" sau khi bật lại device_mode | 🟡 Logic | ❌ Chưa sửa | — |
| 7 | `ai_input` không có khoá, 2 task đọc/ghi song song | 🟡 Logic | ✅ Đã sửa | `d432327` |
| 8 | Lệch nguồn thời gian (DS3231 vs `time(NULL)`) | 🟡 Logic | ❌ Chưa sửa | — |
| 9 | Stack task 4096 byte, `now_ms()` tràn sau ~49 ngày | ⚪ Nhỏ | ❌ Chưa sửa | — |
| 10 | Dữ liệu huấn luyện (trạm ngoài trời) ≠ cảm biến thiết bị (trong nhà) | 🔴 Chất lượng mô hình | ❌ Chưa xử lý — cần dữ liệu thực | — |
| 11 | Ngưỡng 0.5 → ~91% cảnh báo là báo nhầm | 🟡 Chất lượng mô hình | ❌ Chưa xử lý | — |
| 12 | Model `nofreeze` INT8 dưới ngưỡng khớp 98% | ⚪ Chất lượng mô hình | ❌ Chưa xử lý | — |
| 13 | Topic `ai/state` chưa có trong `docs/reference/MQTT_PROTOCOL.md`, server chưa đọc | ⚪ Tài liệu | ❌ Chưa sửa | — |

**Chưa có gì được build hay chạy thử.** Máy dùng để rà soát không có ESP-IDF và không có trình biên
dịch C. Mọi kết luận ở đây đến từ việc đọc code. `SA_AI_ENABLED` mặc định là `n`, nên khi chưa bật
thì firmware chạy như trước (chỉ thêm việc gom dữ liệu vào `ai_input`, rất nhẹ).

---

## 1. Luồng dữ liệu (để hiểu các vấn đề bên dưới)

```
sensor_task (5s/lần)
   │  nhiệt độ, độ ẩm, CO, NO2 + timestamp (DS3231 hoặc time(NULL))
   ▼
ai_input_feed_sample()        gom trung bình theo từng giờ → vòng đệm 24 giờ
   │
   ▼  (mỗi 30s kiểm tra; chạy suy luận tối đa 1 lần/giờ khi đủ 24 giờ liên tục)
ai_scheduler ──► ai_infer()   2 model TFLite INT8, lấy trung bình softmax
   │
   ├─► MQTT  device/{id}/ai/state
   └─► relay_set(Fan) + 3 tiếng bíp khi chuyển sang ALERT
```

Các file tích hợp vào firmware:
- [firmware/CMakeLists.txt](../firmware/CMakeLists.txt) — thêm 3 component `../ai/*`.
- [sensor_task.c](../firmware/components/core/sensor_task/sensor_task.c) — gọi `ai_input_feed_sample()` mỗi lần đọc cảm biến.
- [sysload.c](../firmware/components/core/sysload/sysload.c) — gọi `ai_scheduler_start()` sau `sensor_task_start()`.

---

## 2. Các vấn đề đã giải quyết

### ✅ #1 — Sai đơn vị CO/NO2

**Vấn đề.** Mô hình được huấn luyện trên dữ liệu trạm quan trắc với CO trung bình **1056**, NO2 trung
bình **77** — đây là đơn vị **µg/m³**. Firmware lại đưa vào giá trị **ppm** (CO khoảng 3–13, NO2
khoảng 0.03–0.12).

**Vì sao nghiêm trọng.** Sau chuẩn hoá z-score, CO = 5 ppm thành `(5 − 1056) / 644.7 ≈ −1.63`,
NO2 = 0.05 ppm thành `(0.05 − 77.08) / 42.7 ≈ −1.80`. Đầu vào INT8 của model chỉ biểu diễn được tới
khoảng **−1.82** (scale 0.0607, zero-point −98). Nghĩa là mô hình **luôn thấy không khí sạch nhất có
thể**, dù CO thật có tăng vọt. Quyết định gần như chỉ còn dựa vào nhiệt độ và độ ẩm.

**Cách sửa.**
- Thêm hằng số quy đổi ở 25°C, 1 atm vào [ai_input.h](ai_input/include/ai_input.h):
  `AI_CO_PPM_TO_UGM3 = 1145.6`, `AI_NO2_PPM_TO_UGM3 = 1881.6` (= khối lượng mol / 24.45 × 1000).
- `sensor_task` nhân với hệ số này trước khi đưa vào `ai_input`.
- Đổi tên trường thành `co_ugm3` / `no2_ugm3` để về sau không ai đưa nhầm ppm vào.

**Còn cần kiểm tra.** Đơn vị gốc của tập dữ liệu nằm ở repo `ungdungdidong`, không có trong repo này.
Con số trung bình 1056 / 77 rất khớp với µg/m³ ở TP.HCM, nhưng nên xác nhận lại tại nguồn.

### 🟡 #2 — Topic `ai/state` bị EMQX chặn và ngắt kết nối thiết bị (sửa một phần)

**Vấn đề.** AI publish lên `device/{id}/ai/state`, nhưng ACL của thiết bị
([emqx.js](../server/api/src/services/emqx.js) → `deviceRules()`) không có topic này. EMQX đang cấu
hình ([emqx.conf](../server/emqx/emqx.conf)):

```
no_match    = deny
deny_action = disconnect
```

**Vì sao nghiêm trọng.** Khi bật AI, thiết bị bị **ngắt MQTT mỗi 10 phút** (lúc đang chờ đủ 24h) hoặc
**mỗi giờ** (sau đó). Telemetry, lệnh relay, OTA đều bị ảnh hưởng — tức là bật AI làm hỏng cả hệ thống.

**Đã sửa.** Thêm quyền `publish` cho `device/{id}/ai/state` vào `deviceRules()`.

**Chưa xong.** ACL chỉ được ghi **một lần khi đăng ký thiết bị** (`createDeviceUser`). Thiết bị đã
đăng ký trước đó **không tự có quyền mới**. Trước khi bật `SA_AI_ENABLED` trên thiết bị cũ, phải:
- đăng ký lại thiết bị, **hoặc**
- thêm quyền qua EMQX dashboard / API, **hoặc**
- (hướng lâu dài) viết một bước đồng bộ ACL cho mọi thiết bị khi server khởi động.

### ✅ #3 — Sai tên symbol của file model nhúng

**Vấn đề.** ESP-IDF sinh symbol cho `EMBED_FILES` từ **tên file**, không kèm thư mục
(`get_filename_component(... NAME)` trong `data_file_embed_asm.cmake`). File
`model/model_beijing_freeze_int8.tflite` → symbol `_binary_model_beijing_freeze_int8_tflite_start`.
Code lại khai báo `_binary_model_model_...` (thừa một `model_` do tưởng có tính cả thư mục).

**Hậu quả.** Lỗi link `undefined reference` khi bật AI.

**Đã sửa** trong [ai_inference.cpp](ai_inference/src/ai_inference.cpp).

### ✅ #4 — Target CMake `tflite-lib` không tồn tại

**Vấn đề.** [ai_inference/CMakeLists.txt](ai_inference/CMakeLists.txt) có dòng
`target_link_libraries(${COMPONENT_LIB} PRIVATE tflite-lib)`. `tflite-lib` là tên component trong
repo ví dụ cũ, không phải target mà `espressif/esp-tflite-micro` đăng ký.

**Đã sửa.** Bỏ dòng này. Dependency đã khai báo trong `idf_component.yml`, component manager tự thêm
vào requirements.

### ✅ #7 — `ai_input` không có khoá

**Vấn đề.** `sensor_task` (ghi) và `ai_scheduler` (đọc, ghim vào `APP_CPU`) chạy trên hai core khác
nhau, cùng truy cập biến static trong `ai_input.c` mà không có khoá. Nếu `ai_input_get_window()` đọc
đúng lúc `push_hour()` đang ghi, cửa sổ 24h có thể bị lẫn dữ liệu cũ/mới.

**Đã sửa.** Mọi hàm public của [ai_input.c](ai_input/src/ai_input.c) chạy trong `portMUX` critical
section. Khi build trên máy tính (không có `ESP_PLATFORM`), khoá là no-op nên test host vẫn biên dịch
được.

---

## 3. Các vấn đề chưa giải quyết

### ❌ #5 — AI tranh quyền điều khiển quạt với người dùng (cần quyết định sản phẩm)

**Hiện trạng.** Mỗi giờ AI đặt quạt theo kết quả: ALERT → **bật**, SAFE → **tắt**. Khi phát hiện ai
đó đổi trạng thái quạt (so `relay_get_all()` với lệnh cuối của AI), AI chỉ nhường
`SA_AI_OVERRIDE_COOLDOWN_MIN` = **30 phút**.

**Vì sao là vấn đề.** Người dùng bật quạt bằng tay → 30 phút sau, nếu AI thấy SAFE, **AI tắt quạt**.
App không có công tắc "chế độ tự động", nên người dùng không có cách nào tắt hành vi này ngoài việc
build lại firmware.

**Các hướng xử lý:**
- **(a) Ít xâm lấn:** AI chỉ tắt quạt nếu chính AI đã bật nó. Người dùng bật tay thì AI không bao giờ tắt.
- **(b) Đầy đủ:** thêm cờ `auto_mode` (lưu NVS, điều khiển qua lệnh MQTT/shadow và nút trong app).
  AI chỉ điều khiển relay khi `auto_mode` bật. Cần sửa cả firmware, server (schema shadow/command,
  xem `docs/reference/MQTT_PROTOCOL.md`) và app.

### ❌ #6 — Nhận nhầm "người dùng can thiệp" sau khi bật lại device_mode

Khi device_mode chuyển OFF → ON, `relay_force_all_off_silent()` tắt mọi relay. Nếu trước đó AI đã bật
quạt, AI thấy trạng thái thực (tắt) khác lệnh cuối (bật) → coi như người dùng can thiệp → tự dừng 30
phút. Không nguy hiểm, nhưng làm AI "đứng yên" vô cớ.

**Hướng sửa:** khi `device_mode_get()` là false, đặt lại `s_last_commanded_valid = false` (lấy lại
mốc khi bật lại).

### ❌ #8 — Lệch nguồn thời gian

`ai_input` gom giờ theo timestamp do `sensor_task` truyền vào (ưu tiên DS3231), còn `ai_scheduler`
quyết định "đã chạy giờ này chưa" bằng `time(NULL)`. Nếu hai đồng hồ lệch nhau (RTC chưa đồng bộ
SNTP, pin RTC hết…), có lúc suy luận chạy lại trên cửa sổ cũ hoặc chạy trễ gần 1 giờ.

**Hướng sửa:** `ai_input` trả về bucket giờ mới nhất đã chốt (hoặc một bộ đếm "phiên bản cửa sổ"),
scheduler chỉ chạy suy luận khi con số này thay đổi.

### ❌ #9 — Các lỗi nhỏ trong `ai_scheduler.c`

- Stack `AI_SCHEDULER_TASK_STACK_SIZE = 4096` hơi ít cho `MicroInterpreter::Invoke()` + cJSON. Nên để
  8192, rồi đo `uxTaskGetStackHighWaterMark()` trên board thật.
- `now_ms()` là `uint32_t` từ tick count → tràn sau ~49.7 ngày. Phép so sánh `now < s_override_until_ms`
  sai trong khoảng thời gian quanh lúc tràn. Nên dùng `esp_timer_get_time()` (64-bit).

### ❌ #10 — Dữ liệu huấn luyện khác xa dữ liệu thiết bị

Mô hình học từ **trạm quan trắc ngoài trời ở TP.HCM** (thiết bị tham chiếu, đã hiệu chuẩn). Thiết bị
dùng cảm biến MEMS giá rẻ GM702B/GM102B, đặt **trong nhà**, chưa hiệu chuẩn. Kể cả khi đơn vị đã đúng
(#1), phân phối giá trị vẫn có thể khác hẳn. Firmware có sẵn lệnh `calibrate_co` / `calibrate_no2`
(`docs/reference/MQTT_PROTOCOL.md` mục 4.1) — nên hiệu chuẩn trước khi đánh giá AI.

**Khuyến nghị:** bật AI ở chế độ **chỉ publish, không điều khiển relay** vài ngày, ghi log `ai/state`
kèm telemetry, xem tỉ lệ ALERT có hợp lý không rồi mới cho điều khiển quạt.

### ❌ #11 — Ngưỡng dự báo và tỉ lệ báo nhầm

Xem chi tiết ở mục 4. Tóm tắt: ngưỡng 0.5, không có hysteresis → khoảng **91% cảnh báo là báo nhầm**
và quạt có thể bật khoảng 4 giờ/ngày.

### ❌ #12 — Model `nofreeze` sau lượng tử hoá INT8

[AI_EXPORT_REPORT.md](ai_inference/model/AI_EXPORT_REPORT.md) tự cảnh báo: model `nofreeze` chỉ khớp
**97.69%** với bản PyTorch gốc, dưới ngưỡng 98% mà chính báo cáo đặt ra. Ensemble vẫn giữ nguyên
recall (87.30%), nên ảnh hưởng thực tế nhỏ, nhưng nên xem lại tập calibration khi export lần sau.

### ❌ #13 — Tài liệu và phía server

- `device/{id}/ai/state` chưa được mô tả trong [docs/reference/MQTT_PROTOCOL.md](../docs/reference/MQTT_PROTOCOL.md)
  (bảng mục 2 và mục 3).
- Server và bridge chưa subscribe topic này (`bridgeRules()` không có), app cũng chưa hiển thị. Hiện
  tại dữ liệu AI publish lên nhưng **không ai đọc**.

---

## 4. Ngưỡng dự báo của AI

| Thông số | Giá trị |
|---|---|
| Quy tắc quyết định | Lấy trung bình softmax của 2 model; **ALERT nếu p(alert) trung bình > 0.5** (argmax) |
| Hiệu chỉnh ngưỡng / hysteresis / độ tin cậy tối thiểu | **Không có** |
| Tần suất | Tối đa 1 lần/giờ |
| Thời gian khởi động | Cần 24 giờ liên tục → kết quả đầu tiên sau ~24–25h; **bắt đầu lại sau mỗi lần reboot/OTA** hoặc mất dữ liệu cả 1 giờ |
| Hành động | ALERT → bật quạt (relay 1) + 3 tiếng bíp; SAFE → tắt quạt |

Chỉ số trên tập test TP.HCM (3590 cửa sổ, chỉ 63 cửa sổ thực sự là cảnh báo ≈ 1.75%):

| Chỉ số | Giá trị | Ý nghĩa |
|---|---|---|
| Alert recall | **87.3%** (55/63) | Bắt được phần lớn cảnh báo thật, bỏ sót 8 |
| False alarm rate | **16.1%** (~568/3527) | Cứ 100 giờ an toàn thì ~16 giờ bị báo nhầm |
| Precision | **≈ 8.8%** (55/623) | Trong mọi lần báo ALERT, chỉ ~9% là đúng |

**Cách hiểu:** ngưỡng 0.5 ưu tiên "không bỏ sót" và chấp nhận báo nhầm nhiều. Vì cảnh báo thật rất
hiếm (1.75%), ngay cả 16% báo nhầm cũng lấn át số cảnh báo đúng.

**Hướng cải thiện (cần tính lại trên tập test ở repo `ungdungdidong`):**
- Nâng ngưỡng (ví dụ 0.6–0.7) và xem recall giảm bao nhiêu.
- Hysteresis: chỉ bật quạt khi ALERT **2 giờ liên tiếp**, chỉ tắt khi SAFE 2 giờ liên tiếp.
- Đưa ngưỡng vào Kconfig để chỉnh mà không cần sửa code.

**Chưa rõ:** định nghĩa nhãn `canh_bao` (dựa trên ngưỡng AQI nào, dự báo giờ hiện tại hay giờ tới)
nằm ở repo `ungdungdidong`, không có trong repo này.

---

## 5. Việc cần làm tiếp (theo thứ tự)

1. [ ] `idf.py build` với `SA_AI_ENABLED=y` — xác nhận #3, #4 đã hết lỗi, sửa nếu API tflite-micro lệch phiên bản.
2. [ ] Chạy test host của `ai_input` trên máy có gcc (lệnh ở [README.md](README.md) mục 2).
3. [ ] Cập nhật ACL cho các thiết bị đã đăng ký trước (#2).
4. [ ] Quyết định hướng cho #5 (a hoặc b).
5. [ ] Sửa #6, #8, #9.
6. [ ] Hiệu chuẩn cảm biến, chạy AI ở chế độ chỉ quan sát vài ngày (#10).
7. [ ] Xem lại ngưỡng / thêm hysteresis (#11).
8. [ ] Bổ sung `ai/state` vào `docs/reference/MQTT_PROTOCOL.md` và quyết định server/app có dùng dữ liệu này không (#13).
9. [ ] Chạy checklist benchmark trên board thật ([README.md](README.md) mục 8): RAM, flash, thời gian suy luận, kích thước tensor arena.
