# API Reference — smart-air

**Base URL:** `https://minhnhat05.xyz`
**Framework:** Fastify (Node.js) — port 3000 nội bộ, expose qua nginx → Cloudflare Tunnel
**Content-Type:** `application/json` cho tất cả request có body
**Auth:** JWT Bearer token — `Authorization: Bearer <accessToken>`
**CORS:** Chỉ cho phép `https://minhnhat05.xyz` (cấu hình qua env `CORS_ORIGINS`)

---

## Mục lục

1. [Tổng quan](#1-tổng-quan)
2. [Auth — Xác thực](#2-auth--xác-thực)
3. [Homes — Quản lý nhà](#3-homes--quản-lý-nhà)
4. [Rooms — Phòng](#4-rooms--phòng)
5. [Devices — Thiết bị](#5-devices--thiết-bị)
6. [Shadow — Trạng thái thiết bị](#6-shadow--trạng-thái-thiết-bị)
7. [Commands — Điều khiển](#7-commands--điều-khiển)
8. [Telemetry — Dữ liệu cảm biến](#8-telemetry--dữ-liệu-cảm-biến)
8a. [Incidents — Bằng chứng sự cố blockchain](#8a-incidents--bằng-chứng-sự-cố-blockchain)
8b. [Chain worker — Health và metrics vận hành](#8b-chain-worker--health-và-metrics-vận-hành)
9. [Realtime — App SSE and Notifications Feed](#9-realtime--app-sse-and-notifications-feed)
10. [Redis Keys Reference](#10-redis-keys-reference)
11. [MQTT Bridge — Server-side](#11-mqtt-bridge--server-side)
12. [Constants Reference](#12-constants-reference)
13. [Flows thực tế](#13-flows-thực-tế)
14. [Error Reference](#14-error-reference)

---

## 1. Tổng quan

### Endpoint Summary

| Method | Path                              | Auth  | Rate Limit | Mô tả                                                     |
| ------ | --------------------------------- | :---: | :--------: | --------------------------------------------------------- |
| GET    | `/api/health/live`                |       |            | Liveness check (process up)                               |
| GET    | `/api/health/ready`               |       |            | Readiness check (DB + Redis + EMQX API + MQTT + realtime) |
| GET    | `/api/health`                     |       |            | Alias của readiness check                                 |
| GET    | `/api/health/chain`               |  ops* |            | Chain worker: 200 ok / 503 degraded + lý do (mục 8b)      |
| GET    | `/api/metrics/chain`              |  ops  |            | Metrics chain worker dạng Prometheus (mục 8b)             |
| POST   | `/api/auth/register`              |       |   10/min   | Đăng ký                                                   |
| POST   | `/api/auth/login`                 |       |   10/min   | Đăng nhập                                                 |
| POST   | `/api/auth/refresh`               |       |   10/min   | Refresh token                                             |
| POST   | `/api/auth/logout`                |   🔒   |            | Đăng xuất                                                 |
| GET    | `/api/homes`                      |   🔒   |            | Danh sách nhà                                             |
| POST   | `/api/homes`                      |   🔒   |            | Tạo nhà                                                   |
| PUT    | `/api/homes/:id`                  |   🔒   |            | Sửa nhà (owner/admin)                                     |
| DELETE | `/api/homes/:id`                  |   🔒   |            | Xóa nhà (owner)                                           |
| POST   | `/api/homes/:id/invite`           |   🔒   |            | Mời thành viên (owner/admin)                              |
| GET    | `/api/homes/:homeId/rooms`        |   🔒   |            | Danh sách phòng                                           |
| POST   | `/api/homes/:homeId/rooms`        |   🔒   |            | Tạo phòng (owner/admin)                                   |
| PUT    | `/api/rooms/:id`                  |   🔒   |            | Sửa phòng (owner/admin)                                   |
| DELETE | `/api/rooms/:id`                  |   🔒   |            | Xóa phòng (owner/admin)                                   |
| POST   | `/api/devices`                    |   🔒   |   20/min   | Đăng ký device                                            |
| GET    | `/api/devices/announce/:mac`      |   🔒   |            | Kiểm tra device đã online                                 |
| GET    | `/api/devices`                    |   🔒   |            | Danh sách device                                          |
| PUT    | `/api/devices/:id`                |   🔒   |            | Sửa device (member)                                       |
| DELETE | `/api/devices/:id`                |   🔒   |            | Xóa device (owner/admin)                                  |
| GET    | `/api/devices/:id/shadow`         |   🔒   |            | Lấy shadow state                                          |
| PUT    | `/api/devices/:id/shadow/desired` |   🔒   |            | Set desired state                                         |
| POST   | `/api/devices/:id/command`        |   🔒   |   30/min   | Gửi command                                               |
| POST   | `/api/devices/:id/relay/:channel` |   🔒   |   30/min   | Điều khiển relay trực tiếp                                |
| POST   | `/api/devices/:id/mode`           |   🔒   |   30/min   | Đổi mode thiết bị trực tiếp                               |
| POST   | `/api/devices/:id/ai`             |   🔒   |   30/min   | Bật/tắt AI on-device (runtime, không lưu NVS)             |
| GET    | `/api/devices/:id/commands`       |   🔒   |            | Lịch sử command                                           |
| GET    | `/api/devices/:id/telemetry`      |   🔒   |            | Dữ liệu cảm biến                                          |
| GET    | `/api/devices/:id/incidents`      |   🔒   |            | Danh sách incident đã ký (Schema v2)                      |
| GET    | `/api/devices/:id/incidents/:incidentId` | 🔒 |          | Chi tiết incident + trạng thái chain                      |
| GET    | `/api/devices/:id/incidents/:incidentId/verify` | 🔒 |   | Tính lại hash/chữ ký từ payload gốc đã lưu                |
| GET    | `/api/notifications`              |   🔒   |            | Feed thông báo thiết bị theo thời gian                    |
| GET    | `/api/realtime`                   |   🔒   |            | App realtime stream (SSE)                                 |

### Authentication

Endpoint có 🔒 yêu cầu JWT access token:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

JWT payload: `{ sub: userId, email: userEmail }`
Access token hết hạn **15 phút** (env `JWT_EXPIRES_IN`).
Khi hết hạn → gọi `POST /api/auth/refresh`.

### Cấu trúc lỗi

```json
{ "error": "mô tả lỗi" }
```

| HTTP Code | Ý nghĩa                                              |
| --------- | ---------------------------------------------------- |
| 400       | Thiếu / sai định dạng request                        |
| 401       | Chưa đăng nhập hoặc token hết hạn                    |
| 403       | Không có quyền (sai role hoặc không phải thành viên) |
| 404       | Không tìm thấy tài nguyên                            |
| 409       | Xung đột — email/device đã tồn tại                   |
| 429       | Rate limit — quá nhiều request                       |
| 503       | Server degraded — một hoặc nhiều dependency down     |

### Role hệ thống

| Role     | Quyền                                                          |
| -------- | -------------------------------------------------------------- |
| `owner`  | Toàn quyền: xóa nhà, xóa device, mời thành viên, sửa nhà/phòng |
| `admin`  | Sửa nhà, tạo/sửa/xóa phòng, mời thành viên, xóa device         |
| `member` | Xem, gửi command, xem telemetry, đổi tên/chuyển phòng device   |

Role được enforce bằng `CHECK (role IN ('owner', 'admin', 'member'))` trong DB.

### Device ID

Device ID = MAC address ESP32, **lowercase**, format `aa:bb:cc:dd:ee:ff`.
Hàm `normalizeDeviceId()` validate regex `/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/` — trả `null` nếu invalid.

### Authorization Functions

| Function                                         | Kiểm tra                                 | Dùng cho                                         |
| ------------------------------------------------ | ---------------------------------------- | ------------------------------------------------ |
| `checkDeviceAccess(fastify, deviceId, userId)`   | User là member của home sở hữu device    | GET/PUT shadow, GET/POST command, GET telemetry  |
| `checkMembership(fastify, homeId, userId)`       | User là member của home (any role)       | GET rooms                                        |
| `requireRole(fastify, homeId, userId, ...roles)` | User có role cụ thể, throw 403 nếu không | DELETE home/device, PUT home, invite, CRUD rooms |

---

## 2. Auth — Xác thực

### `POST /api/auth/register`

Tạo tài khoản mới.

**Rate limit:** 10/phút/IP

**Request body:**

| Field       | Type   | Bắt buộc | Default |
| ----------- | ------ | :------: | ------- |
| `email`     | string |    ✓     | —       |
| `password`  | string |    ✓     | —       |
| `full_name` | string |          | `null`  |

`full_name` được trim trước khi lưu và nếu có giá trị thì tối đa `255` ký tự.

```bash
curl -X POST https://minhnhat05.xyz/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"nhat@example.com","password":"matkhau123","full_name":"Minh Nhat"}'
```

**201 Created:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "nhat@example.com",
  "full_name": "Minh Nhat",
  "created_at": "2026-05-01T10:00:00.000Z"
}
```

| Error                | Code | Message                                      |
| -------------------- | ---- | -------------------------------------------- |
| Thiếu email/password | 400  | `"email and password required"`              |
| `full_name` quá dài  | 400  | `"full_name must be 255 characters or less"` |
| Email đã tồn tại     | 409  | `"Email already registered"`                 |

**Internal:** bcrypt hash (`BCRYPT_ROUNDS = 12`), email lowercase trước khi lưu.

---

### `POST /api/auth/login`

Đăng nhập.

**Rate limit:** 10/phút/IP

**Request body:**

| Field      | Type   | Bắt buộc |
| ---------- | ------ | :------: |
| `email`    | string |    ✓     |
| `password` | string |    ✓     |

**200 OK:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "nhat@example.com",
    "full_name": "Minh Nhat"
  }
}
```

> `refreshToken` là UUID v4 (không phải JWT). Lưu vào secure storage trên mobile.

| Error                               | Code | Message                         |
| ----------------------------------- | ---- | ------------------------------- |
| Thiếu email/password                | 400  | `"email and password required"` |
| Sai password hoặc `is_active=false` | 401  | `"Invalid credentials"`         |

**Internal:**
- Access token: JWT, expiry 15m (`JWT_EXPIRES_IN`)
- Refresh token: UUID v4, expiry 30 ngày (`REFRESH_TOKEN_EXPIRES_DAYS`)
- INSERT `refresh_tokens` (token lưu dạng SHA-256 hash)
- SET HttpOnly cookie `refreshToken` (SameSite: Strict, path: `/api/auth/refresh`)
- Body cũng chứa `refreshToken` cho mobile client (không dùng cookie)

---

### `POST /api/auth/refresh`

Lấy access token mới. Flutter Dio interceptor gọi tự động khi 401.

**Rate limit:** 10/phút/IP

**Request body** (hoặc HttpOnly cookie):

| Field          | Type   |    Bắt buộc     |
| -------------- | ------ | :-------------: |
| `refreshToken` | string | ✓ (hoặc cookie) |

> Ưu tiên: `body.refreshToken` > `cookie.refreshToken`

**200 OK:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

| Error                 | Code | Message                              |
| --------------------- | ---- | ------------------------------------ |
| Không gửi token       | 401  | `"No refresh token"`                 |
| Token invalid/expired | 401  | `"Invalid or expired refresh token"` |

**Internal:**
1. Tìm token trong `refresh_tokens` (JOIN users), check `expires_at > NOW()`
2. Trong cùng transaction: ghi `refresh_token_reuse_markers`, DELETE token cũ, INSERT token mới
3. Nếu duplicate refresh request tới gần như đồng thời, request thua sẽ nhận `401` nhưng không revoke token mới vừa rotate
4. Nếu token cũ bị dùng lại sau grace window, server tìm marker và revoke toàn bộ refresh sessions của user
5. Issue access token mới

---

### `POST /api/auth/logout` 🔒

Đăng xuất toàn bộ session.

**200 OK:**
```json
{ "success": true }
```

**Internal:**
1. DELETE tất cả `refresh_tokens` theo `user_id` (logout everywhere)
2. Clear cookie `refreshToken`

---

## 3. Homes — Quản lý nhà

### `GET /api/homes` 🔒

Danh sách nhà user là thành viên.

**200 OK:**
```json
[
  {
    "id": "uuid",
    "owner_id": "uuid",
    "name": "Nhà Bình Thạnh",
    "address": "Bình Thạnh, TP.HCM",
    "timezone": "Asia/Ho_Chi_Minh",
    "created_at": "2026-04-01T00:00:00.000Z"
  }
]
```

Sắp xếp `created_at ASC`. Trả `[]` nếu chưa thuộc nhà nào.

---

### `POST /api/homes` 🔒

Tạo nhà mới. User tự động thành `owner`.

**Request body:**

| Field      | Type   | Bắt buộc | Default              |
| ---------- | ------ | :------: | -------------------- |
| `name`     | string |    ✓     | —                    |
| `address`  | string |          | `null`               |
| `timezone` | string |          | `"Asia/Ho_Chi_Minh"` |

**201 Created:** Home object.

| Error      | Code | Message           |
| ---------- | ---- | ----------------- |
| Thiếu name | 400  | `"name required"` |

**Internal:** Transaction — INSERT `homes` + INSERT `home_members` (role='owner'). Rollback nếu một trong hai fail.

---

### `PUT /api/homes/:id` 🔒

Sửa nhà. **owner/admin**.

**Request body** (optional, COALESCE — field không gửi giữ nguyên):

| Field      | Type   |
| ---------- | ------ |
| `name`     | string |
| `address`  | string |
| `timezone` | string |

**200 OK:** Updated home object.

| Error                  | Code | Message       |
| ---------------------- | ---- | ------------- |
| Không phải owner/admin | 403  | `"Forbidden"` |
| Home không tồn tại     | 404  | `"Not found"` |

---

### `DELETE /api/homes/:id` 🔒

Xóa nhà. **Chỉ owner**.

**204 No Content.**

| Error            | Code | Message       |
| ---------------- | ---- | ------------- |
| Không phải owner | 403  | `"Forbidden"` |

**Internal:**
1. Trong cùng DB transaction: owner check + lock `homes` row bằng `FOR UPDATE`
2. Capture device IDs rồi DELETE `homes`; DB cascade xóa devices/rooms/home_members
3. Trigger `AFTER DELETE ON devices` tạo `external_cleanup_jobs(kind='emqx_device_user')`
4. Sau commit: best-effort cleanup Redis + EMQX cho các device IDs đã capture

---

### `POST /api/homes/:id/invite` 🔒

Mời thành viên bằng email. **owner/admin**.

**Request body:**

| Field   | Type   | Bắt buộc | Default    |
| ------- | ------ | :------: | ---------- |
| `email` | string |    ✓     | —          |
| `role`  | string |          | `"member"` |

**200 OK:** `{ "success": true }`

| Error                  | Code | Message                                                 |
| ---------------------- | ---- | ------------------------------------------------------- |
| Email thiếu/sai format | 400  | `"valid email required"`                                |
| Không phải owner/admin | 403  | `"Forbidden"`                                           |
| Email chưa đăng ký     | 200  | `{ "success": true }` để tránh lộ email đã đăng ký      |
| Đã là thành viên       | 200  | `{ "success": true }` để tránh lộ trạng thái membership |

---

## 4. Rooms — Phòng

### `GET /api/homes/:homeId/rooms` 🔒

Danh sách phòng. **Mọi thành viên** xem được.

**200 OK:**
```json
[
  { "id": "uuid", "home_id": "uuid", "name": "Phòng ngủ", "icon": "bed" }
]
```

Sắp xếp `name ASC`. Authorization: `checkMembership()`.

| Error                 | Code | Message       |
| --------------------- | ---- | ------------- |
| Không phải thành viên | 403  | `"Forbidden"` |

---

### `POST /api/homes/:homeId/rooms` 🔒

Tạo phòng. **owner/admin**.

| Field  | Type   | Bắt buộc |
| ------ | ------ | :------: |
| `name` | string |    ✓     |
| `icon` | string |          |

**201 Created:** Room object.

| Error                  | Code | Message           |
| ---------------------- | ---- | ----------------- |
| Thiếu name             | 400  | `"name required"` |
| Không phải owner/admin | 403  | `"Forbidden"`     |

---

### `PUT /api/rooms/:id` 🔒

Sửa phòng. **owner/admin**.

| Field  | Type   |
| ------ | ------ |
| `name` | string |
| `icon` | string |

**200 OK:** Updated room object.

| Error                  | Code | Message       |
| ---------------------- | ---- | ------------- |
| Không phải owner/admin | 403  | `"Forbidden"` |
| Room không tồn tại     | 404  | `"Not found"` |

**Internal:** Truy vấn `home_id` từ room, sau đó `requireRole()`.

---

### `DELETE /api/rooms/:id` 🔒

Xóa phòng. **owner/admin**. Devices trong phòng sẽ SET `room_id = NULL` (không bị xóa).

**204 No Content.**

| Error                  | Code | Message       |
| ---------------------- | ---- | ------------- |
| Không phải owner/admin | 403  | `"Forbidden"` |
| Room không tồn tại     | 404  | `"Not found"` |

---

## 5. Devices — Thiết bị

### `POST /api/devices` 🔒

Đăng ký ESP32 sau BLE provisioning.

> Đây là bước backend cấp credential MQTT riêng cho thiết bị.
> Thiết bị không tự xuất hiện trong EMQX chỉ vì đã bật nguồn, đã pair BLE, hay đã vào Wi-Fi.

**Rate limit:** 20/phút/IP

**Request body:**

| Field       | Type          | Bắt buộc | Validation                     |
| ----------- | ------------- | :------: | ------------------------------ |
| `device_id` | string        |    ✓     | MAC format `aa:bb:cc:dd:ee:ff` |
| `name`      | string        |    ✓     | —                              |
| `home_id`   | string (UUID) |    ✓     | UUID regex                     |
| `room_id`   | string (UUID) |          | —                              |

**201 Created:**
```json
{
  "id": "dc:b4:d9:13:ed:8c",
  "name": "Cảm biến phòng ngủ",
  "home_id": "uuid",
  "room_id": null,
  "type_id": "uuid",
  "owner_id": "uuid",
  "secret_key": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "online": false,
  "last_seen": null,
  "firmware_ver": null,
  "created_at": "2026-05-01T10:00:00.000Z"
}
```

> `secret_key` là MQTT password. Chỉ trả về **1 lần** khi tạo device.

| Error                       | Code | Message                                |
| --------------------------- | ---- | -------------------------------------- |
| Thiếu fields                | 400  | `"device_id, name, home_id required"`  |
| room_id sai format          | 400  | `"room_id must be a valid UUID"`       |
| room không thuộc home       | 400  | `"room_id does not belong to home"`    |
| Không phải owner/admin      | 403  | `"Forbidden"`                          |
| Device đã tồn tại           | 409  | `"Device already registered"`          |
| EMQX đã có user orphan      | 409  | `"Device provisioning conflict"`       |
| Quá quota device của home   | 429  | `"device limit reached for this home"` |
| EMQX Admin API fail/timeout | 502  | `"Device provisioning failed"`         |

**Internal:**
1. `normalizeDeviceId()` — validate MAC + lowercase
2. `requireRole('owner', 'admin')` trên home
3. Preflight transaction: re-check owner/admin membership dưới DB lock, lock quota, check duplicate device, check room thuộc home, check quota
4. Tạo `secret_key = uuidv4()`
5. Arm durable cleanup marker trong `external_cleanup_jobs` trước khi gọi EMQX để orphan credential có đường dọn dẹp nếu tiến trình crash giữa chừng
6. EMQX: tạo MQTT user + ACL với timeout `EMQX_API_TIMEOUT_MS` (default 5000 ms); nếu user đã tồn tại nhưng DB chưa có device thì trả 409, không overwrite password
7. Transaction thứ hai re-check role/quota/room/device conditions rồi INSERT `devices`; nếu quyền đã bị thu hồi hoặc DB fail sau khi tạo EMQX user thì server chạy cleanup compensation ngay và retry job vẫn còn marker để dọn orphan nếu cleanup tức thời thất bại
8. Trả `secret_key` về app đúng 1 lần để app hoặc provisioning flow chuyển credential đó xuống firmware trước khi thiết bị login MQTT

---

### `GET /api/devices/announce/:mac` 🔒

Kiểm tra ESP32 đã announce online chưa (polling sau BLE provisioning).

**200 OK:** `{ "announced": true }` hoặc `{ "announced": false }`

| Error       | Code | Message         |
| ----------- | ---- | --------------- |
| MAC invalid | 400  | `"Invalid mac"` |

**Internal:** Redis key `announce:{deviceId}`, TTL 300s (`REDIS_TTL_ANNOUNCE`).

> Polling mỗi 2-3s sau provisioning cho đến khi `announced: true` hoặc timeout 60s.

---

### `GET /api/devices` 🔒

Danh sách device thuộc các nhà của user.

**200 OK:**
```json
[
  {
    "id": "dc:b4:d9:13:ed:8c",
    "name": "Cảm biến phòng ngủ",
    "home_id": "uuid",
    "room_id": null,
    "online": true,
    "last_seen": "2026-05-01T10:05:00.000Z",
    "firmware_ver": "1.0.0",
    "created_at": "2026-04-01T00:00:00.000Z",
    "mode": "on",
    "relay_1": true,
    "relay_2": false,
    "relay_3": false
  }
]
```

Sắp xếp `created_at ASC`, rồi `id ASC` để phân trang ổn định khi nhiều device có cùng thời điểm tạo. Kèm thêm trạng thái shadow gần nhất: `mode`, `relay_1`, `relay_2`, `relay_3`. **Không** bao gồm `secret_key`, `type_id`, `owner_id`.

---

### `PUT /api/devices/:id` 🔒

Đổi tên/chuyển phòng. **Mọi thành viên** (via `checkDeviceAccess`).

| Field     | Type          |
| --------- | ------------- |
| `name`    | string        |
| `room_id` | string (UUID) |

**200 OK:**
```json
{
  "id": "dc:b4:d9:13:ed:8c",
  "name": "Tên mới",
  "home_id": "uuid",
  "room_id": "uuid",
  "online": true,
  "last_seen": "2026-05-01T10:05:00.000Z",
  "firmware_ver": "1.0.0"
}
```

| Error                 | Code | Message               |
| --------------------- | ---- | --------------------- |
| Invalid MAC           | 400  | `"Invalid device ID"` |
| Không phải thành viên | 403  | `"Forbidden"`         |
| Device không tồn tại  | 404  | `"Not found"`         |

---

### `DELETE /api/devices/:id` 🔒

Xóa device. **owner/admin** (via `requireRole`).

**204 No Content.**

| Error                  | Code | Message               |
| ---------------------- | ---- | --------------------- |
| Invalid MAC            | 400  | `"Invalid device ID"` |
| Không phải owner/admin | 403  | `"Forbidden"`         |
| Device không tồn tại   | 404  | `"Not found"`         |

**Internal:**
1. Verify role `owner/admin` trên home chứa device
2. Trong cùng DB transaction: lock device row, verify role, rồi DELETE `devices`
3. Trigger `AFTER DELETE ON devices` tạo `external_cleanup_jobs(kind='emqx_device_user')`
4. Sau commit: best-effort DEL Redis `shadow:`, `pending_cmds:`, `announce:`, `ota_progress:`
5. EMQX: xóa user + ACL; nếu fail thì giữ DB cleanup job để retry

---

## 6. Shadow — Trạng thái thiết bị

Shadow = snapshot state gồm:
- **`reported`**: ESP32 tự báo state hiện tại (`mode`, `relay_1..3`, sensor fields, `ts`)
- **`desired`**: App set target state cho các key firmware hiện hỗ trợ qua shadow (`mode`, `relay_1..3`)

Cache: Redis `shadow:{deviceId}` TTL 1h (`REDIS_TTL_SHADOW`), fallback DB `device_shadows`.
Malformed Redis JSON is deleted. Cache writes are versioned by `updatedAt`, and a failed write clears the key so stale Redis state cannot outrun Postgres.
For inbound `device/{id}/shadow/report`, `payload.ts` is the ordering key: older reports are ignored so out-of-order MQTT delivery cannot overwrite newer state. Reports more than 300 seconds in the future are normalized to current server time before persistence.

### `GET /api/devices/:id/shadow` 🔒

Authorization: `checkDeviceAccess()`

**200 OK:**
```json
{
  "reported": {
    "mode": "on",
    "relay_1": false,
    "relay_2": false,
    "relay_3": false,
    "temperature": 28.5,
    "humidity": 65.2,
    "co_ppm": 3.1,
    "no2_ppm": 0.2,
    "ts": 1777631000
  },
  "desired": {
    "mode": "on",
    "relay_1": true
  },
  "updatedAt": "2026-05-01T10:05:00.000Z"
}
```

> Device chưa có shadow: `{ "reported": {}, "desired": {}, "updatedAt": null }`

| Error                 | Code | Message               |
| --------------------- | ---- | --------------------- |
| Invalid MAC           | 400  | `"Invalid device ID"` |
| Không phải thành viên | 403  | `"Forbidden"`         |

---

### `PUT /api/devices/:id/shadow/desired` 🔒

Authorization: `checkDeviceAccess()`

**Request body:** JSON object chỉ gồm các desired device-state keys hiện được firmware hỗ trợ: `mode`, `relay_1`, `relay_2`, `relay_3`.

```json
{ "mode": "on", "relay_1": true }
```

Nếu mode hiệu lực là `off` thì mọi `relay_N=true` đều bị reject. Mode hiệu lực resolve theo thứ tự: `body.mode` → `desired.mode` đang lưu → `reported.mode` hiện tại.

**200 OK:** `{ "success": true }`

| Error                  | Code | Message                                                                                |
| ---------------------- | ---- | -------------------------------------------------------------------------------------- |
| Body không phải object | 400  | `"body must be a plain JSON object"`                                                   |
| Key không hỗ trợ       | 400  | `"Unsupported desired keys: ... Supported keys: mode, relay_1, relay_2, relay_3."`    |
| `mode` sai kiểu        | 400  | `"mode must be on or off"`                                                             |
| `relay_N` sai kiểu     | 400  | `"relay_N must be boolean"`                                                            |
| `relay_N=true` khi mode hiệu lực = `off` | 400 | `"relay_N cannot be true when effective desired mode is off"` |
| Body vượt size limit   | 400  | `"desired shadow payload exceeds size limit"`                                          |
| Invalid MAC            | 400  | `"Invalid device ID"`                                                                  |
| Không phải thành viên  | 403  | `"Forbidden"`                                                                          |

**Internal:**
1. Validate plain object + size limit, rồi `setDesired()` UPSERT DB + write-through Redis cache
2. Nếu device online → MQTT publish `device/{id}/shadow/get_response`:
   ```json
   { "desired": { "mode": "on", "relay_1": true }, "delta": { "mode": "on", "relay_1": true }, "ts": 1777631761 }
   ```
3. Nếu offline → chỉ lưu DB, push khi device online lại hoặc khi device publish `shadow/get`

> `PUT /shadow/desired` là declarative target state cho các keys firmware hỗ trợ qua `shadow/get_response`. Typed command endpoints vẫn tồn tại cho imperative command/history flow.
> Chi tiết topic/payload MQTT tương ứng nằm ở `docs/reference/MQTT_PROTOCOL.md`.

---

## 7. Commands — Điều khiển

### `POST /api/devices/:id/command` 🔒

**Rate limit:** 30/phút/IP
Authorization: `checkDeviceAccess()`

**Request body:**

| Field     | Type   | Bắt buộc |
| --------- | ------ | :------: |
| `payload` | object |    ✓     |

```bash
curl -X POST https://minhnhat05.xyz/api/devices/dc:b4:d9:13:ed:8c/command \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"payload":{"type":"set_time","ts":1777631761}}'
```

**201 Created:**
```json
{ "command_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479" }
```

| Error                 | Code | Message               |
| --------------------- | ---- | --------------------- |
| Invalid MAC           | 400  | `"Invalid device ID"` |
| Thiếu/sai payload     | 400  | `"payload required"`  |
| Không phải thành viên | 403  | `"Forbidden"`         |

**Internal (device online):**
1. INSERT `commands` status=`pending`
2. `flushPending()` lấy pending commands từ PostgreSQL theo FIFO
3. UPDATE status=`sent` + COMMIT dispatch record
4. MQTT publish `device/{id}/command`: `{ command_id, ...payload }`
5. Nếu publish call fail đồng bộ, server revert row về `pending`

**Internal (device offline):**
1. INSERT `commands` status=`pending`
2. Khi device online → `flushPending()` lấy pending commands từ DB và gửi từng command

**Command lifecycle:** `pending` → `sent` → `done` | `error` | `timeout`

> Status cuối do firmware quyết định hoặc timeout job. CHECK constraint: `('pending','sent','done','error','timeout')`.
> `sent` command quá hạn `COMMAND_SENT_TIMEOUT_SECONDS` sẽ thành `timeout` (default 420s); `pending` command quá hạn `COMMAND_PENDING_TIMEOUT_SECONDS` sẽ thành `timeout` (default 1800s).
> Firmware dedupe duplicate MQTT QoS 1 replays theo `command_id` trong RAM cache 20 entries: duplicate khi command gốc còn chạy sẽ bị bỏ qua, duplicate sau khi đã có kết quả sẽ re-publish cùng `done|error`, và cache không giữ qua reboot.
> `set_config` và `ota_update` bị chặn ở generic endpoint; `set_config` chỉ đi qua local device `POST /api/config`. OTA app flow đi qua endpoint riêng `POST /api/devices/:id/ota`, rồi server publish topic riêng `device/{id}/ota/update`.

**Các lệnh thực tế:**

| Lệnh              | Payload                                              |
| ----------------- | ---------------------------------------------------- |
| Relay             | `{ "type": "relay_set", "relay": 1, "state": true }` |
| Device mode       | `{ "type": "device_mode", "mode": "on" }`            |
| Đồng bộ thời gian | `{ "type": "set_time", "ts": 1777631761 }`           |
| Calibrate CO      | `{ "type": "calibrate_co" }`                         |
| Calibrate NO2     | `{ "type": "calibrate_no2" }`                        |
| Bật/tắt AI        | `{ "type": "ai_set", "state": true }`                |

> Calibration là maintenance command nhưng vẫn dùng quyền member như các command generic khác.

`set_config` và `ota_update` không được nhận qua generic command endpoint. OTA app flow đi qua endpoint riêng `POST /api/devices/:id/ota`, rồi server publish topic `device/{id}/ota/update`.

> ESP32 nhận → thực thi → publish `device/{id}/response`: `{ command_id, status: "done" }`
> Server `handleResponse()` → UPDATE `commands.status`, `executed_at = NOW()`.

---

### `POST /api/devices/:id/relay/:channel` 🔒

**Rate limit:** 30/phút/IP
Authorization: `checkDeviceAccess()`

Typed endpoint để điều khiển trực tiếp relay, tương đương payload command:
`{ "type": "relay_set", "relay": <channel>, "state": <boolean> }`

**Path params:**

| Param     | Type    | Ràng buộc        |
| --------- | ------- | ---------------- |
| `id`      | string  | Device ID hợp lệ |
| `channel` | integer | `1..3`           |

**Request body:**

```json
{ "state": true }
```

**201 Created:**
```json
{ "command_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479" }
```

| Error                                       | Code | Message                   |
| ------------------------------------------- | ---- | ------------------------- |
| Invalid MAC                                 | 400  | `"Invalid device ID"`     |
| `channel` ngoài `1..3` / body thiếu `state` | 400  | Fastify schema validation |
| Không phải thành viên                       | 403  | `"Forbidden"`             |

**Internal:** Server chuẩn hóa thành command payload `relay_set`, lưu vào `commands`, rồi dispatch qua cùng luồng `sendCommand()` như endpoint generic.

---

### `POST /api/devices/:id/mode` 🔒

**Rate limit:** 30/phút/IP
Authorization: `checkDeviceAccess()`

Typed endpoint để đổi mode thiết bị, tương đương payload command:
`{ "type": "device_mode", "mode": "on" | "off" }`

**Path params:**

| Param | Type   | Ràng buộc        |
| ----- | ------ | ---------------- |
| `id`  | string | Device ID hợp lệ |

**Request body:**

```json
{ "mode": "on" }
```

**201 Created:**
```json
{ "command_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479" }
```

| Error                                | Code | Message                    |
| ------------------------------------ | ---- | -------------------------- |
| Invalid MAC                          | 400  | `"Invalid device ID"`      |
| Body thiếu / `mode` không phải `on` hoặc `off` | 400  | Fastify schema validation |
| Không phải thành viên                | 403  | `"Forbidden"`              |

**Internal:** Server chuẩn hóa thành command payload `device_mode`, lưu vào `commands`, rồi dispatch qua cùng luồng `sendCommand()` như endpoint generic.

---

### `POST /api/devices/:id/ai` 🔒

**Rate limit:** 30/phút/IP
Authorization: `checkDeviceAccess()`

Typed endpoint để bật/tắt AI on-device, tương đương payload command:
`{ "type": "ai_set", "state": <boolean> }`

**Path params:**

| Param | Type   | Ràng buộc        |
| ----- | ------ | ---------------- |
| `id`  | string | Device ID hợp lệ |

**Request body:**

```json
{ "state": true }
```

**201 Created:**
```json
{ "command_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479" }
```

| Error                  | Code | Message                   |
| ---------------------- | ---- | ------------------------- |
| Invalid MAC            | 400  | `"Invalid device ID"`     |
| Body thiếu `state`     | 400  | Fastify schema validation |
| Không phải thành viên  | 403  | `"Forbidden"`             |

**Internal:** Server chuẩn hóa thành command payload `ai_set`, lưu vào `commands`, rồi dispatch qua cùng luồng `sendCommand()` như endpoint generic. Trạng thái chỉ nằm trong RAM của firmware: reboot sẽ về default Kconfig. `ai_enabled` không phải desired key nên server không gửi lại trạng thái cũ sau reconnect.

---

### `GET /api/devices/:id/ota/versions` 🔒

Authorization: `checkDeviceAccess()`

Trả về catalog OTA hiện có cho thiết bị bằng cách scan `server/ota-files`. Mỗi file `.bin` là một version khả dụng; version label là tên file bỏ hậu tố `.bin`.

**200 OK:**

```json
{
  "device_id": "aa:bb:cc:dd:ee:ff",
  "current_version": "0.1.1",
  "device_online": false,
  "versions": [
    {
      "version": "0.1.2",
      "filename": "0.1.2.bin",
      "url": "https://updates.example.com/ota/0.1.2.bin"
    },
    {
      "version": "0.1.1",
      "filename": "0.1.1.bin",
      "url": "https://updates.example.com/ota/0.1.1.bin"
    }
  ]
}
```

| Error               | Code | Message               |
| ------------------- | ---- | --------------------- |
| Invalid device ID   | 400  | `"Invalid device ID"` |
| Không có quyền      | 403  | `"Forbidden"`         |

**Internal:**
1. Validate device ID
2. Lookup device mà user hiện tại có quyền truy cập
3. Scan `server/ota-files` lấy tất cả file `.bin`
4. Sort version giảm dần theo dot-segment numeric nếu có thể, fallback lexical
5. Build public OTA URL từ `OTA_PUBLIC_BASE_URL` nếu được cấu hình; nếu không thì dùng runtime default

---

### `POST /api/devices/:id/ota` 🔒

**Rate limit:** 20/phút/IP
Authorization: `checkDeviceAccess()`

Trigger OTA cho một version cụ thể từ catalog server-side. Endpoint này không queue request khi device offline; request sẽ fail ngay.

**Request body:**

```json
{ "version": "0.1.2" }
```

**202 Accepted:**

```json
{
  "device_id": "aa:bb:cc:dd:ee:ff",
  "version": "0.1.2",
  "filename": "0.1.2.bin",
  "status": "accepted"
}
```

| Error               | Code | Message                   |
| ------------------- | ---- | ------------------------- |
| Invalid device ID   | 400  | `"Invalid device ID"`     |
| Thiếu version       | 400  | `"version required"`      |
| Không có quyền      | 403  | `"Forbidden"`             |
| Không có artifact   | 404  | `"OTA version not found"` |
| Device đang offline | 409  | `"device offline"`        |

**Internal:**
1. Validate device ID + `version`
2. Lookup device mà user hiện tại có quyền truy cập
3. Reject ngay nếu `devices.online = false`
4. Resolve `version -> filename` bằng cách scan `server/ota-files`
5. Tính OTA `sha256` theo contract firmware:
   - nếu artifact là ESP-IDF app image có appended hash thì dùng `app image digest` được nhúng ở cuối image
   - nếu không thì fallback sang SHA-256 của toàn bộ file
6. MQTT publish `device/{id}/ota/update` với payload `{ url, sha256 }`

> Endpoint này cho phép chọn bất kỳ version nào đang có trong catalog, kể cả downgrade. API layer hiện chưa áp policy tương thích hoặc release channel.

---

### `GET /api/devices/:id/commands` 🔒

Lịch sử command, mới nhất trước. Authorization: `checkDeviceAccess()`

**Query params:**

| Param    | Default | Max                        |
| -------- | ------- | -------------------------- |
| `limit`  | 50      | 200 (`COMMANDS_MAX_LIMIT`) |
| `offset` | 0       | 2147483647                 |

**200 OK:**
```json
[
  {
    "id": "uuid",
    "payload": { "type": "set_time", "ts": 1777631761 },
    "status": "done",
    "created_at": "2026-05-01T10:00:00.000Z",
    "executed_at": "2026-05-01T10:00:01.243Z"
  }
]
```

| Error                 | Code | Message               |
| --------------------- | ---- | --------------------- |
| Invalid MAC           | 400  | `"Invalid device ID"` |
| Không phải thành viên | 403  | `"Forbidden"`         |

---

## 8. Telemetry — Dữ liệu cảm biến

ESP32 publish telemetry theo `CONFIG_SA_SENSOR_POLLING_INTERVAL` giây, hiện default trong repo là 5 giây. Server `handleTelemetry()` validate payload rồi INSERT vào TimescaleDB hypertable. QoS-1 redelivery được dedupe theo `(device_id, ts, mqtt_message_id)` khi packet metadata có sẵn. Retention: 1 year.

Telemetry guardrails:

- `mode` phải là `on` hoặc `off`
- `ts` phải là Unix timestamp giây hữu hạn
- `device_id`, nếu có trong payload, phải khớp topic device id
- sensor fields phải là `number` hoặc `null`
- payload quá cũ bị clamp lên `2000-01-01T00:00:00Z`
- payload quá tương lai bị clamp về `NOW()` của Postgres

### `GET /api/devices/:id/telemetry` 🔒

Authorization: `checkDeviceAccess()`

**Query params:**

| Param   | Default   | Max  | Mô tả                                                 |
| ------- | --------- | ---- | ----------------------------------------------------- |
| `from`  | 24h trước | —    | ISO 8601                                              |
| `to`    | Hiện tại  | —    | ISO 8601                                              |
| `limit` | 1000      | 5000 | Chỉ áp dụng raw mode                                  |
| `agg`   | _(none)_  | —    | Whitelist: `1m`, `5m`, `15m`, `30m`, `1h`, `6h`, `1d` |

> Khi có `agg`: `time_bucket()` + AVG, vẫn áp dụng `limit` cho số bucket trả về.
> Khi không có `agg`: raw data, áp dụng `limit`.
> Ràng buộc thời gian: `from` phải `<= to`, và `to - from` không được vượt quá `90 ngày`.

**200 OK (raw):**
```json
[
  { "ts": "2026-05-01T10:05:00.000Z", "temperature": 28.5, "humidity": 65.2, "co_ppm": 3.1, "no2_ppm": 0.04, "mode": "on" },
  { "ts": "2026-05-01T10:04:55.000Z", "temperature": 28.4, "humidity": 65.0, "co_ppm": 3.0, "no2_ppm": 0.04, "mode": "on" }
]
```

**200 OK (agg=1h):**
```json
[
  { "ts": "2026-05-01T10:00:00.000Z", "temperature": 28.4, "humidity": 65.1, "co_ppm": 3.0, "no2_ppm": 0.04 },
  { "ts": "2026-05-01T09:00:00.000Z", "temperature": 27.9, "humidity": 64.5, "co_ppm": 2.8, "no2_ppm": 0.03 }
]
```

Raw telemetry trả về `mode`, `temperature`, `humidity`, `co_ppm`, `no2_ppm`. Aggregation mode trả về `temperature`, `humidity`, `co_ppm`, `no2_ppm` theo bucket và không có `mode`.

Sắp xếp `ts DESC`.

| Error                       | Code | Message                                                      |
| --------------------------- | ---- | ------------------------------------------------------------ |
| `from > to`                 | 400  | `"from must be <= to"`                                       |
| Range vượt `90 ngày`        | 400  | `"range must be <= 90 days"`                                 |
| `from` / `to` sai định dạng | 400  | `"invalid from/to date (ISO8601 expected)"`                  |
| Invalid MAC                 | 400  | `"Invalid device ID"`                                        |
| `agg` không hợp lệ          | 400  | `"Invalid agg value. Allowed: 1m, 5m, 15m, 30m, 1h, 6h, 1d"` |
| Không phải thành viên       | 403  | `"Forbidden"`                                                |

**Flutter `fl_chart` guide:**

| Chart mode  | `agg`    | `limit`  | `from`      |
| ----------- | -------- | -------- | ----------- |
| 1h realtime | _(none)_ | 720      | `now - 1h`  |
| 24h         | `1h`     | _(omit)_ | `now - 24h` |
| 7 ngày      | `6h`     | _(omit)_ | `now - 7d`  |
| 30 ngày     | `1d`     | _(omit)_ | `now - 30d` |

---

## 8a. Incidents — Bằng chứng sự cố blockchain

Incident do firmware ký (EIP-712) và gửi qua `device/{id}/incident`; backend verify rồi lưu vào `incidents` (không retention) và xếp `blockchain_outbox` ở `queued`. Hợp đồng dữ liệu: `docs/reference/BLOCKCHAIN_INCIDENT_SCHEMA.md`. Mọi route yêu cầu user là thành viên home của device (`checkDeviceAccess`), nếu không trả `403`. `:incidentId` là bytes32 hex (`0x` + 64 hex, không phân biệt hoa thường), sai định dạng trả `400`, không có trả `404`.

### `GET /api/devices/:id/incidents` 🔒

| Param             | Default | Max | Mô tả                                              |
| ----------------- | ------- | --- | -------------------------------------------------- |
| `limit`           | `50`    | 200 | Số item                                            |
| `before_sequence` | _(none)_| —   | Cursor: chỉ lấy `sequence` nhỏ hơn (chuỗi uint64)  |

**200 OK** (mới nhất trước, theo `sequence` giảm dần):
```json
[
  {
    "device_id": "aa:bb:cc:dd:ee:ff",
    "incident_id": "0xb11c…7477",
    "sequence": "44",
    "observed_at": "1790394700",
    "received_at": "2026-09-26T03:51:45.000Z",
    "severity": "danger",
    "overall_level": "EXCEEDED",
    "co_level": "EXCEEDED",
    "no2_level": "SAFE",
    "verify_status": "valid",
    "owner_status": "open",
    "chain_status": "queued",
    "tx_hash": null
  }
]
```

`chain_status`: `queued` | `pending` | `confirmed` | `failed` | `blocked` (Task 3 chỉ tạo `queued`; worker chain cập nhật phần còn lại). `owner_status`: `open` | `acknowledged` | `resolved` (indexer cập nhật).

### `GET /api/devices/:id/incidents/:incidentId` 🔒

Trả toàn bộ field summary và thêm:

| Field | Ý nghĩa |
| --- | --- |
| `incident_kind`, `time_source`, `observed_at_iso` | enum đã giải mã |
| `sensors`, `derived`, `model` | giá trị đã quy đổi (°C, %, ppm, xác suất 0..1); **`null` khi bit valid tương ứng bị clear** |
| `alarm_sources.co/no2` | `{ rule, projection, model }` từ source mask |
| `firmware`, `calibration` | version/hash firmware, `model_sha256`, calibration revision/hash; canonical là `null` cho Task 1 wire payload và hash không thể tái tạo độc lập |
| `evidence_hash`, `eip712_digest`, `signature`, `signer_address` | bằng chứng đã verify lúc intake |
| `owner_address` | ví owner on-chain (`null` tới khi indexer đồng bộ) |
| `owner` | thời điểm/ví/tx acknowledge và resolve |
| `chain` | `{ status, attempts, tx_hash, block_number, confirmations, confirmed_at, last_error, updated_at }` |
| `evidence` | 33 field evidence nguyên bản đúng như đã ký (uint64 là chuỗi) |

### `GET /api/devices/:id/incidents/:incidentId/verify` 🔒

Parse lại `raw_payload` đã lưu, tính lại identity/firmware/evidence/EIP-712 hash và chữ ký với domain đã ghi lúc intake, đồng thời đối chiếu các cột DB với payload gốc. `calibration_hash` được kiểm tra như signed evidence nhưng không có canonical preimage trên wire để tính độc lập.

**200 OK:**
```json
{
  "device_id": "aa:bb:cc:dd:ee:ff",
  "incident_id": "0xe8f3…a4d0",
  "valid": true,
  "db": {
    "stored": true,
    "received_at": "2026-09-26T03:50:05.000Z",
    "verify_status": "valid",
    "raw_payload_parsed": true,
    "columns_match_raw_payload": true,
    "mismatched_columns": []
  },
  "hashes": {
    "device_id_hash": { "stored": "0x…", "computed": "0x…", "match": true },
    "incident_id": { "stored": "0x…", "computed": "0x…", "match": true },
    "firmware_version_hash": { "stored": "0x…", "computed": "0x…", "match": true },
    "calibration_hash": { "stored": "0x…", "computed": null, "match": true, "independently_recomputable": false },
    "evidence_hash": { "stored": "0x…", "computed": "0x…", "match": true },
    "eip712_digest": { "stored": "0x…", "computed": "0x…", "match": true }
  },
  "signature": {
    "valid": true,
    "recovered_signer": "0xf39f…2266",
    "stored_signer": "0xf39f…2266",
    "registered": true,
    "signer_status": "active",
    "error": null
  },
  "domain": { "name": "AirSafetyLog", "version": "1", "chain_id": "11155111", "verifying_contract": "0x…" },
  "chain": { "status": "queued", "attempts": 0, "tx_hash": null, "block_number": null, "confirmations": null, "confirmed_at": null, "last_error": null, "updated_at": "…" }
}
```

`valid` = mọi hash có thể tái tạo khớp, `calibration_hash` trong DB khớp signed evidence, chữ ký recover đúng signer đã lưu, signer có trong registry (signer bị revoke sau thời điểm ký vẫn hợp lệ, `signer_status` báo `revoked`), và cột DB khớp payload gốc.

### Realtime / notification

Incident mới phát SSE event `incident.created` với payload `{ incident_id, sequence, severity, overall_level, co_level, no2_level, observed_at, chain_status }` và notification `incident.warning` ("Gas early warning") hoặc `incident.danger` ("Gas threshold exceeded").

---

## 8b. Chain worker — Health và metrics vận hành

Đọc từ DB (heartbeat `chain_worker_status`, `chain_checkpoints`, `blockchain_outbox`, `device_chain_ops`, `chain_ops_alerts`), không gọi RPC. Tách khỏi `/api/health/ready`: chain kẹt không làm API rớt khỏi rotation, vì MQTT intake, ACK và app vẫn chạy được. Hướng dẫn xử lý: [`docs/ops/CHAIN_WORKER_RUNBOOK.md`](../ops/CHAIN_WORKER_RUNBOOK.md).

**Quyền "ops":** header `Authorization: Bearer <OPS_METRICS_TOKEN>`. Nếu không đặt `OPS_METRICS_TOKEN`: mở khi chạy ngoài production, tắt trong production.

### `GET /api/health/chain`

Công khai phần tóm tắt; thêm `metrics` khi có quyền ops. `200` khi `status = "ok"`, `503` khi `"degraded"`.

```json
{
  "status": "degraded",
  "reasons": ["1 outbox item(s) blocked", "indexer is 102 blocks behind the chain head"],
  "checked_at": "2026-10-02T10:47:15.597Z",
  "metrics": {
    "worker": { "last_tick_age_seconds": 2, "consecutive_failures": 0, "rpc_errors_total": 1, "head_block": 1100, "indexed_block": 998, "index_lag_blocks": 102, "relayer_balance_wei": "…", "last_error": "…" },
    "outbox": { "by_status": { "queued": 0, "pending": 0, "confirmed": 12, "failed": 0, "blocked": 1, "legacy_domain": 0, "waiting_signer": 0, "stale_signer": 0 }, "oldest_queued_age_seconds": null, "oldest_pending_age_seconds": null, "max_attempts_open": 0 },
    "device_ops": { "by_status": { "queued": 0, "pending": 0, "confirmed": 3, "failed": 0, "blocked": 0 }, "oldest_queued_age_seconds": null },
    "alerts": { "open": 1, "undelivered": 0 }
  }
}
```

Lý do `degraded`: chưa có heartbeat; heartbeat cũ hơn `CHAIN_HEALTH_MAX_TICK_AGE_SECONDS` (120); lỗi liên tiếp ≥ `CHAIN_ALERT_FAILURE_STREAK` (5); lag indexer > `CHAIN_HEALTH_MAX_LAG_BLOCKS` (50); số dư relayer < `CHAIN_RELAYER_MIN_BALANCE_ETH` (0.05); có item `blocked`/`failed`; item `queued` cũ nhất > `CHAIN_HEALTH_MAX_QUEUED_AGE_SECONDS` (900).

### `GET /api/metrics/chain`

`text/plain; version=0.0.4`. Cần quyền ops (`401` khi sai token, `404` khi bị tắt). Các metric: `smartair_chain_healthy`, `smartair_chain_outbox_items{status}`, `smartair_chain_outbox_oldest_queued_age_seconds`, `smartair_chain_outbox_oldest_pending_age_seconds`, `smartair_chain_outbox_max_attempts`, `smartair_chain_device_ops_items{status}`, `smartair_chain_device_ops_oldest_queued_age_seconds`, `smartair_chain_worker_last_tick_age_seconds`, `smartair_chain_worker_consecutive_failures`, `smartair_chain_worker_rpc_errors_total`, `smartair_chain_head_block`, `smartair_chain_indexed_block`, `smartair_chain_index_lag_blocks`, `smartair_chain_relayer_balance_eth`, `smartair_chain_alerts_open`, `smartair_chain_alerts_undelivered`.

---

## 9. Realtime — App SSE and Notifications Feed

### `GET /api/notifications` 🔒

App-facing notification feed. Trả về newest-first history của các event có ý nghĩa vận hành thay vì raw telemetry.

Authorization: user phải là thành viên của home sở hữu device tạo ra notification event. Route hiện truy vấn qua `notification_events -> devices -> home_members`, không nhận `device_id` từ client.

**Query params:**

| Param       | Default | Max | Mô tả                                       |
| ----------- | ------- | --- | ------------------------------------------- |
| `limit`     | `50`    | 100 | Số item trả về                              |
| `before_id` | _(none)_| —   | Cursor phân trang theo `source_event_id`    |

**200 OK:**
```json
[
  {
    "id": "42",
    "type": "command.done",
    "device_id": "aa:bb:cc:dd:ee:ff",
    "device_name": "Living Room Air",
    "title": "Relay 1 turned on",
    "body": "Command completed successfully.",
    "severity": "success",
    "occurred_at": "2026-05-24T13:55:00.000Z",
    "payload": { "command_id": "cmd-1", "status": "done", "payload": { "type": "relay_set", "relay": 1, "state": true } }
  }
]
```

**Included sources:**

- `device.status` -> `device.online`, `device.offline`
- `command.updated` -> terminal states only: `command.done`, `command.error`, `command.timeout`
- `ota.progress` -> actionable milestones only: `ota.rebooting`, `ota.failed`

**Excluded sources:** `telemetry.point`, `shadow.reported`, `replay.reset`

| Error                    | Code | Message                                  |
| ------------------------ | ---- | ---------------------------------------- |
| `before_id` sai định dạng| 400  | `"before_id must be a numeric event id"` |
| `limit` không hợp lệ     | 400  | `"limit must be a positive integer"`     |
| Chưa đăng nhập           | 401  | `"Unauthorized"`                         |

### `GET /api/realtime` 🔒

App-facing realtime stream. This endpoint uses the same JWT session and device ownership checks as the REST API.
It is the default realtime transport for Flutter UI state.

```text
Authorization: Bearer <accessToken>
Accept: text/event-stream
Last-Event-ID: <optional event id>
```

Nginx disables buffering for this exact path. Server sends heartbeat comments to keep the connection open.
Server also enforces both global SSE capacity (`REALTIME_MAX_CLIENTS`) and per-IP SSE capacity (`REALTIME_MAX_CLIENTS_PER_IP`, default `10`).

**SSE frame:**

```text
id: 12345
event: telemetry.point
data: {"id":"12345","type":"telemetry.point","device_id":"aa:bb:cc:dd:ee:ff","occurred_at":"2026-05-15T10:00:00.000Z","payload":{}}
```

**Envelope fields:**

| Field         | Type   | Mô tả                                            |
| ------------- | ------ | ------------------------------------------------ |
| `id`          | string | Monotonic realtime event id for reconnect replay |
| `type`        | string | Event type, also used as the SSE `event` field   |
| `device_id`   | string | Device id this event belongs to                  |
| `occurred_at` | string | ISO timestamp for the underlying state change    |
| `payload`     | object | Type-specific app payload                        |

**Event types:**

| Type              | Produced after                              | Payload shape                                          |
| ----------------- | ------------------------------------------- | ------------------------------------------------------ |
| `telemetry.point` | Telemetry DB insert succeeds                | `{ ts, temperature, humidity, co_ppm, no2_ppm, mode }` |
| `device.status`   | Device row online/last_seen update succeeds | `{ online, firmware }`                                 |
| `shadow.reported` | Reported shadow update succeeds             | `{ reported, patch }`                                  |
| `command.updated` | Command row changes status                  | `{ command_id, status, payload?, error_message? }`     |
| `ota.progress`    | OTA progress Redis write succeeds           | OTA progress payload                                   |

| Error                        | Code                              | Message                               |
| ---------------------------- | --------------------------------- | ------------------------------------- |
| Invalid `Last-Event-ID`      | 400                               | `"Invalid Last-Event-ID"`             |
| Global realtime capacity hit | 503                               | `"Realtime capacity exceeded"`        |
| Per-IP realtime capacity hit | 429                               | `"Realtime per-IP capacity exceeded"` |

REST remains canonical for initial snapshots, history, reconnect backfill beyond the SSE replay window, and fallback.
Realtime events are retained for short reconnect replay (`REALTIME_EVENT_RETENTION_HOURS`, default 24h).
When an event source provides a stable idempotency key, retried inserts reuse the existing `realtime_events` row and do not emit duplicate SSE replay/history entries.

### MQTT WebSocket — broker clients

```text
Public URL:   wss://minhnhat05.xyz/mqtt
Internal hop: nginx /mqtt -> emqx:8083
Protocol:     MQTT v3.1.1 over WebSocket
```

> EMQX không publish port `8083` ra host.
> WebSocket path này chỉ đi qua `nginx` và Cloudflare Tunnel, không phải `ws://127.0.0.1:8083`.

> **Lưu ý:** Flutter app production flow dùng `/api/realtime`, không subscribe trực tiếp `/mqtt`.
> Nếu dùng WebSocket MQTT trực tiếp, EMQX đang xác thực bằng MQTT username/password theo built-in database; JWT của REST API không được dùng cho MQTT/WSS.
> `docs/reference/MQTT_PROTOCOL.md` mới là contract chi tiết cho toàn bộ topics và payload MQTT.

**Topics subscribe:**

| Topic                      | Payload                                                           | Dùng để         |
| -------------------------- | ----------------------------------------------------------------- | --------------- |
| `device/{id}/status`       | `{"online":true,"firmware":"<firmware version>"}`                 | Online/offline  |
| `device/{id}/telemetry`    | `{"device_id":"...","mode":"on","ts":123,"temperature":28.5,"humidity":65.2,"co_ppm":3.1,"no2_ppm":0.04}` | Realtime sensor |
| `device/{id}/ota/progress` | `{"progress":10}` or `{"progress":100,"status":"rebooting"}`      | OTA progress    |

---

## 10. Redis Keys Reference

| Key                       | Type        | TTL    | Set bởi               |
| ------------------------- | ----------- | ------ | --------------------- |
| `announce:{deviceId}`     | string      | 300s   | `handleStatus()`      |
| `shadow:{deviceId}`       | JSON string | 3600s  | `getShadow()` (cache) |
| `pending_cmds:{deviceId}` | list        | legacy | Dọn khi delete device |
| `ota_progress:{deviceId}` | JSON string | 600s   | `handleOtaProgress()` |

---

## 11. MQTT Bridge — Server-side

Client ID `sa-api-bridge`, kết nối `mqtt://emqx:1883` (internal Docker network).
EMQX Admin API provisioning/cleanup dùng `EMQX_API_URL` và timeout `EMQX_API_TIMEOUT_MS` (default 5000 ms).

**Subscribe:**

| Topic                    | Handler                | Xử lý                                                                                                                                                                                |
| ------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `device/+/status`        | `handleStatus()`       | Validate `{online:boolean}`; update `devices.online`; persist firmware version when present; emit `device.status`; SET `announce:`; `flushPending()`                                 |
| `device/+/telemetry`     | `handleTelemetry()`    | Validate plain-object schema, size, device/topic match, mode, sensor fields, ts; clamp stale/future ts; INSERT TimescaleDB with QoS-1 dedupe; emit `telemetry.point`                 |
| `device/+/response`      | `handleResponse()`     | Accept `done`/`error`; guard device mismatch; update `commands` from `sent` to terminal state; persist optional error message; emit `command.updated`                                 |
| `device/+/shadow/report` | `handleShadowReport()` | Drop unknown devices, validate known fields and size, normalize future ts, UPSERT `device_shadows` only when `payload.ts` is not older than current `reported.ts`; emit applied patch |
| `device/+/shadow/get`    | `handleShadowGet()`    | Require plain object payload, load shadow, best-effort publish `shadow/get_response`                                                                                                  |
| `device/+/ota/progress`  | `handleOtaProgress()`  | Cache raw JSON at `ota_progress:` TTL 600s; emit `ota.progress` without additional schema validation                                                                                 |
| `device/+/incident`      | `handleIncident()`     | Dedupe theo `(device_id, incident_id)`; verify Schema v2 (format, enum/mask, wire-recomputable hashes, signed `calibration_hash`, EIP-712, signer active); delayed/future-time và sequence-uniqueness policy; một transaction INSERT `incidents` + `blockchain_outbox(queued)` + `incident.created`; ACK sau commit |

**Publish:**

| Topic                             | Khi nào                                              | Payload                      |
| --------------------------------- | ---------------------------------------------------- | ---------------------------- |
| `device/{id}/command`             | `sendCommand()` / `flushPending()`                   | `{ command_id, ...payload }` |
| `device/{id}/shadow/get_response` | Device online / `PUT /shadow/desired` / `shadow/get` | `{ desired, delta, ts }`     |
| `device/{id}/incident/ack`        | Sau khi xử lý `device/{id}/incident`                  | `{ schema_version, incident_id, evidence_hash, accepted, error_code, received_at }` |

> OTA trigger `device/{id}/ota/update` hiện do API bridge publish khi app gọi `POST /api/devices/:id/ota`. Manual broker/admin publish vẫn là fallback operator path nếu cần.

---

## 12. Constants Reference

Tất cả centralized tại `src/constants.js`:

| Constant                  | Giá trị                      | Dùng cho                            |
| ------------------------- | ---------------------------- | ----------------------------------- |
| `REDIS_TTL_ANNOUNCE`      | 300                          | TTL `announce:` key                 |
| `REDIS_TTL_OTA`           | 600                          | TTL `ota_progress:` key             |
| `REDIS_TTL_SHADOW`        | 3600                         | TTL `shadow:` cache                 |
| `BCRYPT_ROUNDS`           | 12                           | Password hash strength              |
| `REFRESH_COOKIE_PATH`     | `/api/auth/refresh`          | Cookie path                         |
| `SECONDS_PER_DAY`         | 86400                        | Refresh token expiry calc           |
| `ALLOWED_ORIGINS`         | `['https://minhnhat05.xyz']` | CORS (env override: `CORS_ORIGINS`) |
| `RATE_LIMIT_COMMAND`      | 30/min                       | POST /command                       |
| `RATE_LIMIT_DEVICE`       | 20/min                       | POST /devices                       |
| `AGG_ALLOWED`             | `1m,5m,15m,30m,1h,6h,1d`     | Telemetry agg whitelist             |
| `COMMANDS_MAX_LIMIT`      | 200                          | Max limit query commands            |
| `TELEMETRY_DEFAULT_LIMIT` | 1000                         | Default limit telemetry             |
| `TELEMETRY_MAX_LIMIT`     | 5000                         | Max limit telemetry                 |
| `MS_PER_DAY`              | 86400000                     | Default `from` (24h trước)          |

---

## 13. Flows thực tế

### Flow 1 — BLE Provisioning → Device online

```
 1. ESP32 boot → BLE advertising "SMART_AIR_13ED8C"
 2. Flutter scan BLE → connect GATT
 3. Flutter write SSID → characteristic 0xFF01
 4. Flutter write Password → characteristic 0xFF02
 5. ESP32 join Wi-Fi
 6. ESP32 notify Flutter qua 0xFF03: {"ip":"192.168.1.26","device_id":"aa:bb:cc:dd:ee:ff","status":"ok"}
 7. Flutter POST /api/devices { device_id, name, home_id, room_id? }
 8. Server tạo EMQX user + ACL → trả về secret_key đúng 1 lần
9. App chuyển `device_id` + `secret_key` xuống firmware qua local endpoint `POST http://<device-ip>/api/config`
10. ESP32 validate `device_id` phải trùng Wi-Fi STA MAC, lưu credential vào NVS, reboot, rồi kết nối MQTT broker (`wss://minhnhat05.xyz/mqtt` mặc định)
11. ESP32 publish `device/{device_id}/status = {"online":true,"firmware":"<current firmware version>" }`
12. Server handleStatus() → UPDATE devices → SET announce:{device_id} TTL 300s
13. Flutter polling GET /api/devices/announce/{device_id} → announced: true
14. Flutter navigate → device detail screen
```

> Security note: bước BLE provisioning hiện chưa yêu cầu authenticated pairing, bonding, hay encrypted link trước khi app ghi SSID/password. Thiết kế hiện tại giả định thiết bị đang ở môi trường cài đặt vật lý tin cậy; client BLE bất kỳ trong vùng radio vẫn có thể thử ghi credential trong lúc onboarding.

> Firmware local endpoint `POST /api/config` nhận JSON:
> `{ "device_id": "aa:bb:cc:dd:ee:ff", "secret_key": "...", "broker_uri": "wss://minhnhat05.xyz/mqtt" }`.
> `broker_uri` optional; nếu bỏ qua firmware xóa override cũ và dùng Kconfig default.
> Endpoint này là local device provisioning, không phải public server REST endpoint.
> Security note: transport hiện là plain HTTP trên LAN, không có TLS, request auth, hay one-time bootstrap token trong firmware. Flow này chỉ phù hợp khi thiết bị đang ở mạng cài đặt tạm thời và installer tin cậy toàn bộ local network trong lúc provisioning; shared/untrusted LAN có thể sniff hoặc race `secret_key`.

### Flow 2 — Realtime Dashboard

```
1. Flutter mở device detail
2. GET /api/devices/:id/shadow → hiển thị reported/desired state hiện tại
3. GET /api/devices/:id/telemetry?from=now-30m&limit=... → initial live snapshot
4. GET /api/realtime → subscribe SSE bằng JWT
5. ESP32 publish telemetry/status/shadow/response/OTA qua MQTT
6. Server persist state → insert `realtime_events` → SSE emits app event
7. Flutter Riverpod live store append/merge event without remounting the screen
8. Nếu reconnect vượt replay window, Flutter refetch snapshot/history qua REST
```

### Flow 3 — Command set_time

```
1. Flutter POST /api/devices/:id/command { payload: { type: "set_time", ts: ... } }
2. Server INSERT commands status='pending'
3. Device online → MQTT publish device/{id}/command: { command_id, type, ts }
4. Server UPDATE status='sent'
5. ESP32 nhận → cập nhật DS3231 RTC
6. ESP32 publish device/{id}/response: { command_id, status: "done" }
7. Server handleResponse() → UPDATE status='done', executed_at=NOW(), emit `command.updated`
8. Flutter SSE updates recent command state; REST command history remains available for history/backfill
```

### Flow 4 — OTA từ app

```
1. Drop `0.1.2.bin` vào `server/ota-files/`
2. Flutter `GET /api/devices/:id/ota/versions`
3. User chọn version trong app
4. Flutter `POST /api/devices/:id/ota` với `{ "version": "0.1.2" }`
5. Server resolve file, tính SHA-256, rồi MQTT publish `device/{id}/ota/update`
6. ESP32 download → verify SHA256 → reboot
7. Server handleOtaProgress() → Redis ota_progress:{id}
8. ESP32 boot → ota_validate_and_commit() → committed
```

### Admin surfaces hiện có

| Surface             | URL / Port                        | Ghi chú                 |
| ------------------- | --------------------------------- | ----------------------- |
| EMQX Dashboard      | `http://127.0.0.1:18083`          | localhost only          |
| pgAdmin             | `http://127.0.0.1:5050`           | localhost only          |
| Portainer           | `http://127.0.0.1:9000`           | localhost only          |
| API public path     | `https://minhnhat05.xyz/api/...`  | qua nginx + cloudflared |

> `api`, `nginx`, và `redis` không bind port trực tiếp ra host trong `docker-compose.yml`.

---

## 14. Error Reference

### Auth Errors

| Situation                  | Code | Body                          |
| -------------------------- | ---- | ----------------------------- |
| Thiếu Authorization header | 401  | `{ "error": "Unauthorized" }` |
| Token hết hạn / invalid    | 401  | `{ "error": "Unauthorized" }` |

### Permission Errors

| Situation                                    | Code | Body                                                                           |
| -------------------------------------------- | ---- | ------------------------------------------------------------------------------ |
| `checkDeviceAccess` / `checkMembership` fail | 403  | `{ "error": "Forbidden" }`                                                     |
| `requireRole` fail                           | 403  | Fastify: `{ "statusCode": 403, "error": "Forbidden", "message": "Forbidden" }` |

### Validation Errors

| Situation              | Code | Message                                                      |
| ---------------------- | ---- | ------------------------------------------------------------ |
| Thiếu email/password   | 400  | `"email and password required"`                              |
| Thiếu name (home/room) | 400  | `"name required"`                                            |
| Email invite invalid   | 400  | `"valid email required"`                                     |
| Thiếu device fields    | 400  | `"device_id, name, home_id required"`                        |
| room_id sai UUID       | 400  | `"room_id must be a valid UUID"`                             |
| room không thuộc home  | 400  | `"room_id does not belong to home"`                          |
| Device ID sai MAC      | 400  | `"Invalid device ID"` hoặc `"Invalid mac"`                   |
| Thiếu command payload  | 400  | `"payload required"`                                         |
| Shadow body sai format | 400  | `"body must be a plain JSON object"`                         |
| Telemetry agg sai      | 400  | `"Invalid agg value. Allowed: 1m, 5m, 15m, 30m, 1h, 6h, 1d"` |

### Conflict Errors

| Situation         | Code | Message                       |
| ----------------- | ---- | ----------------------------- |
| Email đã đăng ký  | 409  | `"Email already registered"`  |
| Device đã tồn tại | 409  | `"Device already registered"` |
| Đã là thành viên  | 409  | `"Already a member"`          |

### Infrastructure Errors

| Situation           | Code | Body                                                                         |
| ------------------- | ---- | ---------------------------------------------------------------------------- |
| DB/Redis/MQTT down  | 503  | `{ "status": "degraded", "ts": ..., "checks": { "postgres": "fail", ... } }` |
| Rate limit exceeded | 429  | `{ "statusCode": 429, "error": "Too Many Requests", ... }`                   |
