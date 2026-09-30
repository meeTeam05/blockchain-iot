# Kế hoạch: dApp Web3 (Task 5 + Task 8)

dApp chạy trên trình duyệt, là nơi **duy nhất** người dùng thao tác với ví và
contract. Tài liệu này chi tiết hóa:

- Task 5 trong [`Blockchain_task.md`](Blockchain_task.md): incident, verify, owner action.
- Task 8 trong [`Token_incentive_task.md`](Token_incentive_task.md): token thưởng/phạt.

```text
            ┌──────────── App mobile (giữ nguyên) ────────────┐
            │ Provision BLE/Wi-Fi · telemetry · điều khiển     │
            │ Thông báo realtime · nhãn chain_status           │
            └──────────────┬───────────────────────────────────┘
                           │ link: <dapp>/d/<device_id>/i/<incident_id>
                           ▼
┌──────────────────────── dApp web3 (web3/) ────────────────────────┐
│  Đọc evidence, danh sách ──▶ API backend (JWT)                     │
│  Đọc trạng thái thật ──────▶ contract (eth_call qua RPC)           │
│  Gửi tx ───────────────────▶ MetaMask ──▶ AirSafetyLog / Incentives │
└────────────────────────────────────────────────────────────────────┘
```

## 1. Nguyên tắc

1. **Chain là nguồn sự thật cho trạng thái.** Owner, `status`, `loggedAt`,
   `evidenceHash`, stake và số dư token đều đọc bằng `eth_call`. API chỉ cung cấp
   evidence đầy đủ, danh sách và lịch sử đã index.
2. **Không tin backend khi xác minh.** dApp tự tính lại hash và so với chain.
3. **Không bao giờ chạm private key.** Chỉ dùng ví trình duyệt (MetaMask).
   Không có ô nhập khóa, không lưu seed.
4. **Mô phỏng trước khi gửi.** Mọi tx đều chạy `simulateContract` trước. Nếu sẽ
   revert thì báo lỗi bằng tiếng Việt, không bật popup MetaMask.
5. **Không cần ví vẫn xem được.** Các trang xem và verify chạy ở chế độ chỉ đọc.
6. **Chạy được trên điện thoại.** Mở trong trình duyệt của MetaMask Mobile qua
   `https://metamask.app.link/dapp/<dapp-url>/...`.

## 2. Công nghệ và cấu trúc

| Hạng mục | Chọn |
|---|---|
| Khung | Vite + React + TypeScript, React Router |
| Web3 | `wagmi` v2 + `viem` (connector `injected`, WalletConnect là tùy chọn) |
| Dữ liệu | TanStack Query (cache API và `eth_call`), invalidate khi có tx hoặc event mới |
| UI | Tailwind; mobile-first |
| Test | Vitest (logic, hash), Playwright + hardhat node + mock connector (E2E) |

```text
web3/
  src/config/networks.ts     đọc spec/incident/deployments/{localhost,sepolia}.json
                             + deployments/sepolia.incentives.json (Task 8)
  src/abi/                   copy từ blockchain/abi (script sync, không sửa tay)
  src/lib/evidence.ts        encode + keccak IncidentEvidence (khớp docs/test-vectors)
  src/lib/errors.ts          decode custom error → thông báo tiếng Việt
  src/lib/tx.ts              state machine giao dịch (mục 5)
  src/blocks/<B1…B11>/       mỗi khối chức năng một thư mục
  src/pages/                 route (mục 4)
```

Cấu hình bằng biến môi trường: `VITE_NETWORK=sepolia|localhost`,
`VITE_API_BASE_URL`, `VITE_RPC_URL` (dự phòng khi ví chưa kết nối).

## 3. Các khối chức năng

Mỗi khối gồm: mục đích, dữ liệu đọc, giao dịch gửi, trạng thái UI và tiêu chí
xong. Phần **Nền tảng** (B0–B2) phải xong trước. Phần **incident** (B3–B6) thuộc
Task 5, phần **token** (B7–B11) thuộc Task 8.

### B0. Nền tảng web3
- **Mục đích:** hạ tầng dùng chung cho mọi khối.
- **Gồm:**
  - Nạp cấu hình mạng từ file spec (address, chain ID, `blockNumber`).
  - Kiểm tra `eip712Domain()` của contract khớp spec khi khởi động. Nếu lệch thì
    hiện banner đỏ và khóa mọi nút gửi tx.
  - Component `<TxButton>` chạy state machine giao dịch (mục 5).
  - `decodeError()` cho custom error của cả 2 contract (mục 6).
  - Component `<ExplorerLink>` cho tx, address, block.
- **Xong khi:**
  - Đổi `VITE_NETWORK` giữa localhost và sepolia không cần sửa code.
  - Sai domain thì dApp bị khóa.

### B1. Ví và phiên đăng nhập
- **Mục đích:** biết **ai** đang dùng dApp: user nào trên API, và ví nào trên chain.
- **Luồng:**
  1. Đăng nhập API bằng tài khoản app (email/mật khẩu → JWT, dùng chung `/api/auth`).
  2. Bấm **Kết nối ví**. Sai mạng thì gọi `wallet_switchEthereumChain` (nếu ví chưa
     có localhost thì dùng `wallet_addEthereumChain`).
  3. Theo dõi `accountsChanged`/`chainChanged`. Khi đổi account, tính lại quyền ngay.
- **Hiển thị:** địa chỉ rút gọn, mạng, số dư ETH (cảnh báo khi dưới 0.002 ETH vì
  không đủ phí gas), nhãn vai trò: `Owner của N device`, `Keeper` (ai cũng là keeper).
- **Xong khi:** đổi account trong MetaMask thì nút owner action ẩn/hiện đúng mà không
  cần tải lại trang.

### B2. Danh sách thiết bị
- **Dữ liệu:** `GET /api/devices` (device user được xem). Với mỗi device, tính
  `deviceIdHash = keccak256(device_id)` và đọc `getDevice()`.
- **Mỗi thẻ device:**
  - `active` / `revoked` / **chưa đăng ký on-chain**
  - Signer, owner (có nhãn **"Bạn"** nếu khớp ví đang kết nối), `lastSequence`
  - Số incident đang `open`
  - Task 8 thêm: stake và cảnh báo khi stake thấp
- **Trạng thái đặc biệt:** API có device nhưng chain chưa có thì hiện "Chờ
  đăng ký on-chain" và hướng dẫn liên hệ operator. dApp không tự đăng ký, vì đó
  là quyền của `DEVICE_MANAGER_ROLE`.

### B3. Danh sách và chi tiết incident
- **Dữ liệu:** `GET /api/devices/:id/incidents` (phân trang `before_sequence`) và
  `GET …/:incidentId` (evidence 33 field). Tính `incidentKey = computeIncidentKey(...)`,
  rồi đọc `getIncident(incidentKey)` để lấy `status`, `loggedAt`, `evidenceHash` thật.
- **Hợp nhất trạng thái** (ưu tiên chain):

| API `chain_status` | Chain `status` | Hiển thị |
|---|---|---|
| `queued`/`pending` | `None` | ⏳ Đang đưa lên chain |
| bất kỳ | `Logged` | 🟥 Đã ghi on-chain, chờ xử lý |
| bất kỳ | `Acknowledged` | 🟧 Đã xác nhận |
| bất kỳ | `Resolved` | 🟩 Đã xử lý xong |
| `failed`/`blocked` | `None` | ⚠️ Lỗi đưa lên chain (hiện `fail_reason`) |
| `legacy_domain` | `None` | ⚪ Ký cho contract cũ, không lên chain |

- **Chi tiết:**
  - Mức độ, thời điểm phát hiện (`observedAt`) và thời điểm lên chain (`loggedAt`).
  - Số đo (chỉ hiện giá trị có bit valid), nguồn cảnh báo (rule/projection/model).
  - Firmware, model và calibration hash.
  - Tx hash kèm link Etherscan.
- **Cập nhật:** nghe realtime của API (hoặc polling 10 s). Khi có tx của chính mình
  thì poll nhanh tới khi indexer đồng bộ.

### B4. Xác minh độc lập (Verify)
- **Mục đích:** chứng minh dữ liệu hiển thị **đúng là dữ liệu kit đã ký và đã ghi
  trên chain**, không cần tin server.
- **Các bước kiểm tra** (mỗi dòng ✅/❌):
  1. `keccak256(device_id)` bằng `deviceIdHash` trong evidence.
  2. `computeIncidentId(deviceIdHash, sequence)` bằng `incidentId`.
  3. `evidenceHash` tính **tại trình duyệt** (`lib/evidence.ts`) bằng
     `hashEvidence(evidence)` gọi trên contract **và** bằng `getIncident().evidenceHash`
     trên chain.
  4. `signer` trong incident trên chain là signer của device tại thời điểm ghi
     (so với `getDevice().signer` và event `DeviceSignerRotated`).
  5. (Tùy chọn) Đối chiếu kết quả `GET …/verify` của backend. Chỉ dùng để tham
     khảo, không phải căn cứ.
- **Kết quả:** "✅ Dữ liệu toàn vẹn", hoặc "❌ Không khớp ở bước X", kèm giá trị
  hai bên. Có nút **Sao chép link xác minh**.
- **Xong khi:** chạy đúng với 2 vector trong `docs/test-vectors/` (unit test); với
  dữ liệu bị sửa 1 field thì báo ❌ đúng bước 3.

### B5. Owner action: Acknowledge / Resolve
- **Chỉ hiện khi:** ví đang kết nối bằng `getDevice().owner` **và** `status` phù hợp.
- **Luồng Acknowledge:**
  1. Kiểm tra trước: `status == Logged`.
  2. `simulateContract(acknowledgeIncident, key)`.
  3. MetaMask ký, rồi gửi tx.
  4. Chờ receipt, sau đó chờ API báo `owner_status = acknowledged`.
  5. (Task 8) Nếu còn trong hạn, tự gọi tiếp `recordTimelyAck` (B9).
- **Resolve:** cho phép từ `Logged` hoặc `Acknowledged`, luồng tương tự.
- **Lỗi thường gặp:**
  - Ví không phải owner: `NotDeviceOwner`.
  - Đã xử lý rồi: `InvalidStatus`.
  - Người dùng hủy trong MetaMask: quay lại trạng thái cũ, không báo lỗi đỏ.

### B6. Lịch sử on-chain
- **Dữ liệu:** `getLogs` của `AirSafetyLog`, lọc theo topic `deviceIdHash`, từ
  `deployment.blockNumber`. Chia nhỏ theo `≤ 2 000` block mỗi lần gọi.
- **Hiển thị:** dòng thời gian gồm `DeviceRegistered`, `DeviceSignerRotated`,
  `DeviceRevoked`, `DeviceOwnerChanged`, `IncidentLogged`, `IncidentAcknowledged`,
  `IncidentResolved`. Mỗi dòng có block, thời gian và link Etherscan.
- **Mục đích:** người dùng tự kiểm tra lịch sử **không qua API**.

### B7. Ví token (Task 8)
- **Dữ liệu:** `ASAFE.balanceOf(me)`, stake theo từng device của mình, trạng thái
  rút stake (thời gian chờ còn lại) và tham số hiện hành (`OWNER_BOND`, thời hạn,
  trần ngày).
- **Lịch sử:** event `AckRewarded`, `ResolveRewarded`, `MissedAckSlashed`,
  `Staked`, `Withdrawn` liên quan tới mình. Nguồn là API `GET /api/devices/:id/incentives`,
  có nút "đối chiếu on-chain" bằng `getLogs`.

### B8. Stake / Unstake / Withdraw (Task 8)
- **Stake:** chọn device (chỉ device mình là owner), nhập số lượng (mặc định bằng
  `OWNER_BOND`).
  - **Bước 1:** `approve(incentives, amount)`, bỏ qua nếu allowance đã đủ.
  - **Bước 2:** `stakeDevice(deviceIdHash, amount)`.
  - Hiển thị rõ **"Bước 1/2", "Bước 2/2"**. Nếu hủy giữa chừng thì lần sau tiếp tục
    từ bước 2.
- **Unstake:** `requestUnstake`. Hiện đồng hồ 7 ngày và nhắc "trong thời gian chờ
  vẫn có thể bị phạt".
- **Withdraw:** chỉ bật khi đã hết thời gian chờ.
- **Lỗi:** `BondTooLow`, `CooldownActive`, `NotDeviceOwner`, không đủ ASAFE.

### B9. Incentive trên trang incident (Task 8)
- **Đồng hồ đếm ngược** tới `loggedAt + ACK_DEADLINE[severity]` (đọc từ chain).
  Đổi màu khi còn dưới 3 phút; khi hết hạn hiện "Quá hạn, có thể bị phạt".
- **Nhãn thưởng/phạt:** `Đã thưởng ack +5`, `Đã thưởng resolve +5`,
  `Vượt trần ngày: không thưởng`, `Đã bị phạt −20`, `Relay trễ: operator bị phạt`.
- **Nút ghi nhận thủ công:** `recordTimelyAck` / `recordTimelyResolve` khi keeper
  chưa gọi (ai cũng bấm được, phần thưởng luôn về owner).
- **Chỉ báo trần ngày:** `2/3 lượt thưởng hôm nay`.

### B10. Bảng keeper công khai (Task 8)
- **Ai cũng dùng được**, chỉ cần ví có ETH trả phí gas.
- **Hai danh sách:**
  - **Quá hạn acknowledge:** `loggedAt + deadline < now`, chưa `timelyAck`, chưa
    bị phạt. Nút `slashMissedAck` và "Bounty: +10 ASAFE".
  - **Relay trễ:** `loggedAt − observedAt > MAX_RELAY_DELAY`, chưa bị phạt. Nút
    `slashLateRelay`.
- Trước khi bấm, `simulateContract` phải thành công. Nếu người khác đã phạt trước
  (`AlreadySettled`), dòng đó tự biến mất.

### B11. Bảng tham số và quỹ (chỉ đọc)
- Tham số hiện hành, số dư quỹ thưởng, stake của operator, lịch sử `ParamsUpdated`.
- **Không có** chức năng admin trong dApp. Admin dùng script Hardhat, để giữ khóa
  admin tách khỏi trình duyệt.

## 4. Trang (route)

| Route | Khối | Cần đăng nhập API | Cần ví |
|---|---|---|---|
| `/` | B1, B2 | ✔ | ✖ (xem) / ✔ (hành động) |
| `/d/:deviceId` | B2, B3 (danh sách), B6 | ✔ | ✖ |
| `/d/:deviceId/i/:incidentId` | B3, B4, B5, B9 | ✔ | ✔ cho B5/B9 |
| `/verify/:deviceId/:incidentId` | B4 | ✔ (xem mục 8, câu hỏi 1) | ✖ |
| `/wallet` | B7, B8 | ✔ | ✔ |
| `/keeper` | B10 | ✖ | ✔ |
| `/params` | B11 | ✖ | ✖ |

## 5. State machine giao dịch (`<TxButton>`)

```text
idle ─bấm─▶ simulating ─revert─▶ error(decoded)
               │ ok
               ▼
          awaiting_wallet ─user hủy─▶ idle
               │ ký
               ▼
          pending (tx hash, link Etherscan)
               │ receipt status=1          receipt status=0 ─▶ error(decoded)
               ▼
          confirmed (≥1 block) ──▶ indexing (chờ API phản ánh, tối đa 2 phút)
               │                              │ quá 2 phút
               ▼                              ▼
             done                    done + "API đang chậm, chain đã ghi"
```

Tx đang `pending` lưu tạm trong `localStorage` (hash, loại, incident). Khi tải lại
trang, dApp tiếp tục theo dõi thay vì cho gửi lại.

## 6. Thông báo lỗi

| Custom error | Thông báo |
|---|---|
| `NotDeviceOwner` | Ví đang kết nối không phải chủ thiết bị này |
| `InvalidStatus` | Sự cố đã được xử lý ở bước này rồi |
| `IncidentNotFound` | Sự cố chưa được ghi lên chain |
| `AckDeadlinePassed` | Đã quá hạn xác nhận, không thể nhận thưởng |
| `AckDeadlineNotPassed` / `RelayNotLate` | Chưa đủ điều kiện phạt |
| `AlreadySettled` | Đã có người xử lý trước |
| `BondTooLow` | Ký quỹ chưa đủ mức tối thiểu |
| `CooldownActive` | Chưa hết thời gian chờ rút ký quỹ |
| `ResolveDeadlinePassed` | Đã quá hạn xử lý, không thể nhận thưởng |
| `NotAcknowledged` / `NotResolved` | Sự cố chưa được xác nhận / chưa được xử lý trên chain |
| `IncidentNotCovered` | Sự cố ghi trước khi bật thưởng/phạt, không áp dụng |
| `BondHeldByOther` | Ký quỹ của chủ cũ chưa rút, chưa thể ký quỹ |
| `NotStaker` / `NotOperator` | Ví này không giữ khoản ký quỹ này |
| `NoUnstakeRequest` / `UnstakeAlreadyRequested` | Chưa yêu cầu rút / đã yêu cầu rút rồi |
| `DeviceNotFound` | Thiết bị chưa đăng ký on-chain |
| `ZeroAmount` | Số lượng phải lớn hơn 0 |
| `ERC20InsufficientBalance` | Không đủ ASAFE |
| `ERC20InsufficientAllowance` | Chưa approve đủ ASAFE (bước 1 của stake) |
| (RPC/gas) | Mạng Sepolia đang chậm hoặc ví không đủ ETH trả phí |

## 7. Kịch bản sử dụng và khối xử lý

### Kịch bản A: E2E incident (Task 5, không cần token)
| Bước | Người dùng thấy / làm | Khối |
|---|---|---|
| A1 | Kit phát hiện CO. App mobile báo "⚠️ Vượt ngưỡng", bấm "Xem trên chain" | App → link B3 |
| A2 | dApp mở trang incident, trạng thái ⏳ Đang đưa lên chain, rồi 🟥 Đã ghi on-chain | B3 |
| A3 | Bấm **Xác minh**: 4 dòng ✅, "Dữ liệu toàn vẹn" | B4 |
| A4 | Kết nối MetaMask (ví `0x4aC8…`), nút **Xác nhận** hiện ra vì là owner | B1, B5 |
| A5 | Bấm Xác nhận → mô phỏng → MetaMask → pending → confirmed → 🟧 | B5, B0 |
| A6 | Đổi sang ví khác: nút biến mất; nếu gọi thẳng thì báo "không phải chủ thiết bị" | B1, B5, B0 |
| A7 | Bấm **Đã xử lý** → 🟩; tab Lịch sử có 3 event Logged/Acknowledged/Resolved | B5, B6 |

### Kịch bản B: một ngày thưởng/phạt (Task 8, theo `Token_incentive_task.md`)
| Giờ | Tình huống | Người dùng làm trên dApp | Khối |
|---|---|---|---|
| 08:00 | Khởi tạo | Owner vào `/wallet`, stake 100 ASAFE (approve → stake, 2 bước) | B7, B8 |
| 09:01 | Sự cố #1 (mức 1) | Trang incident có đồng hồ **30:00**; owner xác nhận lúc 09:08, dApp tự gọi `recordTimelyAck` → nhãn **+5** | B3, B9, B5 |
| 10:00 | Resolve #1 | Owner bấm Đã xử lý → **+5**; `/wallet` hiện số dư 10 | B5, B9, B7 |
| 13:01 | Sự cố #2 (mức 2) | Đồng hồ **10:00** chuyển đỏ khi còn dưới 3 phút; owner không vào | B9 |
| 13:11 | Quá hạn | Keeper K mở `/keeper`, thấy #2 trong "Quá hạn acknowledge", bấm phạt → K +10; owner thấy **−20** và stake 80 | B10, B7 |
| 13:30 | Owner ack muộn | Ack vẫn thành công (🟧), nhưng dApp **không** gọi `recordTimelyAck` và hiện "Quá hạn, không có thưởng" | B5, B9 |
| 18:25 | Sự cố #3 lên chain trễ 25 phút | `/keeper` hiện #3 trong "Relay trễ"; K bấm phạt operator. Trang incident hiện "Relay trễ: operator bị phạt"; đồng hồ owner vẫn đếm từ 18:25 | B10, B9 |
| 18:40 | Owner ack #3 | **+5**, chỉ báo "2/3 lượt thưởng hôm nay" | B5, B9 |
| 20:00 | 3 sự cố giả | #4 được **+5** (3/3); #5 và #6 hiện "Vượt trần ngày: không thưởng", nhưng vẫn **không bị phạt** | B9 |
| Cuối ngày | Kiểm tra | `/wallet`: ví 20, stake 80; lịch sử khớp bảng tổng kết | B7, B11 |

## 8. Phụ thuộc backend và câu hỏi mở

| # | Vấn đề | Đề xuất |
|---|---|---|
| 1 | Trang `/verify` cho **người ngoài** (thanh tra) cần evidence, nhưng API incidents đòi JWT và quyền home | Thêm link chia sẻ có hạn (`share_token`) hoặc endpoint công khai chỉ trả evidence + hash. **Nhóm quyết định**, vì số đo có thể là dữ liệu riêng tư |
| 2 | CORS | Thêm origin của dApp vào `CORS_ORIGINS` |
| 3 | Liên kết user ↔ ví | Không bắt buộc: quyền owner xác định bằng chain. Phase 2 có thể thêm SIWE (Sign-In with Ethereum) để bỏ đăng nhập email |
| 4 | API incentives (Task 7) | `GET /api/devices/:id/incentives`, `GET /api/incentives/overdue` để trang keeper khỏi quét `getLogs` |
| 5 | RPC công cộng giới hạn `getLogs` | Dùng RPC riêng qua `VITE_RPC_URL`; B6 chia nhỏ theo 2 000 block |
| 6 | Hosting | Build tĩnh (`vite build`), phục vụ qua nginx hiện có tại đường dẫn `/dapp/` hoặc Cloudflare Pages |

## 9. Kiểm thử

| Mức | Nội dung | Công cụ |
|---|---|---|
| Unit | `lib/evidence.ts` khớp 2 vector `docs/test-vectors/`; sửa 1 field thì hash khác; `decodeError` đủ mọi custom error; hợp nhất trạng thái (bảng B3) | Vitest |
| Tích hợp | B0–B6 trên hardhat node với deployment `localhost.json` và incident do `chain-e2e` tạo | Vitest + hardhat |
| E2E UI | Kịch bản A và kịch bản B với `time.increase` trên hardhat; ví mô phỏng bằng mock connector của wagmi | Playwright |
| Thủ công | Kịch bản A trên **Sepolia** bằng kit thật và MetaMask thật, cả desktop và MetaMask Mobile | Checklist |

## 10. Mốc triển khai

| Mốc | Nội dung | Hoàn thành khi |
|---|---|---|
| M1 | B0, B1, B2 | Kết nối ví, đúng mạng, danh sách device hiển thị trạng thái on-chain |
| M2 | B3, B4, B6 | Xem incident, verify độc lập ✅ với incident thật trên Sepolia (ví dụ tx `0x14e0…a49c`) |
| M3 | B5 | Kịch bản A chạy trọn trên Sepolia |
| M4 | B7–B11 (sau Task 6 và 7) | Kịch bản B chạy trọn trên hardhat; số dư khớp bảng tổng kết |

**Không làm:** provision BLE, MQTT, ký evidence, relayer, chức năng admin, deploy
contract.
