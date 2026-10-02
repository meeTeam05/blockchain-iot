# Task 1 Pre-Board Audit

Audit date: 2026-09-27 (Asia/Ho_Chi_Minh)

## Verdict

**PRE-BOARD TASK 1 READY**

This is not a claim that Task 1 is complete. No board was flashed or modified
during this audit.

## Host verification summary

| Suite | Result |
|---|---|
| Schema-v2 production codec | PASS |
| Exact signer/signature and recovery | PASS |
| Tamper/ABI negative matrix | PASS |
| Transition matrix | PASS |
| NVS persistence/reboot/retry fault injection | PASS |
| Strict ACK matrix | PASS |
| Queue-full/boundary matrix | PASS |
| Gas EWS golden regression | PASS; zero replay mismatches |

All suites were rerun in this audit; old log files were not used as the basis
for the verdict.

## Build verification

ESP-IDF 5.4.2, target ESP32-S3. Both profiles were run through `fullclean`,
reconfigure and full build. Both contain `compile_commands.json`.

Disabled build: **PASS** — final link and `smart-air.bin`; size `0x148d80`,
`0xb7280` bytes (36%) free. The incident feature is unset, stubs compile, AI
links normally, and encrypted NVS is not required.

Enabled secure build: **PASS** — final link and `smart-air.bin`; size
`0x167a10`, `0x985f0` bytes (30%) free. The generated config enables incident,
AI, encrypted NVS, HMAC NVS key protection (eFuse key ID 5), secp256k1, queue
capacity 4 and the Kconfig verifying-contract mechanism.

There are no Task-1-specific warnings after the final source adjustment. The
clean build's remaining `-Wshadow` warnings originate in the pinned managed
TFLite dependency.

## Golden vectors

| Vector | deviceIdHash | incidentId | firmwareVersionHash | calibrationHash | evidenceHash | EIP-712 digest | signer | signature |
|---|---|---|---|---|---|---|---|---|
| `incident-v2-model-early-warning` | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| `incident-v2-qcvn-exceeded` | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |

Both signatures also pass deterministic three-process equality, exact `r/s/v`,
65-byte `r||s||v`, `v` 27/28, low-s, recovery, and mutated/invalid/high-s
negative cases.

## Lifecycle verification

- Sequence initialization, monotonic durability, commit failure and no reuse:
  PASS.
- Persist-before-publish and save-failure publication block: PASS.
- Offline and reboot retry with exact bytes: PASS.
- No re-sign and no new sequence on retry: PASS.
- Corrupt queue-record rejection: PASS.
- Strict ACK deletion, retention and delete-commit failure: PASS.
- Persistent/work queue bounds, overflow, reboot and ACK capacity recovery:
  PASS.

## Security verification

- Private key handling: PASS. Production has no key literal and clears loaded
  key/public-key buffers; neither key nor EIP-712 digest is logged.
- NVS encryption guard: PASS. Provisioning refuses storage when
  `CONFIG_NVS_ENCRYPTION` is unavailable.
- Test-key isolation: PASS. The known Hardhat key occurs only in the two
  designated JSON fixtures and is supplied to host crypto at runtime.
- Signer lifecycle implementation: PASS for source/API/build verification.
  Provision, inspect, rotate and local revoke exist; rotate requires an empty
  queue; factory reset preserves `incidentv2`, while explicit local revoke
  deletes the signer; operator register/revoke ordering is documented. Runtime
  encrypted-flash behavior remains board-only.
- Secret/path scan: PASS. No production signer secret or developer-machine
  absolute path remains outside ignored generated build data.

## AI regression verification

The `.tflite` file is unchanged and its SHA-256 is
`d1a789f1e6ad1e2b5225fb8ed78876b5ef348c2a81741e46c8fcb50c85048dcc`.
The diff does not change weights, input shape, feature engineering, thresholds,
STEL/TWA, projection, debounce, or `ai_set`. It adds raw validity/snapshot
metadata, embedded-model hashing and buzzer-first incident dispatch. The Gas
EWS golden regression and both firmware profiles pass.

## Repository hygiene

- `git diff --check`: PASS.
- Unrelated changes: none identified; current code changes are Task 1 incident
  implementation/integration, tests, secure profile, docs and ignore rules.
- Generated artifacts: build directories, generated incident sdkconfig and
  host `.log` files are ignored and unstaged. The model binary is unchanged.
- Test runner paths use `IDF_PATH` with a home-relative fallback; no editor or
  developer-machine absolute path remains.
- The audit request named four paths that do not exist. The audit used their
  actual repository locations: root `Blockchain_task.md`, root `AI.md`,
  `firmware/components/general/sa_mqtt`, and
  `firmware/main/Kconfig.projbuild`.

## Pre-board completion matrix

Each canonical Task 1 requirement appears exactly once below.

| Requirement | Status | Evidence | Needs board? |
|---|---|---|---|
| Feature-gated incident component | PASS | Clean enabled/disabled links; explicit component discovery | No |
| Correct upward-transition eligibility | PASS | Transition matrix accepts only 0→1, 0→2, 1→2 | No |
| Local safety before blockchain work | PASS | Buzzer-first ordering and runtime queue instrumentation | Board confirmation only |
| Consistent Gas EWS snapshot | PASS | Single copied status, Gas EWS regression, codec/tamper field coverage | Board observation only |
| Valid time-source requirement | PASS | NONE/zero rejected; SNTP/DS3231 accepted | Board clock integration only |
| Durable uint64 sequence | PASS | Transactional NVS shim and restart tests | Board flash confirmation only |
| No sequence reuse | PASS | Commit/power-loss/restart fault matrix | Board flash confirmation only |
| Exact incidentId | PASS | Both golden vectors exact-match production codec | No |
| Exact evidenceHash | PASS | Both vectors plus every-field tamper/ABI tests | No |
| Exact EIP-712 digest | PASS | Both vectors plus attestation tamper tests | No |
| Deterministic secp256k1 signing | PASS | Three independent exact runs for both vectors | No |
| r/s/v format | PASS | Exact components, 65 bytes and v 27/28 | No |
| Low-s | PASS | Exact and high-s negative tests | No |
| Signer recovery | PASS | Expected Ethereum address recovered for both vectors | No |
| Private key not hardcoded/logged | PASS | Production source/log scan; fixture isolation | Board plaintext inspection remains |
| NVS encryption refusal when unavailable | PASS | Guarded production provision API/source and disabled profile | No |
| Secure incident build profile | PASS | Encrypted NVS, HMAC, secp256k1 and contract config | Activation needs board |
| Persist-before-publish | PASS | Instrumented event ordering and failure injection | Board confirmation only |
| MQTT QoS 1 | PASS | Production publish calls and retry harness use QoS 1 | Real broker needed |
| Offline retry | PASS | Exact persisted payload retry | Real disconnect needed |
| Reboot retry | PASS | Restart shim preserves pending records | Real reboot needed |
| Exact-byte retry | PASS | Payload/signature/IDs/hash/sequence/time identical | Real broker capture needed |
| No resign on retry | PASS | Sign counter remains unchanged | Board confirmation only |
| No new sequence on retry | PASS | Sequence counter remains unchanged | Board confirmation only |
| Queue corruption handling | PASS | Checksum corruption is rejected, never published | No |
| Strict ACK deletion | PASS | Exact ID/hash pair and commit required | Real ACK callback needed |
| Malformed/mismatched ACK retention | PASS | Full malformed/type/hex/cross-match matrix | No |
| Duplicate ACK safety | PASS | Duplicate and unknown ACK cases | No |
| Bounded persistent queue | PASS | Capacity−1/capacity/overflow at sizes 4 and 2 | Board stress optional |
| Bounded work queue | PASS | Four accepted, fifth rejected with zero wait | Board stress optional |
| Queue-full safety | PASS | No overwrite, partial record, sign or sequence on rejection | Board stress optional |
| Local safety unaffected by queue-full | PASS | Buzzer action precedes both work/persistent overflow | Board confirmation only |
| Signer provision/inspect/rotate/reset interfaces | PASS | API/source review and secure link; rotation queue guard | Runtime encrypted NVS needed |
| Factory reset behavior | PASS | Production reset erases default NVS containing signer | Safe board test needed |
| MQTT incident/ACK topic integration | PASS | Exact route, callback registration and handler checks | Real broker needed |
| AI model/decision behavior unchanged | PASS | Unchanged model/diff audit/Gas EWS regression | Board runtime smoke test |
| Feature-enabled build | PASS | Clean secure full build and link | No |
| Feature-disabled build | PASS | Clean default full build and link | No |
| Golden vectors | PASS | All eight required outputs exact for both fixtures | No |
| Host regression suite | PASS | Seven incident suites plus Gas EWS | No |
| Documentation | PASS | Firmware, verification, status and this audit agree | No |
| No unrelated changes | PASS | Full diff/stat review | No |
| No secrets in repo | PASS | Key/seed/secret scan; designated fixtures only | No |

Host-side requirements complete: **43 / 43**.

## Board-only remaining checklist

Retain UART, broker and payload evidence for every checked item:

1. Flash the enabled secure profile to the intended ESP32-S3 and confirm NVS
   encryption/HMAC key protection is actually active without destructive
   reprovisioning of an already deployed device.
2. Provision a non-fixture signer through the supported operator flow; inspect
   the derived address, reboot, and prove the same address survives.
3. Confirm private-key bytes and EIP-712 digest never appear on UART, broker
   logs, coredumps or readable plaintext NVS/flash output.
4. Connect to the real MQTT broker and verify the exact incident publish topic,
   QoS 1 delivery and exact ACK-topic callback.
5. ACK one real incident with the exact ID/hash pair and prove the durable
   queue entry is deleted; verify malformed/mismatched ACKs retain it.
6. Disconnect the broker, create an incident, reconnect and prove the persisted
   record is retried byte-identically without a new signature or sequence.
7. Reboot with an unacknowledged incident and prove the same incident bytes,
   signature, ID, hash, sequence and observed time are retried.
8. Observe that the local buzzer begins before incident persistence/network I/O
   and still operates when work or persistent queues are saturated.
9. Confirm Gas EWS sensors, model self-test/inference, MQTT state and normal AI
   decisions continue while incident handling is enabled.
10. With a safe recovery plan, verify rotation is rejected while a pending
    record exists, then succeeds after ACK; perform backend old-signer revoke
    and new-signer registration in the documented order.
11. With explicit permission to erase the device, run factory reset and prove
    the local signer is removed and signing stays unavailable until reprovision.

## Final statement

All Task 1 requirements that can be verified without physical hardware are
complete. The remaining work is limited to board-backed encrypted-NVS and MQTT
end-to-end verification.
