# Rà soát cách hoạt động của `gas_ews`: đã phù hợp chưa?

Ngày rà soát: 2026-09-25, nhánh `feature/ai-inference`. Cập nhật 2026-09-26 khi chuyển sang cấu trúc `components/core/ai` của `feature/ai-sprint2` (nhánh `feature/ai-gas-ews`): AI chỉ báo còi + publish, không điều khiển relay; có công tắc `ai_set`.

Phạm vi: toàn bộ luồng cảnh báo CO/NO2 trên thiết bị, gồm `sensor_task` → [`gas_ews.c`](gas_ews.c) → [`ai.c`](ai.c) → MQTT/còi. Mô tả chi tiết từng thành phần nằm trong [README.md](README.md). Tài liệu này chỉ đánh giá.

Nguồn số liệu:
- Mọi mốc thời gian trong tài liệu được lấy bằng cách chạy chính `gas_ews.c` trên máy tính, qua [`tools/sim_gas_ews_timeline.c`](tools/sim_gas_ews_timeline.c) (mẫu 5 s đều đặn, không có model). Không phải ước lượng.
- **Chưa build bằng ESP-IDF, chưa chạy trên board.**

---

## 1. Kết luận ngắn

**Phần lõi đúng hướng và đủ tin cậy về mặt tính toán:**
- Luật QCVN (STEL/TWA) độc lập với model.
- Model chỉ có thể *thêm* cảnh báo, và tự tắt nếu self-test sai.
- Code C khớp Python 0 sai khác trên 8,342 bước (có 3.2 giờ dữ liệu thật).

**Chưa phù hợp để dùng thật** vì 4 điểm, xếp theo mức độ:

| # | Vấn đề | Mức độ |
|---|---|---|
| A | Cảnh báo chỉ tới người dùng qua **còi**: server/app chưa đọc `ai/state`. Tắt AI bằng `ai_set` thì tắt luôn còi của luật QCVN | 🟠 |
| B | Tắt `device_mode` là **ngừng giám sát khí**. Bật lại thì thêm 10 phút mù | 🔴 |
| C | TWA mất sau mỗi lần reboot: phơi nhiễm kéo dài có thể bị **báo trễ vài giờ** | 🟠 |
| D | Ngưỡng QCVN 03:2019 là cho **nơi làm việc 8 giờ/ngày**. Nếu thiết bị đặt trong nhà ở, các ngưỡng này lỏng hơn khuyến nghị sức khoẻ | 🟠 (cần quyết định sản phẩm) |

Chi tiết và đề xuất sửa ở mục 4.

---

## 2. Hệ thống hoạt động thế nào (tóm tắt)

```
Cảm biến (mỗi 5 s)
  → bỏ 10 phút preheat
  → gộp bước 10 s
  → tính STEL 15 phút, TWA 8 giờ, ngoại suy STEL 10 phút tới
  → 3 lớp quyết định cho mỗi khí:
       1. VƯỢT NGƯỠNG  : STEL ≥ ngưỡng  hoặc  TWA ≥ ngưỡng      (luật QCVN, luôn chạy)
       2. CẢNH BÁO SỚM : ngoại suy ≥ k × ngưỡng STEL           (luật vật lý, luôn chạy)
       3. CẢNH BÁO SỚM : model 1D-CNN dự báo vượt STEL trong 10 phút  (chạy mỗi 10 s)
  → level = 0 an toàn / 1 cảnh báo sớm / 2 vượt ngưỡng
  → ai/state (MQTT) + còi (khi mức tăng lên); không điều khiển relay
```

| Sau khởi động | Hoạt động |
|---|---|
| 0 – 10 phút | Preheat. **Không giám sát** |
| ~11 phút | Luật STEL chạy |
| ~15 phút | Ngoại suy chạy |
| ~30 phút | Model chạy lần đầu (cửa sổ 20 phút), sau đó 10 s/lần |
| ~8 giờ 10 phút | TWA có đủ 8 giờ lịch sử (giải thích ở mục 3) |

---

## 3. TWA là gì, đóng vai trò gì, tại sao "8 giờ mới đủ"

### 3.1 Định nghĩa

**TWA** (*Time-Weighted Average*, trung bình theo thời gian) là **tổng liều khí hít vào trong 8 giờ, chia cho 8 giờ**:

```
TWA = Σ (Cᵢ × tᵢ) / 8 giờ
```

- `Cᵢ`: nồng độ trong khoảng thời gian `tᵢ`.
- Khoảng thời gian không có dữ liệu được tính là **0**.

Đây đúng là cách QCVN 03:2019/BYT định nghĩa giới hạn TWA: nồng độ trung bình cho một ca làm việc 8 giờ. Trong firmware ([gas_ews.c](gas_ews.c), hàm `process_step`):
- dữ liệu được cộng vào 480 "xô" 1 phút (`GAS_EWS_TWA_BUCKET_STEPS = 6` bước × 10 s);
- TWA = tổng 480 xô / 2880 bước;
- cửa sổ **trượt**: luôn là 8 giờ gần nhất.

Ví dụ: 2 giờ CO 40 ppm, 6 giờ còn lại 0 ppm → TWA = (40 × 2 + 0 × 6) / 8 = **10 ppm**, dưới ngưỡng 17.46.

### 3.2 Vai trò: TWA bắt cái STEL không bắt được

Hai giới hạn trả lời hai câu hỏi khác nhau:

| | STEL (15 phút) | TWA (8 giờ) |
|---|---|---|
| Câu hỏi | Có đợt nồng độ cao **ngắn** nào nguy hiểm không? | Tổng lượng khí hít vào **cả ngày** có quá mức không? |
| Nguy cơ | Ngộ độc cấp | Phơi nhiễm mạn tính, liều tích luỹ (CO gắn vào hemoglobin tích dần) |
| Ngưỡng CO | 34.92 ppm | 17.46 ppm |
| Ngưỡng NO2 | 5.31 ppm | 2.66 ppm |

Nồng độ **nằm giữa hai ngưỡng**, ví dụ CO 25 ppm kéo dài (bếp than cháy âm ỉ, phòng kín thông gió kém), **không bao giờ** làm STEL vượt ngưỡng. Chỉ có TWA phát hiện được. Kết quả mô phỏng:

| CO liên tục từ lúc bật máy | STEL vượt? | TWA vượt sau |
|---|---|---|
| 20 ppm | không bao giờ | 7 giờ 9 phút |
| 25 ppm | không bao giờ | 5 giờ 46 phút |
| 30 ppm | không bao giờ | 4 giờ 50 phút |
| 300 ppm (từ phút 60) | sau 110 s | 28 phút (STEL đã báo từ lâu) |
| NO2 3 ppm | không bao giờ | 7 giờ 16 phút |

Công thức kiểm tra: thời gian đến lúc báo = 8 giờ × (ngưỡng TWA / nồng độ) + 10 phút preheat. Với CO 25 ppm: 8 × 17.46 / 25 = 5.59 h + 0.17 h = 5.76 h, khớp mô phỏng.

### 3.3 "8 giờ mới đủ" nghĩa là gì chính xác

**Không** có nghĩa là phải đợi 8 giờ thì TWA mới hoạt động. TWA được tính và so ngưỡng **ngay từ phút thứ 11**. Nếu nồng độ đủ cao (CO ≥ ~140 ppm), liều 8 giờ có thể bị dùng hết trong chưa tới 1 giờ và TWA báo ngay.

"8 giờ mới đủ" nghĩa là: sau khi bật máy, thiết bị **không biết** người trong phòng đã hít bao nhiêu khí trong 8 giờ trước đó, nên phần đó được tính là 0.
- **Trong 8 giờ đầu**, TWA hiển thị **≤ TWA thật**, tức đánh giá thấp. Nó chỉ đúng nếu thật sự không có khí trước khi bật máy.
- **Sau 8 giờ 10 phút**, cả cửa sổ 8 giờ đều là dữ liệu đo được, và TWA mới phản ánh đúng liều thật.

Đánh giá thấp là an toàn theo một hướng (không báo nhầm) nhưng **không an toàn theo hướng kia**: có thể **báo trễ**. Ví dụ mô phỏng: CO 25 ppm liên tục, thiết bị reboot ở giờ thứ 5:

| | Không reboot | Reboot ở giờ thứ 5 |
|---|---|---|
| TWA báo vượt ngưỡng | sau 5 giờ 46 phút | sau **10 giờ 46 phút** |
| Người trong phòng đã hít | ~liều 8 giờ | **~1.9 lần liều 8 giờ** trước khi có cảnh báo |

Đây là vấn đề C ở mục 4.

---

## 4. Đánh giá chi tiết

### 4.1 Những gì đã phù hợp ✅

| Điểm | Vì sao phù hợp |
|---|---|
| Luật QCVN độc lập với model | Model lỗi, chưa đủ dữ liệu hoặc self-test sai thì luật vẫn chạy. Model chỉ OR thêm cảnh báo |
| Self-test model lúc boot | 2 cửa sổ có kết quả chuẩn từ lúc export. Runtime lệch > 1 LSB → model tự tắt, không đoán bừa |
| Đồng hồ đơn điệu (`esp_timer`) | SNTP chỉnh giờ không bị hiểu nhầm thành mất dữ liệu |
| Bỏ 10 phút preheat | Cảm biến MOS vừa bật thường đọc vọt lên tới trần. Không bỏ thì sẽ báo nhầm mỗi lần khởi động |
| Debounce: bật sau 2 bước, tắt sau 30 bước (5 phút) | Không nháy trạng thái quanh ngưỡng. Quạt không bật/tắt liên tục |
| Phản ứng với nồng độ nguy hiểm | CO 300 ppm: cảnh báo sớm +30 s, vượt ngưỡng +110 s. CO 1000 ppm: +20 s / +40 s. Nhanh đủ cho tình huống cấp cứu |
| Chi phí tính toán | Khoảng 160k phép nhân-cộng mỗi 10 s. Ước lượng < 0.1% CPU (chưa đo trên board). RAM tĩnh khoảng 32 KB |
| Port C khớp Python | Golden test 8,342 bước, 0 sai khác. Đã thử sửa sai một hằng số để chắc test bắt được lỗi |
| Chu kỳ đọc thực tế 5–6 s | Đã có trong dữ liệu thật của golden test: gộp theo khe 5 s và lấp 60 s xử lý được |

### 4.2 Những gì chưa phù hợp ⚠️

#### A. 🟠 Cảnh báo chỉ tới người dùng qua còi

Khi build với `SA_ENABLE_AI=y`, AI bật sẵn sau boot (`SA_AI_ENABLED_AT_BOOT=y`) và kêu còi khi mức tăng lên (3 tiếng dài: cảnh báo sớm, 4 tiếng rất dài: vượt ngưỡng). Nhưng:
- server chưa đọc `ai/state`, app không hiển thị mức cảnh báo;
- người không ở cạnh thiết bị không biết gì;
- tắt AI bằng `ai_set` thì tắt **cả** còi và `ai/state` của luật QCVN, không chỉ model. Người dùng có thể nghĩ mình chỉ tắt "AI".

Đề xuất: server lưu `ai/state`, app hiển thị và push thông báo khi `level` ≥ 1. Cân nhắc cho `ai_set` chỉ tắt model, còn luật QCVN (level 2) luôn kêu còi.

#### B. 🔴 Tắt `device_mode` là ngừng giám sát khí

`device_mode` OFF làm dừng `sensor_task`, nên `gas_ews` không nhận mẫu nào. Bật lại thì preheat 10 phút nữa. Người dùng có thể hiểu "tắt thiết bị" là tắt quạt/đèn (relay), không biết là tắt luôn cảnh báo khí độc.

Đề xuất: khi `device_mode` OFF, `sensor_task` vẫn đọc cảm biến và gọi `gas_ews_feed()`, chỉ ngừng publish telemetry và điều khiển relay. Cảm biến MOS được cấp nguồn liên tục thì cũng không cần preheat lại. Nếu buộc phải giữ hành vi hiện tại, cần ghi rõ trong app.

#### C. 🟠 TWA mất sau reboot

Lịch sử TWA chỉ nằm trong RAM (mục 3.3). Reboot do OTA, crash hay watchdog đều xoá liều đã tích luỹ. Ví dụ trên cho thấy cảnh báo trễ 5 giờ.

Đề xuất, từ rẻ tới đắt:
1. Đặt 480 xô TWA (đổi `double` → `float`: 2 khí × 480 × 4 B = **3.8 KB**) vào `RTC_NOINIT_ATTR`. Vùng nhớ này giữ được qua reboot mềm, OTA, crash, watchdog; chỉ mất khi mất điện. Khi khởi động lại, dùng DS3231 (thiết bị đã có) để tính khoảng thời gian đã mất, rồi đẩy xô tương ứng.
2. Lưu thêm snapshot vào NVS mỗi 10–15 phút để chịu được mất điện (khoảng 100 lần ghi/ngày, không đáng kể với wear leveling).
3. Tối thiểu: trong `ai/state` thêm `twa_hours_covered` để server/app biết TWA đang dựa trên bao nhiêu giờ dữ liệu.

#### D. 🟠 QCVN 03:2019/BYT là quy chuẩn nơi làm việc

QCVN 03:2019/BYT giả định **một ca 8 giờ**, người lao động khoẻ mạnh, và 16 giờ còn lại được nghỉ trong không khí sạch. Nếu thiết bị đặt **trong nhà ở** (người ở 24 giờ, có trẻ em, người già, người bệnh tim), các khuyến nghị sức khoẻ nghiêm hơn nhiều. Ví dụ khuyến nghị chất lượng không khí trong nhà của WHO (2010) cho CO 8 giờ là 10 mg/m³ (khoảng 8.7 ppm), bằng một nửa TWA của QCVN.

Đây là **quyết định sản phẩm**, không phải lỗi code: chọn "nơi làm việc" hay "nhà ở".

Lưu ý về NO2: các mức khuyến nghị cho nhà ở nằm dưới 0.1 ppm, tức dưới dải đo của GM102B (0.1–10 ppm). Với nhà ở, cảm biến này chỉ bắt được NO2 ở mức sự cố.

#### E. 🟡 Chưa hiệu chuẩn NO2 thì TWA NO2 gần như chắc chắn báo nhầm

GM102B chưa hiệu chuẩn đọc khoảng **2 ppm** trong không khí sạch:
- tức **75% ngưỡng TWA NO2** (2.66 ppm) và 38% ngưỡng STEL;
- trên dữ liệu thật, STEL NO2 đã lên tới 0.83 × ngưỡng.

Chỉ cần nền trôi thêm 0.7 ppm là sau vài giờ TWA báo "vượt ngưỡng" giả, và `level=2` sẽ kêu còi dài. Mục "Trước khi dùng thật" trong README đã yêu cầu hiệu chuẩn, nhưng firmware không ngăn được việc chạy khi chưa hiệu chuẩn.

Đề xuất: lưu cờ "đã hiệu chuẩn" (NVS, do `calibrate_no2` ghi). Chưa hiệu chuẩn thì báo `calibrated:false` trong `ai/state`, và không cho `level` của NO2 kêu còi.

#### F. 🟡 Mức cảnh báo sớm NO2 thực tế là "khoảng 60% ngưỡng"

Ngưỡng ngoại suy NO2 = 0.6 × STEL và ngưỡng model NO2 = 0.05 được chọn trên dữ liệu mô phỏng. Trên sự cố thật đã nhân biên độ về 0.7 × ngưỡng (không vượt), cảnh báo sớm NO2 vẫn bật ở **95%** sự cố (model 20 phút). Như vậy "cảnh báo sớm NO2" thực chất là "NO2 đã tới khoảng 60% ngưỡng". Không sai, nhưng cần đặt tên/giải thích đúng trong app.

#### G. 🟡 CO trong khoảng 35–52 ppm chỉ có model mới báo sớm được

Ngưỡng ngoại suy CO = 1.5 × STEL = 52 ppm. Với CO ổn định 40–50 ppm, ngoại suy không bao giờ bật. Mô phỏng không có model cho thấy cảnh báo chỉ đến khi STEL vượt thật: +13 phút 10 s với 40 ppm, +10 phút 30 s với 50 ppm. Trong 30 phút đầu sau khởi động (model chưa chạy), hoặc khi model bị tắt do self-test sai, vùng này **không có cảnh báo sớm**.

Chấp nhận được vì STEL vẫn bắt, nhưng cần biết khi đọc các con số "báo trước 92%": đó là với model đang chạy.

#### H. ⚪ Các điểm nhỏ

- **10 phút mù sau mỗi lần khởi động**: không tránh được với cảm biến MOS. Nên có đèn/biểu tượng "đang khởi động cảm biến" để người dùng biết. `ai/state` đã có `warmup:true`.
- **Model train trên mô phỏng**: đã kiểm chứng trên dữ liệu thật công khai, nhưng chỉ có 2 đợt vượt ngưỡng thật. Bước kiểm chứng cuối vẫn là đặt thiết bị cạnh máy đo tham chiếu.
- **Không thay thế đầu báo CO đạt chuẩn** (EN 50291 / UL 2034). Nên ghi rõ trong tài liệu sản phẩm.

---

## 5. Đề xuất theo thứ tự ưu tiên

| Ưu tiên | Việc | Giải quyết | Ước lượng |
|---|---|---|---|
| 1 | Build + flash, đọc các dòng log thời gian/stack/arena ([README.md](README.md) mục 3) | mọi thứ "chưa kiểm chứng" | 1 buổi có board |
| 2 | Server lưu `ai/state`, app hiển thị/push; cân nhắc để `ai_set` chỉ tắt model | A | vừa (server/app) + nhỏ (firmware) |
| 3 | Giám sát khí tiếp khi `device_mode` OFF | B | nhỏ, nhưng phải kiểm tra lại logic relay/telemetry |
| 4 | Cờ hiệu chuẩn, chặn còi NO2 khi chưa hiệu chuẩn | E | nhỏ |
| 5 | TWA trong `RTC_NOINIT_ATTR` + DS3231 để bù khoảng mất | C | vừa, cần thêm golden test cho trường hợp reboot |
| 6 | Chốt môi trường sử dụng (nơi làm việc / nhà ở) và bộ ngưỡng | D, F | quyết định + train lại |
| 7 | Thử nghiệm có kiểm soát cạnh máy đo tham chiếu | G, H | lớn |

---

## 6. Tái tạo số liệu

```bash
cd iot_code/components/core/ai/tools
gcc -std=c99 -O2 -I../include sim_gas_ews_timeline.c ../gas_ews.c -o sim -lm && ./sim
gcc -std=c99 -O2 -Wall -Wextra -I../include test_gas_ews_host.c ../gas_ews.c -o test_gas_ews -lm && ./test_gas_ews golden
```

Trên máy này dùng gcc của MSYS2: `C:\msys64\ucrt64\bin\gcc.exe`.
