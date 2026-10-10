# Rà soát riêng phần model AI của `gas_ews` và lịch hoạt động trên hệ thống

Ngày rà soát: 2026-09-26, nhánh `feature/ai-inference`. Cập nhật cùng ngày cho model **cửa sổ 20 phút** (120 bước), chạy cho cả CO và NO2, và khi chuyển sang `components/core/ai` của `feature/ai-sprint2` (arena trong PSRAM, task theo sự kiện, công tắc `ai_set`).

Phạm vi: **chỉ model** 1D-CNN INT8 ([gas_ews_model.cpp](gas_ews_model.cpp)), cách nó được gọi trong [ai.c](ai.c) và cách kết quả được dùng trong [gas_ews.c](gas_ews.c). Luật QCVN, ngoại suy, MQTT và còi đã được rà ở [REVIEW_HOAT_DONG.md](REVIEW_HOAT_DONG.md).

Nguồn số liệu:
- Mốc thời gian: chạy `gas_ews.c` thật trên máy tính ([sim_gas_ews_timeline.c](tools/sim_gas_ews_timeline.c)).
- Độ nhạy của model: chạy `gas_ews_int8.tflite` bằng TFLite interpreter trên 2 cửa sổ self-test, thay đổi kênh nhiệt độ/độ ẩm.
- **Chưa chạy trên ESP32-S3.** Thời gian `Invoke()` trên chip vẫn là ước lượng.

---

## 1. Kết luận

Cách **tích hợp** model đã ổn:
- model chỉ thêm cảnh báo, không bao giờ tắt được luật;
- có self-test lúc khởi động;
- không cấp phát động;
- tham số lượng tử hoá được đọc từ file model chứ không gõ tay.

Còn **3 điểm cần xử lý trước khi tin model**:

| # | Vấn đề | Mức độ |
|---|---|---|
| M1 | Model phụ thuộc mạnh vào độ ẩm, và **T < 22.5 °C hoặc RH < 47.9 % bị kẹp** do dải lượng tử hoá INT8. Phòng máy lạnh hoặc mùa khô nằm ngoài dải huấn luyện, và model báo sớm ít hơn hẳn | 🟠 |
| M2 | **Model NO2 chưa mang lại lợi ích** so với ngoại suy (0 đợt model báo được mà ngoại suy bỏ lỡ, 2 đợt ngược lại). Giữ lại để hai khí dùng cùng một cơ chế; chưa thấy báo nhầm riêng | ⚪ (theo dõi) |
| M3 | Chưa đo trên chip: thời gian `Invoke()`, arena, stack, và self-test có qua không | 🟡 (việc phải làm, không phải lỗi) |

---

## 2. Những gì đã ổn ✅

| Điểm | Chi tiết |
|---|---|
| Kích thước | Cửa sổ 120 bước × 8 kênh (20 phút). 12,186 tham số, 20,896 B flash; arena 16 KB trong PSRAM, không có PSRAM thì RAM trong (chưa đo, activation lớn nhất chỉ 1 KB); buffer cửa sổ 3.8 KB tĩnh |
| Tính toán | 159,264 phép nhân-cộng mỗi lần (4 CONV_2D + 2 FULLY_CONNECTED); ước lượng vài ms trên ESP32-S3 |
| Op | Chỉ 4 op (`CONV_2D, FULLY_CONNECTED, LOGISTIC, RESHAPE`), resolver chỉ đăng ký đúng 4 op này |
| Self-test | 2 cửa sổ có đầu ra chuẩn từ lúc export. Lệch > 1 LSB (= 0.004 xác suất) → model tắt cả phiên, luật vẫn chạy |
| Lượng tử hoá | Scale/zero-point đọc từ flatbuffer. Đầu vào được kẹp [-128, 127] giống lúc kiểm chứng trên Python. INT8 khớp bản float 99.91% (CO) / 99.995% (NO2) |
| Độ phân giải đầu ra | 1/256. Ngưỡng CO 0.90 và NO2 0.05 cách xa sai số self-test |
| Không dùng kết quả cũ | Mỗi bước mới: model không chạy được → báo "không có kết quả", tính là "dưới ngưỡng" |
| Luồng/khoá | Model chạy trong `ai_task` (priority 3, APP_CPU), thấp hơn `sensor_task`, được đánh thức ngay khi có bước 10 s mới. Khoá spinlock chỉ giữ trong lúc copy 3.8 KB cửa sổ, cỡ vài µs |
| Đầu vào quá lớn | Kênh khí kẹp ở 13.2 × STEL (CO ≈ 460 ppm). Ở mức đó luật đã báo vượt ngưỡng từ lâu, nên kẹp không làm mất cảnh báo |
| Đóng góp của model CO | Theo `ungdungdidong/gas_ews/README.md`: có model thì tỉ lệ báo trước tăng từ 71% lên 92%, lead trung vị từ +1.5 lên +6.5 phút. So từng đợt với ngoại suy: model báo được 21 đợt mà ngoại suy bỏ lỡ, ngược lại chỉ 2 đợt |
| Độ dài cửa sổ | Đã so 30 / 20 / 15 / 10 phút (cùng seed). 20 phút bằng hoặc tốt hơn 30 phút ở mọi chỉ số, và model chạy sớm hơn 10 phút. Bảng so sánh ở `ungdungdidong/gas_ews/README.md` mục 5 |

---

## 3. Những gì chưa ổn ⚠️

### M1. 🟠 Nhiệt độ/độ ẩm ngoài dải huấn luyện, và bị kẹp

Kênh 6/7 của model là `(T − 28) / 5` và `(RH − 70) / 20`. Dải INT8 của đầu vào là [−1.10, 3.83], tương ứng:

| | Biểu diễn được | Dải lúc train (`simulate.py`) | Dữ liệu thiết bị thật (862 mẫu) |
|---|---|---|---|
| Nhiệt độ | **≥ 22.5 °C** | khoảng 22 – 35 °C | 30.0 – 32.1 °C |
| Độ ẩm | **≥ 47.9 %RH** | khoảng 48 – 92 %RH | 74 – 81 %RH |

Dữ liệu thiết bị hiện có nằm gọn trong dải. Nhưng phòng máy lạnh (20–24 °C, 40–55 %RH) hoặc mùa khô thì không. Ở đó model gặp dữ liệu chưa từng thấy, và giá trị còn bị kẹp (18 °C và 22 °C cho **cùng** kết quả).

Model nhạy với độ ẩm hơn nhiều so với mức người ta thường nghĩ. Ví dụ, cửa sổ self-test số 1 (CO đang tăng, T 29.8 °C, RH 62 %, p gốc = 0.852, ngưỡng CO 0.90), chỉ đổi T/RH:

| | RH 40 % | RH 55 % | RH 70 % | RH 85 % |
|---|---:|---:|---:|---:|
| T 22 °C | 0.555 | 0.500 | 0.609 | 0.391 |
| T 26 °C | 0.555 | 0.660 | 0.879 | **0.957** |
| T 30 °C | 0.391 | 0.660 | 0.852 | 0.824 |
| T 34 °C | 0.027 | 0.176 | 0.750 | 0.750 |

(in đậm = vượt ngưỡng 0.90, tức model cảnh báo). Ở 30 °C, p giảm từ 0.85 (RH 70 %) xuống 0.39 (RH 40 %). Model 30 phút trước đó có cùng xu hướng, nên đây là đặc điểm của dữ liệu huấn luyện, không phải do đổi cửa sổ.

Cùng một diễn biến CO, không khí khô thì model **không** cảnh báo sớm. Điều này hợp lý một phần: bộ mô phỏng có hiệu ứng độ ẩm lên số đọc cảm biến, nên model học cách bù. Nhưng mức phụ thuộc như trên chưa được kiểm chứng trên cảm biến thật.

Hướng lỗi là **an toàn**: model báo ít đi chứ không báo nhầm nhiều hơn, và luật STEL vẫn bắt được. Tuy vậy, con số "báo trước 92%" không áp dụng cho phòng khô/lạnh.

Đề xuất:
1. Mở rộng dải T/RH trong `simulate.py` (ví dụ 16–38 °C, 30–95 %RH) rồi train lại. Dải lượng tử hoá sẽ tự mở theo.
2. Trong `ai/state` hoặc log, cảnh báo khi T/RH nằm ngoài dải lúc train (`model_in_range:false`).
3. Kiểm tra độ lệch nhiệt độ của SHT3x trong vỏ máy, vì cảm biến MOS có bộ gia nhiệt. Model nhạy với T, nên lệch +3 °C cũng đáng kể.

### M2. ⚪ Model NO2 chưa mang lại lợi ích (giữ lại để đồng nhất)

Với NO2, ngoại suy đã báo trước 100% đợt, và model **không thêm** được đợt nào (0 so với 2 trên TEST). Model được giữ cho cả hai khí theo quyết định dùng một cơ chế thống nhất. Hiện chưa thấy tác hại:
- hệ thống chọn cho NO2 báo nhầm 0.19 lần/ngày, thấp hơn bản 30 phút (0.25);
- trên dữ liệu thiết bị thật, model NO2 báo khoảng 5 phút, **nằm trọn trong** khoảng ngoại suy đã báo sẵn (0 bước model báo riêng).

Cần theo dõi `no2.model_alarm` trong `ai/state` khi chạy chỉ quan sát. Nếu model NO2 bật mà `proj_alarm` không bật thì đó là báo nhầm riêng của model; khi đó mới cân nhắc nâng ngưỡng (ở `ungdungdidong`, không sửa tay header tự sinh).

### M3. 🟡 Chưa đo trên chip

Khi flash lần đầu, đọc các dòng log sau:

```
gas_ews_model: gas_ews model ready: 20896 B flatbuffer, arena used X/16384 B in PSRAM, ...; self-test OK
ai: gas_ews_model_init (AllocateTensors + 2-window self-test): X us
ai: first inference at T s after boot (step N): X us; stack high-water mark: Y bytes free
ai: inference timing: 360 runs, avg X us, max Y us                    (mỗi giờ)
```

| Kiểm tra | Đạt khi |
|---|---|
| self-test | có `self-test OK`. Nếu báo sai: runtime trên chip khác interpreter tham chiếu, cần tìm nguyên nhân trước khi dùng model |
| arena | X ≪ 16384 → giảm `SA_AI_TENSOR_ARENA_SIZE` còn X + 1 KB; dòng log cho biết arena nằm ở PSRAM hay RAM trong |
| thời gian | max ≪ 10 s (một bước); dự kiến vài ms |
| thời điểm chạy đầu | T ≈ 1800 s + thời gian boot |
| stack | còn ≥ 1 KB |

### Các điểm nhỏ ⚪

- **Một cảm biến hỏng thì tắt model của cả hai khí**: `model_ok` đòi cả CO và NO2 hợp lệ 20 phút. Nếu GM102B hỏng, model CO cũng không chạy. Chấp nhận được, vì model được train với cả 8 kênh.
- **Bước bị bỏ qua được tính là "dưới ngưỡng"**: nếu `ai_task` chưa kịp chạy mà đã có 2 bước mới (ví dụ sau một khoảng mất dữ liệu được lấp một lượt), bước giữa bị tính là miss. Khi đó chuỗi 2 lần liên tiếp để bật cảnh báo bị ngắt, chỉ làm trễ thêm khoảng 10 s.
- **AI OFF (`ai_set`)**: model không chạy. Khi bật lại, các bước đã bỏ qua được tính là miss, nên cảnh báo của model (nếu có) được xoá, không dùng kết quả cũ.
- **Cảnh báo của model tắt chậm 5 phút** kể cả khi model ngừng chạy (mất dữ liệu): các lần "không có kết quả" được tính là miss, qua debounce tắt 30 bước. Đây là hướng bảo thủ, hợp lý.

---

## 4. Lịch hoạt động của model trên hệ thống

### 4.1 Từ lúc khởi động

`t` tính từ mẫu cảm biến đầu tiên. Các mốc đã kiểm chứng bằng mô phỏng.

```
t:   0        10 phút          30 phút                                   →
     │─ preheat ─│─ đầy cửa sổ 20 ─│── model chạy mỗi 10 s ─────────────────→
     ▲                             ▲
     init + self-test (lúc task    Invoke lần đầu
     khởi động, vài chục ms)       (log "first inference at T s")
```

| Giai đoạn | Thời gian | Model làm gì | `ai/state` |
|---|---|---|---|
| Boot, `ai_start()` | vài giây đầu | `AllocateTensors` + self-test 2 lần `Invoke` | `model_ready` = kết quả self-test |
| Preheat | 0 – 10 phút | **không chạy**, khí bị bỏ qua | `warmup:true`, `model_ok:false`, `p_model:null` |
| Đầy cửa sổ | 10 – 30 phút | **không chạy**, luật STEL (từ ~11 phút) và ngoại suy (từ ~15 phút) đã chạy | `model_ok:false`, `p_model:null` |
| Hoạt động | từ **~30 phút** | chạy **1 lần mỗi 10 s** trên 20 phút dữ liệu gần nhất, dự báo STEL vượt ngưỡng trong 10 phút tới | `model_ok:true`, `p_model` có giá trị |

### 4.2 Trong một bước 10 giây

```
sensor_task:  mẫu ───── 5 s ───── mẫu ───── 5 s ───── mẫu (thuộc bước k+1) → chốt bước k
ai_task:                                          được đánh thức ngay (xTaskNotifyGive)
                                                  ├─ copy cửa sổ 120×8        ~µs
                                                  ├─ lượng tử hoá + Invoke()   vài ms (chưa đo)
                                                  ├─ gas_ews_set_model_result → debounce
                                                  └─ đổi mức → còi + publish ai/state
```

| Sự kiện | Độ trễ |
|---|---|
| Bước được chốt → model chạy xong | vài ms |
| p ≥ ngưỡng lần đầu → **cảnh báo sớm bật** | lần thứ 2 liên tiếp, tức thêm 10 s → **~10 s** |
| p < ngưỡng → **cảnh báo sớm tắt** | 30 lần liên tiếp = **5 phút** |
| Model dự báo trước bao lâu | đến 10 phút (horizon lúc train). Lead trung vị trên mô phỏng: +6.5 phút với CO, +12.7 phút với NO2 |

### 4.3 Khi bị gián đoạn

| Sự kiện | Model ngừng | Chạy lại sau |
|---|---|---|
| Mất mẫu khí ≤ 60 s | không ngừng (lấp giá trị) | — |
| Một cảm biến khí mất > 60 s | ngay khi hết lấp | 20 phút dữ liệu liên tục |
| Mất toàn bộ cảm biến > 60 s, reboot, `device_mode` OFF | ngay | **30 phút** (10 preheat + 20 cửa sổ) |
| Self-test sai lúc boot | cả phiên | lần boot sau |
| `Invoke` lỗi | bước đó (tính là miss) | bước kế tiếp |

### 4.4 Khối lượng mỗi ngày

| | Giá trị |
|---|---|
| Số lần chạy, không gián đoạn | 360 lần/giờ, **8,640 lần/ngày** |
| Ngày có boot | 8,460 lần (mất 30 phút đầu) |
| CPU, giả sử 3–5 ms/lần | khoảng 26–43 s/ngày ≤ **0.05%** (sẽ thay bằng số đo thật từ log `inference timing`) |
| Dữ liệu `p_model` trên MQTT | trong mỗi `ai/state` (khi đổi mức + mỗi 60 s) |

---

## 5. Việc cần làm cho phần model

| Ưu tiên | Việc | Giải quyết |
|---|---|---|
| 1 | Flash, đọc 4 dòng log ở M3 | M3 |
| 2 | Chạy chỉ quan sát vài ngày, ghi lại T/RH thực tế và `p_model`. Nếu T/RH thường xuyên dưới 22.5 °C / 47.9 % thì M1 là vấn đề thật | M1 |
| 3 | Mở rộng dải T/RH khi mô phỏng, train lại, `export_firmware` | M1 |
| 4 | Theo dõi `no2.model_alarm` so với `no2.proj_alarm` trong `ai/state`; chỉ nâng ngưỡng nếu model NO2 báo riêng | M2 |
| 5 | Chạy thêm 3–5 seed cho cửa sổ 20 và 30 phút để chắc chênh lệch không phải ngẫu nhiên | độ dài cửa sổ |
| 6 | Đặt thiết bị cạnh máy đo CO tham chiếu, tạo sự cố có kiểm soát, so lead time thật với +6.5 phút | toàn bộ |
