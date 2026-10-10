# Test AI (`gas_ews`) trên board thật

Checklist cho nhánh `feature/ai-gas-ews`. Mỗi mục ghi: lệnh cần chạy, rồi điều phải thấy (log UART, MQTT, app). Ghi kết quả vào bảng ở mục 6.

Ký hiệu: `{id}` = device ID, `{host}` = domain server, `{token}` = JWT access token (hết hạn sau 15 phút, lấy lại bằng `POST /api/auth/refresh`).

---

## 0. Chuẩn bị

**Build** (menuconfig):

| Tuỳ chọn | Giá trị |
|---|---|
| `SA_ENABLE_AI` | `y` |
| `SA_AI_ENABLED_AT_BOOT` | `y` |
| `SA_ENABLE_BUZZER` | `y` |
| SHT3x, GM-702B, GM-102B | bật |
| `SA_SENSOR_POLLING_INTERVAL` | 5 (phải ≤ 10) |

```bash
cd iot_code
idf.py build && idf.py -p <PORT> flash monitor
```

**ACL EMQX:** thiết bị phải được phép publish `device/{id}/ai/state`. Thiết bị đăng ký trước khi có rule này thì thêm rule trước, nếu không mỗi lần publish sẽ bị ngắt MQTT.

**Theo dõi MQTT:** dùng MQTTX hoặc WebSocket client trong EMQX dashboard, subscribe bằng tài khoản có quyền đọc:

```
device/{id}/ai/state
device/{id}/shadow/report
device/{id}/response
device/{id}/telemetry
```

Ghi lại giờ bật board.

---

## 1. Log lúc boot

| Dòng log phải thấy | Đạt khi |
|---|---|
| `gas_ews_model: gas_ews model ready: 20896 B flatbuffer, arena used X/16384 B in PSRAM, ...; self-test OK` | có `self-test OK`, arena ở `PSRAM`, X ≪ 16384 |
| `ai: gas_ews_model_init (AllocateTensors + 2-window self-test): X us` | X dưới vài trăm ms |
| `ai: ai started: QCVN 03:2019/BYT CO STEL/TWA 34.9/17.5 ppm, NO2 5.31/2.66 ppm; model window 120 steps x 10s; topic=device/{id}/ai/state` | có |

**Không đạt:**
- `self-test ... got X, expected Y ... model disabled`: model trên chip cho kết quả khác PC. Ghi lại cả dòng. Luật QCVN vẫn chạy.
- `AllocateTensors failed`: tăng `SA_AI_TENSOR_ARENA_SIZE`.
- `arena ... in internal RAM`: không tìm thấy PSRAM, model vẫn chạy.

---

## 2. Trạng thái `ai/state` theo thời gian (không làm gì, để board chạy)

`t` tính từ lúc `sensor_task` đọc mẫu đầu tiên.

| Thời điểm | `warmup` | `model_ok` | `co.ppm` / `no2.ppm` | `co.stel15` | `co.proj10` | `co.p_model` | `level` |
|---|---|---|---|---|---|---|---|
| 0 – 10 phút | `true` | `false` | `null` | `null` | `null` | `null` | 0 |
| ~11 phút | `false` | `false` | số | **có số** | `null` | `null` | 0 |
| ~15 phút | `false` | `false` | số | số | **có số** | `null` | 0 |
| **~30 phút** | `false` | **`true`** | số | số | số | **có số** | 0 (không khí sạch) |

- `ai/state` được gửi khi trạng thái đổi và mỗi **60 s**.
- Khoảng phút 30 phải có log: `ai: first inference at T s after boot (step N): X us; stack high-water mark: Y bytes free`. Đạt khi T ≈ 1800 + thời gian boot, X vài ms, Y ≥ 1024.
- Sau 1 giờ chạy model: log `ai: inference timing: 360 runs, avg X us, max Y us`.
- Cảm biến chưa hiệu chuẩn: `no2.ppm` có thể khoảng 2 và `no2.level` = 1 (`proj_alarm: true`). Ghi lại; đây là vấn đề hiệu chuẩn, không phải lỗi code.

---

## 3. Lệnh `ai_set` (bật/tắt AI)

Gửi qua API (giống app):

```bash
# Tắt AI
curl -X POST https://{host}/api/devices/{id}/ai \
  -H "Authorization: Bearer {token}" -H "Content-Type: application/json" \
  -d '{"state": false}'

# Bật AI
curl -X POST https://{host}/api/devices/{id}/ai \
  -H "Authorization: Bearer {token}" -H "Content-Type: application/json" \
  -d '{"state": true}'
```

API trả `201 {"command_id": "..."}`. Có thể dùng nút AI trên app thay cho curl.

| Bước | UART | `device/{id}/response` | `device/{id}/shadow/report` | `ai/state` |
|---|---|---|---|---|
| 3.1 Tắt AI | `AI runtime switch set to off` | `{"command_id":"...","status":"done"}` | `{"mode":"on","ai_enabled":false,"ts":...}` | **ngừng gửi** |
| 3.2 Tắt lần nữa | (không log đổi trạng thái) | `done` | không gửi | vẫn ngừng |
| 3.3 Bật AI | `AI runtime switch set to on` | `done` | `{"mode":"on","ai_enabled":true,...}` | **gửi ngay** ở bước 10 s kế tiếp, rồi mỗi 60 s |
| 3.4 Bật lại sau khi tắt > 1 phút | — | `done` | `ai_enabled:true` | `model_ok` vẫn `true` (không phải đợi lại 20 phút), `p_model` có số ngay |

Command History trên app phải hiện AI ON/OFF với trạng thái DONE.

---

## 4. `device_mode` và reboot

```bash
curl -X POST https://{host}/api/devices/{id}/mode \
  -H "Authorization: Bearer {token}" -H "Content-Type: application/json" \
  -d '{"mode": "off"}'        # rồi "on"
```

| Bước | Phải thấy |
|---|---|
| 4.1 `mode: off` | `sensor_task` dừng; `ai/state` ngừng gửi; shadow mode-off có `ai_enabled` |
| 4.2 Gửi `ai_set` khi mode OFF | `response` = `status: "error"`; UART `ai_set command rejected: device mode is off` |
| 4.3 `mode: on` | `ai/state` quay lại với `warmup: true` (**preheat lại 10 phút**), `model_ok` = `true` sau khoảng 30 phút |
| 4.4 Tắt AI rồi reset board | sau boot AI về **ON** (`SA_AI_ENABLED_AT_BOOT=y`), app hiện ON; `ai/state` bắt đầu lại từ `warmup: true` |

---

## 5. Còi và cảnh báo

**An toàn:** không đốt than, xăng hay chạy động cơ trong phòng để tạo CO. Chỉ dùng nhiễu chéo của cảm biến MOS: cồn làm GM-702B đọc tăng như CO, mà không khí thật vẫn không độc.

Chờ `model_ok = true` (sau phút 30). Đưa miếng bông tẩm cồn (hoặc nước rửa tay khô) lại gần GM-702B, giữ khoảng 2–3 phút rồi bỏ ra.

| Điều kiện số đọc | Phải thấy |
|---|---|
| `co.ppm` ≥ ~52 trong ≥ 20 s (ngoại suy) **hoặc** `co.p_model` ≥ 0.90 hai bước liên tiếp | UART `co: an_toan -> canh_bao_som (...)`; **còi 3 tiếng dài**; `ai/state` gửi ngay với `level: 1`, `co.proj_alarm` hoặc `co.model_alarm` = `true` |
| `co.stel15` ≥ 34.92 (số đọc cao kéo dài vài phút) | UART `co: canh_bao_som -> vuot_nguong`; **còi 4 tiếng rất dài**; `level: 2`, `co.rule: true` |
| Bỏ cồn ra, số đọc giảm | mức giảm khoảng 5 phút sau khi STEL/ngoại suy xuống dưới ngưỡng; **không kêu còi**; `ai/state` gửi ngay khi đổi mức |
| Làm lại khi AI đang OFF | không còi, không `ai/state` |

Ghi `co.ppm` cao nhất, thời điểm bắt đầu, thời điểm còi kêu, và `co.p_model` ở mỗi mức.

NO2 khó tạo an toàn trên bàn test; logic NO2 giống hệt CO và đã được kiểm bằng golden test trên PC.

---

## 5A. Replay dữ liệu mô phỏng (không cần khí, so được từng mốc)

Firmware phát lại một kịch bản mô phỏng có sẵn thay cho số đọc cảm biến đưa vào AI. Toàn bộ đường xử lý chạy thật: `gas_ews`, model trên chip, còi, `ai/state`. Telemetry vẫn báo cảm biến thật.

**Build:** menuconfig → AI (on-device inference):

| Tuỳ chọn | Giá trị |
|---|---|
| `SA_AI_REPLAY` | `y` (**không bao giờ** để bật khi build bản dùng thật) |
| `SA_AI_REPLAY_SCENARIO` | `0` = `co_event` (72 phút), `1` = `no2_event` (88 phút) |
| `SA_AI_REPLAY_SPEED` | hệ số tua, mặc định `60`: `co_event` chạy hết trong ~72 s. `1` = thời gian thực, `500` = nhanh nhất (~10 s, chỉ để so số liệu) |

Dùng được cả với board có cảm biến lẫn chế độ demo (`SA_DEMO_NO_PERIPHERALS`, không cần cảm biến).

**Chạy:** flash rồi để board chạy hết kịch bản, không đụng vào. Replay bắt đầu 10 s sau `ai_start` (chờ Wi-Fi/MQTT) và chạy trên đồng hồ mô phỏng: mẫu thứ `i` ở giây `5·i`, đưa vào nhanh gấp `SA_AI_REPLAY_SPEED` lần. Tốc độ nào thì model cũng chạy đủ từng bước 10 s, nên kết quả giống nhau. Muốn chạy lại thì reset board. AI phải đang bật (`ai_set` true); nếu tắt thì các bước vẫn trôi qua nhưng không có model, log `RS,` hay `ai/state`.

| Log / MQTT | Phải thấy |
|---|---|
| lúc boot | `ai: AI REPLAY MODE: scenario 'co_event', 866 samples (~72 min) at x60 -- the AI ignores the real sensors` |
| sau 10 s | `ai: replay 'co_event' start: 866 samples (72 min simulated) at x60` |
| mỗi bước 10 s | `ai: RS,<t_s>,...` (một dòng CSV, dùng cho `compare_replay_log.py`) |
| mỗi 5 phút mô phỏng | `ai: replay 'co_event': sample 60/866 (5 min)` |
| mỗi `ai/state` | có thêm trường `"replay":"co_event"` |
| khi hết | `ai: replay 'co_event' finished: 433 steps in N s -- AI gets no more input; ...`, sau đó `ai/state` ngừng |

Ở x60, `ai/state` heartbeat vẫn là 60 s thật (tức 1 giờ mô phỏng), nhưng mỗi lần đổi mức vẫn publish ngay. Mốc thời gian trong bảng dưới là thời gian **mô phỏng**; thời gian thật = mốc / `SA_AI_REPLAY_SPEED`.

**So tự động với Python:** lưu log serial rồi chạy script so sánh (chỉ cần Python, không cần thư viện):

```bash
idf.py monitor | tee replay.log        # chờ tới dòng "replay '...' finished", Ctrl+]
python components/core/ai/tools/replay/compare_replay_log.py replay.log
```

Script so từng bước: mức cảnh báo phải khớp tuyệt đối, `p_model` lệch ≤ 0.01, ppm/STEL/TWA/ngoại suy lệch ≤ 0.2%. Script in mốc lên mức 1/2 của board cạnh mốc mong đợi rồi kết luận `PASS`/`FAIL`.

**Kết quả mong đợi** (tính bằng pipeline Python INT8, giống firmware; tính từ mẫu replay đầu tiên):

| Kịch bản | Mất dữ liệu | Model chạy từ | CO mức 1 | CO mức 2 | NO2 mức 1 | NO2 mức 2 | p_model max (CO / NO2) |
|---|---|---|---|---|---|---|---|
| `co_event` | không | 30:00 | **40:00** (còi 3 dài) | **47:20** (còi 4 rất dài) | — | — | 1.00 / 0.00 |
| `no2_event` | phút 49.2 (125 s): board preheat lại 10 phút | 30:00 | — | — | **45:10** (còi 3 dài) | **63:40** (còi 4 rất dài) | 0.02 / 0.99 |

- Đồng hồ mô phỏng đúng 5 s/mẫu như Python, nên mốc trên board phải trùng khớp chứ không chỉ gần đúng.
- Bảng đầy đủ: `tools/replay/replay_summary.md`.
- Giá trị từng bước 10 s: `tools/replay/replay_<tên>_expected.csv`, gồm các cột `co_stel15_ppm`, `co_proj10_ppm`, `co_p_model`, `co_state`, … `compare_replay_log.py` so tự động với các file này.
- Dữ liệu đầu vào: `tools/replay/replay_<tên>_in.csv`.

---

## 6. Bảng kết quả

| # | Mục | Kết quả (PASS/FAIL) | Số liệu / ghi chú |
|---|---|---|---|
| 1 | Boot: self-test OK, arena PSRAM | | arena used = , init = us |
| 2 | Mốc 11 / 15 / 30 phút | | T first inference = s, X = us, stack = B |
| 2b | Inference timing sau 1 giờ | | avg = us, max = us |
| 3.1 | AI OFF: ack done, shadow false, ngừng ai/state | | |
| 3.3 | AI ON: ack done, shadow true, ai/state gửi ngay | | |
| 3.4 | Bật lại không phải đợi 20 phút | | |
| 4.2 | ai_set bị từ chối khi mode OFF | | |
| 4.3 | Mode ON: preheat lại | | |
| 4.4 | Reboot: AI về ON | | |
| 5 | Cảnh báo sớm: còi 3 tiếng dài, level 1 | | co.ppm max = , sau s |
| 5 | Vượt ngưỡng: còi 4 tiếng rất dài, level 2 | | |
| 5 | AI OFF: không còi | | |
| 5A | Replay `co_event`: mức 1 ≈ 40:00, mức 2 ≈ 47:20, còi đúng | | mốc thực tế = |
| 5A | Replay `no2_event`: preheat lại sau mất dữ liệu, mức 1 ≈ 45:10, mức 2 ≈ 63:40 | | mốc thực tế = |
