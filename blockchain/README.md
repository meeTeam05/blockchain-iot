# AirSafetyLog — smart contract (Task 2)

Contract Solidity neo incident Gas EWS đã được thiết bị ký lên Sepolia theo
[`docs/reference/BLOCKCHAIN_INCIDENT_SCHEMA.md`](../docs/reference/BLOCKCHAIN_INCIDENT_SCHEMA.md)
(Schema v2). Chain chỉ lưu claim tối thiểu + `evidenceHash`; evidence đầy đủ
nằm ở TimescaleDB.

```text
contracts/AirSafetyLog.sol    Contract (OpenZeppelin AccessControl + EIP712 + ECDSA)
test/                         Hardhat test: vector v2, tamper, signer, replay, role…
scripts/deploy.js             Deploy + ghi deployments/<network>.json + ABI
scripts/verify.js             Verify source trên Etherscan
scripts/roles.js              Task `hardhat roles`: xem/cấp/thu role
abi/AirSafetyLog.json         ABI bàn giao cho backend (Task 3/4) và dApp web3 (Task 5)
deployments/sepolia.json      Address, chain ID, tx deploy, block, domain (sau khi deploy)
deployments/sepolia.v1-highwater.json  Deployment cũ 0x4E6e… (bytecode high-water-mark, KHÔNG dùng)
../spec/incident/deployments/ Nguồn domain EIP-712 duy nhất cho firmware + backend (deploy.js ghi)
```

## Lệnh

```bash
cd blockchain
npm ci
npm test                 # toàn bộ Hardhat test (chain ID local = 11155111)
npm run export-abi       # sau compile, cập nhật abi/AirSafetyLog.json

cp .env.example .env     # điền SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, ETHERSCAN_API_KEY…
                         # hardhat.config.js tự đọc .env (dotenv), không cần source
npm run deploy:sepolia   # ghi deployments/sepolia.json + spec/incident/deployments/sepolia.json + abi/
node ../spec/incident/gen/gen-all.mjs   # sinh lại incident_domain.h + backend module, commit cùng deployment
npm run verify:sepolia   # verify source, đánh dấu "verified": true
```

Khuyến nghị Node 22 LTS. Trên Node 24/Windows, Hardhat 2 có thể in
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` lúc thoát; lỗi này xảy
ra sau khi lệnh đã chạy xong và có thể bỏ qua.

Compiler: solc `0.8.28`, optimizer 200 runs, `viaIR: true`, EVM `cancun`
(verify phải dùng đúng cấu hình này — `scripts/verify.js` lấy từ
`hardhat.config.js`).

## Deployment Sepolia cũ (không tương thích sequence policy mới)

Deployment dưới đây chạy phiên bản high-water-mark cũ. Source hiện tại đã
chuyển sang exact sequence-use tracking và phải được deploy thành contract mới
trước E2E. Không dùng address cũ như thể bytecode đã được cập nhật tại chỗ.

| Mục | Giá trị |
|---|---|
| Address | [`0x4E6e20bC0601CddD6Cb0C3AE8440e6933839A8Aa`](https://sepolia.etherscan.io/address/0x4E6e20bC0601CddD6Cb0C3AE8440e6933839A8Aa#code) (source verified) |
| Chain ID | `11155111` |
| Deploy tx | `0x1b08b01b8a1b006e1d0a2311efc21551a47719e9b6c12bb68df50508c055a9ac` (block `11791714`) |
| EIP-712 domain | `AirSafetyLog` / `1` / `11155111` / address ở trên |
| Admin, relayer, device manager | `0x7Ee5fAD36702a5228E60D8CDE6Be3FE91f5B1a3F` (ví test, tạm thời) |

Chi tiết deployment cũ: [`deployments/sepolia.v1-highwater.json`](deployments/sepolia.v1-highwater.json). Deployment này chạy bytecode cũ (high-water-mark sequence) và chỉ còn là legacy domain; cần deploy lại (E2E_FIX_PLAN.md giai đoạn 2).
Sau khi deploy source hiện tại, firmware (Task 1) và backend (Task 3) phải được
chuyển cùng lúc sang address mới. Vector dùng `0xCccc…` chỉ để test. ABI của
source hiện tại nằm tại [`abi/AirSafetyLog.json`](abi/AirSafetyLog.json).

## Role

| Role | Ai giữ | Quyền |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | ví vận hành/multisig (`ADMIN_ADDRESS`) | cấp/thu role, `setCriticalPolicyEnabled` |
| `DEVICE_MANAGER_ROLE` | ví provisioning | `registerDevice`, `rotateSigner`, `revokeDevice`, `setDeviceOwner` |
| `RELAYER_ROLE` | relayer wallet của backend | `logIncident` |
| `ownerAddress` của device | ví người dùng (MetaMask qua dApp web3) | `acknowledgeIncident`, `resolveIncident` |

Admin, manager và relayer **không** thể acknowledge/resolve.

Quản lý role trên mạng đã deploy (gửi từ ví admin trong `DEPLOYER_PRIVATE_KEY`):

```bash
npm run roles:sepolia                                            # xem ai giữ role nào
npx hardhat roles --network sepolia --action grant  --role RELAYER_ROLE --account 0x...
npx hardhat roles --network sepolia --action revoke --role RELAYER_ROLE --account 0x...
```

Hiện một ví test giữ cả ba role. Trước khi chạy worker (Task 4), backend phải có
ví relayer riêng: admin `grant RELAYER_ROLE` cho ví đó rồi `revoke RELAYER_ROLE`
(và `DEVICE_MANAGER_ROLE` nếu tách) khỏi ví admin. Khóa relayer chỉ nằm trong
secret của backend; ví admin không bao giờ đặt trên server.

## Quy tắc on-chain

`logIncident(IncidentClaim claim, bytes signature)`:

1. Device phải đã đăng ký và `active` (revoked → `DeviceNotActive`).
2. `severity` ∈ {1 warning, 2 danger}; 3 critical chỉ khi admin bật
   `criticalPolicyEnabled` và khi đó phát thêm `EmergencyTriggered`.
   MVP để tắt.
3. `evidenceHash != 0`; `incidentId == keccak256(abi.encodePacked("AIR-INCIDENT-2", deviceIdHash, uint64 sequence))`.
4. Recover EIP-712 `IncidentAttestation` (domain `AirSafetyLog`/`1`/chain ID/
   address contract), chữ ký 65 byte `r||s||v`, `v` 27/28, `s` low-half; signer
   phải là signer hiện tại của device.
5. Chống replay bằng `incidentKey = keccak256(abi.encode(deviceIdHash, incidentId))`.
6. `sequence` bắt đầu từ 1; 0 được dành riêng và bị từ chối. Mỗi sequence chỉ
   được dùng một lần cho một device. Sequence hợp lệ chưa dùng vẫn được nhận
   khi đến lệch thứ tự (ví dụ 4 rồi 3). `lastSequence` chỉ là metadata sequence
   lớn nhất đã thấy, không phải điều kiện từ chối.

Lưu `Incident { deviceIdHash, incidentId, evidenceHash, sequence, observedAt,
loggedAt, severity, status, signer }`; trạng thái `Logged → Acknowledged →
Resolved` (owner có thể resolve thẳng từ `Logged`).

Vòng đời device:

- `registerDevice(deviceIdHash, signer, owner)` — `deviceIdHash = keccak256(utf8(device_id))`.
- `rotateSigner` — chỉ thực hiện sau khi firmware flush queue; incident ký bằng
  khóa cũ chưa lên chain sẽ bị từ chối (`WrongSigner`).
- Wi-Fi reset/factory reset thông thường **không** revoke signer: Task 1 giữ
  signer, sequence và queue trong encrypted NVS.
- `revokeDevice` — thao tác bảo mật tường minh khi lộ khóa, nghỉ thiết bị hoặc
  decommission. Dùng lại phải `registerDevice` với signer **mới**: mỗi địa chỉ
  signer chỉ được gắn một lần (`SignerAlreadyUsed`). Lịch sử sequence đã dùng
  được giữ; sequence chưa dùng vẫn hợp lệ dù thấp hơn `lastSequence`.

## Event (cho indexer Task 4)

```solidity
IncidentLogged(bytes32 indexed incidentKey, bytes32 indexed deviceIdHash, bytes32 indexed incidentId,
               uint64 sequence, uint64 observedAt, uint8 severity, bytes32 evidenceHash, address signer)
IncidentAcknowledged(bytes32 indexed incidentKey, bytes32 indexed deviceIdHash, address indexed owner)
IncidentResolved(bytes32 indexed incidentKey, bytes32 indexed deviceIdHash, address indexed owner)
EmergencyTriggered(bytes32 indexed incidentKey, bytes32 indexed deviceIdHash, uint64 observedAt)
DeviceRegistered / DeviceSignerRotated / DeviceRevoked / DeviceOwnerChanged / CriticalPolicyChanged
```

## Helper view/pure cho backend & dApp

`hashEvidence(IncidentEvidence)`, `hashAttestation(IncidentClaim)`,
`attestationDigest(IncidentClaim)`, `computeIncidentId`, `computeIncidentKey`,
`domainSeparator()`, `eip712Domain()`, `getDevice`, `getIncident`, `signerUsed`.

Relayer nên `staticCall` `logIncident` trước khi gửi để phân loại revert (custom
error) và kiểm tra `getIncident(incidentKey).status != 0` trước mỗi lần retry.

## Test vector

`test/vectors.test.js` dùng hai file trong `docs/test-vectors/`: tính lại
device/firmware/calibration hash, incident ID, evidence hash, digest, signer;
đặt bytecode contract tại `verifying_contract` của vector (chain ID local
11155111) để `logIncident` chấp nhận đúng chữ ký vector; và kiểm tra sửa bất kỳ
field evidence/attestation/mask nào đều làm verify thất bại.

## Incentives: token ASAFE thưởng/phạt (Task 6)

Luật đầy đủ: [`Token_incentive_task.md`](../Token_incentive_task.md). Hai contract
mới **chỉ đọc** `AirSafetyLog` qua `getIncident`/`getDevice`
([`IAirSafetyLogView.sol`](contracts/IAirSafetyLogView.sol)); `AirSafetyLog`,
domain EIP-712 và firmware không đổi.

```text
contracts/AirSafeToken.sol        ERC-20 ASAFE, mint 1 000 000 một lần cho Treasury, không mint/burn/pause
contracts/SafetyIncentives.sol    Stake, R1/R2 thưởng, P1/P2 phạt (permissionless), AccessControl + ReentrancyGuard + SafeERC20
contracts/test/ReentrantToken.sol Token giả có hook, chỉ dùng trong test reentrancy
test/incentives.test.js           Unit: từng luật, đúng hạn/trễ 1 s/gọi 2 lần, stake, đổi owner, quỹ cạn, reentrancy
test/incentives.scenario.test.js  Kịch bản một ngày (08:00 → cuối ngày), khớp mọi số dư bảng tổng kết
scripts/deploy-incentives.js      Deploy + ghi deployments/<network>.incentives.json + abi/{AirSafeToken,SafetyIncentives}.json
scripts/fund-incentives.js        Treasury nạp quỹ thưởng (50 000) và ký quỹ operator (1 000); chạy lại an toàn
scripts/verify-incentives.js      Verify cả hai contract trên Etherscan
```

### Lệnh

```bash
npm test && npm run coverage                 # SafetyIncentives: 100% dòng

# Local (sau `npx hardhat node` và `npm run deploy:localhost`)
npm run deploy:incentives:localhost
npm run fund:incentives:localhost

# Sepolia (blockchain/.env có DEPLOYER_PRIVATE_KEY của ví admin = Treasury)
npm run deploy:incentives:sepolia            # operator mặc định = RELAYER_ROLE trong deployments/sepolia.json
npm run fund:incentives:sepolia
npm run verify:incentives:sepolia
node ../spec/incident/gen/gen-all.mjs        # sinh server/api/src/generated/incentives-deployments.js
```

Commit `deployments/<network>.incentives.json`, `abi/` và module đã sinh trong cùng một commit.

### Luật trên chain

| Luật | Hàm (ai cũng gọi) | Điều kiện | Kết quả |
|---|---|---|---|
| R1 | `recordTimelyAck(key)` | `status ∈ {Acknowledged, Resolved}`, `now ≤ loggedAt + ackDeadline[severity]` | Đặt `TIMELY_ACK`; trả `ackReward` nếu stake hợp lệ, chưa đạt trần ngày và quỹ đủ, ngược lại `RewardSkipped` (không revert) |
| R2 | `recordTimelyResolve(key)` | Đã `TIMELY_ACK`, `status == Resolved`, `now ≤ loggedAt + resolveDeadline` | Trả `resolveReward` chỉ khi R1 đã **trả thưởng** (trong trần) |
| P1 | `slashMissedAck(key)` | `now > loggedAt + ackDeadline`, chưa `TIMELY_ACK` | Trừ `missedAckPenalty` vào stake device, chia `keeperShareBps` cho người gọi, còn lại cho Treasury |
| P2 | `slashLateRelay(key)` | `loggedAt − observedAt > maxRelayDelay` | Trừ `lateRelayPenalty` vào stake operator, chia như P1 |

Hạn ack: warning (1) 30 phút, danger/critical (≥ 2) 10 phút, tính từ `loggedAt`.
Mỗi luật chạy một lần cho mỗi incident (`settlementFlags`: `TIMELY_ACK=1`,
`ACK_REWARDED=2`, `RESOLVE_SETTLED=4`, `ACK_SLASHED=8`, `RELAY_SLASHED=16`).
Ngày của trần thưởng là `block.timestamp / 1 days` (UTC), chỉ đếm lần R1 thật sự trả tiền.

Các quyết định thiết kế cần biết:

- **Quỹ thưởng tách khỏi tiền ký quỹ:** `rewardFund() = balanceOf(this) − totalBonded`.
  Quỹ cạn chỉ phát `RewardSkipped(reason=InsufficientFund)`; ack vẫn được ghi nhận
  nên owner không bị phạt.
- **Điều kiện được thưởng:** stake phải thuộc owner hiện tại, không đang chờ rút và
  còn ≥ `missedAckPenalty` (đủ chịu một lần phạt). `ownerBond` (100) là mức tối
  thiểu **khi nạp** stake. Spec ghi "stake ≥ OWNER_BOND" nhưng bảng kịch bản vẫn
  thưởng #3, #4 khi stake còn 80, nên contract theo bảng kịch bản.
- **Không phạt hồi tố:** chỉ xét incident có `loggedAt ≥ activatedAt` (thời điểm
  deploy, nếu không thì `IncidentNotCovered`), và stake của device chỉ chịu incident có
  `loggedAt ≥ bond.since` (lúc bắt đầu stake). Các incident Sepolia cũ (sequence 6–9)
  vì vậy không bị phạt.
- **Đổi owner:** stake cũ vẫn thuộc người đã stake và không chịu phạt cho owner mới;
  owner mới chỉ stake được sau khi stake cũ đã rút (`BondHeldByOther`).
- **Stake thêm** khi đang chờ rút sẽ hủy yêu cầu rút. Trong thời gian chờ, stake vẫn bị phạt được nhưng không được thưởng.
- **Operator bond:** ai cũng nạp được (`depositOperatorBond`), chỉ `operator` rút;
  `setOperator` chuyển stake sang operator mới và hủy yêu cầu rút đang chờ.

### Event (cho indexer Task 7)

```solidity
Staked(bytes32 indexed deviceIdHash, address indexed staker, uint256 amount, uint256 total)
UnstakeRequested(bytes32 indexed deviceIdHash, address indexed staker, uint64 availableAt)
Withdrawn(bytes32 indexed deviceIdHash, address indexed staker, uint256 amount)
  // deviceIdHash = 0x00…00 (OPERATOR_BOND_ID) là stake của operator
AckRewarded(bytes32 indexed incidentKey, address indexed owner, uint256 amount)
ResolveRewarded(bytes32 indexed incidentKey, address indexed owner, uint256 amount)
RewardSkipped(bytes32 indexed incidentKey, address indexed owner, uint8 rule, SkipReason reason)
  // rule 1 = R1, 2 = R2; reason 0 DailyCap, 1 InsufficientFund, 2 NoBond, 3 AckNotRewarded
MissedAckSlashed(bytes32 indexed incidentKey, bytes32 indexed deviceIdHash, uint256 amount, address indexed keeper)
LateRelaySlashed(bytes32 indexed incidentKey, uint64 delaySeconds, uint256 amount, address indexed keeper)
BondExhausted(bytes32 indexed deviceIdHash)
RewardsFunded / ParamsUpdated(Params) / OperatorChanged / TreasuryChanged
```

View cho dApp và keeper: `pendingSettlement(key)` (không revert; trả hạn chót, cờ và
`canRecordAck/canRecordResolve/canSlashMissedAck/canSlashLateRelay`), `params()`,
`deviceBond(h)`, `operatorBond()`, `rewardFund()`, `rewardsToday(h, day)`, `currentDay()`.

Custom error: `AckDeadlinePassed`, `AckDeadlineNotPassed`, `ResolveDeadlinePassed`,
`AlreadySettled`, `NotAcknowledged`, `NotResolved`, `NotDeviceOwner`, `NotStaker`,
`NotOperator`, `BondTooLow`, `BondHeldByOther`, `RelayNotLate`, `CooldownActive`,
`NoUnstakeRequest`, `UnstakeAlreadyRequested`, `IncidentNotFound`, `IncidentNotCovered`,
`DeviceNotFound`, `InvalidParams`, `ZeroAmount`, `ZeroAddress`.

### Deployment Sepolia

Chưa deploy. Sau khi chạy các lệnh ở trên, ghi address tại đây
(nguồn: [`deployments/sepolia.incentives.json`](deployments/)).
