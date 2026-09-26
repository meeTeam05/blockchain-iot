# MQTT Protocol — smart-air

> `docs/MQTT_PROTOCOL.md` là nguồn sự thật cho giao tiếp MQTT giữa firmware ESP32 và broker/server.
> Hợp đồng app production vẫn là REST + SSE; app không dùng MQTT trực tiếp trong flow hiện tại.

---

## 1. Runtime boundary

MQTT hiện được dùng ở ba phía:

- Firmware ESP32-S3 kết nối broker qua `wss://minhnhat05.xyz/mqtt` theo mặc định.
- Fastify API chạy MQTT bridge nội bộ tới `mqtt://emqx:1883`.
- EMQX giữ per-device auth + ACL để cô lập topic theo `device_id`.

Các giá trị runtime hiện tại:

| Thông số | Giá trị repo-truth hiện tại |
| --- | --- |
| Public device broker URI mặc định | `wss://minhnhat05.xyz/mqtt` |
| Public ingress path | Cloudflare Tunnel -> `nginx` -> EMQX WebSocket `8083` |
| API bridge broker URI mặc định | `mqtt://emqx:1883` |
| Device auth | `username = device_id`, `password = secret_key` |
| Bridge auth | `username = sa-server`, `password = EMQX_MQTT_PASSWORD` |
| QoS mặc định | `1` cho mọi publish/subscribe do code hiện tại tạo |
| Keep-alive device | `60` giây |

Ghi chú:

- `device_id` là MAC lowercase dạng `aa:bb:cc:dd:ee:ff`.
- `secret_key` chỉ xuất hiện sau `POST /api/devices`, rồi được app chuyển vào firmware qua local `POST /api/config`.
- Plain `1883` chỉ là hop nội bộ Docker cho API bridge, không phải device contract công khai.

---

## 2. Topic ownership

Direction:

- `device -> broker` nghĩa là firmware publish.
- `broker -> device` nghĩa là firmware subscribe.

| Topic | Direction | QoS | Retain | Nguồn/đích hiện tại | Mục đích |
| --- | --- | --- | --- | --- | --- |
| `device/{deviceId}/status` | `device -> broker` | 1 | `true` | firmware -> bridge | online/LWT |
| `device/{deviceId}/telemetry` | `device -> broker` | 1 | `false` | firmware -> bridge | sensor telemetry |
| `device/{deviceId}/response` | `device -> broker` | 1 | `false` | firmware -> bridge | command ack cuối |
| `device/{deviceId}/shadow/report` | `device -> broker` | 1 | `false` | firmware -> bridge | reported state patch |
| `device/{deviceId}/shadow/get` | `device -> broker` | 1 | `false` | firmware -> bridge | xin desired/delta sau connect |
| `device/{deviceId}/ota/progress` | `device -> broker` | 1 | `false` | firmware -> bridge | OTA progress snapshot |
| `device/{deviceId}/ai/state` | `device -> broker` | 1 | `false` | firmware (khi `SA_ENABLE_AI=y`) -> chưa có bên đọc | trạng thái cảnh báo CO/NO2 (QCVN 03:2019/BYT) |
| `device/{deviceId}/incident` | `device -> broker` | 1 | `false` | firmware -> bridge | incident Schema v2 đã ký EIP-712 |
| `device/{deviceId}/command` | `broker -> device` | 1 | `false` | API bridge -> firmware | imperative command |
| `device/{deviceId}/shadow/get_response` | `broker -> device` | 1 | `false` | API bridge -> firmware | desired + delta |
| `device/{deviceId}/ota/update` | `broker -> device` | 1 | `false` | server/api OTA route or manual admin publish -> firmware | OTA trigger |
| `device/{deviceId}/incident/ack` | `broker -> device` | 1 | `false` | API bridge -> firmware | ACK intake incident |

ACL device hiện tại cho phép đúng 12 topic ở trên, scoped theo device của chính nó. Rule cho `ai/state`, `incident` và `incident/ack` chỉ được ghi khi đăng ký thiết bị; thiết bị đăng ký trước khi có rule phải được cập nhật trước khi firmware publish, nếu không mỗi lần publish sẽ bị ngắt kết nối (`deny_action = disconnect`). Dùng `node scripts/sync-device-acl.js [device_id ...]` trong `server/api` để ghi lại ACL cho thiết bị đã đăng ký.

---

## 3. Device-published topics

### 3.1 `device/{id}/status`

Firmware publish retained online status khi `MQTT_EVENT_CONNECTED`, và cấu hình LWT offline cùng topic.

Online payload:

```json
{
  "online": true,
  "firmware": "<firmware version>"
}
```

Offline LWT payload:

```json
{
  "online": false
}
```

Contract:

- `online` bắt buộc là boolean.
- `firmware` hiện chỉ có trên online publish; server xử lý nếu đây là string.
- Payload sai schema bị bridge bỏ qua.

Server-side effects:

- `devices.online` được cập nhật theo `online`.
- `devices.firmware_ver` chỉ cập nhật khi payload có `firmware` string.
- Khi `online=true`, bridge set Redis `announce:{deviceId}` TTL 300s và gọi `flushPending()` cho command queue.

### 3.2 `device/{id}/telemetry`

Nguồn publish:

- `sensor_task` theo chu kỳ `CONFIG_SA_SENSOR_POLLING_INTERVAL` giây.
- `device_mode_set(false)` publish một final null telemetry khi chuyển sang OFF.

Current schema:

```json
{
  "device_id": "aa:bb:cc:dd:ee:ff",
  "mode": "on",
  "ts": 1712345678,
  "temperature": 28.5,
  "humidity": 65.2,
  "co_ppm": 3.1,
  "no2_ppm": 0.04
}
```

| Field | Type | Bắt buộc | Ghi chú |
| --- | --- | --- | --- |
| `device_id` | string | firmware luôn gửi | nếu có thì phải khớp topic device id |
| `mode` | `"on"` \| `"off"` | có | sensor task gửi `"on"`; mode-off final publish gửi `"off"` |
| `ts` | number | có | Unix timestamp giây, phải hữu hạn, `> 0`, `<= 4294967295` |
| `temperature` | number \| null | có | null khi sensor không khả dụng hoặc mode off |
| `humidity` | number \| null | có | null khi sensor không khả dụng hoặc mode off |
| `co_ppm` | number \| null | có | null khi sensor không khả dụng hoặc mode off |
| `no2_ppm` | number \| null | có | null khi sensor không khả dụng hoặc mode off |

Validation và persistence ở bridge:

- Payload phải là plain JSON object.
- Payload tối đa `4096` bytes.
- `mode` phải là `on` hoặc `off`.
- Sensor fields nếu xuất hiện phải là `number` hoặc `null`.
- Insert vào `telemetry` với QoS-1 dedupe theo `(device_id, ts, mqtt_message_id)` khi broker packet metadata có `messageId`.
- `ts` nhỏ hơn `2000-01-01T00:00:00Z` bị clamp lên mốc đó.
- `ts` lớn hơn `NOW() + 300s` bị clamp về `NOW()` của Postgres.

Ghi chú:

- Demo mode `SA_DEMO_NO_PERIPHERALS` vẫn giữ nguyên topic và schema này; chỉ đổi nguồn dữ liệu sensor.
- Realtime event app-facing sinh từ DB insert, không phát trực tiếp từ MQTT packet.

### 3.3 `device/{id}/response`

Firmware publish ack cuối cho command đã nhận trên `device/{id}/command`.

Minimum schema:

```json
{
  "command_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "status": "done"
}
```

Allowed fields bridge hiện xử lý:

| Field | Type | Bắt buộc | Ghi chú |
| --- | --- | --- | --- |
| `command_id` | string | có | phải khớp command row hiện có |
| `status` | `"done"` \| `"error"` | có | chỉ hai trạng thái này được bridge chấp nhận |
| `device_id` | string | không | nếu có và không khớp topic thì payload bị bỏ qua |
| `reason` | string | không | bridge trim và lưu vào `commands.error_message` khi `status="error"` |

Ack semantics:

- Sync handler trả `ESP_OK` -> publish `done`.
- Handler trả lỗi khác `ESP_OK` -> publish `error`.
- Handler trả `ESP_ERR_NOT_FINISHED` -> không ack ngay; worker phải publish ack sau.
- Duplicate command đã có kết quả sẽ republish cùng status cache thay vì chạy lại handler.

Bridge effects:

- `pending` có thể được chuẩn hóa sang `sent` nếu response tới trước update dispatch.
- Command chỉ transition terminal từ `sent` sang `done` hoặc `error`.
- Duplicate/stale terminal responses bị bỏ qua.

### 3.4 `device/{id}/shadow/report`

Topic này mang patch reported-state dạng flat JSON, không có wrapper `reported`.

Các nguồn publish hiện tại:

1. `sensor_task` sau mỗi telemetry tick.
2. `relay_set()` sau khi relay thay đổi thành công.
3. `device_mode_set()` khi đổi mode.
4. `device_mode_publish_current_shadow()` ngay sau MQTT reconnect bootstrap.
5. `ai_set_enabled()` sau khi đổi trạng thái AI (chỉ khi `SA_ENABLE_AI=y`).

Ví dụ sensor patch:

```json
{
  "mode": "on",
  "temperature": 28.5,
  "humidity": 65.2,
  "co_ppm": 3.1,
  "no2_ppm": 0.04,
  "ts": 1712345678
}
```

Ví dụ relay delta:

```json
{
  "mode": "on",
  "relay_1": true,
  "ts": 1712345678
}
```

Ví dụ AI delta:

```json
{
  "ai_enabled": true,
  "ts": 1712345678
}
```

Snapshot mode-on/mode-off cũng kèm `ai_enabled` (boolean khi build `SA_ENABLE_AI=y`, `null` khi build không có AI để xoá giá trị cũ trong shadow đã merge). App chỉ hiện công tắc AI khi `ai_enabled` là boolean.

Ví dụ mode-off patch:

```json
{
  "mode": "off",
  "relay_1": false,
  "relay_2": false,
  "relay_3": false,
  "temperature": null,
  "humidity": null,
  "co_ppm": null,
  "no2_ppm": null,
  "ts": 1712345678
}
```

Allowed keys bridge hiện validate:

- `mode` -> `on` hoặc `off`
- `relay_1`, `relay_2`, `relay_3` -> boolean
- `temperature`, `humidity`, `co_ppm`, `no2_ppm` -> number hoặc null
- `ts` -> Unix timestamp giây hữu hạn nếu có

Bridge rules:

- Payload tối đa `16384` bytes.
- `payload.ts` là ordering key cho `reported`.
- Report có `ts` cũ hơn `reported.ts` hiện tại bị bỏ qua.
- Report có `ts` tương lai quá `300s` bị normalize về current time trước khi UPSERT.
- Patch hợp lệ được merge vào `device_shadows.reported` và cache Redis `shadow:{deviceId}`.

### 3.5 `device/{id}/shadow/get`

Firmware publish topic này ngay sau khi reconnect và subscribe xong required topics.

Schema hiện tại:

```json
{
  "ts": 1712345678
}
```

Bridge chỉ yêu cầu payload là plain JSON object. Sau đó bridge load shadow hiện tại và best-effort publish `shadow/get_response`.

### 3.6 `device/{id}/ota/progress`

Firmware OTA task publish JSON progress snapshots trong lúc cập nhật OTA.

Payloads thực tế hiện tại:

```json
{ "progress": 0, "status": "starting" }
```

```json
{ "progress": 10 }
```

```json
{ "progress": 100, "status": "rebooting" }
```

Các `status` firmware đang phát ra:

| Status | Khi nào |
| --- | --- |
| `starting` | vừa dequeue OTA request |
| `failed` | `esp_https_ota_begin`, `perform`, hoặc `finish` fail |
| `sha256_mismatch` | hash không khớp trước `finish()` |
| `busy` | trigger mới đến khi queue OTA depth=1 đã đầy |
| `rebooting` | OTA thành công, chuẩn bị reboot |

Ghi chú:

- Progress bucket 10% trong download loop có thể không có `status`.
- Bridge hiện không validate schema OTA progress; nó chỉ cache JSON và phát realtime event.
- Notification feed app chỉ project các status terminal `rebooting` và `failed`.

### 3.7 `device/{id}/ai/state`

Firmware component `components/core/ai` publish khi mức cảnh báo đổi và mỗi 60 s (chỉ khi AI đang bật bằng `ai_set` và có dữ liệu cảm biến mới). Chi tiết: `firmware/components/core/ai/README.md`.

```json
{
  "standard": "QCVN 03:2019/BYT",
  "level": 1,
  "level_name": "canh_bao_som",
  "warmup": false,
  "model_ready": true,
  "model_ok": true,
  "co":  { "ppm": 12.7, "stel15": 16.8, "twa8h": 2.1, "proj10": 14.0, "p_model": 0.004, "level": 0,
           "rule": false, "proj_alarm": false, "model_alarm": false },
  "no2": { "ppm": 2.08, "stel15": 4.31, "twa8h": 0.4, "proj10": 3.9, "p_model": 0.0, "level": 1,
           "rule": false, "proj_alarm": true, "model_alarm": false },
  "ts": 1777631761
}
```

| Field | Ý nghĩa |
| --- | --- |
| `level` | `0` an toàn, `1` cảnh báo sớm, `2` vượt ngưỡng QCVN; ở gốc là mức cao nhất của 2 khí |
| `warmup` | đang bỏ qua 10 phút preheat của cảm biến MOS |
| `model_ready` / `model_ok` | model qua self-test lúc boot / đủ 20 phút dữ liệu liên tục để chạy |
| `ppm`, `stel15`, `twa8h`, `proj10` | ppm: số đọc, STEL 15 phút, TWA 8 giờ, STEL ngoại suy sau 10 phút |
| `p_model` | xác suất model dự báo STEL vượt ngưỡng trong 10 phút tới |
| `rule` / `proj_alarm` / `model_alarm` | nguồn của cảnh báo |

Ghi chú:

- Giá trị chưa biết được gửi là `null`.
- Bridge và app hiện chưa đọc topic này.

### 3.8 `device/{id}/incident`

Hợp đồng field-level: `docs/BLOCKCHAIN_INCIDENT_SCHEMA.md` (Schema v2). Payload là 33 field evidence `snake_case` cộng `device_id`, `firmware_version`, `calibration_canonical`, `evidence_hash`, `signature`; không nhận field khác. Firmware chỉ publish khi level chung tăng (xem schema mục 3), persist payload trước khi publish, và gửi tuần tự theo `sequence`: chờ ACK của incident trước rồi mới gửi incident kế tiếp.

Bridge xử lý (`handleIncident()`):

1. Payload tối đa `4096` bytes; `device_id` phải khớp topic; device phải tồn tại.
2. Dedupe trước mọi kiểm tra thời gian: cùng `(device_id, incident_id)`, cùng `evidence_hash` và **nguyên bytes** đã lưu → ACK `accepted:true` với `received_at` gốc, không tạo row. Cùng hash khai báo nhưng bytes khác thì phải verify lại đầy đủ ra đúng evidence và signer đã lưu mới được coi là trùng; sai thì trả mã lỗi của lần verify đó (vd `HASH_MISMATCH`). Khác hash → `INCIDENT_HASH_CONFLICT` + `security_events`.
3. Verify format, enum/mask, tính lại `device_id_hash`, `incident_id`, `firmware_version_hash`, `calibration_hash` (SHA-256 của `calibration_canonical`), `evidence_hash`, EIP-712 digest (domain lấy từ config server), chữ ký low-s `v∈{27,28}`.
4. Trong transaction có advisory lock theo device: signer phải là signer active trong `device_signers`; `|observed_at − received_at| ≤ 600s`; `observed_at` không lùi quá 60s so với incident đã lưu; `sequence` lớn hơn sequence đã lưu.
5. INSERT `incidents` + `blockchain_outbox(queued)` + realtime `incident.created`, COMMIT, ack gói MQTT, rồi mới publish ACK. DB lỗi → không ack gói để EMQX redeliver. ACK không được publish bên trong handler vì `mqtt.js` xử lý gói đến tuần tự: chờ PUBACK trong handler sẽ tự khóa tới timeout. Nếu publish ACK lỗi, firmware không nhận ACK sẽ gửi lại nguyên bytes và nhánh dedupe trả lại ACK.

---

## 4. Broker-to-device topics

### 4.1 `device/{id}/command`

API bridge publish command JSON với envelope:

```json
{
  "command_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "type": "relay_set",
  "relay": 1,
  "state": true
}
```

Generic command types mà API hiện chấp nhận:

- `relay_set`
- `device_mode`
- `set_time`
- `calibrate_co`
- `calibrate_no2`
- `ai_set`

Bridge-side validation:

- `payload` phải là plain object.
- `type` phải thuộc whitelist trên.
- `set_config` và `ota_update` bị reject ở generic REST endpoint.
- `relay_set` chỉ nhận `type`, `relay`, `state`.
- `device_mode` chỉ nhận `type`, `mode`.
- `set_time` chỉ nhận `type`, `ts`.
- `calibrate_*` chỉ nhận `type`.
- `ai_set` chỉ nhận `type`, `state` (boolean).

Firmware-side validation và handling:

- Inbound payload cho `command` bị drop nếu tổng payload > `512` bytes.
- `set_time` được xử lý trực tiếp trong MQTT component qua `mqtt_register_time_sync_cb`.
- `relay_set`, `device_mode`, `calibrate_co`, `calibrate_no2`, `ai_set` được dispatch qua bảng handler đăng ký bởi `sysload.c` (`ai_set` chỉ được đăng ký khi `SA_ENABLE_AI=y`).
- `set_config` luôn bị firmware reject trên MQTT với log hướng dẫn dùng local `POST /api/config`.
- Unsupported command type hoặc thiếu field -> command ack `error`.

#### `relay_set`

```json
{
  "command_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "type": "relay_set",
  "relay": 1,
  "state": true
}
```

Behavior:

- `relay` phải là integer `1..3`.
- `state` phải là boolean.
- `relay_set()` trả `ESP_ERR_INVALID_STATE` nếu `device_mode` đang OFF.
- Thành công sẽ persist NVS, publish `shadow/report`, và beep buzzer.

#### `device_mode`

```json
{
  "command_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "type": "device_mode",
  "mode": "off"
}
```

Behavior:

- `mode` phải là `on` hoặc `off`.
- Chuyển OFF sẽ publish final null telemetry rồi publish mode-off shadow.
- Chuyển ON sẽ enable sensor task và publish mode-on shadow với relay state hiện tại.

#### `ai_set`

```json
{
  "command_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "type": "ai_set",
  "state": true
}
```

Behavior:

- `state` phải là boolean.
- Trả `ESP_ERR_INVALID_STATE` (ack `error`) nếu `device_mode` đang OFF.
- Gọi `ai_set_enabled(state)`: chỉ đổi cờ trong RAM, không lưu NVS; reboot về default Kconfig.
- Thành công sẽ publish `shadow/report` với `ai_enabled`.
- Build `SA_ENABLE_AI=n` không đăng ký handler nên lệnh bị ack `error` (unsupported command type).

#### `set_time`

```json
{
  "command_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "type": "set_time",
  "ts": 1777631761
}
```

Behavior:

- `ts` phải là Unix timestamp giây hữu hạn trong khoảng `1..4294967295`.
- Callback hiện tại update system clock; nếu DS3231 enable thì còn ghi RTC.

#### `calibrate_co` / `calibrate_no2`

```json
{
  "command_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "type": "calibrate_co"
}
```

Behavior:

- Command được enqueue vào calibration worker queue.
- Worker lấy baseline R0 trong khoảng 3 phút, bỏ outlier, reject nếu mẫu không ổn định, rồi publish ack sau khi persist hoàn tất.
- Nếu queue đầy hoặc không khởi tạo, command kết thúc bằng `error`.
- Nếu không có khí chuẩn / thiết bị tham chiếu, R0 calibration chỉ hỗ trợ đo tương đối, xu hướng, và cảnh báo; không biến `co_ppm` / `no2_ppm` thành phép đo chuẩn tuyệt đối.
- Gas calibration thuộc sensor vật lý và được lưu trong NVS partition `calib`, nên physical factory reset không xóa `r0_co` / `r0_no2`; người dùng có thể chạy lại `calibrate_*` từ app để overwrite baseline.

### 4.2 `device/{id}/shadow/get_response`

Bridge publish topic này trong ba tình huống:

- thiết bị vừa gọi `shadow/get`
- app gọi `PUT /api/devices/:id/shadow/desired` khi device đang online
- các flow nội bộ khác tái dùng `publishShadowGetResponse()`

Schema hiện tại:

```json
{
  "desired": {
    "mode": "on",
    "relay_1": true
  },
  "delta": {
    "mode": "on",
    "relay_1": true
  },
  "ts": 1712345678
}
```

Meaning:

- `desired` là desired state hiện tại.
- `delta` = `desired - reported` theo `computeDelta()`.
- `ts` là thời điểm bridge publish response này.

Constraints:

- API chỉ cho desired keys `mode`, `relay_1`, `relay_2`, `relay_3`.
- API reject mọi payload muốn bật relay khi effective desired mode là `off`.
- Inbound payload này vào firmware bị drop nếu > `512` bytes.

Firmware apply rules:

- Firmware ưu tiên apply `delta` nếu `delta` là object; nếu không có thì fallback sang `desired`.
- Chỉ `mode` và `relay_1..3` được apply; key khác bị log là unsupported và bị bỏ qua.
- Nếu patch set `mode="off"` thì relay keys trong cùng patch không được apply tiếp.
- Nếu relay key xuất hiện khi mode hiện tại OFF thì relay key đó bị bỏ qua.

### 4.3 `device/{id}/ota/update`

OTA trigger hiện có thể do API bridge publish khi app gọi `POST /api/devices/:id/ota`; manual broker/admin publish vẫn là fallback operator path.

Minimum payload firmware chấp nhận:

```json
{
  "url": "https://example.com/ota/smart-air.bin",
  "sha256": "a3f5b2c1d4e6f7890123456789abcdef0123456789abcdef0123456789abcdef"
}
```

Constraints:

- `url` và `sha256` phải là string.
- `sha256` phải cùng loại digest mà firmware verify:
  - với ESP-IDF app image có `hash_appended=1`, giá trị này là `app image digest` được append trong image, không phải `sha256sum` của cả file `.bin`
  - nếu artifact không có appended hash thì mới fallback sang SHA-256 của toàn bộ file
- `url` phải bắt đầu bằng `https://`.
- Firmware drop inbound OTA payload nếu > `512` bytes.
- `url` phải fit buffer OTA nội bộ `256` bytes cả null terminator.
- Extra keys hiện bị firmware bỏ qua.

### 4.4 `device/{id}/incident/ack`

```json
{
  "schema_version": 2,
  "incident_id": "0xe8f3e03ea5a28046ea1da415f43795e53d347c068800cd7ffff7e658b571a4d0",
  "evidence_hash": "0xa8acc3c5d1ef72bebd65acb59b0fc91585b3b6ec53d366ee44e917577e8bcc96",
  "accepted": true,
  "error_code": null,
  "received_at": "1790394605"
}
```

- `accepted:true` chỉ xác nhận DB commit, không xác nhận transaction blockchain.
- `received_at` là chuỗi uint64 Unix giây lúc server nhận lần đầu.
- `incident_id`/`evidence_hash` echo lại giá trị thiết bị gửi. Firmware chỉ xóa record khi `accepted:true` và cả hai khớp bản đã persist.
- Payload không có `incident_id`/`evidence_hash` bytes32 hợp lệ thì không được ACK (chỉ log).
- `error_code` khi `accepted:false`: `INVALID_PAYLOAD`, `DEVICE_MISMATCH`, `UNKNOWN_DEVICE`, `INVALID_SEMANTICS`, `HASH_MISMATCH`, `INVALID_SIGNATURE`, `SIGNER_NOT_ACTIVE`, `OBSERVED_AT_OUT_OF_WINDOW`, `OBSERVED_AT_REGRESSED`, `SEQUENCE_NOT_INCREASING`, `INCIDENT_HASH_CONFLICT`.

---

## 5. Delivery, ordering, and retry behavior

### 5.1 Command queue on the server

- REST command requests luôn insert DB row `status='pending'`.
- Nếu MQTT bridge ready, `flushPending()` cố publish command FIFO theo device.
- Publish fail sau dispatch commit sẽ cố revert row từ `sent` về `pending`.
- Pending row quá hạn `COMMAND_PENDING_TIMEOUT_SECONDS` sẽ thành `timeout`.

### 5.2 Duplicate command handling on firmware

Firmware giữ cache RAM tối đa 20 `command_id`.

- Duplicate khi command gốc còn `pending` -> bỏ qua execution, chờ ack gốc.
- Duplicate khi command đã `done` hoặc `error` -> publish lại cùng terminal ack.
- Cache không durable qua reboot.

### 5.3 Shadow ordering

- `shadow/report` dùng `payload.ts` làm ordering key.
- Older patch không được phép overwrite reported state mới hơn.
- Desired state không có timestamp riêng; bridge tính `delta` tại thời điểm publish `shadow/get_response`.

### 5.4 MQTT reconnect bootstrap

Ngay sau `MQTT_EVENT_CONNECTED`, firmware hiện làm theo thứ tự:

1. subscribe `command`, `shadow/get_response`, `ota/update`
2. publish retained `status` online
3. publish current `shadow/report`
4. publish `shadow/get`

Thứ tự này quan trọng vì firmware cần subscribe xong trước khi status/shadow/get có thể kéo desired state mới về.

---

## 6. Security and provisioning constraints

- Device chỉ được pub/sub topic `device/{own_id}/*` theo EMQX built-in authz rules.
- `secret_key` là credential MQTT per-device, do backend sinh ra lúc đăng ký.
- Firmware mặc định verify TLS qua ESP CRT bundle khi kết nối broker public.
- Build repo hiện tại vẫn để `CONFIG_NVS_ENCRYPTION=n` và `CONFIG_FLASH_ENCRYPTION_ENABLED=n`, nên MQTT `secret_key` và Wi-Fi credentials đang nằm plaintext trong flash/NVS nếu deployment không bật lớp bảo vệ ngoài repo.

Provisioning sequence hiện tại:

1. App gọi `POST /api/devices`.
2. API tạo EMQX user + ACL cho `device_id`, trả `secret_key` đúng 1 lần.
3. App gọi local `POST http://<device-ip>/api/config` với:

```json
{
  "device_id": "aa:bb:cc:dd:ee:ff",
  "secret_key": "device secret",
  "broker_uri": "wss://minhnhat05.xyz/mqtt"
}
```

4. Firmware chỉ chấp nhận request đầu tiên khi chưa có `secret_key`, validate `device_id` phải khớp MAC thật, rồi lưu config và reboot.
5. Sau reboot, firmware mới bắt đầu login MQTT.

Security note:

- Hop local `POST /api/config` hiện là plain HTTP trên LAN, không có TLS hay bootstrap token.
- BLE provisioning và local HTTP bootstrap hiện dựa vào giả định môi trường cài đặt tin cậy.

---

## 7. App boundary

Các điểm sau dễ gây nhầm:

- Public MQTT WebSocket endpoint tồn tại, nhưng app production hiện không subscribe MQTT trực tiếp.
- Flutter app dùng REST cho snapshot/history/command và dùng `/api/realtime` SSE cho live updates.
- Nếu có client MQTT ngoài firmware, nó phải tự dùng credential MQTT do EMQX hiểu; JWT REST không được dùng cho MQTT broker hiện tại.
