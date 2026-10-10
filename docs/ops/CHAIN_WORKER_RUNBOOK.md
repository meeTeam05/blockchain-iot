# Runbook chain worker (Task 4)

Vận hành phần đưa incident lên Sepolia: relayer, device op, indexer, giám sát và
xử lý sự cố. Kiến trúc và luật nghiệp vụ nằm ở
[`docs/reference/BLOCKCHAIN_INCIDENT_SCHEMA.md`](../reference/BLOCKCHAIN_INCIDENT_SCHEMA.md).

## 1. Thành phần

| Thành phần | Ở đâu | Việc |
|---|---|---|
| `chain-worker` (container `sa-chain-worker`, profile `chain`) | `server/api/src/worker.js` | Mỗi `CHAIN_POLL_INTERVAL_MS`: indexer → device op → outbox → heartbeat → gửi alert |
| Relayer | `src/chain/relayer.js` | `blockchain_outbox` → `logIncident`; `device_chain_ops` → register/rotate/revoke/set_owner |
| Indexer | `src/chain/indexer.js` | Đọc event từ `chain_checkpoints` tới head − (`CHAIN_CONFIRMATIONS` − 1), ghi `chain_events`, cập nhật outbox/incident/device |
| Heartbeat | `chain_worker_status` | Head block, lỗi liên tiếp, tổng lỗi, số dư relayer |
| Alert | `chain_ops_alerts` (+ `OPS_ALERT_WEBHOOK_URL`) | Item `blocked`/`failed`, worker lỗi liên tiếp/dừng, số dư thấp |
| CLI | `server/api/scripts/chain-ops.js` | Xem trạng thái, requeue, ack alert |

Các lệnh `docker compose` trong runbook chạy trong thư mục `server/`. Lệnh
`make` chạy ở thư mục gốc repo.

Chỉ chạy **một** worker trên mỗi database: worker giữ advisory lock và từ chối
khởi động nếu đã có worker khác. Hai worker dùng chung một ví relayer sẽ tranh nonce.

### Luật thứ tự

- **Outbox incident:** mỗi row độc lập. Contract lưu exact-use theo
  `(device, sequence)`, nên một row `blocked` **không** chặn các sequence khác
  của cùng thiết bị.
- **Device op:** tuần tự theo từng thiết bị. Một op `blocked`/`failed` giữ các op
  phía sau của thiết bị đó cho đến khi được requeue.
- **Giới hạn retry:** `CHAIN_MAX_ATTEMPTS` (10) lần hoặc `CHAIN_MAX_RETRY_AGE_HOURS`
  (24) giờ, tính từ `retry_window_started_at` (mặc định `created_at`). Tx bị drop
  hoặc revert khi vào block cũng bị tính vào giới hạn này.
- **Không bao giờ gửi trùng:** trước mỗi lần gửi, relayer đọc `getIncident` trên
  chain; incident đã có thì chỉ đánh `confirmed`.

## 2. Giám sát

### Lệnh nhanh

```bash
make chain-status                       # = docker exec sa-chain-worker node scripts/chain-ops.js status
make chain-ops ARGS="stuck"             # item blocked/failed
make chain-ops ARGS="alerts"            # alert chưa ack
```

### Endpoint

| Endpoint | Ai xem | Dùng cho |
|---|---|---|
| `GET /api/health/chain` | Công khai: `status` + `reasons`; ops: thêm `metrics` | Uptime check: `200` ok, `503` degraded |
| `GET /api/metrics/chain` | Ops (`Authorization: Bearer $OPS_METRICS_TOKEN`) | Prometheus scrape |

Trong production phải đặt `OPS_METRICS_TOKEN`, nếu không hai view ops bị tắt.
Chi tiết schema: [`API_REFERENCE.md` mục 8b](../reference/API_REFERENCE.md#8b-chain-worker--health-và-metrics-vận-hành).

### Ngưỡng degraded (biến `.env`)

| Điều kiện | Biến | Mặc định |
|---|---|---|
| Heartbeat cũ | `CHAIN_HEALTH_MAX_TICK_AGE_SECONDS` | 120 |
| Lỗi liên tiếp (cũng là ngưỡng alert) | `CHAIN_ALERT_FAILURE_STREAK` | 5 |
| Indexer chậm | `CHAIN_HEALTH_MAX_LAG_BLOCKS` | 50 |
| Item queued cũ nhất | `CHAIN_HEALTH_MAX_QUEUED_AGE_SECONDS` | 900 |
| Số dư relayer thấp | `CHAIN_RELAYER_MIN_BALANCE_ETH` (`0` = tắt) | 0.05 |
| Có item `blocked`/`failed` | — | luôn |

### Alert

| `kind` | Mức | Khi nào | Xử lý |
|---|---|---|---|
| `outbox_blocked` | critical | Row hết retry | §4.1 |
| `outbox_failed` | critical | Revert xác định (`SequenceAlreadyUsed`, lỗi intake, …) | §4.2 |
| `device_op_blocked` | critical | Op hết retry; op sau của thiết bị đang chờ | §4.3 |
| `device_op_failed` | critical | Op revert (vd. `DeviceNotRegistered`) | §4.3 |
| `worker_failing` | critical | Lỗi liên tiếp ≥ `CHAIN_ALERT_FAILURE_STREAK` | §4.4 |
| `worker_stopped` | critical | Worker dừng vì lỗi nghiêm trọng (mất role) | §4.5 |
| `relayer_low_balance` | warning | Số dư < ngưỡng, nhắc tối đa 1 lần/ngày | §3 |

Mỗi alert chỉ được tạo một lần (theo `dedupe_key`). Nếu có `OPS_ALERT_WEBHOOK_URL`
(Slack hoặc Discord), worker gửi theo thứ tự và thử lại cho tới khi webhook nhận.
Xử lý xong thì ack:

```bash
make chain-ops ARGS="ack-alert 12 13"   # hoặc ARGS="ack-alert --all"
```

## 3. Nạp Sepolia ETH cho relayer

1. Xem địa chỉ và số dư: `make chain-status` → `metrics.worker.relayer_address`,
   `relayer_balance_wei`; hoặc metric `smartair_chain_relayer_balance_eth`.
2. Nạp từ faucet Sepolia hoặc chuyển từ ví team. Phí mỗi `logIncident` thay đổi
   theo gas price. Ước lượng bằng phí các tx gần nhất của ví relayer trên
   Etherscan, và giữ số dư trên ngưỡng `CHAIN_RELAYER_MIN_BALANCE_ETH`.
3. Không cần restart. Row bị `blocked` vì hết ETH (`last_error` chứa
   `insufficient funds`) phải requeue (§4.1).

## 4. Xử lý sự cố

### 4.1 Outbox `blocked`

```bash
make chain-ops ARGS="stuck"                          # xem last_error
# sửa nguyên nhân (nạp ETH, đổi RPC, …) rồi:
make chain-ops ARGS="requeue-outbox 41 42"           # hoặc ARGS="requeue-outbox --all-blocked"
```

Requeue đặt `attempts = 0`, `retry_window_started_at = NOW()` và gửi lại ở tick
sau. An toàn kể cả khi tx cũ thực ra đã lên chain: relayer kiểm tra chain trước
khi gửi. **Không** sửa bằng `UPDATE … SET status='queued'`, vì cách đó không reset
retry window nên row cũ hơn 24 giờ sẽ bị `blocked` lại ngay lần lỗi đầu.

### 4.2 Outbox `failed`

`failed` là revert xác định, gửi lại vẫn ra cùng kết quả:

| `fail_reason` | Ý nghĩa | Việc làm |
|---|---|---|
| `SequenceAlreadyUsed` / `IncidentAlreadyLogged` (kèm `security_events.CHAIN_CONFLICT`) | Chain đã có incident cùng key nhưng **khác** evidence | Sự cố bảo mật: điều tra thiết bị/khóa, không requeue |
| `InvalidSignature`, `IncidentIdMismatch`, `InvalidSequence`, … | Intake nhận một bản ghi mà contract từ chối | Bug: báo dev kèm `incident_id` |

Chỉ requeue bằng `--include-failed` sau khi đã sửa nguyên nhân.

### 4.3 Device op `blocked`/`failed`

Op sau của cùng thiết bị đang chờ op này.

- `blocked` (RPC/ETH): sửa nguyên nhân rồi `make chain-ops ARGS="requeue-op <id>"`.
- `failed`, ví dụ:
  - `DeviceNotRegistered`: phải `register` trước, dùng `node scripts/device-signer.js sync-chain <device> --owner <ví>`.
  - `SignerAlreadyUsed`: khóa đã từng đăng ký, phải provision khóa mới.

  Sau đó `requeue-op <id> --include-failed`, hoặc để op hỏng lại và tạo op mới
  sau khi dev xác nhận.

### 4.4 `worker_failing` / heartbeat cũ

```bash
docker logs --tail 100 sa-chain-worker
```

| Log | Nguyên nhân | Việc làm |
|---|---|---|
| `429`, `rate limit`, `ECONNRESET`, timeout | RPC công cộng quá tải | Đổi `CHAIN_RPC_URL` sang RPC riêng, restart worker |
| `eth_getLogs` range/limit | RPC giới hạn range | Đặt `CHAIN_LOG_BATCH_BLOCKS=500`, restart worker |
| `another chain worker already holds the worker lock` | Có worker thứ hai | Tắt worker thừa |
| Heartbeat cũ nhưng log im lặng | Container dừng/treo | `docker compose --profile chain up -d chain-worker` |

### 4.5 `worker_stopped` / worker exit code 2

Lỗi nghiêm trọng thì worker dừng hẳn, row vẫn ở `queued`:

- **`missing on-chain roles` / `relayer lost its role`:** cấp lại role (§5), rồi
  `docker compose --profile chain up -d chain-worker`.
- **`EIP-712 domain mismatch` / `RPC chainId … does not match`:** `.env` hoặc RPC
  trỏ sai mạng/contract. Sửa `INCIDENT_DEPLOYMENT`/`CHAIN_RPC_URL`, không đổi contract.

### 4.6 Indexer chậm hoặc cần replay

- **Lag tăng dần:** RPC chậm hoặc batch quá lớn. Xem §4.4.
- **Replay an toàn:** event lưu idempotent theo `(contract, tx_hash, log_index)`,
  và cập nhật incident/outbox có điều kiện, nên chạy lại không ghi trùng. Để
  index lại từ đầu, ví dụ sau khi restore DB:

  ```sql
  DELETE FROM chain_checkpoints WHERE contract_address = '<contract lowercase>';
  ```

  Worker đọc lại từ `CHAIN_START_BLOCK`, hoặc từ block deploy nếu biến này không đặt.

## 5. Rotate ví relayer

Làm khi khóa relayer có thể bị lộ, hoặc định kỳ.

1. Tạo ví mới, nạp ETH (§3). **Không** dùng ví admin.
2. Cấp role bằng ví admin (`blockchain/.env`: `DEPLOYER_PRIVATE_KEY`, `SEPOLIA_RPC_URL`):
   ```bash
   cd blockchain
   npx hardhat roles --network sepolia --action grant --role RELAYER_ROLE --account <ví mới>
   ```
3. Chờ không còn outbox `pending`: `make chain-status` → `outbox.by_status.pending = 0`.
   Tx `pending` của ví cũ vẫn được reconcile theo tx hash, nhưng chờ cho gọn hơn.
4. Đổi `RELAYER_PRIVATE_KEY` trong `server/.env`, rồi
   `docker compose --profile chain up -d --force-recreate chain-worker`.
   Kiểm tra log `chain worker started` có `relayer` là ví mới.
5. Thu hồi role ví cũ:
   ```bash
   npx hardhat roles --network sepolia --action revoke --role RELAYER_ROLE --account <ví cũ>
   ```
6. Kiểm tra lại: `npx hardhat roles --network sepolia`.

Rotate ví device manager (`DEVICE_MANAGER_PRIVATE_KEY`) làm giống hệt, với
`DEVICE_MANAGER_ROLE`.

## 6. Checklist sau sự cố

- [ ] `GET /api/health/chain` trả `200`.
- [ ] `make chain-ops ARGS="stuck"` rỗng, hoặc các item còn lại đã được ghi rõ lý do.
- [ ] Alert đã xử lý xong được ack.
- [ ] Nếu nguyên nhân là ETH/RPC, đã điều chỉnh ngưỡng hoặc nhà cung cấp để không lặp lại.
