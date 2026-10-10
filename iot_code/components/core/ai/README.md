# `components/core/ai`: Cảnh báo sớm CO/NO2 theo QCVN 03:2019/BYT (ESP32-S3)

Component này chạy trên thiết bị, dùng trực tiếp số đọc ppm của GM-702B (CO) và GM-102B (NO2). Nó thay cho model AQI 24 giờ trước đây; model cũ vẫn còn trong lịch sử git. Phần huấn luyện, đánh giá và nguồn gốc của mọi hằng số nằm ở repo `ungdungdidong/gas_ews/`.

Component chỉ **báo còi và publish `ai/state`**. Nó **không điều khiển relay**.

## Ngưỡng

| Khí | TWA (8 giờ) | STEL (15 phút) |
|---|---|---|
| CO | 20 mg/m³ = **17.46 ppm** | 40 mg/m³ = **34.92 ppm** |
| NO2 | 5 mg/m³ = **2.66 ppm** | 10 mg/m³ = **5.31 ppm** |

Quy đổi ở 25°C, 1 atm theo công thức của QCVN.

## Luồng xử lý

```
sensor_task (mỗi 5 s) ── ai_feed_sample(ppm, T, RH, đồng hồ đơn điệu esp_timer)
   │  gas_ews_feed():
   │    bỏ qua 10 phút preheat sau khởi động, hoặc sau khi mất dữ liệu > 60 s
   │    gộp thành bước 10 s; lấp mẫu khí thiếu tối đa 60 s
   │    STEL = TB 15 phút | TWA = Σ(C·t) / 8 giờ | ngoại suy STEL 10 phút tới
   │  mỗi bước 10 s mới → xTaskNotifyGive(ai_task)
   ▼
ai_task (theo sự kiện, không có vòng lặp dò)
   │  AI đang OFF (ai_set) → bỏ qua bước này
   │  gas_ews_get_window() → 120×8 (20 phút) → gas_ews_model_infer() (INT8, 21 KB)
   │  → gas_ews_set_model_result()
   ▼
Mỗi khí:  VƯỢT NGƯỠNG  = STEL ≥ ngưỡng OR TWA ≥ ngưỡng                      (luật, luôn chạy)
          CẢNH BÁO SỚM = VƯỢT NGƯỠNG OR ngoại suy ≥ ngưỡng OR model ≥ ngưỡng (bật sau 2 bước, tắt sau 5 phút)
   ├─► mức tăng lên: cảnh báo sớm = 3 tiếng bíp dài, vượt ngưỡng = 4 tiếng bíp rất dài
   └─► MQTT device/{id}/ai/state   (ngay khi đổi trạng thái, và mỗi 60 s)
```

**Model không bao giờ tắt được phần luật.** Model lỗi, không có PSRAM hoặc không qua self-test lúc boot thì chỉ model bị tắt. Luật QCVN và cảnh báo từ ngoại suy vẫn chạy.

## 1. Cấu hình

| Tuỳ chọn | Ở đâu | Mặc định | Ghi chú |
|---|---|---|---|
| `SA_ENABLE_AI` | `main/Kconfig.projbuild` → Peripheral Enable/Disable, map trong `config.h` | `n` | `n`: component chỉ là stub, không có TFLM, không có model trong flash |
| `SA_AI_ENABLED_AT_BOOT` | `main/Kconfig.projbuild` → AI (on-device inference) | `y` | Giá trị mặc định của công tắc runtime sau mỗi lần boot (không lưu NVS) |
| `SA_AI_TENSOR_ARENA_SIZE` | `main/Kconfig.projbuild` → AI (on-device inference) | 16384 | Cấp từ PSRAM, không có PSRAM thì từ RAM trong. Log boot in số byte thực dùng |
| `CONFIG_SPIRAM*` | `sdkconfig.defaults` | Octal, chỉ caps-alloc | Chỉ các lệnh cấp phát `MALLOC_CAP_SPIRAM` mới dùng PSRAM |

Còi chỉ kêu khi `SA_ENABLE_BUZZER=y`. Self-test model luôn chạy lúc boot, không cần bật tuỳ chọn riêng.

## 2. API (`include/ai.h`)

```c
esp_err_t ai_start(const char *device_id);                  // sysload, sau sensor_task_start()
void      ai_feed_sample(const gas_ews_sample_t *sample);   // sensor_task, mỗi lần đọc
esp_err_t ai_set_enabled(bool enabled);                     // công tắc runtime cho lệnh MQTT "ai_set"
bool      ai_get_enabled(void);
```

- Công tắc runtime không lưu NVS: mỗi lần boot quay về `SA_AI_ENABLED_AT_BOOT`.
- Khi AI **OFF**: không chạy model, không kêu còi, không publish `ai/state`. `gas_ews` vẫn tiếp tục nhận mẫu, nên khi bật lại không phải preheat lại hay đợi đầy cửa sổ. Lần bật lại đầu tiên sẽ publish `ai/state` ngay.
- Khi đổi trạng thái, `ai_set_enabled()` publish shadow delta `{"mode":"on","ai_enabled":<bool>,"ts":...}` lên `device/{id}/shadow/report`, giống cách `relay.c` báo trạng thái relay.
- `ai_start()` chỉ trả lỗi khi không tạo được task. Lỗi model/PSRAM chỉ được log.

## 3. Thời gian chạy thực tế

### Chu kỳ

| Việc | Chu kỳ | Ghi chú |
|---|---|---|
| `sensor_task` đọc cảm biến → `ai_feed_sample()` | 5 s | `SA_SENSOR_POLLING_INTERVAL`, phải ≤ 10 s |
| Một bước xử lý (STEL, TWA, ngoại suy, luật) | 10 s | bước được chốt khi mẫu đầu tiên của bước kế tiếp tới |
| `ai_task` thức dậy | mỗi bước mới (10 s) | được `ai_feed_sample()` đánh thức, không dò định kỳ |
| Chạy model | 10 s | đúng 1 lần mỗi bước mới, khi `model_ok` |
| Publish `ai/state` | ngay khi đổi trạng thái + mỗi 60 s | chỉ khi AI ON và có dữ liệu mới |
| Log thời gian suy luận | 1 giờ (360 lần chạy) | `inference timing: ... avg ... max ...` |

Độ trễ từ mẫu tới `ai/state`/còi: bước 10 s được chốt khi mẫu kế tiếp tới, `ai_task` chạy ngay, nên **≤ ~10 s**. Cộng thêm debounce bật (2 bước liên tiếp) là thêm 10 s.

### Mốc sau khi khởi động

Tính từ mẫu cảm biến đầu tiên. Số đo bằng cách chạy chính `gas_ews.c` trên máy tính với mẫu 5 s đều đặn (`tools/sim_gas_ews_timeline.c`), không phải ước lượng:

| Thời điểm | Chuyện gì xảy ra |
|---|---|
| 0 – 10 phút | Preheat: bỏ qua CO/NO2, `warmup=true`, `level=0`. **Không theo dõi được.** |
| ~11 phút | Có STEL (cần ≥ 1 phút dữ liệu) → **luật QCVN bắt đầu chạy** |
| ~15 phút | Có ngoại suy (cần 5 phút liên tục) → cảnh báo sớm từ ngoại suy chạy |
| **~30 phút** | `model_ok` (120 bước = 20 phút liên tục, cả 2 khí) → **model chạy lần đầu**, sau đó 10 s một lần |
| ~8 giờ 10 phút | TWA 8 giờ mới đủ dữ liệu thật (trước đó phần thiếu được tính là 0) |

- Mất dữ liệu > 60 s (mất điện, reboot, `device_mode` OFF làm dừng `sensor_task`) thì quay lại từ đầu bảng này.
- Mất ngắn hơn thì không ảnh hưởng, vì giá trị khí được lấp tối đa 60 s.
- Nếu chỉ một cảm biến khí mất > 60 s thì không preheat lại, nhưng model phải đợi thêm 20 phút dữ liệu liên tục.

### Phản ứng khi khí tăng đột ngột (mô phỏng, chưa tính model)

Không khí sạch CO 2 ppm, sau 60 phút khí tăng vọt và giữ 30 phút:

| Kịch bản | Cảnh báo sớm (ngoại suy) | Vượt ngưỡng (STEL) | Về an toàn sau khi khí giảm |
|---|---|---|---|
| CO 40 ppm | không bật (cần ≥ 1.5 × STEL = 52 ppm) | +13 phút 10 s | 7 phút |
| CO 50 ppm | không bật | +10 phút 30 s | ~10 phút |
| CO 100 ppm | **+60 s** | +5 phút 20 s | ~15 phút |
| CO 300 ppm | **+30 s** | +1 phút 50 s | — |
| NO2 8 ppm | **+50 s** | +10 phút 10 s | 10 phút |

- STEL là trung bình 15 phút nên luôn chậm vài phút. Đó là định nghĩa của QCVN, không phải độ trễ của hệ thống.
- Với CO trong khoảng 35–52 ppm, chỉ model mới có thể báo trước khi STEL vượt ngưỡng.

### Chi phí một lần suy luận

| | Giá trị |
|---|---|
| Phép nhân-cộng | 159,264 / lần (4 CONV_2D + 2 FULLY_CONNECTED) |
| Thời gian trên ESP32-S3 | **chưa đo**, ước lượng vài ms (< 0.1% CPU) |

Trên board, các dòng log sau cho số thật:

```
gas_ews_model: gas_ews model ready: 20896 B flatbuffer, arena used X/16384 B in PSRAM, ...; self-test OK
ai: gas_ews_model_init (AllocateTensors + 2-window self-test): X us
ai: first inference at T s after boot (step N): X us; stack high-water mark: Y bytes free
ai: inference timing: 360 runs, avg X us, max Y us        <- mỗi giờ
```

`T` phải xấp xỉ 1800 s cộng thời gian boot trước khi `sensor_task` đọc mẫu đầu tiên. Nếu lớn hơn nhiều thì có bước bị thiếu dữ liệu.

## 4. Model

| | |
|---|---|
| File | `ai_model/gas_ews_int8.tflite` (thư mục gốc repo): 12,186 tham số, 20,896 B, INT8 toàn phần |
| Kiến trúc | 1D-CNN: `Conv1D(16,k5,s2) → Conv1D(24,k5,s2) → Conv1D(32,k3,s2) → Conv1D(32,k3,s2) → Dense(16) → Dense(2, sigmoid)` |
| Đầu vào | 120 bước × 8 kênh (20 phút): CO, NO2, STEL CO, STEL NO2, ngoại suy CO, ngoại suy NO2 (đều là `log2(1 + x/ngưỡng STEL)`), `(T−28)/5`, `(RH−70)/20` |
| Đầu ra | `p_co`, `p_no2` = xác suất STEL thật vượt QCVN trong 10 phút tới |
| Ngưỡng | model: CO 0.90, NO2 0.05; ngoại suy: CO 1.5 × STEL, NO2 0.6 × STEL (chọn trên tập VAL) |
| Op | CONV_2D, FULLY_CONNECTED, LOGISTIC, RESHAPE |
| Self-test | 2 cửa sổ int8 kèm đầu ra chuẩn (`gas_ews_selftest.h`, tự sinh khi export). Lệch > 1 LSB → tắt model |

Kết quả trên tập test mô phỏng (hệ thống đầy đủ):
- CO: báo trước 92% đợt, trung vị sớm hơn +6.5 phút, 0.21 lần báo nhầm/ngày.
- NO2: báo trước 100% đợt, +12.7 phút, 0.19 lần báo nhầm/ngày.

Chi tiết và kiểm thử trên dữ liệu thật: [REVIEW_MODEL.md](REVIEW_MODEL.md), `ungdungdidong/gas_ews/README.md`.

## 5. MQTT `device/{id}/ai/state`

QoS 1, không retain.

```json
{"standard":"QCVN 03:2019/BYT","level":1,"level_name":"canh_bao_som","warmup":false,
 "model_ready":true,"model_ok":true,
 "co": {"ppm":12.7,"stel15":16.8,"twa8h":2.1,"proj10":14.0,"p_model":0.004,"level":0,
        "rule":false,"proj_alarm":false,"model_alarm":false},
 "no2":{"ppm":2.08,"stel15":4.31,"twa8h":0.4,"proj10":3.9,"p_model":0.0,"level":1,
        "rule":false,"proj_alarm":true,"model_alarm":false},
 "ts":1777631761}
```

- `level`: 0 = an toàn, 1 = cảnh báo sớm, 2 = vượt ngưỡng. Giá trị ở gốc là mức cao nhất của hai khí.
- Giá trị chưa biết (đang preheat, thiếu dữ liệu, model chưa chạy) được gửi là `null`.
- Schema này thay schema cũ (`ready`/`alert`/`confidence`). Server và app hiện chưa đọc nội dung topic này.
- EMQX chạy với `no_match = deny`, `deny_action = disconnect`. `server/api/src/services/emqx.js` đã cho phép topic này, nhưng ACL chỉ được ghi khi đăng ký thiết bị. **Thiết bị đăng ký trước đó phải được thêm rule trước khi bật AI**, nếu không mỗi lần publish sẽ bị ngắt kết nối.

## 6. Kiểm thử

**Golden test** (`gas_ews.c` so với Python từng bước, 3 bộ dữ liệu, 8,342 bước):

```bash
cd tools
gcc -std=c99 -O2 -Wall -Wextra -I../include test_gas_ews_host.c ../gas_ews.c -o test_gas_ews -lm
./test_gas_ews golden        # -> "All tests passed."
```

**Mô phỏng mốc thời gian:**

```bash
cd tools
gcc -std=c99 -O2 -I../include sim_gas_ews_timeline.c ../gas_ews.c -o sim -lm && ./sim
```

**Trên board:** build với `SA_ENABLE_AI=y`, flash, xem log boot có `self-test OK`, rồi đọc các dòng thời gian ở mục 3. Checklist đầy đủ: [BOARD_TEST.md](BOARD_TEST.md).

**Replay dữ liệu mô phỏng trên board** (không cần khí): bật `SA_AI_REPLAY` và chọn `SA_AI_REPLAY_SCENARIO` (0 = `co_event`, 1 = `no2_event`). AI bỏ qua số đọc thật và phát lại kịch bản trong `ai_replay_data.h` trên đồng hồ mô phỏng, tua nhanh `SA_AI_REPLAY_SPEED` lần (mặc định 60: kịch bản 72 phút chạy trong ~72 s). Mỗi bước in một dòng `RS,`; so log với kết quả Python bằng `tools/replay/compare_replay_log.py` (xem [BOARD_TEST.md](BOARD_TEST.md) mục 5A). Chỉ dùng để test, không bao giờ bật khi build bản dùng thật.

Sau khi train lại model, cập nhật model, `gas_ews_contract.h`, `gas_ews_selftest.h`, golden vector, rồi dữ liệu replay bằng:

```bash
cd ungdungdidong
PYTHONPATH=. .venv_export/Scripts/python -m gas_ews.export_firmware --fw D:/project/aiot-edge
PYTHONPATH=. .venv_export/Scripts/python -m gas_ews.export_replay --fw D:/project/aiot-edge
```

## 7. Trước khi dùng thật

- **Phải hiệu chuẩn cảm biến** (preheat ≥ 24 giờ, rồi chạy `calibrate_co` / `calibrate_no2`). Khi chưa hiệu chuẩn, GM-102B đọc khoảng 2 ppm NO2 trong không khí sạch, tức 75% ngưỡng TWA của NO2.
- Có khoảng **10 phút không theo dõi được** sau mỗi lần khởi động hoặc sau khi `device_mode` bật lại, do cảm biến MOS cần preheat.
- Lịch sử chỉ nằm trong RAM: khởi động lại thì TWA 8 giờ bắt đầu lại từ 0.
- Model nhạy với độ ẩm. Nhiệt độ < 22.5 °C hoặc độ ẩm < 47.9 % nằm ngoài dải huấn luyện.
- Model được train trên mô phỏng và kiểm thử trên dữ liệu thật công khai. Bước kiểm chứng cuối cùng vẫn là thiết bị đặt cạnh một máy đo tham chiếu.
- RAM tĩnh: khoảng 12 KB cho `gas_ews`, 3.8 KB buffer cửa sổ trong `ai.c`. Arena 16 KB nằm trong PSRAM.

Rà soát đầy đủ: [REVIEW_HOAT_DONG.md](REVIEW_HOAT_DONG.md) (hệ thống, TWA), [REVIEW_MODEL.md](REVIEW_MODEL.md) (model). Nhật ký công việc: [WORKLOG.md](WORKLOG.md).

## 8. File

```
components/core/ai/
├── include/ai.h               API công khai
├── include/gas_ews.h          tiền xử lý + luật + logic cảnh báo (C99, test được trên PC)
├── include/gas_ews_model.h    wrapper TFLite Micro
├── include/gas_ews_contract.h TỰ SINH từ model_contract.json, không sửa tay
├── ai.c                       ai task, còi + MQTT, công tắc runtime
├── gas_ews.c
├── gas_ews_model.cpp          arena PSRAM, self-test lúc boot
├── gas_ews_selftest.h         TỰ SINH: 2 cửa sổ int8 + đầu ra chuẩn
├── ai_replay_data.h           TỰ SINH: kịch bản replay (chỉ build khi SA_AI_REPLAY=y)
├── BOARD_TEST.md              checklist test trên board
└── tools/                     golden test, golden vector, mô phỏng mốc thời gian,
                               replay/ (đầu vào + kết quả mong đợi của kịch bản replay,
                               compare_replay_log.py so log board với kết quả mong đợi)
```
