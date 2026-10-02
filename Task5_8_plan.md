# Kế hoạch triển khai Task 5 – Task 8

Tài liệu này mô tả **mục tiêu, kết quả bàn giao, cách triển khai và tiêu chí
hoàn thành** cho các task sau đợt E2E ngày 30/09/2026. Đặc tả chi tiết nằm ở:

- [`Web3_task.md`](Web3_task.md): khối chức năng dApp B0–B11, route, state machine giao dịch.
- [`Token_incentive_task.md`](Token_incentive_task.md): luật thưởng/phạt, tham số, kịch bản một ngày.
- [`Blockchain_task.md`](Blockchain_task.md): Task 1–5 gốc.

## 0. Tổng quan

### Hiện trạng (đầu vào)
- `AirSafetyLog` v2 trên Sepolia: `0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A`,
  block `11810036`, đã verify.
- Luồng thiết bị → backend → chain → indexer đã chạy thật: sequence 6–9 của kit
  `dc:b4:d9:13:ed:8c` đều `confirmed`.
- Chưa có giao diện nào để owner acknowledge/resolve, chưa có token.

### Phụ thuộc và thứ tự

```text
Task 5 (dApp incident) ─────────────────────────────┐
                                                    ├──▶ Task 8 (dApp token)
Task 6 (contract token) ──▶ Task 7 (backend keeper) ─┘
```

| Task | Bắt đầu được khi | Chặn task nào |
|---|---|---|
| 5 | **Ngay** | 8 (dùng lại khung dApp) |
| 6 | **Ngay** (song song với 5) | 7, 8 |
| 7 | Task 6 có ABI và bản deploy trên hardhat | 8 (API incentives) |
| 8 | Task 5 xong M1–M2, Task 6 xong, Task 7 có API | — |

### Phân công

Phân theo mảng mỗi người đã làm (lịch sử commit). Người review là người sẽ dùng
kết quả của task đó.

| Task | Phụ trách | Review | Nhánh | Lý do |
|---|---|---|---|---|
| 5. dApp incident | **nhat092005** (MinhNhat) | Nguyen Hung | `feature/task5-web3-dapp` | Làm frontend `app`/`app_new` nhiều nhất; Nguyen Hung review phần hash evidence và contract |
| 6. Contract token | **Nguyen Hung** | TrongNguyen0 | `feature/task6-incentives-contract` | Đã làm contract v2 và deploy Sepolia; TrongNguyen0 dùng ABI ở Task 7 |
| 7. Backend keeper | **TrongNguyen0** | Nguyen Hung | `feature/task7-incentives-backend` | Đã làm intake và API incident (Task 3) |
| 8. dApp token | **Viet Ho** | nhat092005 | `feature/task8-web3-token` | Đã tích hợp và chạy E2E thật (có sẵn kit và server chain-worker); nhat092005 review vì Task 8 xây trên khung dApp của Task 5 |
| Test E2E còn lại (ngoài Task 5–8) | **pdqmei** | Viet Ho | `test/e2e-hardware-round2` | Làm AI/replay trên firmware; phụ trách checklist mất mạng, cảm biến thật, kịch bản NO₂, và flash lại bản thường cho kit |

Quy ước:
- Mọi nhánh tách từ `integration/task1-task2-task3` và PR về nhánh này.
- Task 7 bắt đầu khi Task 6 có ABI và deploy trên hardhat. Trước đó làm migration
  và API với mock.
- Task 8 bắt đầu khi Task 5 xong M2. Trong lúc chờ, Viet Ho tạo ví keeper và hỗ
  trợ Task 7 chạy E2E trên hardhat.
- Người giữ `server/.env` và kit thật (máy chạy chain-worker) là **Viet Ho**. Mọi
  lần chạy trên Sepolia phải báo trước, để chỉ một worker chạy.

### Ví và biến môi trường

| Ví | Đang có? | Dùng ở task | Lưu ở đâu |
|---|---|---|---|
| Admin `0x7Ee5…` | ✅ | 6 (deploy, cấp quỹ, đặt tham số) | `blockchain/.env` (`DEPLOYER_PRIVATE_KEY`) |
| Relayer `0xe942…` (là Operator) | ✅ | 6 (được đăng ký làm operator) | `server/.env` |
| Device manager `0x106c…` | ✅ | không đổi | `server/.env` |
| Owner `0x4aC8…` | ✅ | 5, 8 (MetaMask) | MetaMask |
| **Keeper** | ❌ **tạo mới** | 7 | `server/.env` → `KEEPER_PRIVATE_KEY` |
| Ví test "người khác" | ❌ tùy chọn | 5, 8 (test ẩn quyền, bấm phạt tay) | MetaMask (account phụ) |

---

## Task 5: dApp web3 cho incident

### Mục tiêu
Cho **owner và người xem** thao tác với incident trên chain qua trình duyệt:
- Xem trạng thái thật trên chain.
- **Tự xác minh dữ liệu mà không cần tin server.**
- Acknowledge/resolve bằng MetaMask.

App mobile chỉ còn provision và mở link sang dApp.

### Kết quả bàn giao
1. Thư mục `web3/`: dApp Vite + React + TypeScript + `wagmi`/`viem`.
2. Các khối **B0–B6** trong `Web3_task.md`, gồm:
   - Kết nối ví, danh sách device, danh sách và chi tiết incident.
   - Xác minh độc lập, acknowledge/resolve.
   - Lịch sử on-chain.
3. `web3/src/lib/evidence.ts`: mã hóa và hash evidence **khớp 2 test vector**.
4. Unit test (Vitest) và E2E UI (Playwright) cho kịch bản A.
5. `web3/README.md`: cách chạy với hardhat local và với Sepolia.
6. App mobile: nút "Xem trên chain" mở `<dapp>/d/<device_id>/i/<incident_id>`.
7. Backend: thêm origin của dApp vào `CORS_ORIGINS`; nginx phục vụ bản build tại `/dapp/`.

### Phạm vi
- **Có:** đọc chain, gửi `acknowledgeIncident`/`resolveIncident`, đọc API incident.
- **Không:** provision BLE, MQTT, ký evidence, relayer, token (Task 8), chức năng admin.

### Cách triển khai

**Bước 5.1: Khung dự án (M1)**
```bash
npm create vite@latest web3 -- --template react-ts
cd web3
npm i wagmi viem @tanstack/react-query react-router-dom
npm i -D tailwindcss vitest @playwright/test
```
- Script `npm run sync-abi` chép:
  - `blockchain/abi/AirSafetyLog.json` vào `src/abi/`
  - `spec/incident/deployments/{localhost,sepolia}.json` vào `src/generated/`

  Chạy lại mỗi khi deploy. CI chạy `sync-abi --check`, giống `gen-all.mjs --check`.
- `src/config/networks.ts` chọn mạng theo `VITE_NETWORK`.
- Tạo wagmi config với connector `injected` (MetaMask).

⚠️ **Lưu ý chain ID:** hardhat local của dự án dùng chain ID `11155111`, trùng
Sepolia, để test vector khớp. Khi dev local phải thêm mạng tùy chỉnh trong MetaMask
(RPC `http://127.0.0.1:8545`, chain ID `11155111`) và **luôn kiểm tra RPC đang
chọn**. E2E tự động dùng mock connector nên không bị ảnh hưởng.

**Bước 5.2: B0 + B1 (M1)**
- Khi khởi động, đọc `eip712Domain()` và so với spec. Nếu lệch thì hiện banner đỏ
  và khóa mọi `<TxButton>`.
- Đăng ký thông báo lỗi: `decodeErrorResult` với ABI, rồi dịch sang tiếng Việt theo
  bảng ở mục 6 của `Web3_task.md`.
- Đăng nhập API: `POST /api/auth/login` → JWT (lưu trong bộ nhớ và
  `sessionStorage`), tự `POST /api/auth/refresh` khi hết hạn.
- Kết nối ví và kiểm tra mạng (`useSwitchChain`). Nghe `accountsChanged` để tính lại quyền.

**Bước 5.3: B2 thiết bị (M1)**
- `GET /api/devices`. Với mỗi device, tính `keccak256(toBytes(device_id))` rồi gọi
  `getDevice` bằng `useReadContracts` (gộp nhiều lần gọi làm một).
- Hiện nhãn "Bạn" khi `owner == address`. Device chưa đăng ký on-chain hiện
  "Chờ đăng ký".

**Bước 5.4: B3 incident (M2)**
- Danh sách: `GET /api/devices/:id/incidents?limit=50&before_sequence=`.
- Chi tiết: `GET …/:incidentId`.
- Tính `incidentKey = computeIncidentKey(deviceIdHash, incidentId)` rồi đọc
  `getIncident(incidentKey)`.
- Hợp nhất trạng thái theo bảng B3. Cập nhật qua `/api/realtime` (nếu không được
  thì polling 10 s).

**Bước 5.5: B4 xác minh độc lập (M2)**
- `lib/evidence.ts`: dựng tuple `IncidentEvidence` đúng thứ tự trong
  `docs/BLOCKCHAIN_INCIDENT_SCHEMA.md`, `encodeAbiParameters` rồi `keccak256`.
- Unit test chạy trên cả 2 file `docs/test-vectors/*.json`: hash phải khớp. Sửa
  từng field một thì hash phải khác.
- Trên UI: chạy 4 bước (deviceIdHash, incidentId, evidenceHash so với chain và
  `hashEvidence()`, signer). Mỗi bước ✅/❌ kèm giá trị hai bên.

**Bước 5.6: B5 acknowledge/resolve (M3)**
- `<TxButton>` gọi `simulateContract` → `writeContract` → `waitForTransactionReceipt`,
  rồi poll API tới khi `owner_status` đổi (tối đa 2 phút).
- Nút chỉ hiện khi `getDevice().owner == address` và `status` phù hợp.

**Bước 5.7: B6 lịch sử on-chain (M2)**
- `getLogs` theo topic `deviceIdHash`, bắt đầu từ `deployment.blockNumber`, chia
  nhỏ ≤ 2 000 block mỗi lần gọi, có cache.

**Bước 5.8: Tích hợp và phát hành (M3)**
- Backend: thêm origin dApp vào `CORS_ORIGINS`.
- nginx: `location /dapp/ { root /var/www; try_files … /dapp/index.html; }`, và
  mount thư mục `web3/dist`.
- App mobile: nút mở `https://<domain>/dapp/d/<id>/i/<incidentId>` (trên điện
  thoại dùng link `metamask.app.link/dapp/...`).

### Tiêu chí hoàn thành
- **M1:** kết nối MetaMask đúng Sepolia; danh sách device hiện đúng `active`,
  owner, `lastSequence = 9` cho kit `dc:b4:d9:13:ed:8c`.
- **M2:** xác minh incident sequence 6 (tx `0x14e0…a49c`) ra 4 dòng ✅. Unit test
  vector pass.
- **M3:** kịch bản A (7 bước, mục 7 trong `Web3_task.md`) chạy trọn trên Sepolia
  bằng ví owner `0x4aC8…`. Etherscan có `IncidentAcknowledged` và `IncidentResolved`.
  Ví khác không thấy nút.

---

## Task 6: Contract token và incentives

### Mục tiêu
Đưa luật thưởng/phạt lên chain **mà không sửa `AirSafetyLog`**:
- Thưởng owner acknowledge/resolve đúng hạn.
- Phạt owner bỏ qua sự cố.
- Phạt operator đưa sự cố lên chain trễ.
- Mọi luật đều do người bất kỳ thực thi được.

### Kết quả bàn giao
1. `blockchain/contracts/AirSafeToken.sol`: ERC-20, mint cố định 1 000 000 ASAFE cho Treasury.
2. `blockchain/contracts/SafetyIncentives.sol` và interface `IAirSafetyLogView.sol`
   (chỉ gồm `getIncident`, `getDevice`).
3. `test/incentives.test.js` (unit) và `test/incentives.scenario.test.js` (kịch bản một ngày).
4. `scripts/deploy-incentives.js`: ghi `deployments/<network>.incentives.json` và
   `abi/SafetyIncentives.json`, `abi/AirSafeToken.json`.
5. `scripts/fund-incentives.js`: Treasury nạp quỹ thưởng và ký quỹ cho operator.
6. Deploy lên Sepolia, verify source, cập nhật `blockchain/README.md` mục Incentives.

### Cách triển khai

**Bước 6.1: Token**
- Kế thừa `ERC20` của OpenZeppelin 5.x. Constructor gọi `_mint(treasury, 1_000_000e18)`.
  Không có hàm mint, burn hay pause.

**Bước 6.2: Storage của `SafetyIncentives`**
```solidity
struct Params { uint64 ackDeadlineWarning; uint64 ackDeadlineDanger; uint64 resolveDeadline;
                uint128 ownerBond; uint128 ackReward; uint128 resolveReward; uint128 missedAckPenalty;
                uint64 maxRelayDelay; uint128 lateRelayPenalty; uint16 keeperShareBps;
                uint8 dailyRewardCap; uint64 unstakeCooldown; }
struct Bond { address staker; uint128 amount; uint64 unstakeRequestedAt; }

mapping(bytes32 deviceIdHash => Bond) deviceBond;
Bond operatorBond;  address operator;           // operator = ví relayer, admin đặt
mapping(bytes32 incidentKey => uint8 flags);    // TIMELY_ACK | RESOLVE_REWARDED | ACK_SLASHED | RELAY_SLASHED
mapping(bytes32 deviceIdHash => mapping(uint64 day => uint8)) rewardsToday;
uint256 totalBonded;                            // quỹ thưởng = balanceOf(this) - totalBonded
```
Quỹ thưởng **không được** chi vào tiền ký quỹ. Mọi khoản thưởng kiểm tra
`balanceOf(this) - totalBonded ≥ amount`. Nếu không đủ thì bỏ qua thưởng và phát
event `RewardSkipped`, không revert, để ack vẫn được ghi nhận.

**Bước 6.3: Hàm**

| Hàm | Ai gọi | Điều kiện chính |
|---|---|---|
| `stakeDevice(deviceIdHash, amount)` | `getDevice().owner` | Device tồn tại; khi đổi người stake thì stake cũ phải bằng 0 |
| `requestUnstake(deviceIdHash)` / `withdraw(deviceIdHash)` | Người đã stake | Chờ đủ `unstakeCooldown` |
| `depositOperatorBond(amount)` | Bất kỳ ai (Treasury nạp) | — |
| `requestOperatorUnstake()` / `withdrawOperator()` | `operator` | Chờ đủ `unstakeCooldown` |
| `recordTimelyAck(key)` | Bất kỳ ai | R1 |
| `recordTimelyResolve(key)` | Bất kỳ ai | R2 |
| `slashMissedAck(key)` | Bất kỳ ai | P1 |
| `slashLateRelay(key)` | Bất kỳ ai | P2 |
| `setParams(Params)` / `setOperator(addr)` | `DEFAULT_ADMIN_ROLE` | Phát `ParamsUpdated` / `OperatorChanged` |
| `pendingSettlement(key)` (view) | Bất kỳ ai | Trả về hạn chót, cờ, "có thể phạt không" cho dApp và keeper |

Ngày tính theo `block.timestamp / 1 days` (UTC). Dùng `nonReentrant` và `SafeERC20`
cho mọi hàm chuyển token. Mọi lỗi là custom error (danh sách ở
`Token_incentive_task.md`).

**Bước 6.4: Test**
- **Unit:**
  - Mỗi luật: đúng hạn, trễ 1 giây, gọi 2 lần.
  - Stake không đủ, rút stake trong thời gian chờ, đổi owner.
  - Quỹ cạn (`RewardSkipped`), phần trăm keeper, reentrancy (dùng token giả có hook).
  - `AirSafetyLog` chưa có incident (`IncidentNotFound`).
- **Kịch bản:** dựng `AirSafetyLog` thật, đăng ký device, ký incident bằng khóa test
  với `observedAt` đúng giờ trong kịch bản, dùng `time.increaseTo` để đi qua
  08:00 → cuối ngày. **Assert mọi số dư** trong bảng tổng kết (owner ví 20 / stake 80,
  operator 980, keeper 20, Treasury +20, quỹ 49 980, tổng cung không đổi).

**Bước 6.5: Deploy**
```bash
cd blockchain
npx hardhat test
npm run deploy:incentives:localhost    # scripts/deploy-incentives.js --network localhost
npm run deploy:incentives:sepolia
npm run verify:incentives:sepolia
node scripts/fund-incentives.js --network sepolia   # quỹ 50 000, operator bond 1 000
```
Chạy lại `node spec/incident/gen/gen-all.mjs` sau khi mở rộng generator để sinh
module incentives cho backend (Task 7), rồi commit cùng deployment.

### Tiêu chí hoàn thành
- `npx hardhat test` pass toàn bộ, kể cả **kịch bản một ngày khớp từng số dư**.
- Deploy lên Sepolia và verify xong. `deployments/sepolia.incentives.json` được
  commit. `AirSafetyLog` và firmware **không đổi**.
- Coverage của `SafetyIncentives` ≥ 95% dòng (`npx hardhat coverage`).

---

## Task 7: Backend (keeper, indexer, API)

### Mục tiêu
- Tự động hóa phần của hệ thống: ghi nhận thưởng thay owner, phạt owner quá hạn.
- Đồng bộ event token về DB và cung cấp API cho dApp.

### Kết quả bàn giao
1. Migration `server/db/migrations/020_incentives.sql`.
2. `server/api/src/chain/incentives.js` (context contract), `keeper.js` (vòng lặp
   keeper), indexer mở rộng cho event của `SafetyIncentives`.
3. Route `server/api/src/routes/incentives.js`.
4. Biến môi trường mới: `KEEPER_PRIVATE_KEY`, `INCENTIVES_ENABLED`, `KEEPER_ENABLED`.
5. Test (PGlite, giống test hiện có) và E2E trên hardhat.
6. Cập nhật `docs/API_REFERENCE.md` và `.env.example`.

### Cách triển khai

**Bước 7.1: Cấu hình**
- Mở rộng `spec/incident/gen/gen-all.mjs` để sinh thêm address và ABI incentives
  vào `server/api/src/generated/`.
- `config.js`: `chain.keeperPrivateKey`, `incentives.enabled` (mặc định `false`
  để không ảnh hưởng hệ thống đang chạy).
- Khi worker khởi động: nếu bật incentives, kiểm tra ví keeper **khác** ví relayer
  và manager (nếu trùng thì thoát, exit code 2) và có ETH.

**Bước 7.2: Migration `020_incentives.sql`**
- `incentive_events(contract, tx_hash, log_index, block_number, name, incident_key,
  device_id_hash, account, amount, data jsonb)`, khóa duy nhất
  `(contract, tx_hash, log_index)`, giống `chain_events`.
- `incidents` thêm `reward_status` (`none|ack_rewarded|resolved_rewarded|over_cap|
  slashed|late_relay_slashed`), `ack_deadline_at`.
- `device_bonds(device_id, staker, amount, unstake_requested_at, updated_block)`.
- Checkpoint riêng trong `chain_checkpoints` với key là address incentives.

**Bước 7.3: Indexer**
- Thêm vòng quét logs cho `SafetyIncentives`, cùng cơ chế confirmations và checkpoint.
- Xử lý các event: `Staked`, `UnstakeRequested`, `Withdrawn`, `AckRewarded`,
  `ResolveRewarded`, `RewardSkipped`, `MissedAckSlashed`, `LateRelaySlashed`,
  `BondExhausted`, `ParamsUpdated`.
- Mỗi event cập nhật DB và phát `createRealtimeEvent` cho dApp.

**Bước 7.4: Keeper (`keeper.js`)**, chạy trong vòng lặp của `worker.js`, sau
`relayer.tick()`:
1. **Ghi nhận thưởng:** tìm incident có `owner_status` là `acknowledged`/`resolved`,
   `reward_status = none` và còn trong hạn. Gọi `pendingSettlement(key)` trên chain
   để chắc chắn, rồi `simulate` → `recordTimelyAck` / `recordTimelyResolve`.
2. **Phạt quá hạn:** tìm incident `owner_status = open` mà
   `ack_deadline_at < now()`. Gọi `slashMissedAck`.
3. **Không** gọi `slashLateRelay`. Operator không tự phạt mình; việc này dành cho
   keeper bên ngoài (dApp `/keeper`, bot độc lập).
4. Coi `AlreadySettled` và `AckDeadlinePassed` là **kết quả bình thường** (có người
   làm trước, hoặc đã hết hạn), chỉ ghi log. Lỗi RPC thì backoff như relayer.
5. Mỗi vòng xử lý giới hạn N incident (`KEEPER_BATCH_SIZE`, mặc định 20).

**Bước 7.5: API**

| Route | Quyền | Trả về |
|---|---|---|
| `GET /api/devices/:id/incentives` | Thành viên home | Stake, lịch sử thưởng/phạt, số lượt thưởng hôm nay |
| `GET /api/incentives/overdue` | Công khai | Incident có thể `slashMissedAck` / `slashLateRelay` (chỉ gồm key, hạn chót, mức, **không có số đo**) |
| `GET /api/incentives/params` | Công khai | Tham số hiện hành, số dư quỹ, stake operator |
| `GET /api/devices/:id/incidents/:incidentId` | (sẵn có) | Thêm `incentive: { deadline_at, reward_status, events[] }` |

**Bước 7.6: Test**
- Unit bằng PGlite: chọn đúng incident cần xử lý; không xử lý lại; `AlreadySettled`
  không báo lỗi; kiểm tra ví trùng.
- E2E: mở rộng `test/e2e/chain-e2e.test.js`, hoặc thêm `incentives-e2e.test.js`,
  trên hardhat. Owner không ack thì sau khi tua thời gian keeper tự phạt (P1). Owner
  ack đúng hạn thì keeper tự ghi nhận thưởng (R1).

### Tiêu chí hoàn thành
- Kịch bản 09:00 (R1/R2) và 13:00 (P1) trên hardhat chạy **tự động**, không gọi tay.
- Kịch bản 18:00 (P2): keeper **không** tự phạt; một ví bên ngoài gọi được, và
  indexer ghi nhận đúng.
- Tắt `INCENTIVES_ENABLED` thì worker chạy y như hiện tại (không ảnh hưởng luồng incident).
- Tài liệu API và `.env.example` đã cập nhật.

---

## Task 8: dApp phần token

### Mục tiêu
Cho owner quản lý ký quỹ, thấy rõ **hạn chót và thưởng/phạt** trên từng incident.
Cho bất kỳ ai làm keeper để nhận bounty, nhất là phạt operator relay trễ (việc
keeper của server không làm).

### Kết quả bàn giao
1. Các khối **B7–B11** trong `Web3_task.md`.
2. Route `/wallet`, `/keeper`, `/params`, và phần incentive trên trang incident.
3. Playwright E2E cho **kịch bản B** (một ngày) trên hardhat.
4. `web3/README.md` thêm mục token.

### Cách triển khai

**Bước 8.1: Cấu hình**
- `sync-abi` chép thêm `AirSafeToken.json`, `SafetyIncentives.json`, `<network>.incentives.json`.
- Tự ẩn toàn bộ menu token khi mạng chưa có deployment incentives.

**Bước 8.2: B7 ví token và B8 stake**
- Đọc `balanceOf`, `deviceBond`, `params`, `allowance`.
- Luồng stake 2 bước (`approve` → `stakeDevice`). Lưu tiến trình để nếu người dùng
  hủy giữa chừng thì lần sau tiếp tục từ bước 2.
- Unstake và withdraw có đồng hồ thời gian chờ, tính từ `unstakeRequestedAt` trên chain.

**Bước 8.3: B9 trên trang incident**
- Đồng hồ = `loggedAt + deadline[severity] − now`. `now` lấy từ block mới nhất,
  cập nhật mỗi giây ở phía client.
- Sau khi acknowledge thành công (B5): nếu `pendingSettlement(key)` cho biết chưa
  ghi nhận và còn hạn, tự gọi `recordTimelyAck`. Nếu keeper đã làm thì bỏ qua.
- Hiện nhãn thưởng/phạt từ API, đối chiếu với cờ trên chain.

**Bước 8.4: B10 trang keeper**
- Nguồn danh sách: `GET /api/incentives/overdue`. Nếu API không có thì quét
  `IncidentLogged` và gọi `pendingSettlement`.
- Mỗi dòng: `simulate` trước. Nếu người khác đã phạt (`AlreadySettled`) thì ẩn dòng.
  Hiển thị bounty sẽ nhận.
- Nhấn mạnh mục **"Relay trễ (phạt operator)"**, vì chỉ keeper bên ngoài làm việc này.

**Bước 8.5: B11 tham số**
- Chỉ đọc: tham số, quỹ thưởng, stake operator, lịch sử `ParamsUpdated`.

**Bước 8.6: Test**
- Playwright và hardhat: deploy đủ 3 contract, chạy kịch bản B bằng
  `evm_increaseTime`/`evm_mine` giữa các bước. Trên UI assert:
  - Đồng hồ hiện đúng.
  - Nhãn thưởng/phạt đúng từng sự cố.
  - Chỉ báo `2/3` lượt thưởng hôm nay.
  - `/wallet` cuối ngày hiện ví 20 / stake 80.
- Các test lỗi: người dùng hủy giữa `approve` và `stake`; `CooldownActive`; quỹ cạn;
  sai mạng.

### Tiêu chí hoàn thành
- Kịch bản B chạy trọn **bằng UI** trên hardhat. Số dư khớp bảng tổng kết trong
  `Token_incentive_task.md`.
- Trên Sepolia: owner `0x4aC8…` stake 100 ASAFE; một incident thật được thưởng khi
  ack đúng hạn; một ví khác phạt thành công một incident quá hạn.

---

## Rủi ro chung

| Rủi ro | Task | Giảm thiểu |
|---|---|---|
| Hardhat local và Sepolia cùng chain ID `11155111` làm MetaMask nhầm mạng | 5, 8 | Banner hiện RPC đang dùng; kiểm tra `eip712Domain` (B0); E2E dùng mock connector |
| Evidence encode trong dApp lệch với contract | 5 | Unit test bằng 2 vector bắt buộc trong CI; so thêm với `hashEvidence()` trên chain |
| Keeper và relayer tranh nonce | 7 | Ví keeper riêng; worker kiểm tra khi khởi động |
| Quỹ thưởng cạn | 6, 7 | `RewardSkipped` không revert; API `params` báo số dư; cảnh báo khi dưới 1 000 ASAFE |
| Phạt oan vì RPC hoặc chain chậm | 6, 7 | Hạn chót đủ rộng; tham số chỉnh được; phase 2 thêm maintenance window |
| Lộ khóa keeper | 7 | Không có role; chỉ giữ ít ETH; định kỳ rút bounty về ví lạnh |
