# Blockchain incident test vectors

Schema v2 là schema duy nhất và dùng hai vector bắt buộc:

| File | Tình huống cần chứng minh |
|---|---|
| `incident-v2-model-early-warning.json` | CO vào `EARLY_WARNING` do model; cả hai model probability hợp lệ. |
| `incident-v2-qcvn-exceeded.json` | CO vào `EXCEEDED` do luật QCVN trong khi model không có output. |

Các private key trong vector là khóa Hardhat công khai, chỉ dành cho test.
Không dùng chúng trong firmware, backend, ví hoặc môi trường deploy.

`transport.calibration_canonical` trong vector chỉ là dữ liệu nguồn để chứng
minh cách firmware tạo `calibration_hash`; nó không phải field MQTT Schema v2.
Backend nhận `calibration_hash` bên trong signed evidence nên không thể tái tạo
độc lập hash đó từ payload. Mỗi implementation phải tính lại hash định danh,
`evidence_hash` (Keccak-256 ABI encoding), EIP-712 digest và signer. Test phải
fail khi sửa một evidence field, attestation field, source mask hoặc valid mask.
