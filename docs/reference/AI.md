# AI gas EWS trong firmware

Tài liệu này mô tả phần AI trên nhánh `feature/ai-gas-ews`, dựa trên mã trong `firmware/components/core/ai/`. Mục tiêu của nó là **cảnh báo sớm nguy cơ CO hoặc NO2 vượt chuẩn QCVN 03:2019/BYT**; nó không phải model phân loại chất lượng không khí 3 lớp như nhánh AI cũ.

## Kết luận ngắn

- Model nhận **20 phút lịch sử** của CO, NO2, nhiệt độ và độ ẩm, sau đó xuất ra **2 xác suất độc lập**: một cho CO và một cho NO2.
- Mỗi xác suất trả lời: “STEL 15 phút của khí này có khả năng vượt ngưỡng trong **10 phút tới** hay không?”
- Ba nhãn `an_toan`, `canh_bao_som`, `vuot_nguong` là **trạng thái quyết định của firmware**, kết hợp model với luật QCVN và ngoại suy; chúng không phải ba đầu ra trực tiếp của model.
- Luật QCVN và ngoại suy vẫn chạy nếu model lỗi. Model chỉ bổ sung một đường cảnh báo sớm.
- Cơ chế chỉ phát còi và publish MQTT; **không tự điều khiển relay**.

## Ba nhãn thực sự nghĩa là gì?

Firmware giữ một trạng thái riêng cho CO và NO2, rồi chọn trạng thái cao nhất làm `level` chung của thiết bị.

| Giá trị | `level_name` | Khi nào xuất hiện |
|---:|---|---|
| 0 | `an_toan` | Không có cảnh báo luật, ngoại suy hoặc model. |
| 1 | `canh_bao_som` | Dự báo bằng ngoại suy hoặc model cho thấy nguy cơ sắp vượt ngưỡng. |
| 2 | `vuot_nguong` | STEL 15 phút hoặc TWA 8 giờ đã vượt ngưỡng QCVN. Mức này luôn ưu tiên hơn mức 1. |

Nói cách khác, model không xuất ra `0/1/2`. Nó xuất ra:

```text
p[CO]  = P(CO STEL 15 phút vượt ngưỡng trong 10 phút tới)
p[NO2] = P(NO2 STEL 15 phút vượt ngưỡng trong 10 phút tới)
```

`p[CO] >= 0.90` hoặc `p[NO2] >= 0.05` trong hai bước 10 giây liên tiếp sẽ bật nhánh cảnh báo từ model. Ngưỡng NO2 thấp hơn là tham số đã chọn lúc huấn luyện/đánh giá, không có nghĩa NO2 “an toàn” hơn CO.

## Chuẩn và các đại lượng firmware theo dõi

Các giá trị ppm được quy đổi cho 25 °C, 1 atm theo contract sinh tự động của model.

| Khí | STEL 15 phút | TWA 8 giờ |
|---|---:|---:|
| CO | 34.916 ppm | 17.458 ppm |
| NO2 | 5.315 ppm | 2.657 ppm |

- **STEL** là trung bình trượt 15 phút gần nhất; đây là chỉ số chính để phát hiện đợt tăng nồng độ ngắn.
- **TWA** là trung bình theo thời gian 8 giờ. Sau boot, lịch sử trước đó không tồn tại nên giá trị này được tích luỹ dần từ đầu phiên chạy.
- **`proj10`** là phép ngoại suy: lấy 5 phút gần nhất, giả định mức 1 phút gần đây tiếp tục trong 10 phút tiếp theo, rồi tính STEL dự kiến. Nó không phải đầu ra AI.

Ngoại suy sẽ tạo cảnh báo sớm khi `proj10 / STEL` đạt 1.5 cho CO hoặc 0.6 cho NO2. Ngưỡng dưới 1 ở NO2 là lựa chọn để báo sớm hơn đối với khí này.

## Luồng dữ liệu từ cảm biến đến cảnh báo

```text
GM-702B (CO), GM-102B (NO2), SHT3x (T/RH)
                    │ mẫu ppm mỗi ~5 giây
                    ▼
      gom hai mẫu thành một bước 10 giây
                    │
                    ├── STEL 15 phút / TWA 8 giờ / proj10
                    │              │
                    │              └── luật QCVN + ngoại suy
                    │
                    └── cửa sổ 120 bước × 8 feature (20 phút)
                                   │
                                   ▼
                         TFLite Micro 1D-CNN INT8
                                   │ p[CO], p[NO2]
                                   ▼
          hợp nhất + chống rung (debounce) thành level 0/1/2
                                   │
                       còi + MQTT `device/{id}/ai/state`
```

`sensor_task` đưa dữ liệu ppm thô vào `ai_feed_sample()`. Clock dùng để chia bước là clock đơn điệu, vì vậy thay đổi NTP/RTC không làm sai cửa sổ thời gian.

### Làm sạch dữ liệu và thời gian chờ

- 2 mẫu 5 giây được lấy trung bình thành 1 bước 10 giây.
- Giá trị CO/NO2 bị thiếu được giữ lại tối đa 60 giây; thiếu lâu hơn làm cửa sổ model không hợp lệ.
- Nhiệt độ/độ ẩm được giữ giá trị gần nhất; nếu chưa có, firmware dùng mốc 28 °C và 70 %RH cho feature.
- Sau lúc bắt đầu, reboot, `device_mode` OFF, hoặc mất toàn bộ dữ liệu trực tuyến quá 60 giây, khí bị bỏ qua trong **10 phút preheat**.
- Sau preheat, model còn cần **20 phút dữ liệu CO và NO2 liên tục**. Vì vậy lần suy luận đầu tiên thường ở khoảng **phút 30** kể từ mẫu đầu tiên.

Trong lúc model chưa sẵn sàng, luật STEL có thể có dữ liệu từ khoảng phút 11 và ngoại suy từ khoảng phút 15. Hệ thống không phải chờ model mới có thể cảnh báo.

## Input của model: 120 × 8

Model nhận 120 hàng, mỗi hàng đại diện cho một bước 10 giây, theo thứ tự từ cũ đến mới. Tổng cộng là 20 phút.

| Kênh | Feature | Ý nghĩa |
|---:|---|---|
| 0 | `co_rel` | CO hiện tại so với STEL CO. |
| 1 | `no2_rel` | NO2 hiện tại so với STEL NO2. |
| 2 | `co_stel_rel` | STEL CO hiện tại so với ngưỡng STEL CO. |
| 3 | `no2_stel_rel` | STEL NO2 hiện tại so với ngưỡng STEL NO2. |
| 4 | `co_proj_rel` | STEL CO ngoại suy 10 phút so với ngưỡng STEL CO. |
| 5 | `no2_proj_rel` | STEL NO2 ngoại suy 10 phút so với ngưỡng STEL NO2. |
| 6 | `temp_norm` | `(nhiệt_độ °C - 28) / 5`. |
| 7 | `rh_norm` | `(độ_ẩm %RH - 70) / 20`. |

Sáu feature khí trước khi đưa vào model đều được nén bằng `log2(1 + giá_trị_tương_đối)` để các giá trị lớn không chi phối toàn bộ input.

Việc đưa STEL, ngoại suy, nhiệt độ và độ ẩm vào input nghĩa là model không chỉ nhìn nồng độ tức thời. Nó học xu hướng tăng/giảm và bối cảnh môi trường của cảm biến MOS.

## Bản thân model làm gì?

- Định dạng: `gas_ews_int8.tflite`, chạy bằng TensorFlow Lite Micro trên ESP32-S3.
- Kiến trúc: 1D-CNN lượng tử INT8, 12,186 tham số, flatbuffer 20,896 byte.
- Các toán tử dùng: `Conv2D`, `FullyConnected`, `Logistic`, `Reshape`.
- Tần suất: một lần cho mỗi bước 10 giây có cửa sổ hợp lệ, tức tối đa 360 lần/giờ.
- Tensor arena mặc định 16 KiB, ưu tiên PSRAM và có fallback RAM trong.

Khi khởi động, firmware đọc thông số lượng tử hoá trực tiếp từ model, cấp phát tensor và chạy hai cửa sổ self-test. Nếu self-test hoặc `Invoke()` lỗi, `model_ready`/`model_ok` phản ánh lỗi đó và kết quả model không được dùng; luật QCVN cùng ngoại suy vẫn còn.

## Cách firmware ra quyết định

Với từng khí:

```text
vuot_nguong = (STEL >= ngưỡng) OR (TWA >= ngưỡng)

canh_bao_som = NOT vuot_nguong AND
                ((proj10 đạt ngưỡng ngoại suy) OR (p_model đạt ngưỡng model))
```

Mỗi tín hiệu STEL, TWA, ngoại suy và model đều dùng chống rung:

- bật ở lần phù hợp thứ hai trong 2 bước 10 giây liên tiếp (trễ thêm khoảng 10 giây sau lần phù hợp đầu);
- tắt sau 30 bước liên tiếp không còn phù hợp (5 phút).

Điều này tránh còi/MQTT nhấp nháy vì dao động quanh ngưỡng, nhưng cũng có nghĩa trạng thái có độ trễ có chủ đích.

Khi mức chung tăng, firmware kêu 3 tiếng dài cho `canh_bao_som` hoặc 4 tiếng rất dài cho `vuot_nguong`. Khi mức giảm, firmware chỉ publish trạng thái, không kêu còi báo “đã an toàn”.

## Dữ liệu quan sát trên MQTT

Topic là `device/{id}/ai/state`. Firmware gửi khi trạng thái thay đổi và ít nhất mỗi 60 giây khi AI runtime đang bật.

Các trường nên theo dõi:

| Trường | Cách đọc |
|---|---|
| `warmup` | Đang trong 10 phút bỏ dữ liệu khí sau khởi động/gián đoạn. |
| `model_ready` | Model qua bước khởi tạo và self-test ở boot. |
| `model_ok` | Hiện có cửa sổ 20 phút liên tục để model suy luận. |
| `co.ppm` / `no2.ppm` | Giá trị khí hiện tại sau xử lý dữ liệu thiếu. |
| `stel15`, `twa8h`, `proj10` | Ba đại lượng luật/QCVN và ngoại suy. |
| `p_model` | Xác suất đầu ra của model; `null` trước khi model chạy hoặc khi không có kết quả. |
| `rule`, `proj_alarm`, `model_alarm` | Nguồn nào đang làm khí đó báo động. |
| `level`, `level_name` | Kết quả hợp nhất cho khí đó hoặc cho toàn thiết bị. |

Ví dụ diễn giải: nếu `co.level = 1`, `co.proj_alarm = true`, `co.model_alarm = false` thì hệ thống cảnh báo sớm do ngoại suy, không phải do model. Nếu `co.level = 2` thì CO đã vượt luật QCVN, dù `p_model` bằng bao nhiêu.

## Bật/tắt và các điều kiện để nó hoạt động

Feature phải được build với `SA_ENABLE_AI=y`. Nếu build với `SA_ENABLE_AI=n`, phần model không được nhúng vào firmware và API AI chỉ là stub.

Khi feature đã được build, `ai_set` chỉ là công tắc runtime:

- tắt: không suy luận, không còi và không publish `ai/state`; pipeline vẫn giữ lịch sử mẫu;
- bật lại: sử dụng lịch sử còn hợp lệ, nhưng các bước model đã bỏ qua được xem là kết quả không đạt để không dùng cảnh báo model cũ;
- boot mặc định bật/tắt theo `SA_AI_ENABLED_AT_BOOT`.

## Các giới hạn cần hiểu trước khi tin vào model

- Đây là cảnh báo hỗ trợ, không thay thế thiết bị phát hiện khí được chứng nhận hoặc quy trình an toàn.
- Độ chính xác ppm phụ thuộc mạnh vào hiệu chuẩn GM-702B/GM-102B; đặc biệt NO2 cần được kiểm tra trên thiết bị thật.
- Model phụ thuộc đáng kể vào nhiệt độ/độ ẩm. Rà soát hiện tại ghi nhận input INT8 bị kẹp khi nhiệt độ dưới khoảng 22.5 °C hoặc độ ẩm dưới khoảng 47.9 %RH; ở môi trường lạnh/khô, model có thể cảnh báo sớm ít hơn. Luật STEL/TWA vẫn là hàng rào an toàn còn lại.
- Model cần **cả CO lẫn NO2 hợp lệ** trong 20 phút. Hỏng một cảm biến khí thì model cho cả hai khí dừng, dù luật của khí còn lại vẫn tính được.
- TWA 8 giờ khởi tạo lại sau reboot; nó không lưu lịch sử qua lần mất điện.
- Kết quả integration review hiện ghi nhận cần flash board để xác nhận self-test, thời gian suy luận, arena và stack trên chip thực.

## Nguồn để đọc sâu hơn

- `firmware/components/core/ai/ai.c`: task suy luận, còi, MQTT và công tắc runtime.
- `firmware/components/core/ai/gas_ews.c`: tạo feature, STEL/TWA/ngoại suy, debounce và quyết định level.
- `firmware/components/core/ai/include/gas_ews_contract.h`: contract, ngưỡng và kích thước cửa sổ sinh từ pipeline huấn luyện.
- `firmware/components/core/ai/REVIEW_MODEL.md`: đánh giá riêng về model, các giới hạn T/RH và việc cần đo trên board.
- `firmware/components/core/ai/BOARD_TEST.md`: checklist flash, UART và MQTT để xác thực trên board thật.
