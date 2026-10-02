# Task 1 status audit

Audit date: 2026-09-27 (Asia/Ho_Chi_Minh)

## Executive summary

Verdict: **PRE-BOARD TASK 1 READY**.

All Task 1 requirements that can reasonably be verified without physical
hardware pass. Task 1 is deliberately **not** called complete: encrypted-NVS
operation, signer lifecycle on real flash, and broker-backed MQTT/reboot/ACK
behavior remain `BLOCKED_BY_BOARD`.

The requested paths `docs/Blockchain_task.md`, `docs/AI.md`,
`firmware/components/core/sa_mqtt`, and `firmware/Kconfig.projbuild` do not
exist in this checkout. Their actual authoritative locations are
`Blockchain_task.md`, `AI.md`, `firmware/components/general/sa_mqtt`, and
`firmware/main/Kconfig.projbuild`; those files were used for this audit.

## Capability status

| Requirement group | Status | Executed evidence |
|---|---|---|
| Component discovery, feature gate, disabled stubs | PASS | Clean disabled ESP32-S3 build linked `incident` with the feature unset; AI/Gas EWS also linked. |
| Transition eligibility, warmup/time/trigger validation | PASS | `test_incident_transitions.py`. |
| Local buzzer before incident submission | PASS | Transition ordering check and queue-full runtime instrumentation. |
| Snapshot, masks, firmware/model/calibration identities | PASS | Gas EWS regression, exact codec vectors, tamper/ABI matrix, enabled link; embedded model SHA-256 is `d1a789f1e6ad1e2b5225fb8ed78876b5ef348c2a81741e46c8fcb50c85048dcc`. |
| Durable sequence and persist-before-publish | PASS | `test_incident_persistence_retry.py`, including commit/power-loss injection. |
| Exact incidentId/evidenceHash/EIP-712 | PASS | Both production-code golden vectors and tamper/ABI suite. |
| Deterministic secp256k1, r/s/v, low-s, recovery | PASS | `test_incident_signatures.py`, exact across three processes plus negative cases. |
| Private-key guard and test-key isolation | PASS | Provisioning refuses non-encrypted NVS; repository scan finds the known test key only in designated fixtures. |
| Secure enabled build profile | PASS | `CONFIG_NVS_ENCRYPTION=y`, HMAC protection/key ID 5, secp256k1, contract Kconfig and incident feature all present in the clean enabled build. |
| Offline/reboot/exact-byte retry and corruption rejection | PASS | `test_incident_persistence_retry.py`. |
| Strict ACK lifecycle | PASS | `test_incident_ack_matrix.py`, including malformed, mismatch, duplicate and erase-commit failure cases. |
| Bounded work/persistent queues and full safety | PASS | `test_incident_queue_full.py`, capacities 4 and 2. |
| Signer provision/inspect/rotate/revoke and factory reset implementation | PASS | Source/API audit plus clean secure link; rotation requires an empty queue, factory reset preserves `incidentv2`, and explicit revoke deletes the signer. Runtime encrypted-flash behavior is board-only. |
| MQTT incident/ACK integration and QoS 1 | PASS | Production route/registration checks plus persistence, retry and ACK host instrumentation. Real broker transport is board-only. |
| AI model and decision behavior unchanged | PASS | `.tflite` unchanged; diff changes only incident snapshot metadata/model hashing and dispatch integration; Gas EWS golden regression passes. |
| Feature-enabled and feature-disabled builds | PASS | Both clean builds completed and produced `smart-air.bin` and `compile_commands.json`. |
| Documentation and repository hygiene | PASS | `git diff --check` clean; generated builds/sdkconfig and host logs ignored; no machine-specific absolute path remains. |
| Encrypted NVS and MQTT end-to-end on ESP32-S3 | BLOCKED_BY_BOARD | Requires physical hardware and a real broker; see `TASK1_PRE_BOARD_AUDIT.md`. |

## Build status

Environment: ESP-IDF 5.4.2, target `esp32s3`.

| Profile | Result | Binary | Partition free |
|---|---|---:|---:|
| Default, incident disabled | PASS | `0x148d80` bytes | `0xb7280` bytes (36%) |
| Incident enabled, encrypted-NVS secure profile | PASS | `0x167a10` bytes | `0x985f0` bytes (30%) |

Both builds were run through `fullclean`, reconfigure and full build. The final
post-audit incident-only rebuild emitted no Task-1-specific warning. The
remaining `-Wshadow` messages in the clean build come from the pinned managed
TFLite dependency.

## Final status

Host-verifiable requirements: **43 / 43 PASS**.

Task 1 remains incomplete until the board-only checklist in
`docs/TASK1_PRE_BOARD_AUDIT.md` is executed with retained evidence.
