# Task 1 Final Handoff — Blockchain Incident Firmware

## 1. Task 1 Objective

Task 1 adds the ESP32-S3 side of Blockchain Incident Schema v2. After Gas EWS raises the overall severity, firmware captures one canonical snapshot, assigns a durable sequence, derives the incident and evidence hashes, signs an EIP-712 attestation with the device secp256k1 signer, persists the complete transport record, and publishes it through MQTT QoS 1.

Task 1 owns firmware incident creation, signing, local persistence, retry, ACK-controlled deletion, signer lifecycle APIs, test-only replay/bench support, and the least-privilege MQTT ACL additions needed to transport incidents.

Task 1 does not implement or deploy a smart contract, verify or persist incidents in the backend, submit Sepolia transactions, operate a relayer/outbox/indexer, or provide incident UI. Those are downstream Task 2–5 responsibilities.

## 2. Final Architecture After Task 1

```text
Gas EWS
  -> upward severity transition
  -> local buzzer action
  -> immutable incident snapshot copied to bounded worker queue
  -> persistent uint64 sequence allocation
  -> deviceIdHash + incidentId + evidenceHash
  -> EIP-712 secp256k1 signature
  -> complete signed JSON persisted in encrypted default NVS
  -> device/{deviceId}/incident, MQTT QoS 1, retain=false
  -> application ACK on device/{deviceId}/incident/ack
  -> delete and commit only the exact acknowledged NVS record
```

The alarm dispatch calls the buzzer before submitting incident work. Signing, NVS, and MQTT therefore do not block or roll back the local safety action. Pending records are loaded from NVS and retried using the stored JSON bytes; retry does not allocate a sequence, recompute a timestamp, or re-sign.

## 3. Security Model

- Signer storage: a caller-provided 32-byte secp256k1 private scalar, stored as the `signer` blob in default-NVS namespace `incidentv2`.
- Signer creation: firmware does not generate a signer. The test/operator UART provisioner imports one explicit 64-hex-character scalar through `incident_provision_signer()`.
- NVS protection: signer provisioning is compiled to return `ESP_ERR_NOT_SUPPORTED` unless `CONFIG_NVS_ENCRYPTION=y`.
- Secure profile: `sdkconfig.incident` enables NVS encryption, HMAC-backed NVS key protection, and `CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID=5`. The configuration is verified; the actual eFuse state cannot be inferred from the repository.
- Lifecycle APIs: provision, inspect public address, rotate, and explicitly revoke are declared in `incident.h` and implemented in `incident.c`.
- Rotation intent: rotation is allowed only with no pending records. The current implementation uses `find_empty()!=0` as its guard; this should be reviewed before relying on rotation after ACK-created queue holes because it is not an explicit full-queue-empty scan.
- Factory reset: GPIO0/BOOT is held for `CONFIG_SA_FACTORY_RESET_HOLD_MS`; reset blocks NVS writers, stops MQTT, erases only `wifi_prov` and `device`, then reboots. It preserves `incidentv2` and the separate `calib` partition.
- Startup recovery: when blockchain incidents are enabled, default-NVS `NO_FREE_PAGES` or `NEW_VERSION_FOUND` recovery refuses automatic whole-partition erase, protecting the signer and queued incidents.
- Secrets: production code contains no private-key literal and zeroizes loaded/imported key buffers. Private keys and EIP-712 digests must not be logged. Never put signer material, MQTT credentials, NVS encryption keys, or HMAC secrets in source, logs, chat, or this document.

Source of truth: `firmware/components/core/incident/incident.c`, `firmware/components/general/factory_reset/factory_reset.c`, `firmware/components/config/config.c`, and `firmware/components/core/sysload/sysload.c`.

## 4. Incident Schema and Cryptography

- Schema: version `2`.
- Device identity: lowercase Wi-Fi STA MAC; `deviceIdHash = keccak256(device_id UTF-8)`.
- Sequence: persistent `uint64`, starting at 1; stored under `incidentv2/sequence`.
- Incident ID: `keccak256("AIR-INCIDENT-2" || deviceIdHash || uint64(sequence) big-endian)`.
- Evidence hash: EIP-712-style struct hash of the exact `IncidentEvidence(...)` field order in `incident.c` and `docs/BLOCKCHAIN_INCIDENT_SCHEMA.md`; it uses ABI 32-byte words, not JSON hashing or packed ABI. Signed `temperatureCx100` is sign-extended as `int32`.
- Attestation type: `IncidentAttestation(bytes32 deviceIdHash,bytes32 incidentId,uint64 sequence,uint64 observedAt,uint8 severity,bytes32 evidenceHash)`.
- EIP-712 domain: name `AirSafetyLog`, version `1`, chain ID `11155111` (Sepolia), and `CONFIG_SA_INCIDENT_VERIFYING_CONTRACT`.
- Current overlay contract value: `0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC`; it is a configured development/test value and must match the deployed Task 2 contract before production deployment.
- Signature: 65-byte `r || s || v`, encoded as `0x` plus 130 hex digits; `v` is 27 or 28 and `s` is normalized to the low half of the secp256k1 order.
- Firmware identity: Keccak-256 of `FIRMWARE_VERSION` (`0.1.1-gas-ews` in the current implementation).
- Model identity: SHA-256 of the exact embedded TFLite flatbuffer.
- Calibration identity: SHA-256 of `AIR-CAL-1|co_r0_q10000=...|no2_r0_q10000=...|revision=...`.

Do not change the type strings, field order, integer widths, domain, contract address, or derivations independently across firmware, backend, and contract.

## 5. AI-to-Incident Trigger

The single production gate accepts only:

- `SAFE -> EARLY_WARNING`
- `SAFE -> EXCEEDED`
- `EARLY_WARNING -> EXCEEDED`

It rejects same/decreasing levels, warmup, missing time provenance, zero timestamp, inconsistent overall level, and a transition without a valid trigger gas. `EARLY_WARNING` maps to kind/severity 1 (`warning`); `EXCEEDED` maps to kind/severity 2 (`danger`).

Task 1 did not change the TFLite model, feature formulas, thresholds, STEL/TWA/projection rules, or debounce semantics. It adds raw validity metadata, model hashing, snapshot conversion, and buzzer-first incident dispatch. The Gas EWS golden regression passes with zero mismatches.

Replay verification uses the existing AI replay boundary with scenario 0 at 60x. `sdkconfig.incident.bench` bypasses networking for physical offline diagnostics; `sdkconfig.incident.network-replay` retains normal BLE/Wi-Fi/MQTT behavior.

## 6. Persistence and Retry Guarantees

- `next_sequence()` commits the increment before returning it. A failure can create a gap, but the committed number is not reused.
- The persistent queue contains complete signed records in `incidentv2/q0` through the configured capacity (default 4).
- Each record includes magic, length, sequence, incident ID, evidence hash, signature, exact JSON payload, and a checksum.
- The complete record is committed before the first MQTT publish attempt.
- Startup/reconnect/periodic retry reloads the stored payload and publishes those exact bytes. It does not rebuild or re-sign the incident.
- Corrupt or incomplete records fail validation and are not published.
- The worker queue and NVS queue are bounded. A full queue does not overwrite an existing record, allocate another sequence, or undo the local alarm.
- Records remain durable after MQTT PUBACK. Only the application-level accepted ACK with the exact ID/hash pair deletes a record.

## 7. MQTT Integration

Device publishes, QoS 1 and non-retained:

```text
device/{deviceId}/incident
```

Device subscribes at QoS 1:

```text
device/{deviceId}/incident/ack
```

The EMQX ACL grants each device only its exact incident publish and ACK-subscribe topics. The backend bridge receives `device/+/incident` and may publish `device/+/incident/ack`; it does not grant devices `device/#` or `#`. Server startup refreshes rules for already-provisioned device IDs and clears the EMQX authorization cache.

This is transport/ACL support only. The current backend has no Task 3 incident intake handler, strict schema/signature verification, TimescaleDB incident persistence, or production ACK generation.

## 8. ACK Contract

Firmware requires a strict complete JSON object with these fields:

```json
{
  "schema_version": 2,
  "incident_id": "0x<64 lowercase hex digits>",
  "evidence_hash": "0x<64 lowercase hex digits>",
  "accepted": true,
  "error_code": "<string>",
  "received_at": "<string>"
}
```

- Malformed JSON, missing/extra trailing data, wrong types, wrong schema, invalid hex, or `accepted:false` returns an error and retains every record.
- A valid-shaped ACK with an unknown or mismatched ID/hash pair deletes nothing.
- Only a record matching both `incident_id` and `evidence_hash` is erased and committed.
- A duplicate ACK is harmless because the record is already absent.
- If erase commit fails, the record remains durable and can retry.

The firmware validates that `error_code` and `received_at` are strings but does not interpret their content.

## 9. Task 1 Verification Results

The host suites below were rerun on 2026-09-29. Build evidence comes from the current `build-incident-network-replay/` tree and prior Task 1 verification docs. No physical-board log remains in the repository, so board-only claims are not marked PASS here.

| Check | Status | Evidence |
|---|---|---|
| Host incident suites | PASS | All nine current Python suites completed successfully |
| Golden Schema-v2 vectors | PASS | `test_incident_vectors.py` |
| Exact signatures/recovery/low-s | PASS | `test_incident_signatures.py` |
| Tamper and ABI negatives | PASS | `test_incident_tamper_abi.py` |
| Transition matrix | PASS | `test_incident_transitions.py` |
| Persistence/reboot simulation | PASS | `test_incident_persistence_retry.py` |
| Strict ACK matrix | PASS | `test_incident_ack_matrix.py` |
| Queue-full boundaries | PASS | `test_incident_queue_full.py` |
| Signer provisioning parser/lifecycle bridge | PASS | `test_incident_signer_provision_bench.py` |
| Signer reset/startup policy | PASS | `test_signer_reset_policy.py` |
| Gas EWS regression | PASS | host golden run, zero field mismatches |
| Server incident ACL | PASS | 4/4 Node tests across the two EMQX ACL test files |
| Network-replay firmware build | PASS | current build contains `smart-air.bin`, ELF, compile database, and required generated config |
| Physical encrypted-NVS board test | NOT VERIFIED | no retained board log in current repository |
| Real MQTT connect/subscription | NOT VERIFIED | source/build and ACL tests exist; no retained broker/board log |
| Real incident publish | NOT VERIFIED | host persist/publish ordering passes; no retained broker capture |
| Physical reboot retry | NOT VERIFIED | host reboot simulation passes; no retained board log |
| Physical wrong-ACK retention | NOT VERIFIED | host ACK matrix passes; no retained board/backend log |
| Physical correct-ACK deletion | NOT VERIFIED | host ACK matrix passes; no retained board/backend log |
| Physical ACKed record absent after reboot | NOT VERIFIED | host lifecycle passes; no retained board log |

`git diff --check` is clean as of the handoff audit.

## 10. Files Added by Task 1

### Firmware production

- `firmware/components/core/incident/CMakeLists.txt` — incident component registration.
- `firmware/components/core/incident/incident.c` — codec, hashing, signing, queue, retry, ACK, and signer lifecycle.
- `firmware/components/core/incident/include/incident.h` — public incident API and snapshot contract.
- `firmware/components/core/ai/ai_alarm_dispatch.c` — buzzer-first incident dispatch.
- `firmware/components/core/ai/include/ai_alarm_dispatch.h` — dispatch interface.

### Firmware lifecycle/provisioning

- `firmware/components/core/incident/incident_signer_provision_bench.c` — test/operator UART signer importer.
- `firmware/components/core/incident/include/incident_signer_provision_bench.h` — provisioning bench interface.

### Tests/tools

- `firmware/components/core/incident/tools/incident_hash_cli.c`
- `firmware/components/core/incident/tools/incident_signature_cli.c`
- `firmware/components/core/incident/tools/incident_tamper_abi_cli.c`
- `firmware/components/core/incident/tools/incident_transition_cli.c`
- `firmware/components/core/incident/tools/incident_persistence_cli.c`
- `firmware/components/core/incident/tools/incident_ack_matrix_cli.c`
- `firmware/components/core/incident/tools/incident_queue_full_cli.c`
- `firmware/components/core/incident/tools/incident_signer_provision_bench_cli.c`
- `firmware/components/core/incident/tools/include/esp_err.h`
- `firmware/components/core/incident/tools/include/incident_persistence_shim.h`
- `firmware/components/core/incident/tools/test_incident_vectors.py`
- `firmware/components/core/incident/tools/test_incident_signatures.py`
- `firmware/components/core/incident/tools/test_incident_tamper_abi.py`
- `firmware/components/core/incident/tools/test_incident_transitions.py`
- `firmware/components/core/incident/tools/test_incident_persistence_retry.py`
- `firmware/components/core/incident/tools/test_incident_ack_matrix.py`
- `firmware/components/core/incident/tools/test_incident_queue_full.py`
- `firmware/components/core/incident/tools/test_incident_signer_provision_bench.py`
- `firmware/components/core/incident/tools/test_signer_reset_policy.py`
- `server/api/test/emqx-incident-acl.test.js` — least-privilege device ACL and startup-refresh regression.

### Config overlays

- `firmware/sdkconfig.incident` — secure incident base overlay.
- `firmware/sdkconfig.incident.bench` — offline replay bench overlay.
- `firmware/sdkconfig.incident.network-replay` — normal-network AI replay overlay.
- `firmware/sdkconfig.incident.signer-provision.bench` — UART signer-provisioning overlay.

### Protocol fixtures and documentation

- `docs/BLOCKCHAIN_INCIDENT_SCHEMA.md` and `docs/test-vectors/` — cross-layer Schema v2 contract and golden fixtures.
- `docs/BLOCKCHAIN_INCIDENT_FIRMWARE.md`
- `docs/TASK1_BLOCKCHAIN_FIRMWARE_VERIFICATION.md`
- `docs/TASK1_OFFLINE_BOARD_BENCH.md`
- `docs/TASK1_PRE_BOARD_AUDIT.md`
- `docs/TASK1_REPLAY_INCIDENT_AUDIT.md`
- `docs/TASK1_SIGNER_PROVISIONING_BENCH.md`
- `docs/TASK1_STATUS_AUDIT.md`
- `AI.md` and `Blockchain_task.md` — project/task planning committed when blockchain work began.

## 11. Existing Files Modified by Task 1

- `.gitignore` — ignores Task 1 build/config/log artifacts and the pre-existing `skills/` entry from the task-definition commit.
- `firmware/CMakeLists.txt` — discovers the incident component.
- `firmware/main/Kconfig.projbuild` — feature gate, queue/contract options, offline bench, provisioning bench, and reset help.
- `firmware/components/config/config.c` and `include/config.h` — incident feature macros, calibration identity snapshot/revision, and targeted provisioning reset.
- `firmware/components/core/ai/CMakeLists.txt` — builds dispatch and links incident/mbedTLS.
- `firmware/components/core/ai/ai.c` — constructs a canonical incident snapshot on upward transition.
- `firmware/components/core/ai/gas_ews.c` and `include/gas_ews.h` — exposes raw sample validity/temperature/humidity in status without changing decision rules.
- `firmware/components/core/ai/gas_ews_model.cpp` and `include/gas_ews_model.h` — exposes SHA-256 of embedded model bytes.
- `firmware/components/core/sysload/CMakeLists.txt` and `sysload.c` — initializes incident runtime, time provenance, MQTT ACK callback, offline bench, signer bench, and fail-closed NVS recovery.
- `firmware/components/general/factory_reset/factory_reset.c` — replaces whole-default-NVS erase with targeted provisioning reset.
- `firmware/components/general/sa_mqtt/include/mqtt.h` and `mqtt.c` — incident ACK callback, exact subscription topic, and payload routing.
- `docs/ARCHITECTURE_FIRMWARE.md` and `docs/MQTT_PROTOCOL.md` — document targeted reset and preserved blockchain state.
- `server/api/src/services/emqx.js` — exact device/bridge incident ACL rules and authorization refresh helper.
- `server/api/src/plugins/mqtt.js` — refreshes existing device authorizations at server startup.
- `server/api/test/emqx-bridge-ota-rule.test.js` — verifies bridge incident permissions and rejects broad wildcards.

## 12. Generated / Temporary Artifacts

- `firmware/build-incident-network-replay/` — ignored CMake/Ninja objects, libraries, bootloader, ELF, binary, maps, generated headers, and compile database; regenerable.
- `firmware/sdkconfig` — ignored generated/stale working config. It is not a source overlay and currently does not enable encrypted NVS.
- `firmware/managed_components/` — ignored dependency-manager output shared by firmware builds; regenerable from `dependencies.lock`.
- `server/api/node_modules/` — ignored installed Node dependencies; regenerable from `package-lock.json`.

No Task 1 `*.generated`, `*.old`, incident log, or Python cache artifact is currently present in the working tree. Ignored local server secrets and Docker data are not source-of-truth and were not inspected or attributed to Task 1.

## 13. Important Configuration Profiles

- `sdkconfig.defaults`: tracked normal project defaults. It remains the base for BLE, Wi-Fi, MQTT, sensors, and normal runtime behavior.
- `sdkconfig.incident`: secure incident overlay enabling AI, incident firmware, queue capacity 4, contract address, encrypted NVS/HMAC protection, and secp256k1 deterministic ECDSA.
- `sdkconfig.incident.bench`: test-only offline overlay enabling scenario 0 replay at 60x, buzzer, and network bypass.
- `sdkconfig.incident.network-replay`: test-only replay overlay that leaves offline bench and signer-provisioning bench disabled, preserving normal BLE/Wi-Fi/MQTT.
- `sdkconfig.incident.signer-provision.bench`: adds the UART signer provisioner. Existing documentation combines it with the offline bench overlay for controlled board provisioning.

Always generate a profile-specific `sdkconfig.*.generated`; do not treat the ignored root `firmware/sdkconfig` as authoritative.

## 14. Build Commands

Run from `firmware/` after loading ESP-IDF:

```bash
. ~/esp/esp-idf/export.sh
cd ~/Documents/Edge_IOT/Blockchain-iot/blockchain-iot/firmware
```

### Normal incident build

```bash
idf.py -B build-incident-enabled \
  -D SDKCONFIG=sdkconfig.incident.generated \
  -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident' \
  fullclean build
```

### Offline bench build

```bash
idf.py -B build-incident-bench \
  -D SDKCONFIG=sdkconfig.incident.bench.generated \
  -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident;sdkconfig.incident.bench' \
  fullclean build
```

### Network replay build

```bash
idf.py -B build-incident-network-replay \
  -D SDKCONFIG=sdkconfig.incident.network-replay.generated \
  -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident;sdkconfig.incident.network-replay' \
  fullclean build
```

### Signer provisioning build

```bash
idf.py -B build-incident-signer-provision \
  -D SDKCONFIG=sdkconfig.incident.signer-provision.generated \
  -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident;sdkconfig.incident.bench;sdkconfig.incident.signer-provision.bench' \
  fullclean build
```

Do not run `erase-flash`. **DO NOT erase NVS on provisioned hardware unless intentionally decommissioning or reprovisioning the signer.** Builds do not provision eFuses.

## 15. Signer Provisioning Procedure

1. Ensure the board already has the required NVS encryption/HMAC security state. The build itself does not burn eFuses.
2. Build and flash only the signer-provisioning profile using the controlled procedure in `docs/TASK1_SIGNER_PROVISIONING_BENCH.md`.
3. On the local UART console, issue `incident signer-provision <64-hex-private-scalar>` once. The tool refuses an existing signer and zeroizes its input buffers.
4. Record and verify only the returned public Ethereum address.
5. Reboot and verify the same public address is reported from encrypted NVS.
6. Return to the normal incident or network-replay firmware without erasing NVS.

Never commit a real private key or paste it into logs, screenshots, documentation, issue trackers, or chat. Signer provisioning is an explicit physical/operator lifecycle action, not BLE, Wi-Fi, MQTT, or backend provisioning.

## 16. Factory Reset Behavior After Task 1 Fix

The BOOT/GPIO0 reset task samples an active-low button and triggers after `CONFIG_SA_FACTORY_RESET_HOLD_MS`. Once triggered, it:

1. acquires the factory-reset guard so normal NVS writers stop;
2. stops MQTT;
3. erases namespace `wifi_prov`;
4. erases namespace `device`, covering MQTT/device-mode/relay provisioning state;
5. preserves `incidentv2`, including signer, sequence, and pending queue;
6. preserves the separate `calib` partition;
7. reboots.

Whole-default-NVS erase was removed because it silently destroyed the blockchain signer and durable incident state. Signer deletion now requires `incident_revoke_local_signer()` or an intentional device-decommissioning process.

## 17. Known Limitations / Not Implemented Yet

- No `blockchain/` smart-contract implementation, Hardhat suite, deployed/verified Sepolia contract, ABI, or production contract address exists yet.
- Backend does not parse incident payloads, validate schema/time/device identity, recompute hashes, recover/authorize signer addresses, or persist incidents in TimescaleDB.
- Backend does not yet generate production application ACKs. ACL transport support alone is not an ACK implementation.
- No idempotent incident database constraints, security-event handling, or blockchain outbox exists.
- No relayer, Sepolia submission, retry/backoff, blocked-sequence policy, contract event indexer, or chain reconciliation exists.
- No incident list/detail/verification API, realtime incident feed, app incident UI, transaction hash, or explorer link exists.
- The configured verifying contract is a development/test value and must be aligned with Task 2 deployment.
- Physical-board proof is not retained in the repository for encrypted-NVS behavior, real broker delivery, ACK deletion, or reboot persistence.
- Signer rotation's current `find_empty()!=0` guard should be hardened/tested for a sparse queue before production rotation is relied upon.
- Several pre-board audit documents preserve historical “not complete” statements and one obsolete reset expectation; current source and this handoff supersede those specific statements.

## 18. Handoff to Task 2

Task 2 must consume the exact Schema v2 evidence field order, incident ID derivation, EIP-712 domain, attestation type, signature format, sequence semantics, severity mapping, signer address, and golden fixtures. The contract must recover the same signer and reject duplicates, stale sequences, tampered evidence, and revoked devices.

Read first:

1. `docs/BLOCKCHAIN_INCIDENT_SCHEMA.md`
2. `docs/test-vectors/incident-v2-model-early-warning.json`
3. `docs/test-vectors/incident-v2-qcvn-exceeded.json`
4. `firmware/components/core/incident/incident.c`
5. `firmware/components/core/incident/tools/test_incident_signatures.py`
6. `Blockchain_task.md`

Task 2 must provide a deployed Sepolia address and ABI so the firmware overlay and Task 3 verifier use the same domain.

## 19. Handoff to Task 3

Task 3 must implement:

```text
device/{id}/incident
  -> strict JSON and Schema v2 validation
  -> topic/device identity match
  -> time, enum, mask, and numeric validation
  -> recompute deviceIdHash, incidentId, calibrationHash and evidenceHash
  -> rebuild EIP-712 digest and recover secp256k1 signer
  -> validate active authorized signer
  -> durable, idempotent database transaction
  -> enqueue blockchain outbox work
  -> publish application ACK to device/{id}/incident/ack
```

ACK must be sent only after the architecture's required validation and durable commit point. Duplicate identical incidents should ACK idempotently; conflicting duplicate IDs/hashes must not overwrite trusted evidence.

Source of truth:

1. `docs/BLOCKCHAIN_INCIDENT_SCHEMA.md`
2. `firmware/components/core/incident/incident.c`
3. `firmware/components/core/incident/include/incident.h`
4. `docs/test-vectors/`
5. `firmware/components/general/sa_mqtt/mqtt.c`
6. `server/api/src/services/emqx.js`
7. `docs/MQTT_PROTOCOL.md`

## 20. Do Not Break These Invariants

- [ ] Do not change AI/model decision semantics unintentionally.
- [ ] Start local safety signaling before incident persistence or network work.
- [ ] Do not reuse sequence numbers; gaps are safer than reuse.
- [ ] Do not regenerate or re-sign a stored payload during retry.
- [ ] Do not alter incident ID derivation or prefix.
- [ ] Do not alter evidence field order, ABI widths, masks, or signed extension.
- [ ] Do not change the EIP-712 name/version/chain/contract casually.
- [ ] Do not accept a signer when encrypted NVS is unavailable.
- [ ] Do not log private keys, NVS/HMAC secrets, MQTT credentials, or EIP-712 digests.
- [ ] Do not erase signer, sequence, or queue during BLE/Wi-Fi/factory reset.
- [ ] Do not restore automatic destructive default-NVS startup recovery in incident-enabled builds.
- [ ] Do not publish before the complete signed record is committed.
- [ ] Do not delete a queued incident on MQTT PUBACK or before a valid application ACK.
- [ ] Do not accept malformed, rejected, unknown, or cross-matched ACKs.
- [ ] Do not broaden device MQTT ACLs to `device/#` or `#`.
- [ ] Do not overwrite queue records or block the local alarm when queues are full.
- [ ] Do not put production signer material into config overlays, fixtures, or documentation.

## 21. Recommended Reading Order for Next Developer

1. `final_task1.md`
2. `docs/BLOCKCHAIN_INCIDENT_SCHEMA.md`
3. `firmware/components/core/incident/include/incident.h`
4. `firmware/components/core/incident/incident.c`
5. `docs/MQTT_PROTOCOL.md`
6. `firmware/sdkconfig.incident`
7. `docs/TASK1_BLOCKCHAIN_FIRMWARE_VERIFICATION.md`
8. `firmware/components/core/incident/tools/`
9. `server/api/src/services/emqx.js`
10. `Blockchain_task.md`

## 22. Task 1 Final Status

**COMPLETE WITH KNOWN LIMITATIONS**

The firmware implementation, deterministic codec/crypto, host persistence/ACK/queue behavior, signer provisioning parser, reset/startup preservation policy, Gas EWS regression, server ACL rules, and network-replay build are verified. Downstream contract/backend/relayer/UI work is intentionally outside Task 1. Physical-board evidence described in earlier development context is not retained in the current repository, so this handoff does not independently certify the board-only checks.

- Handoff date: 2026-09-29 (Asia/Ho_Chi_Minh)
- Pre-Task-1 baseline: `486d7cc` (`Merge pull request #2 from meeTeam05/feature/ai-gas-ews`)
- Task-definition/current HEAD: `135dba5` (`create 5 task for Blockchain`)
- Working tree: Task 1 implementation is largely modified/untracked and not committed; see the footprint audit accompanying this handoff.
- Signer public address: omitted. Only a fixture signer is present in test vectors, and no retained physical-board log proves the production board address.
