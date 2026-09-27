# AirSafetyLog — smart contract (Task 2)

Contract Solidity neo incident Gas EWS đã được thiết bị ký lên Sepolia theo
[`docs/BLOCKCHAIN_INCIDENT_SCHEMA.md`](../docs/BLOCKCHAIN_INCIDENT_SCHEMA.md)
(Schema v2). Chain chỉ lưu claim tối thiểu + `evidenceHash`; evidence đầy đủ
nằm ở TimescaleDB.

```text
contracts/AirSafetyLog.sol    Contract (OpenZeppelin AccessControl + EIP712 + ECDSA)
test/                         Hardhat test: vector v2, tamper, signer, replay, role…
scripts/deploy.js             Deploy + ghi deployments/<network>.json + ABI
scripts/verify.js             Verify source trên Etherscan
abi/AirSafetyLog.json         ABI bàn giao cho backend (Task 3/4) và app (Task 5)
deployments/sepolia.json      Address, chain ID, tx deploy, block, domain (sau khi deploy)
```

## Lệnh

```bash
cd blockchain
npm ci
npm test                 # toàn bộ Hardhat test (chain ID local = 11155111)
npm run export-abi       # sau compile, cập nhật abi/AirSafetyLog.json

cp .env.example .env     # điền SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, ETHERSCAN_API_KEY…
                         # hardhat.config.js tự đọc .env (dotenv), không cần source
npm run deploy:sepolia   # ghi deployments/sepolia.json + abi/
npm run verify:sepolia   # verify source, đánh dấu "verified": true
```

Khuyến nghị Node 22 LTS. Trên Node 24/Windows, Hardhat 2 có thể in
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` lúc thoát; lỗi này xảy
ra sau khi lệnh đã chạy xong và có thể bỏ qua.

Compiler: solc `0.8.28`, optimizer 200 runs, `viaIR: true`, EVM `cancun`
(verify phải dùng đúng cấu hình này — `scripts/verify.js` lấy từ
`hardhat.config.js`).

## Deployment Sepolia hiện hành

| Mục | Giá trị |
|---|---|
| Address | [`0x4E6e20bC0601CddD6Cb0C3AE8440e6933839A8Aa`](https://sepolia.etherscan.io/address/0x4E6e20bC0601CddD6Cb0C3AE8440e6933839A8Aa#code) (source verified) |
| Chain ID | `11155111` |
| Deploy tx | `0x1b08b01b8a1b006e1d0a2311efc21551a47719e9b6c12bb68df50508c055a9ac` (block `11791714`) |
| EIP-712 domain | `AirSafetyLog` / `1` / `11155111` / address ở trên |
| Admin, relayer, device manager | `0x7Ee5fAD36702a5228E60D8CDE6Be3FE91f5B1a3F` (ví test, tạm thời) |

Chi tiết đầy đủ: [`deployments/sepolia.json`](deployments/sepolia.json); ABI:
[`abi/AirSafetyLog.json`](abi/AirSafetyLog.json). Firmware (Task 1) và backend
(Task 3) phải ký/verify digest với `verifyingContract` là address này — vector
dùng `0xCccc…` chỉ để test.

## Role

| Role | Ai giữ | Quyền |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | ví vận hành/multisig (`ADMIN_ADDRESS`) | cấp/thu role, `setCriticalPolicyEnabled` |
| `DEVICE_MANAGER_ROLE` | ví provisioning | `registerDevice`, `rotateSigner`, `revokeDevice`, `setDeviceOwner` |
| `RELAYER_ROLE` | relayer wallet của backend | `logIncident` |
| `ownerAddress` của device | ví người dùng (app) | `acknowledgeIncident`, `resolveIncident` |

Admin, manager và relayer **không** thể acknowledge/resolve.

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
6. `sequence` phải **lớn hơn** `lastSequence` của device (cho phép khoảng trống,
   sequence đầu tiên có thể là 0).

Lưu `Incident { deviceIdHash, incidentId, evidenceHash, sequence, observedAt,
loggedAt, severity, status, signer }`; trạng thái `Logged → Acknowledged →
Resolved` (owner có thể resolve thẳng từ `Logged`).

Vòng đời device:

- `registerDevice(deviceIdHash, signer, owner)` — `deviceIdHash = keccak256(utf8(device_id))`.
- `rotateSigner` — chỉ thực hiện sau khi firmware flush queue; incident ký bằng
  khóa cũ chưa lên chain sẽ bị từ chối (`WrongSigner`).
- `revokeDevice` — factory reset/lộ khóa. Dùng lại phải `registerDevice` với
  signer **mới**: mỗi địa chỉ signer chỉ được gắn một lần (`SignerAlreadyUsed`).
  `lastSequence` được giữ, nên firmware sau reset phải tiếp tục từ sequence lớn
  hơn `getDevice(deviceIdHash).lastSequence`.

## Event (cho indexer Task 4)

```solidity
IncidentLogged(bytes32 indexed incidentKey, bytes32 indexed deviceIdHash, bytes32 indexed incidentId,
               uint64 sequence, uint64 observedAt, uint8 severity, bytes32 evidenceHash, address signer)
IncidentAcknowledged(bytes32 indexed incidentKey, bytes32 indexed deviceIdHash, address indexed owner)
IncidentResolved(bytes32 indexed incidentKey, bytes32 indexed deviceIdHash, address indexed owner)
EmergencyTriggered(bytes32 indexed incidentKey, bytes32 indexed deviceIdHash, uint64 observedAt)
DeviceRegistered / DeviceSignerRotated / DeviceRevoked / DeviceOwnerChanged / CriticalPolicyChanged
```

## Helper view/pure cho backend & app

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
