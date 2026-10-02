# Kế hoạch: token thưởng/phạt (AirSafe Incentives)

## Mục tiêu

Thêm cơ chế token để **thưởng người phản ứng nhanh với sự cố** và **phạt bên chậm
trễ**, dựa hoàn toàn trên dữ liệu đã nằm trên chain trong `AirSafetyLog`. Hệ thống
không cần tin server hay oracle.

```text
AirSafetyLog (v2, giữ nguyên) ──getIncident / getDevice──▶ SafetyIncentives ──▶ AirSafe Token (ASAFE)
        ▲                                                         ▲
   logIncident / ack / resolve                     stake / recordTimelyAck / slash… (ai cũng gọi được)
```

**Không deploy lại `AirSafetyLog`.** Firmware, domain EIP-712 và địa chỉ
`0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A` giữ nguyên. Hai contract mới chỉ
**đọc** `AirSafetyLog`.

ASAFE là token **chỉ dùng trên testnet** và không có giá trị tiền tệ.

## Nguyên tắc thiết kế (chống lách luật)

1. **Không thưởng cho việc "ít sự cố".** Nếu thưởng như vậy, người dùng sẽ tắt
   cảm biến hoặc che giấu sự cố. Chỉ thưởng cho **tốc độ phản ứng**.
2. **Không thưởng theo số sự cố.** Owner điều khiển được kit, nên có thể tự tạo
   sự cố giả (bật lửa gần cảm biến) để kiếm token. Vì vậy phải có **trần thưởng
   theo ngày** cho mỗi device.
3. **Chỉ phạt dựa trên dữ liệu chain chứng minh được.** Ví dụ đo độ trễ bằng
   `loggedAt - observedAt`, hoặc kiểm tra `status` sau hạn chót. Không phạt dựa
   trên lời khai của server.
4. **Ai cũng thực thi được luật.** Hàm phạt là permissionless, và người gọi nhận
   **tiền thưởng thực thi (bounty)**. Không cần admin theo dõi.
5. **Mỗi incident chỉ được thanh toán một lần**, để không bị thưởng hoặc phạt hai lần.

## Vai trò

| Vai trò | Ai | Stake (ký quỹ) | Được thưởng khi | Bị phạt khi |
|---|---|---|---|---|
| **Owner** | Ví chủ device (ví MetaMask của user) | 100 ASAFE / device | Acknowledge đúng hạn, resolve đúng hạn | Không acknowledge đúng hạn |
| **Operator** | Bên vận hành server/relayer | 1 000 ASAFE | (không thưởng; chi phí vận hành đã tính ngoài) | Đưa incident lên chain quá chậm |
| **Keeper** | Bất kỳ ai (dApp, bot, người dùng khác) | Không cần | Nhận 50% số token phạt khi gọi hàm phạt hợp lệ | — |
| **Treasury** | Ví admin | — | Nhận 50% số token phạt, cấp vốn cho quỹ thưởng | — |

## Tham số (do admin đặt, có event khi đổi)

| Tham số | Giá trị MVP | Ý nghĩa |
|---|---|---|
| `OWNER_BOND` | 100 ASAFE | Stake tối thiểu/device để được thưởng và chịu phạt |
| `OPERATOR_BOND` | 1 000 ASAFE | Stake của operator |
| `ACK_DEADLINE[warning]` | 30 phút tính từ `loggedAt` | Hạn acknowledge sự cố mức 1 |
| `ACK_DEADLINE[danger]` | 10 phút tính từ `loggedAt` | Hạn acknowledge sự cố mức 2 |
| `RESOLVE_DEADLINE` | 24 giờ tính từ `loggedAt` | Hạn resolve để được thưởng |
| `ACK_REWARD` | 5 ASAFE | Thưởng acknowledge đúng hạn |
| `RESOLVE_REWARD` | 5 ASAFE | Thưởng resolve đúng hạn (chỉ khi đã ack đúng hạn) |
| `DAILY_REWARD_CAP` | 3 incident / device / ngày (UTC) | Trần chống farm |
| `MISSED_ACK_PENALTY` | 20 ASAFE | Trừ vào stake owner |
| `MAX_RELAY_DELAY` | 15 phút (`loggedAt - observedAt`) | Lớn hơn mức lệch đồng hồ mà server chấp nhận (600 s), để không phạt oan vì đồng hồ kit lệch |
| `LATE_RELAY_PENALTY` | 20 ASAFE | Trừ vào stake operator |
| `KEEPER_SHARE` | 50% | Phần token phạt trả cho keeper |
| `UNSTAKE_COOLDOWN` | 7 ngày | Không rút stake ngay được, để không né phạt |

Hạn acknowledge tính từ `loggedAt`, không tính từ `observedAt`, để **owner không
bị phạt vì server chậm**. Server chậm là lỗi của operator.

## Luật (thực thi trên chain)

Ký hiệu `inc = AirSafetyLog.getIncident(key)` và
`dev = AirSafetyLog.getDevice(inc.deviceIdHash)`.

### R1: Thưởng acknowledge đúng hạn
Hàm `recordTimelyAck(key)` được gọi bởi **bất kỳ ai** (dApp gọi ngay sau khi ack,
hoặc chain-worker gọi sau khi index được `IncidentAcknowledged`).

Điều kiện:
- `inc.status ∈ {Acknowledged, Resolved}`
- `block.timestamp ≤ inc.loggedAt + ACK_DEADLINE[inc.severity]`
- Incident chưa được ghi nhận
- Device còn trong trần thưởng của ngày
- `dev.owner` có stake còn ≥ `MISSED_ACK_PENALTY` (đủ chịu một lần phạt) và không
  đang chờ rút. `OWNER_BOND` là mức tối thiểu **khi nạp** stake; sau khi bị phạt
  xuống dưới mức này (ví dụ 80 ở kịch bản) owner vẫn được thưởng.

Nếu không đạt điều kiện stake, trần ngày hoặc quỹ cạn: ack vẫn được ghi nhận
(`timelyAck` là cờ `TIMELY_ACK` trong `settlementFlags`) nhưng không trả thưởng,
phát `RewardSkipped`.

Kết quả: đánh dấu `timelyAck[key] = true` và trả `ACK_REWARD` cho `dev.owner`
(nếu quỹ còn đủ token).

**Vì sao không cần lưu thời điểm ack:** lệnh ghi nhận chỉ thành công **trước hạn
chót**, và phải có trạng thái Acknowledged. Vậy nếu ghi nhận thành công thì ack
chắc chắn xảy ra trước hạn chót. Ack muộn thì không bao giờ ghi nhận được.

### R2: Thưởng resolve đúng hạn
Hàm `recordTimelyResolve(key)`, ai cũng gọi được. Điều kiện:
- `timelyAck[key]`
- `inc.status == Resolved`
- `block.timestamp ≤ inc.loggedAt + RESOLVE_DEADLINE`
- Chưa được ghi nhận

Kết quả: trả `RESOLVE_REWARD`. Phần thưởng này không tính vào trần ngày, vì chỉ
có được khi đã ack đúng hạn (tức đã tính trần ở R1).

### P1: Phạt không acknowledge đúng hạn
Hàm `slashMissedAck(key)`, **ai cũng gọi được**. Điều kiện:
- `block.timestamp > inc.loggedAt + ACK_DEADLINE[inc.severity]`
- `!timelyAck[key]`
- Incident chưa bị phạt

Kết quả: trừ `MISSED_ACK_PENALTY` khỏi stake của device, chuyển 50% cho người
gọi và 50% cho Treasury.

Ack muộn **không giúp né phạt**. Luật chỉ xét `timelyAck`, không xét `status`.

### P2: Phạt operator đưa incident lên chain chậm
Hàm `slashLateRelay(key)`, ai cũng gọi được. Điều kiện:
- `inc.loggedAt - inc.observedAt > MAX_RELAY_DELAY`
- Incident chưa bị phạt P2

Kết quả: trừ `LATE_RELAY_PENALTY` khỏi stake operator, chia 50/50 cho keeper và Treasury.

`observedAt` do **kit ký**, nên server không sửa được để che giấu độ trễ.

### Stake và rút stake
- `stakeDevice(deviceIdHash, amount)`: chỉ `dev.owner` hiện tại được gọi.
- `requestUnstake`, sau đó `withdraw` khi đã qua `UNSTAKE_COOLDOWN`. Trong thời
  gian chờ, stake **vẫn bị phạt được**.
- Khi `setDeviceOwner` đổi owner, stake cũ vẫn thuộc người đã stake. Owner mới
  phải stake riêng mới được thưởng. Người stake cũ rút về được sau thời gian chờ.
- Stake không đủ để trừ thì trừ hết phần còn lại, rồi ghi event `BondExhausted`.
  dApp hiển thị cảnh báo "device không còn ký quỹ".

### Event (cho indexer)
- `Staked`, `UnstakeRequested`, `Withdrawn`
- `AckRewarded(key, owner, amount)`, `ResolveRewarded(key, owner, amount)`
- `MissedAckSlashed(key, deviceIdHash, amount, keeper)`
- `LateRelaySlashed(key, delaySeconds, amount, keeper)`
- `BondExhausted(deviceIdHash)`, `ParamsUpdated(...)`

---

## Kịch bản minh họa (một ngày vận hành)

Dữ liệu dùng trong kịch bản:

| Thực thể | Giá trị |
|---|---|
| Device | kit `dc:b4:d9:13:ed:8c` |
| Owner | `0x4aC8…F30B` |
| Operator | ví relayer `0xe942…197d` |
| Keeper | một ví bot bất kỳ, gọi là K |

Mọi giờ tính theo UTC+7.

### 08:00: Khởi tạo
| Bước | Giao dịch | Kết quả |
|---|---|---|
| 1 | Admin deploy `AirSafeToken` (1 000 000 ASAFE vào Treasury) và `SafetyIncentives` | — |
| 2 | Treasury chuyển 50 000 ASAFE vào quỹ thưởng | Quỹ thưởng = 50 000 |
| 3 | Treasury gọi `depositOperatorBond(1000)` cho operator | Stake operator = 1 000 |
| 4 | Treasury chuyển 100 ASAFE cho owner; owner `stakeDevice(kit, 100)` | Stake owner = 100, ví owner = 0 |

### 09:00: Sự cố #1, cảnh báo sớm, phản ứng tốt ✅
| Thời điểm | Sự kiện | Luật | Owner (ví / stake) |
|---|---|---|---|
| 09:00:00 | Kit phát hiện CO tăng: `observedAt` = 09:00:00, mức 1 | — | 0 / 100 |
| 09:01:30 | Relayer `logIncident`: `loggedAt` = 09:01:30, trễ 90 s ≤ 15 phút | P2 không áp dụng | 0 / 100 |
| 09:08:00 | Owner bấm **Acknowledge** trên dApp; dApp gọi tiếp `recordTimelyAck` | R1: 09:08 ≤ 09:31:30 → **+5** | 5 / 100 |
| 10:00:00 | Owner **Resolve** trên dApp; dApp gọi `recordTimelyResolve` | R2: ≤ 24 h, đã ack đúng hạn → **+5** | **10** / 100 |

### 13:00: Sự cố #2, vượt ngưỡng, owner không phản ứng ❌
| Thời điểm | Sự kiện | Luật | Owner | Keeper K |
|---|---|---|---|---|
| 13:00:00 | `observedAt` = 13:00:00, **mức 2** | — | 10 / 100 | 0 |
| 13:01:00 | `loggedAt` = 13:01:00; hạn ack là 13:11:00 | — | 10 / 100 | 0 |
| 13:11:30 | K gọi `slashMissedAck(#2)` | P1: quá hạn và chưa có ack đúng hạn → **−20** stake owner; K +10, Treasury +10 | 10 / **80** | **10** |
| 13:30:00 | Owner mới ack; dApp gọi `recordTimelyAck` | R1: 13:30 > 13:11 → **bị từ chối** (`AckDeadlinePassed`) | 10 / 80 | 10 |
| 13:31:00 | K gọi lại `slashMissedAck(#2)` | Bị từ chối (`AlreadySettled`), không phạt 2 lần | 10 / 80 | 10 |

### 18:00: Sự cố #3, server sập, operator bị phạt; owner không bị liên lụy ⚖️
| Thời điểm | Sự kiện | Luật | Owner | Operator | K |
|---|---|---|---|---|---|
| 18:00:00 | `observedAt` = 18:00:00, mức 1. Server đang sập, kit giữ incident trong queue NVS | — | 10 / 80 | 1 000 | 10 |
| 18:25:00 | Server chạy lại; relayer `logIncident`: `loggedAt` = 18:25:00, **trễ 25 phút** | — | | | |
| 18:26:00 | K gọi `slashLateRelay(#3)` | P2: 25 phút > 15 phút → **−20** stake operator; K +10, Treasury +10 | 10 / 80 | **980** | **20** |
| 18:40:00 | Owner ack và ghi nhận | R1: hạn tính từ `loggedAt` 18:25 nên là 18:55 → **+5** | **15** / 80 | 980 | 20 |

### 20:00: Owner cố farm token bằng sự cố giả 🚫
Owner đưa bật lửa lại gần cảm biến và tạo 3 sự cố #4, #5, #6 trong 30 phút, rồi
ack tất cả đúng hạn.

Trần tính theo **số lần thưởng R1** trong ngày của device. Trước 20:00 đã có 2
lần: #1 và #3. #2 không được thưởng nên không tính.

| Sự cố | R1 | Owner (ví / stake) |
|---|---|---|
| #4 | Lần thưởng thứ **3** trong ngày → **+5** | 20 / 80 |
| #5 | **Vượt trần**: ghi nhận ack đúng hạn (`timelyAck = true`, nên **không bị phạt**) nhưng **không trả thưởng** | 20 / 80 |
| #6 | **Vượt trần**: giống #5 | 20 / 80 |

Làm giả 3 sự cố chỉ mang lại thêm 5 ASAFE. Thưởng ack tối đa là 15 ASAFE mỗi
device mỗi ngày (cộng thưởng resolve), trong khi mọi sự cố giả để lại dấu vết
không xóa được trên chain. Sau này có thể dùng registry firmware (chặn bản replay)
và đối chiếu telemetry để phát hiện rồi `revokeDevice`.

### Tổng kết cuối ngày
| Ví | Số dư ví | Stake | Thay đổi |
|---|---|---|---|
| Owner `0x4aC8…` | **20** ASAFE | **80** | +20 thưởng (#1 ack + resolve, #3 ack, #4 ack); −20 phạt trừ vào stake (#2); #5, #6 vượt trần |
| Operator `0xe942…` | 0 | **980** | −20 phạt (#3) |
| Keeper K | **20** | 0 | +10 (#2) +10 (#3) |
| Treasury | +20 | — | 50% của hai lần phạt |
| Quỹ thưởng | 50 000 − 20 = **49 980** | — | |

Kiểm tra bảo toàn: tổng token không đổi (1 000 000). Token chỉ chuyển giữa các
ví, không được mint thêm.

---

## Phân công

### Task 6: Contract token và incentives
**Phạm vi:** `blockchain/contracts/AirSafeToken.sol`, `SafetyIncentives.sol`,
`scripts/deploy-incentives.js`, test.
- `AirSafeToken`: ERC-20 (OpenZeppelin), mint cố định 1 000 000 cho Treasury khi
  deploy, không có hàm mint sau đó.
- `SafetyIncentives`: `AccessControl` (admin chỉ đặt tham số, cấp quỹ và đăng ký
  operator), `ReentrancyGuard`, `SafeERC20`. Constructor nhận địa chỉ `AirSafetyLog`
  và token.
- Custom error: `AckDeadlinePassed`, `AckDeadlineNotPassed`, `AlreadySettled`,
  `NotAcknowledged`, `NotResolved`, `NotDeviceOwner`, `BondTooLow`, `RelayNotLate`,
  `CooldownActive`, `IncidentNotFound`.
- Deploy ghi `deployments/sepolia.incentives.json` và ABI cho backend và dApp.
  **Không** đụng tới `deployments/sepolia.json` hay domain EIP-712.

**Hoàn thành khi:** `test/incentives.scenario.test.js` dựng lại **đúng kịch bản
trên** bằng `time.increaseTo` trên hardhat, với `AirSafetyLog` thật và chữ ký
theo vector. Test phải khớp mọi số dư ở bảng tổng kết, gồm cả các lệnh bị từ chối.
Thêm test cho: gọi 2 lần, stake không đủ, rút stake trong thời gian chờ, đổi
owner, quỹ thưởng cạn, reentrancy.

### Task 7: Backend (keeper, indexer, API)
**Phạm vi:** `server/api/src/chain/`, migration mới.
- Indexer đọc thêm event của `SafetyIncentives`, lưu vào bảng `incentive_events`
  và cập nhật `incidents.reward_status`.
- Keeper trong chain-worker:
  - Sau khi index `IncidentAcknowledged`/`Resolved` và **còn trong hạn**, gọi
    `recordTimelyAck`/`recordTimelyResolve` để owner không phải tự gửi thêm tx.
  - Quét incident quá hạn và gọi `slashMissedAck`.
  - Ví keeper **tách riêng** khỏi relayer, để operator không tự phạt hoặc tự hưởng bounty.
- API: `GET /api/devices/:id/incentives` (stake, lịch sử thưởng/phạt) và
  `GET /api/incentives/leaderboard`.

**Hoàn thành khi:** E2E trên hardhat chạy được kịch bản 13:00 (P1) và 18:00 (P2)
một cách tự động, không cần gọi tay.

### Task 8: Web3 dApp (mở rộng Task 5)

Chi tiết khối chức năng và cách kịch bản trên chạy trên từng màn hình:
[`Web3_task.md`](Web3_task.md) (khối B7–B11, mục 7 kịch bản B, mốc M4).
**Phạm vi:** thư mục `web3/` (dApp của Task 5 trong
[`Blockchain_task.md`](Blockchain_task.md)), dùng `wagmi`/`viem` và MetaMask trên
Sepolia. ABI và address của token và incentives lấy từ
`deployments/sepolia.incentives.json`.

App mobile **không** làm phần token. App chỉ hiện nhãn "đang chờ acknowledge / còn
X phút" và nút mở trang incident trên dApp.

- **Trang "Ví của tôi":** số dư ASAFE, stake theo từng device, trạng thái rút stake
  (thời gian chờ còn lại), lịch sử thưởng/phạt (từ event qua API
  `GET /api/devices/:id/incentives`, đối chiếu thêm bằng `getLogs` trên chain).
- **Stake / Unstake / Withdraw:** gọi `approve` rồi `stakeDevice` (2 tx, hiển thị
  rõ từng bước), `requestUnstake`, và `withdraw` khi đã hết thời gian chờ.
- **Trang incident:** **đồng hồ đếm ngược tới hạn acknowledge**, tính từ
  `loggedAt + ACK_DEADLINE[severity]` đọc trên chain, không dùng giờ server. Khi
  bấm Acknowledge: gửi `acknowledgeIncident`, chờ receipt, rồi gọi
  `recordTimelyAck` nếu keeper chưa gọi. Làm tương tự với Resolve và
  `recordTimelyResolve`.
- **Cảnh báo:**
  - Còn dưới 3 phút tới hạn chót.
  - Stake < `OWNER_BOND` ("không còn được thưởng, vẫn có thể bị phạt").
  - Đã đạt trần thưởng trong ngày.
- **Trang keeper công khai (không cần là owner):** liệt kê incident quá hạn chưa
  bị phạt và incident relay trễ, kèm nút `slashMissedAck` / `slashLateRelay` để
  nhận bounty.
- **Test:** wallet reject giữa `approve` và `stake`, tx revert
  (`AckDeadlinePassed`, `AlreadySettled`, `BondTooLow`, `CooldownActive`), sai mạng,
  và quỹ thưởng cạn.

**Hoàn thành khi:** chạy hết kịch bản minh họa trên hardhat node local bằng dApp
và MetaMask (không gọi tay qua script); số dư hiển thị khớp bảng tổng kết.

## Rủi ro và câu hỏi mở

| Rủi ro | Hướng xử lý |
|---|---|
| Owner ngủ lúc 3 giờ sáng và bị phạt dù không có lỗi | Cho owner ủy quyền ack cho người trực ca (`setDelegate`), hoặc đặt hạn dài hơn ban đêm (quyết định ở phase 2) |
| Chain nghẽn làm ack đúng giờ nhưng tx vào block muộn | Hạn chót tính theo `block.timestamp`. Nên để hạn đủ rộng (10–30 phút). dApp cảnh báo khi còn dưới 3 phút |
| Operator bị phạt oan khi RPC Sepolia sập | Chấp nhận ở MVP (phạt nhỏ). Phase 2: admin mở "maintenance window" được công khai trên chain |
| Keeper và operator là cùng một người | Không lợi được gì: tự phạt mình chỉ nhận lại 50% và mất 50% vào Treasury |
| Farm token bằng sự cố giả | Trần 3/ngày + dấu vết vĩnh viễn trên chain; phase 2 dùng registry firmware |
| Token có giá trị tiền thật (lên mainnet) | **Ngoài phạm vi**. Phải review pháp lý và audit contract trước |

**Không làm trong task này:** sửa `AirSafetyLog`, sửa firmware, đưa token lên
mainnet, bán hay niêm yết token.
