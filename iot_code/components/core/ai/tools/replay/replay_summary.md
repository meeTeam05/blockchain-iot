# Kết quả mong đợi khi replay trên board

AUTO-GENERATED bởi `ungdungdidong/gas_ews/export_replay.py` — không sửa tay.

Thời gian tính từ **mẫu replay đầu tiên** (mẫu đầu tiên `sensor_task` đưa vào AI sau boot). Board đọc mỗi ~5–6 s nên mốc thực tế có thể trễ hơn vài %. Chi tiết từng bước 10 s: `replay_<tên>_expected.csv` (cột `*_state`: AN_TOAN = level 0, CANH_BAO_SOM = 1, VUOT_NGUONG = 2).

| Kịch bản | Dài | Mất dữ liệu > 60 s | Model chạy từ | CO lên mức 1 | CO lên mức 2 | NO2 lên mức 1 | NO2 lên mức 2 | CO ppm / STEL max | NO2 ppm / STEL max | p_model max (CO / NO2) |
|---|---|---|---|---|---|---|---|---|---|---|
| `co_event` | 72 phút | không | 30 phút 00 s | 40 phút 00 s | 47 phút 20 s | không có | không có | 142.7 / 120.5 | 0.61 / 0.14 | 1.00 / 0.00 |
| `no2_event` | 88 phút | phút 49.2 (125 s) | 30 phút 00 s | không có | không có | 45 phút 10 s | 63 phút 40 s | 18.2 / 16.6 | 7.86 / 7.15 | 0.02 / 0.99 |
