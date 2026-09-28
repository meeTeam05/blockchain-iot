# Kế hoạch triển khai tầng Blockchain

## Mục tiêu và phạm vi

Blockchain tạo dấu vết bất biến cho sự cố mà Gas EWS đã chốt; nó không huấn
luyện/suy luận AI và không nằm trên đường cảnh báo an toàn tức thời.

```text
Gas EWS transition tăng mức → ESP32 cảnh báo tại chỗ → incident đã ký
→ MQTT → backend verify + TimescaleDB → ACK → Sepolia outbox → app
```

Nguồn hợp đồng duy nhất là
[`docs/BLOCKCHAIN_INCIDENT_SCHEMA.md`](docs/BLOCKCHAIN_INCIDENT_SCHEMA.md).
Incident mới bắt buộc dùng Schema v2 và hai vector v2 trong `docs/test-vectors/`.
Chỉ tạo incident cho `SAFE → EARLY_WARNING`, `SAFE → EXCEEDED`, hoặc
`EARLY_WARNING → EXCEEDED`; không tạo cho heartbeat, giữ/giảm level, warmup,
clock không hợp lệ hoặc dữ liệu trigger không hợp lệ.

## Quyết định triển khai đã chốt

- Dùng **Sepolia**. Chain chỉ lưu claim tối thiểu và `evidenceHash`; evidence
  đầy đủ lưu, backup và giữ không thời hạn trong TimescaleDB.
- Backend dùng **relayer wallet** từ secret môi trường/secret manager để gọi
  `logIncident`. ESP32 chỉ giữ khóa ký thiết bị; app không giữ khóa relayer.
- Outbox gửi theo `sequence` tuần tự cho từng thiết bị. Retry exponential
  backoff; quá 10 lần hoặc 24 giờ chuyển `blocked`, báo vận hành và chặn các
  incident chain tiếp theo của thiết bị đó. MQTT ACK, DB và app không bị chặn.
- Chỉ nhận `timeSource` SNTP/RTC hợp lệ và `observed_at > 0`; từ chối timestamp
  ở tương lai quá 10 phút. Bản ghi signed hợp lệ đến muộn vẫn được nhận.
- Chỉ rotate sau khi firmware flush queue. Factory reset giữ signer/sequence/
  queue; revoke hoặc rotate signer là lifecycle operation tường minh, phối hợp
  với backend/operator. Không ký lại incident cũ.
- ACK QoS 1 gồm `schema_version`, `incident_id`, `evidence_hash`, `accepted`,
  `error_code`, `received_at`; firmware chỉ xóa queue khi `accepted=true` và
  ID/hash khớp bản đã lưu.
- MVP chỉ tạo `warning` và `danger`. `critical`/`EmergencyTriggered` chưa có
  producer, dù contract có thể giữ event để mở rộng sau.

## Phân công 5 task

### Task 1 — Firmware: tạo, ký và gửi incident

**Phạm vi:** `firmware/components/core/incident/`, tích hợp `ai.c` và MQTT.

- Tạo snapshot nhất quán và incident v2 cho đúng ba transition; lưu sequence
  bền vững, không lặp sau reboot.
- Tính canonical evidence, EIP-712 digest và chữ ký secp256k1, phải khớp hai
  vector v2. Dùng NVS Encryption cho khóa riêng; không log khóa, seed hay digest.
- Persist payload đã ký trước khi publish `device/{id}/incident` QoS 1. Khi mất
  mạng/reboot, retry nguyên bytes/ID/hash/chữ ký; parse ACK và chỉ xóa khi khớp.
- Thêm giới hạn queue, retry/queue-full metrics và tài liệu provision/rotate/reset.

**Không làm:** contract, TimescaleDB, relayer.  
**Hoàn thành khi:** build và vector pass; cảnh báo cục bộ xảy ra trước I/O;
reboot retry không đổi chữ ký; ACK sai không xóa record.

### Task 2 — Smart contract và deploy Sepolia

**Phạm vi:** thư mục `blockchain/`, Hardhat, Solidity, ABI/deploy artifacts.

- Viết `AirSafetyLog` với OpenZeppelin `AccessControl`/`ECDSA`: register,
  rotate, revoke, `logIncident`, acknowledge và resolve.
- Recover EIP-712 signer, kiểm tra device active, chống replay bằng
  `incidentKey`, buộc sequence tăng, và chỉ lưu claim/evidence hash tối thiểu.
- Phát `IncidentLogged`, `IncidentAcknowledged`, `IncidentResolved` và giữ
  `EmergencyTriggered` cho policy sau này; chỉ `ownerAddress` được acknowledge/
  resolve.
- Test vector v2, tamper, signer sai, duplicate, sequence cũ, revoked và role;
  deploy/verify source trên Sepolia, bàn giao ABI, address, chain ID, tx deploy.

**Không làm:** MQTT, DB, app.  
**Hoàn thành khi:** toàn bộ Hardhat test pass và backend có ABI/address Sepolia
đã verify để gọi.

### Task 3 — Backend: intake, verify, lưu evidence và API

**Phạm vi:** Fastify MQTT handler, EMQX ACL, migrations, APIs và realtime.

- Subscribe `device/+/incident`; cấp ACL publish/ACK. Validate v2, topic/device
  ID, time policy, enum/mask, các hash có preimage trên wire, signed
  `calibration_hash`, EIP-712 signature và signer đăng ký.
- Tạo `incidents` không retention với unique `(device_id, incident_id)` và
  `(device_id, sequence)`, evidence/payload nguyên bản, verify result và status.
- Payload trùng cùng hash: ACK thành công, không tạo row. Cùng ID khác hash:
  ghi security event, không ghi đè/ACK thành công. Sau DB commit publish ACK chuẩn.
- Tạo `blockchain_outbox` ở `queued`; expose list/detail/verify API có auth,
  cùng realtime warning/danger. Không gửi transaction trong task này.

**Không làm:** worker/relayer, contract, app wallet.  
**Hoàn thành khi:** hai vector được lưu/ACK idempotent; tamper/timestamp sai bị
từ chối; API verify trả DB, hash và signature status.

**Bàn giao Task 3 (nhánh `feature/blockchain-task3-incident-intake`):**

- Task 1: payload truyền signed `calibration_hash`, không truyền
  `calibration_canonical`; backend không được giả định arrival theo `sequence`.
  ACK thành công dùng `error_code:""`; mã lỗi ACK ở
  `docs/MQTT_PROTOCOL.md` 4.4. Incident hợp lệ đến muộn được nhận; chỉ
  timestamp bằng 0 hoặc ở tương lai quá tolerance bị từ chối.
- Task 2/4: backend đọc domain từ `AIR_SAFETY_LOG_ADDRESS`/`INCIDENT_CHAIN_ID`;
  signer đăng ký ở `device_signers` (`scripts/device-signer.js`) phải trùng
  signer on-chain. Outbox `blockchain_outbox` (migration 017) đã có đủ cột
  `attempts`, `next_attempt_at`, `tx_hash`, `block_number`, `confirmations`,
  `blocked_at`; Task 4 chỉ UPDATE. Indexer ghi `incidents.owner_status`,
  `acknowledged_*`, `resolved_*` và `devices.owner_address`.
- Task 5: API `GET /api/devices/:id/incidents[/:incidentId[/verify]]`, SSE
  `incident.created`, notification `incident.warning`/`incident.danger`
  (`docs/API_REFERENCE.md` mục 8a).
- Vận hành: chạy `node scripts/sync-device-acl.js` trước khi firmware publish
  incident để thiết bị cũ có ACL `incident`/`incident/ack`.
- Kiểm thử end-to-end (API + EMQX + TimescaleDB thật từ `server/docker-compose.yml`):
  `test/e2e/incident-mqtt.e2e.test.js`, lệnh chạy ghi ở đầu file; tự skip khi
  không có `E2E_API_URL`/`E2E_MQTT_URL`.

### Task 4 — Backend: worker chain, indexer và vận hành

**Phạm vi:** worker độc lập, Sepolia config, indexer, metrics và runbook.

- Lấy outbox `queued` FIFO theo từng device; relayer gọi `logIncident`; lưu
  transaction hash, confirmation, block number, attempts và lỗi.
- Retry RPC/revert có phân loại và backoff; kiểm tra on-chain trước retry. Sau
  10 attempts hoặc 24 giờ, đánh `blocked`, alert, và không vượt sequence device.
- Index/replay idempotent từ block checkpoint bền vững cho event logged,
  acknowledged, resolved; DB/indexer là nguồn trạng thái cuối cùng của app.
- Cung cấp health/metrics: age queued, pending/blocked count, attempts, RPC
  errors, DB-chain lag; runbook cho nạp Sepolia ETH, rotate relayer, unblock item.

**Không làm:** nhận MQTT, verify evidence, UI.  
**Hoàn thành khi:** restart/RPC timeout không tạo giao dịch trùng; event replay
an toàn; blocked item giữ đúng thứ tự và tạo cảnh báo vận hành.

### Task 5 — App: incident, verify và owner action

**Phạm vi:** `app_new/` screens, API client, realtime và WalletConnect/deep link.

- Hiển thị danh sách/chi tiết theo device: level, source mask, sensor/derived
  values chỉ khi valid, firmware/model/calibration, verify result và chain status.
- Nhận realtime warning/danger; hiển thị `pending`, `confirmed`, `failed`,
  `blocked`, transaction hash/block và link Etherscan Sepolia.
- Kết nối ví, xác minh ownership với backend, chỉ hiện acknowledge/resolve khi
  ví khớp `ownerAddress`; app gọi contract trực tiếp, indexer xác nhận kết quả.
- Test severity/status, invalid fields, offline, wallet reject, transaction
  failure và user không có quyền. Không lưu private key.

**Không làm:** MQTT trực tiếp, ký evidence ESP32, relayer.  
**Hoàn thành khi:** user chỉ thấy incident được phép; owner action hoạt động;
app cập nhật sau event index và mở đúng explorer Sepolia.

## Phụ thuộc và bàn giao

1. Task 2 bàn giao ABI, address và fixture contract; Task 1/3 bắt buộc dùng
   vector v2 làm test chung.
2. Task 1 và Task 3 làm song song bằng mock MQTT/fixtures.
3. Task 3 bàn giao migrations, outbox và API; Task 4 chỉ xử lý chain, không sửa
   logic intake. Task 5 bắt đầu với API mock rồi tích hợp API thật.
4. Merge end-to-end chỉ sau khi pass: offline/reboot retry, MQTT duplicate/
   tamper, revoke/rotate signer, backend restart, RPC failure, sequence blocked
   và owner authorization.
