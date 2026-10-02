# Task 4 Handoff Report: Chain worker, indexer và vận hành

- **Nhánh:** `feature/task4-chain-ops`, tách từ `integration/task1-task2-task3-task5` (`024a07da`)
- **Ngày:** 2026-10-02
- **Định nghĩa task:** [`Blockchain_task.md`](Blockchain_task.md), mục Task 4

## 1. Tình trạng

Task 4 đã **xong phần code, test và tài liệu**. Còn chờ review/merge và deploy lên Sepolia.

Relayer và indexer đã có từ commit `797280e0` (đợt fix E2E). Nhánh này làm nốt
phần vận hành còn thiếu: metrics, cảnh báo, công cụ unblock, runbook và test,
đồng thời sửa spec cho khớp với contract.

## 2. Đối chiếu tiêu chí Task 4

| Yêu cầu | Trạng thái | Ở đâu |
|---|---|---|
| Relayer gọi `logIncident`, lưu tx/block/attempts/lỗi | ✅ có từ trước | `server/api/src/chain/relayer.js` |
| Retry có phân loại + backoff, kiểm tra on-chain trước khi gửi | ✅ | `relayer.js` |
| Quá 10 lần/24 giờ thì `blocked` + cảnh báo | ✅ mới | `relayer.js`, `chain/ops-alerts.js` |
| Index/replay idempotent từ checkpoint | ✅ có từ trước, nay có test | `chain/indexer.js` |
| Health/metrics: tuổi queued, pending/blocked, attempts, lỗi RPC, lag | ✅ mới | `GET /api/health/chain`, `GET /api/metrics/chain` |
| Runbook: nạp ETH, rotate relayer, unblock | ✅ mới | [`docs/ops/CHAIN_WORKER_RUNBOOK.md`](../ops/CHAIN_WORKER_RUNBOOK.md) |
| Restart/RPC timeout không gửi trùng | ✅ có test | `test/e2e/chain-e2e.test.js` (8), `test/chain-outbox-ops.test.js` |
| Replay an toàn | ✅ có test | `test/chain-indexer-replay.test.js` |
| Item blocked tạo cảnh báo, giữ đúng thứ tự | ✅ có test | `test/chain-outbox-ops.test.js`, `test/chain-op-retry.test.js` |

## 3. Thay đổi spec (cần nhóm biết)

Spec cũ yêu cầu outbox là **hàng đợi FIFO theo thiết bị**: một incident `blocked`
chặn mọi incident sau. Luật này viết cho contract cũ (high-water mark). Contract
hiện tại lưu exact-use theo `(device, sequence)` và nhận incident lệch thứ tự
(`BLOCKCHAIN_INCIDENT_SCHEMA.md` mục 5). Code relayer đã đúng theo contract này;
chỉ spec bị cũ. Đã sửa `Blockchain_task.md` thành:

- **Outbox incident:** mỗi row độc lập. Row `blocked` **không** chặn sequence
  khác của thiết bị, nên incident hợp lệ không bị treo theo.
- **Device op** (register/rotate/revoke/set_owner): **tuần tự** theo thiết bị,
  vì op sau phụ thuộc op trước. Op `blocked`/`failed` giữ các op phía sau.

## 4. Đã làm

### 4.1 Theo yêu cầu Task 4

- **Migration `021_chain_worker_operations.sql`:**
  - cột `retry_window_started_at` cho `blockchain_outbox` và `device_chain_ops`;
  - bảng heartbeat `chain_worker_status`;
  - bảng cảnh báo `chain_ops_alerts`.
- **Heartbeat** (`chain/worker-status.js`): mỗi vòng worker ghi head block, số
  lỗi liên tiếp, tổng lỗi RPC, lỗi cuối và số dư relayer.
- **Cảnh báo** (`chain/ops-alerts.js`), mỗi cảnh báo chỉ tạo một lần:
  `outbox_blocked`, `outbox_failed`, `device_op_blocked`, `device_op_failed`,
  `worker_failing`, `worker_stopped`, `relayer_low_balance`.
- **Endpoint** (`routes/chain-health.js`, `services/chain-metrics.js`):
  - `GET /api/health/chain`: 200 ok / 503 degraded kèm lý do.
  - `GET /api/metrics/chain`: định dạng Prometheus.
  - Phần chi tiết cần `Authorization: Bearer $OPS_METRICS_TOKEN`; production
    không đặt token thì bị tắt.
  - Tách riêng khỏi `/api/health/ready`, để chain kẹt không làm API rớt.
- **Runbook** `docs/ops/CHAIN_WORKER_RUNBOOK.md`: giám sát, bảng xử lý từng loại
  cảnh báo, nạp Sepolia ETH, unblock, rotate ví relayer, replay indexer.

### 4.2 Làm thêm

- **Sửa lỗi có sẵn:**
  - Tx bị drop hoặc revert khi vào block thì outbox requeue vô hạn, không tính
    vào giới hạn 10 lần/24 giờ. Nay đã bị chặn đúng giới hạn.
  - Log lỗi worker rỗng (`"err": ""`) khi ethers để `shortMessage` rỗng. Nay
    dùng hàm chung `chainErrorText`.
  - Hướng dẫn unblock bằng `UPDATE … SET status='queued'` trong E2E guide không
    reset cửa sổ retry. Đã thay bằng lệnh CLI.
- **CLI `server/api/scripts/chain-ops.js`:** `status`, `stuck`,
  `requeue-outbox [--all-blocked]`, `requeue-op`, `alerts`, `ack-alert`. Thêm
  `make chain-status` và `make chain-ops ARGS="…"`.
- **Webhook Slack/Discord** qua `OPS_ALERT_WEBHOOK_URL` (tùy chọn): gửi theo
  thứ tự, tự thử lại khi lỗi.
- **Tài liệu:** `API_REFERENCE.md` thêm mục 8b; `server/.env.example` thêm biến
  mới; `_RUN_BOOK.md` có link tới runbook mới.

### 4.3 Biến môi trường mới (đều có mặc định)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `OPS_METRICS_TOKEN` | (trống) | Token xem metrics. **Production nên đặt** |
| `OPS_ALERT_WEBHOOK_URL` | (trống) | Webhook cảnh báo |
| `CHAIN_ALERT_FAILURE_STREAK` | 5 | Số lỗi liên tiếp thì cảnh báo / degraded |
| `CHAIN_RELAYER_MIN_BALANCE_ETH` | 0.05 | Ngưỡng số dư; `0` = tắt |
| `CHAIN_BALANCE_CHECK_INTERVAL_MS` | 60000 | Chu kỳ đọc số dư |
| `CHAIN_HEALTH_MAX_TICK_AGE_SECONDS` | 120 | Heartbeat cũ hơn thì degraded |
| `CHAIN_HEALTH_MAX_QUEUED_AGE_SECONDS` | 900 | Item queued cũ hơn thì degraded |
| `CHAIN_HEALTH_MAX_LAG_BLOCKS` | 50 | Indexer chậm hơn thì degraded |

## 5. Kiểm thử

| Bộ test | Kết quả |
|---|---|
| Backend (`npm test`) | 196 pass, 3 skip có điều kiện, 1 fail do môi trường* |
| Test mới Task 4 (`chain-outbox-ops`, `chain-indexer-replay`, `chain-worker-ops`) | 16/16 pass |
| Chain E2E trên hardhat (`E2E_CHAIN_RPC_URL`) | 12/12 pass |
| Chạy thật Docker + hardhat | Pass (chi tiết bên dưới) |

\* `firmware-wire-contract.test.js` gọi `python3`, máy test không có trong PATH.
Lỗi này không liên quan Task 4; cần chạy lại trên máy có Python trước khi merge.

**Chạy thật trong Docker** (stack riêng, worker thật, hardhat local):
1. Migration 021 apply sạch.
2. Heartbeat được ghi; lỗi RPC lúc tắt node được đếm, worker tự phục hồi.
3. Một device op bị revert (`DeviceNotRegistered`):
   - op chuyển `failed` và sinh cảnh báo `device_op_failed`;
   - `/api/health/chain` trả 503 kèm lý do;
   - `chain-ops.js stuck` liệt kê op; `ack-alert` đóng cảnh báo.
4. `/api/metrics/chain` trả đủ metric, lag indexer = 0.

## 6. Những gì KHÔNG đổi

Không đổi: `AirSafetyLog.sol`, ABI, deployment, EIP-712 domain, cách tính
`incidentId`/`incidentKey`, evidence schema/hash, giao thức firmware/MQTT,
logic intake.

Migration 021 chỉ **thêm** cột và bảng, không sửa dữ liệu cũ.

## 7. Deploy lên server

1. Merge nhánh, rồi `make server-rebuild-api`. API tự chạy migration 021 khi khởi động.
2. Thêm vào `server/.env`: `OPS_METRICS_TOKEN=<chuỗi ngẫu nhiên>`, và
   `OPS_ALERT_WEBHOOK_URL=` nếu có kênh Slack/Discord.
3. Khởi động lại worker: `docker compose --profile chain up -d --force-recreate chain-worker`.
4. Kiểm tra:
   - `curl https://<domain>/api/health/chain` trả `200`;
   - `make chain-status` có `worker.head_block` tăng dần và `index_lag_blocks` nhỏ.
5. Đưa `/api/health/chain` vào uptime check; scrape `/api/metrics/chain` nếu có Prometheus.

## 8. Việc còn lại

**Task 4:**
1. Review và merge PR vào `integration/task1-task2-task3-task5`.
2. Deploy và chạy trên Sepolia thật (mục 7).
3. Chạy lại `firmware-wire-contract.test.js` trên máy có Python.

**Phát hiện thêm ở Task 5** (lúc review và chạy Playwright, chưa sửa trong nhánh này):

| Mức | Vấn đề | File |
|---|---|---|
| Chặn | Mọi API call sau đăng nhập lỗi "Illegal invocation" (gọi `fetch` sai ngữ cảnh) | `web3/src/lib/authClient.ts` |
| Chặn | Runtime hash localhost sai, guard khóa mọi giao dịch khi chạy local | `web3/src/config/networks.ts` |
| Chặn | RPC mặc định `publicnode` trả receipt deploy `null`, guard khóa giao dịch trên Sepolia | `web3/src/lib/deploymentValidation.ts` |
| Tooling | Playwright cần `--host 127.0.0.1`; spec phải kết nối lại ví sau reload; `test:deployment` lỗi đường dẫn trên Windows | `web3/playwright.config.ts`, `web3/e2e/`, `web3/scripts/` |
| Trung bình | VerifyPanel kẹt "Đang kiểm tra…"; logout dApp đăng xuất luôn app mobile; SSE kết nối lại mỗi lần render; lịch sử on-chain quét lại từ đầu | `web3/src/` |

Khi vá tạm 2 lỗi chặn đầu, kịch bản A trên Playwright (hardhat + Docker) chạy
**pass** trọn vẹn.

## 9. Lấy nhánh

```bash
git fetch origin
git switch -c feature/task4-chain-ops --track origin/feature/task4-chain-ops
```
