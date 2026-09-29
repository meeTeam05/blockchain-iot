# Tổng kết sửa lỗi E2E (theo `E2E_FIX_PLAN.md`)

Nhánh: `integration/task1-task2-task3` (base `75b6221`). Toàn bộ thay đổi **chưa commit**.
Luồng: ESP32 (Task 1) → MQTT → intake (Task 3) → outbox/relayer (Task 4) → `AirSafetyLog` (Task 2) → indexer → API/app (Task 5).

---

## 1. Kết quả ngắn gọn

| Mã lỗi | Nội dung | Trạng thái |
|---|---|---|
| A | Contract fix chưa deploy lên Sepolia | **Chưa làm**: cần private key deployer và ETH Sepolia. Đã chuẩn bị script, đã deploy thử trên hardhat node |
| B | `verifyingContract` lệch giữa các tầng | Đã sửa: một nguồn `spec/incident/`, firmware và backend được sinh code, có self-check |
| C, C' | Record cũ ký cho domain cũ làm đầy queue firmware | Đã sửa: backend nhận nhiều domain, ACK `accepted`, outbox `legacy_domain` |
| D | Không có relayer | Đã sửa: `chain-worker` (relayer, lifecycle ops, indexer) |
| E | Signer giữa DB và chain không đồng bộ | Đã sửa: pipeline `device_chain_ops`, signer `pending` → `active` sau khi chain xác nhận |
| F | E2E trên board thật | **Chưa làm** (cần board, Sepolia). Đã có E2E cục bộ trên hardhat node |
| G | `incident_rotate_signer` chỉ kiểm tra slot 0 | Đã sửa và có test host |
| H | Mất NVS thì sequence quay về 1 | Đã sửa: sàn sequence chỉ tăng + lệnh `signer_activate {floor}` |
| I | Comment "FIFO theo sequence" đã lỗi thời | Đã sửa (migration 017 comment + 019) |
| J | Chọn domain theo "recover được address" | Đã sửa: xác thực theo cặp (domain, signer đã đăng ký) |

---

## 2. Đã sửa những gì

### Giai đoạn 1: `spec/incident/`, một nguồn domain (B)
- `spec/incident/deployments/<network>.json` do `blockchain/scripts/deploy.js` ghi (localhost, sepolia), kèm `domainSeparator` đọc từ contract và `legacyAddresses`.
- `spec/incident/gen/gen-all.mjs` sinh ra:
  - `firmware/components/core/incident/include/incident_domain.h`
  - `server/api/src/generated/incident-deployments.js` (có nhúng ABI)
  - Generator tự tính lại domain separator và từ chối file bị sửa tay. Chạy `--check` để CI phát hiện file sinh bị cũ (`make incident-gen-check`).
- Firmware: bỏ `CONFIG_SA_INCIDENT_VERIFYING_CONTRACT`, thay bằng Kconfig choice `SA_INCIDENT_ENV` (`SEPOLIA` mặc định, hoặc `LOCAL`). `incident_init()` tính lại domain separator và so với giá trị trong spec. Nếu lệch, hoặc env chưa có deployment, thì log lỗi và **không ký**.
- Địa chỉ `0xCccc…` chỉ còn trong host tool và test vector.
- Đã deploy thử lên hardhat node: `spec/incident/deployments/localhost.json` = `0x5FbD…0aa3`. Địa chỉ này cố định khi deploy bằng tài khoản #0 trên node mới.

### Giai đoạn 2: chuẩn bị redeploy (A)
- `deploy.js` ghi thêm spec deployment và tự cộng dồn legacy domain (seed trong `spec/incident/legacy-domains.json`).
- Trên Sepolia, `deploy.js` từ chối nếu `RELAYER_ADDRESS` trùng ví admin (override bằng `ALLOW_SHARED_RELAYER=1`).
- Thêm network `localhost` và script `npm run node`, `npm run deploy:localhost`.
- `blockchain/deployments/sepolia.json` được đổi tên thành `sepolia.v1-highwater.json` để không ai dùng nhầm bytecode cũ.

### Giai đoạn 3: backend nhận nhiều domain (B, C, C', J)
- Migration `019_outbox_domain_and_signer_gate.sql`:
  - Thêm các status outbox `legacy_domain`, `waiting_signer`, `stale_signer`.
  - Thêm cột `verifying_contract`, `signer_address`, `incident_key`, `fail_reason`, `submitted_at`.
  - Thêm status signer `pending`.
  - Thêm bảng `device_chain_ops`, `chain_checkpoints`, `chain_events`, `device_chain_state`.
- `incident-verify.js` tách thành hai bước:
  - `verifyIncidentEvidence` (không phụ thuộc domain): format, semantics, hash, định dạng chữ ký (v, r, s, low-s).
  - `authenticateIncident`: vòng lặp domain. Domain chỉ được chọn khi signer recover ra **là signer đã đăng ký của đúng thiết bị đó**. Nếu khớp một signer không đủ điều kiện thì dừng ngay, không thử domain tiếp.
- Ma trận `outboxStatusFor` đúng như bảng trong plan.
- Security event khi không khớp domain nào chỉ ghi `tried_domains`, không ghi `recovered_signer`.
- `incident-intake.js`: lưu domain và digest của domain được chọn, ghi outbox với status đã quyết định. Retry chỉ xác thực lại với **domain và signer đã lưu** trên dòng incident.
- `incident-domains.js` + config:
  - Chọn deployment bằng `INCIDENT_DEPLOYMENT`. `AIR_SAFETY_LOG_ADDRESS`, nếu đặt, phải khớp.
  - Có thể ghi đè legacy domain bằng `AIR_SAFETY_LOG_LEGACY_ADDRESSES`. Đặt giá trị rỗng để tắt.
- API khởi động:
  - Cấu hình domain sai thì thoát.
  - Có `CHAIN_RPC_URL` thì so domain separator với contract. Lệch thì thoát, RPC không kết nối được thì chỉ cảnh báo.
- API incident trả thêm `chain.fail_reason` và `chain.verifying_contract` cho app.

### Giai đoạn 4: firmware (G, H)
- `pending_count()` đếm mọi slot. `incident_rotate_signer()` từ chối nếu còn record ở **bất kỳ** slot nào, và chạy dưới `s_lock`.
- `incident_set_sequence_floor()`: chỉ nâng, không bao giờ hạ.
- Firmware production không ký cho tới khi đã có bộ đếm sequence, tức là đã nhận floor hoặc đã từng cấp sequence. Board đang chạy có bộ đếm nên không bị ảnh hưởng. Chế độ offline bench được miễn.
- Lệnh MQTT `signer_activate {"floor":"<uint64>"}` được đăng ký trong `sysload.c`.
- Thêm 3 test host: `ROTATE GUARD CHECKS EVERY SLOT`, `SEQUENCE FLOOR RAISE ONLY`, `SEQUENCE FLOOR GATE`.

### Giai đoạn 5: vòng đời signer (E, H)
- `services/signer-lifecycle.js`: mỗi yêu cầu ghi `device_signers` và `device_chain_ops` trong cùng một transaction.
  - register: signer `pending`. Khi chain xác nhận thì chuyển `active`, thả các incident `waiting_signer`, và gửi `signer_activate` với `floor = max(seq trong DB, lastSequence on-chain) + 1`.
  - rotate: key cũ chuyển `revoked(rotated)` chỉ khi chain đã xác nhận. Record key cũ chưa gửi chuyển `stale_signer`.
  - revoke: DB thu hồi ngay, rồi xếp op lên chain. Không cho dùng lý do `rotated`.
  - `sync-chain`: đăng ký signer đang `active` lên contract mới mà không đổi key. Cần cho board hiện tại sau redeploy.
- `scripts/device-signer.js` giờ đi qua pipeline này, gồm các lệnh `register | rotate | revoke | set-owner | sync-chain | activate | show`.
- `signer_activate` không bị job timeout hủy khi thiết bị offline. Job mới `pending-command-dispatch` đẩy lệnh đang chờ tới thiết bị online sau tối đa 30 giây.

### Giai đoạn 6 + 7: chain worker (D, I)
- `src/worker.js` (`npm run worker`, compose service `chain-worker`, profile `chain`):
  - Giữ Postgres advisory lock nên chỉ có một instance.
  - Khi khởi động, kiểm tra domain và role.
  - Mã thoát 2 nghĩa là lỗi nghiêm trọng, cần người vận hành xử lý.
- `chain/relayer.js`:
  - Xử lý op theo thứ tự `id` trong từng thiết bị.
  - Cổng signer: đọc `getDevice()` trực tiếp từ chain.
  - Trước khi gửi: `getIncident` (idempotent), rồi `staticCall`.
  - Ghi `tx_hash` + `pending` vào DB **trước** khi chờ receipt.
  - Phân loại custom error theo bảng trong plan. Lỗi tạm thời thì backoff `2^n` phút, quá 10 lần hoặc 24 giờ thì `blocked`.
  - Mất `RELAYER_ROLE` hoặc `DEVICE_MANAGER_ROLE` thì dừng worker, row giữ nguyên `queued`.
  - Row `failed` không chặn các sequence khác.
- `chain/indexer.js`:
  - Chỉ đọc block đã đủ `CHAIN_CONFIRMATIONS`. Idempotent theo `(contract, tx_hash, log_index)`. Checkpoint commit cùng batch.
  - Cập nhật `device_chain_state` và `devices.owner_address`.
  - Đối soát `IncidentLogged` sang outbox. Ghi `IncidentAcknowledged` và `IncidentResolved` vào `incidents.owner_status`. Phát realtime event cho app.

### Giai đoạn 8: kiểm thử
- `test/incident-multi-domain.test.js` (9 test): kịch bản 4, 11, 12, 13, 14, 15 và kiểm tra drift cấu hình.
- `test/signer-lifecycle.test.js` (5 test).
- `test/e2e/chain-e2e.test.js`: chạy trên hardhat node thật, gồm 11 kịch bản con: 1, 2, 3, 4, 6 (register và rotate), 7, 8, 9, 10, indexer và owner acknowledgement. Chạy bằng `make e2e-chain-local`.

---

## 3. Đã kiểm chứng

| Kiểm tra | Kết quả |
|---|---|
| `blockchain`: `npx hardhat test` | 42/42 pass |
| `server/api`: `npm test` (Windows) | 172 pass, 3 skip (E2E cần env), 1 fail do môi trường: `firmware-wire-contract` cần `python3` + gcc + ESP-IDF. Đã chạy lại trong container Linux: **2/2 pass** |
| Chain E2E trên hardhat node | 12/12 pass |
| Firmware host test (gcc trong Docker): persistence (+3 test mới), transitions, vectors, signatures, tamper-ABI, queue-full, ACK matrix, signer-provision bench, reset policy | Tất cả pass. Dùng cJSON 1.7.18 và mbedTLS 3.6.2 upstream thay cho bản trong ESP-IDF |
| Migration 001 → 019 trên TimescaleDB thật (`timescale/timescaledb:latest-pg16`) | Pass |
| `worker.js` thật với Postgres + hardhat | CLI `register` → op → `registerDevice` on-chain → signer `active` → indexer → `signer_activate {floor:"1"}` |
| API từ chối khởi động khi domain sai | Pass cả 3 trường hợp: không có contract ở địa chỉ, env lệch deployment, deployment chưa tồn tại |
| `node spec/incident/gen/gen-all.mjs --check` | Pass |
| Build firmware bằng ESP-IDF 5.4.2 | Xem mục 5 |

---

## 4. Chưa làm (cần người có quyền hoặc thiết bị)

1. **Redeploy Sepolia (A)**. Cần `DEPLOYER_PRIVATE_KEY`, ETH Sepolia và một ví relayer riêng:
   ```bash
   cd blockchain && npm run deploy:sepolia && npm run verify:sepolia && npm run roles:sepolia
   cd .. && node spec/incident/gen/gen-all.mjs
   ```
   Commit deployment và các file sinh ra **trong cùng một commit**.
2. **E2E trên board thật (F)**. Thứ tự bắt buộc:
   1. Deploy backend với `INCIDENT_DEPLOYMENT=sepolia` và chạy migration 019.
   2. `device-signer.js sync-chain <device> --owner <wallet>`.
   3. Chạy `chain-worker`.
   4. Flash firmware `SA_INCIDENT_ENV_SEPOLIA` bằng `idf.py app-flash`. **Không** `erase-flash`.
   5. Theo dõi queue trống dần.
   6. Chỉ sau đó mới đặt `AIR_SAFETY_LOG_LEGACY_ADDRESSES=` (rỗng).
3. `CODEOWNERS` cho `spec/` và `docs/BLOCKCHAIN_INCIDENT_SCHEMA.md`. Cần GitHub handle của đại diện Task 1, 2, 3.
4. Firmware chưa gửi `domain_separator` trong shadow (mục phụ của giai đoạn 1).
5. Test vector chưa chuyển sang `spec/incident/test-vectors/`. Cố ý giữ ở `docs/test-vectors/` vì nhiều test ở firmware, contract và backend tham chiếu đường dẫn này.
6. Cổng signer của relayer đọc `getDevice()` trực tiếp từ chain thay vì từ bảng của indexer như plan. Cách này mới hơn nhưng tốn thêm một lần gọi RPC cho mỗi thiết bị trong mỗi vòng.
7. App (Flutter / `app_new`) chưa hiển thị `chain_status`. API đã trả đủ dữ liệu.

---

## 5. Build firmware thật

**Chưa kiểm chứng.** Máy này không có ESP-IDF. Mình đã thử build trong image `espressif/idf:v5.4.2`: môi trường IDF khởi tạo xong, nhưng Docker Desktop bị sập (engine trả 500) ngay khi bắt đầu `idf.py build`. Vì vậy chưa có bằng chứng là `sysload.c`, Kconfig choice `SA_INCIDENT_ENV` và việc include `incident_domain.h` biên dịch được cho ESP32-S3.

Phần logic trong `incident.c` đã được biên dịch với `-Wall -Wextra -Werror` qua các host test ở mục 3. Cần chạy:

```bash
cd firmware
idf.py -D SDKCONFIG=sdkconfig.incident.generated \
  -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident" build
```

Sau đó xác nhận log boot có dòng `incident domain … contract …`, hoặc dòng lỗi mong đợi khi chưa có deployment Sepolia.

---

## 6. Nguy cơ tiềm tàng

**Cao, cần xử lý trước khi chạy thật**

1. **Flash firmware mới trước khi redeploy Sepolia thì board ngừng ký incident.** Env mặc định `SEPOLIA` chưa có deployment nên firmware fail-closed. Còi và cảnh báo cục bộ vẫn chạy. Phải làm A trước.
2. **Board mới hoặc board chưa từng cấp sequence cần `signer_activate` mới ký được.** Nếu `chain-worker` không chạy, hoặc op `register` bị `failed`, thiết bị không bao giờ nhận floor. Cách khắc phục thủ công: `device-signer.js activate <device>`. Incident phát sinh trước khi có floor bị bỏ qua (có log), không được xếp hàng.
3. **Lệnh `signer_activate` đi qua topic command chung.** Floor chỉ tăng nên không thể ép dùng lại sequence. Tuy vậy, ai publish được vào `device/{id}/command` có thể đẩy floor lên gần `UINT64_MAX` và làm thiết bị hết sequence (DoS). Cần đảm bảo ACL EMQX chỉ cho server publish vào topic này. API công khai không cho gửi lệnh này vì route commands có allowlist.
4. **Thứ tự triển khai.** Nếu chạy worker trên DB cũ mà chưa `sync-chain`, mọi incident nằm ở `waiting_signer` (không mất, chỉ chờ). Nếu gỡ legacy domain khi còn thiết bị chưa xả hết queue, các record cũ bị ACK false và chiếm slot, tức là lỗi C' quay lại.

**Trung bình**

5. **`blocked` chưa có công cụ requeue.** Hết ETH, RPC hỏng lâu, hoặc quá 10 lần hay 24 giờ thì row chuyển `blocked` và phải `UPDATE blockchain_outbox SET status='queued', attempts=0 …` bằng tay. Worker chưa cảnh báo khi số dư ví relayer thấp.
6. **Chưa có mức trần phí gas.** Worker dùng fee mặc định của provider. Khi Sepolia tăng phí, tx có thể rất đắt hoặc bị kẹt.
7. **Reorg sâu hơn `CHAIN_CONFIRMATIONS`.** Row đã `confirmed` không được kiểm tra lại. Nên giữ `CHAIN_CONFIRMATIONS≥3`, hoặc dùng tag `finalized` nếu cần chắc chắn hơn.
8. **Giới hạn `eth_getLogs` của RPC công cộng.** Một số provider chỉ cho khoảng 500–1000 block mỗi lần gọi. Nếu indexer báo lỗi range, hạ `CHAIN_LOG_BATCH_BLOCKS`.
9. **Revoke có hiệu lực ngay trong DB.** Record còn trong queue thiết bị ký bằng key đó sẽ bị ACK false và nằm lại queue. Với lý do không phải lộ khóa (`retired`, `decommissioned`), nên xả queue trước khi revoke.
10. **Ví relayer và ví device manager dùng chung, hoặc gửi tx tay từ ví relayer trong lúc worker chạy,** có thể gây xung đột nonce. Worker coi đó là lỗi tạm thời và thử lại, nhưng nên dùng ví riêng.
11. **Job `pending-command-dispatch` đổi hành vi.** Mọi lệnh `pending` của thiết bị đang online giờ được đẩy lại trong vòng 30 giây. Trước đây lệnh chỉ được đẩy khi thiết bị kết nối lại hoặc khi có lệnh mới.

**Thấp**

12. Hàm cũ `registerSigner` / `revokeSigner` (ghi thẳng DB) vẫn còn cho test và E2E MQTT cũ. Code production không còn gọi tới. Không nên dùng lại.
13. Mỗi incident tốn N lần `ecrecover`, với N là số domain chấp nhận (hiện tối đa 3). Chi phí CPU không đáng kể.
14. Thay đổi line ending: repo đang dùng `autocrlf=true`. Các file mới được ghi với LF, Git sẽ tự chuyển.

---

## 7. Biến môi trường mới (`server/.env`)

`INCIDENT_DEPLOYMENT`, `AIR_SAFETY_LOG_LEGACY_ADDRESSES`, `CHAIN_RPC_URL`, `RELAYER_PRIVATE_KEY`, `DEVICE_MANAGER_PRIVATE_KEY`, `CHAIN_CONFIRMATIONS`, `CHAIN_POLL_INTERVAL_MS`, `CHAIN_START_BLOCK`, `CHAIN_LOG_BATCH_BLOCKS`, `CHAIN_MAX_ATTEMPTS`, `CHAIN_MAX_RETRY_AGE_HOURS`, `CHAIN_BATCH_SIZE`, `CHAIN_DOMAIN_CHECK`.

`AIR_SAFETY_LOG_ADDRESS` không còn bắt buộc khi đã đặt `INCIDENT_DEPLOYMENT`. Cấu hình hiện tại (chỉ có `AIR_SAFETY_LOG_ADDRESS`, không có RPC) vẫn chạy như cũ.
