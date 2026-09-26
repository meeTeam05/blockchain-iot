# Blockchain incident test vectors

Schema v2 là schema duy nhất và dùng hai vector bắt buộc:

| File | Tình huống cần chứng minh |
|---|---|
| `incident-v2-model-early-warning.json` | CO vào `EARLY_WARNING` do model; cả hai model probability hợp lệ. |
| `incident-v2-qcvn-exceeded.json` | CO vào `EXCEEDED` do luật QCVN trong khi model không có output. |

Các private key trong vector là khóa Hardhat công khai, chỉ dành cho test.
Không dùng chúng trong firmware, backend, ví hoặc môi trường deploy.

Mỗi implementation phải tính lại hash định danh, `calibration_hash` (SHA-256),
`evidence_hash` (Keccak-256 ABI encoding), EIP-712 digest và signer. Test phải
fail khi sửa một evidence field, attestation field, source mask hoặc valid mask.
