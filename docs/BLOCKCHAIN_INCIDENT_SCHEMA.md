# Blockchain Incident Schema v2

Schema này là hợp đồng hiện hành duy nhất giữa firmware, backend, smart
contract và app cho incident từ AI Gas EWS. Mọi incident mới phải dùng Schema
v2 và các test vector v2 đi kèm.

Mục tiêu là chứng minh một thiết bị đã ký snapshot cảnh báo cụ thể. Blockchain
chỉ lưu `evidenceHash` cùng claim tối thiểu; payload đầy đủ nằm ở TimescaleDB.
Hash không được tính từ chuỗi JSON và evidence không có `float`/`NaN`.

## 1. Quy ước chung

- `device_id` là MAC Wi-Fi STA viết thường, ví dụ `aa:bb:cc:dd:ee:ff`.
- `sequence` và `observed_at` là chuỗi thập phân `uint64` trong JSON; không có
  số 0 đứng đầu trừ `"0"`.
- Mọi `bytes32` JSON là hex thường, có `0x` và đúng 64 chữ số hex.
- Giá trị ppm dùng thang `ppm × 1000`; xác suất model dùng `bps = round(p ×
  10000)`, trong khoảng `0..10000`.
- Derived value không có dữ liệu được ghi `0` và clear bit tương ứng trong
  `derivedValidMask`. Model không có output được ghi xác suất `0` và clear bit
  tương ứng trong `modelProbabilityValidMask`.
- `modelSha256` là SHA-256 của nguyên file `.tflite` nhúng; `calibrationHash`
  là SHA-256 của canonical calibration string. Các hash định danh khác dùng
  Keccak-256 như nêu dưới đây.

## 2. Enum và mask

| Field | Giá trị | Ý nghĩa |
|---|---:|---|
| `timeSource` | 1 | SNTP đã đồng bộ |
|  | 2 | DS3231 RTC hợp lệ |
| `sensorValidMask` bit 0..3 | T / RH / CO / NO2 | Giá trị raw tại snapshot hợp lệ |
| `detectionMethod` | 2 | `GAS_EWS_HYBRID` (luật QCVN, projection và model) |
| `overallLevel`, `coLevel`, `no2Level` | 0 | `SAFE` / `an_toan` |
|  | 1 | `EARLY_WARNING` / `canh_bao_som` |
|  | 2 | `EXCEEDED` / `vuot_nguong` |
| `coAlarmSourceMask`, `no2AlarmSourceMask` bit 0 | QCVN rule (STEL hoặc TWA) |
|  | bit 1 | projection 10 phút |
|  | bit 2 | model TFLite |
| `derivedValidMask` bit 0..5 | CO STEL, NO2 STEL, CO TWA, NO2 TWA, CO projection, NO2 projection |
| `modelProbabilityValidMask` bit 0..1 | CO model output, NO2 model output |
| `incidentKind` | 1 | `EARLY_WARNING_ENTERED` |
|  | 2 | `THRESHOLD_EXCEEDED_ENTERED` |
| `severity` | 1 | `warning` |
|  | 2 | `danger` |
|  | 3 | `critical` (chỉ khi có policy riêng) |

Incident v2 hợp lệ khi `timeSource` là 1 hoặc 2, `detectionMethod == 2`,
`overallLevel` là 1 hoặc 2, trigger gas có bit valid và `incidentKind` phù hợp
level. Mapping chuẩn hiện tại là EARLY_WARNING → warning và EXCEEDED → danger.

## 3. Khi nào tạo incident

Firmware tạo đúng một incident mới khi level chung tăng:

```text
SAFE -> EARLY_WARNING       incidentKind = 1
SAFE -> EXCEEDED            incidentKind = 2
EARLY_WARNING -> EXCEEDED   incidentKind = 2
```

Không tạo incident từ heartbeat `ai/state`, khi level giữ nguyên/giảm, trong
warmup, hoặc chỉ vì một output model cũ còn tồn tại. Còi/an toàn cục bộ luôn
xảy ra trước signing, MQTT hoặc blockchain.

## 4. Canonical evidence

`evidenceHash` là EIP-712 struct hash, không có domain:

```solidity
IncidentEvidence(
    uint16 schemaVersion,
    bytes32 deviceIdHash,
    bytes32 incidentId,
    uint64 sequence,
    uint64 observedAt,
    uint8 timeSource,
    uint8 sensorValidMask,
    uint8 detectionMethod,
    int32 temperatureCx100,
    uint16 humidityPctX100,
    uint32 coPpmX1000,
    uint32 no2PpmX1000,
    uint8 overallLevel,
    uint8 coLevel,
    uint8 no2Level,
    uint8 coAlarmSourceMask,
    uint8 no2AlarmSourceMask,
    uint8 derivedValidMask,
    uint32 coStel15PpmX1000,
    uint32 no2Stel15PpmX1000,
    uint32 coTwa8hPpmX1000,
    uint32 no2Twa8hPpmX1000,
    uint32 coProj10PpmX1000,
    uint32 no2Proj10PpmX1000,
    uint8 modelProbabilityValidMask,
    uint16 coModelProbabilityBps,
    uint16 no2ModelProbabilityBps,
    uint8 incidentKind,
    uint8 severity,
    bytes32 firmwareVersionHash,
    bytes32 modelSha256,
    uint32 calibrationRevision,
    bytes32 calibrationHash
)
```

Chuỗi type chính xác là:

```text
IncidentEvidence(uint16 schemaVersion,bytes32 deviceIdHash,bytes32 incidentId,uint64 sequence,uint64 observedAt,uint8 timeSource,uint8 sensorValidMask,uint8 detectionMethod,int32 temperatureCx100,uint16 humidityPctX100,uint32 coPpmX1000,uint32 no2PpmX1000,uint8 overallLevel,uint8 coLevel,uint8 no2Level,uint8 coAlarmSourceMask,uint8 no2AlarmSourceMask,uint8 derivedValidMask,uint32 coStel15PpmX1000,uint32 no2Stel15PpmX1000,uint32 coTwa8hPpmX1000,uint32 no2Twa8hPpmX1000,uint32 coProj10PpmX1000,uint32 no2Proj10PpmX1000,uint8 modelProbabilityValidMask,uint16 coModelProbabilityBps,uint16 no2ModelProbabilityBps,uint8 incidentKind,uint8 severity,bytes32 firmwareVersionHash,bytes32 modelSha256,uint32 calibrationRevision,bytes32 calibrationHash)
```

```text
EVIDENCE_TYPEHASH = keccak256(UTF-8 type string)
evidenceHash = keccak256(abi.encode(EVIDENCE_TYPEHASH, every field in order))
```

Phải dùng `abi.encode`, không dùng `abi.encodePacked`; `temperatureCx100` phải
được sign-extend như `int32` ABI. Field `modelProbabilityValidMask` ngăn việc
diễn giải `0 bps` là xác suất model bằng 0 khi model thực tế chưa chạy.

## 5. Incident ID, attestation và chữ ký

V2 dùng prefix riêng để không trùng ID với v1:

```solidity
incidentId = keccak256(
    abi.encodePacked("AIR-INCIDENT-2", deviceIdHash, uint64(sequence))
)
```

Attestation và EIP-712 domain giữ nguyên vì `evidenceHash` đã commit toàn bộ
field v2:

```solidity
IncidentAttestation(
    bytes32 deviceIdHash,
    bytes32 incidentId,
    uint64 sequence,
    uint64 observedAt,
    uint8 severity,
    bytes32 evidenceHash
)
```

```text
IncidentAttestation(bytes32 deviceIdHash,bytes32 incidentId,uint64 sequence,uint64 observedAt,uint8 severity,bytes32 evidenceHash)
digest = keccak256("\\x19\\x01" || domainSeparator || attestationStructHash)
```

Domain Sepolia hiện tại vẫn là `AirSafetyLog`, version `1`, chain ID `11155111`
và địa chỉ contract đã provision. Nếu ABI/attestation của contract thay đổi,
phải deploy contract/domain version mới; không nhận domain qua MQTT.

Signature là secp256k1 `r || s || v` 65 byte, hex `0x`, `v` là 27 hoặc 28 và
`s` ở low-half. Không dùng EIP-191 prefix ngoài EIP-712 prefix.

## 6. MQTT transport, backend và chain

Topic giữ nguyên:

```text
device/{device_id}/incident
device/{device_id}/incident/ack
```

Payload transport dùng tên `snake_case` của mọi field evidence, thêm
`device_id`, `firmware_version`, `evidence_hash`, `signature`; không có field
nào khác. Firmware chỉ truyền `calibration_hash` đã ký trong evidence, không
truyền calibration canonical. Vì vậy backend xác minh calibration hash là một
phần của `evidence_hash` và chữ ký nhưng không thể tái tạo độc lập hash này từ
payload MQTT. Backend tự tính lại các hash định danh, evidence hash và digest
trước khi ACK. Backend chỉ nhận `timeSource` hợp lệ, `observedAt > 0`, và từ
chối timestamp ở tương lai quá 10 phút; incident hợp lệ đến muộn vẫn được nhận.

ACK là JSON QoS 1 với các field `schema_version`, `incident_id`,
`evidence_hash`, `accepted`, `error_code` (chuỗi rỗng khi accepted) và
`received_at` (chuỗi uint64 Unix giây). Mã lỗi và thứ tự xử lý: xem
`docs/MQTT_PROTOCOL.md` mục 3.8 và 4.4. Delivery có thể đến lệch thứ tự:
backend nhận mọi sequence hợp lệ chưa dùng, nhưng cùng `(device_id, sequence)`
không được đại diện cho hai incident khác nhau. Retry nguyên bytes của một
incident đã được lưu luôn nhận ACK thành công. `accepted:true` chỉ
xác nhận DB commit, không xác nhận transaction blockchain. Firmware chỉ xóa
queue khi `incident_id` và `evidence_hash` trong ACK khớp bản đã persist; ACK
không khớp hoặc `accepted:false` phải giữ record để retry/chẩn đoán.

`AirSafetyLog` có thể giữ `IncidentClaim` hiện tại (`deviceIdHash`,
`incidentId`, `sequence`, `observedAt`, `severity`, `evidenceHash`), vì chain
neo evidence hash thay vì sensor payload. `EmergencyTriggered` chỉ được phát
khi severity là critical theo policy đã chốt.

## 7. Test vectors và compatibility

- [`incident-v2-model-early-warning.json`](test-vectors/incident-v2-model-early-warning.json)
  chứng minh cảnh báo sớm CO do model.
- [`incident-v2-qcvn-exceeded.json`](test-vectors/incident-v2-qcvn-exceeded.json)
  chứng minh vượt QCVN do rule trong khi model không có output.

Firmware phải tính đúng device/incident/firmware/calibration hash; backend tính
lại các hash có preimage trên wire, evidence hash, EIP-712 digest, signer và
signature. Backend kiểm tra `calibration_hash` qua signed evidence nhưng không
thể tái tạo độc lập. Phải có test sửa một field evidence hoặc attestation làm
verify thất bại, và test source mask/valid mask không bị diễn giải sai.
