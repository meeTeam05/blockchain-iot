# Task 1 + Task 2 + Task 3 Integration Blockers

## 1. Purpose

This is the developer handoff for completing the full integration path:

```text
ESP32 Task 1 -> Task 3 backend -> Task 2 AirSafetyLog
```

A successful Git merge only proves that files coexist on one branch. It does
not prove that wire formats, EIP-712 domains, deployed bytecode, signer state,
database state, or runtime services are compatible.

## 2. Current Branch / Integration State

- Current branch: `integration/task1-task2-task3`
- HEAD: `5c0331f` (`Merge remote-tracking branch 'origin/feature/blockchain-task2-contract' into integration/task1-task2-task3`)
- Relevant feature branches present:
  - `feature/blockchain-task1-firmware`
  - `origin/feature/blockchain-task2-contract`
  - `origin/feature/blockchain-task3-incident-intake`
- Relevant integration branches present:
  - `integration/task1-task3` / `origin/integration/task1-task3`
  - `integration/task1-task2-task3`
- Task 1 + Task 3 integration is committed in `159dfea`.
- Task 2's sequence-policy compatibility fix is currently **uncommitted**.
- Before this document was created, the working tree already contained these
  modified files:
  - `blockchain/contracts/AirSafetyLog.sol`
  - `blockchain/test/AirSafetyLog.test.js`
  - `blockchain/test/vectors.test.js`
  - `blockchain/abi/AirSafetyLog.json`
  - `blockchain/README.md`
  - `docs/BLOCKCHAIN_INCIDENT_SCHEMA.md`
- This handoff is the only new file created by this documentation task.

## 3. Current End-to-End Target

```text
Gas EWS                                      EXISTS
  -> Task 1 incident creation               EXISTS
  -> encrypted-NVS persistent queue         EXISTS
  -> MQTT QoS 1 publish                     EXISTS
  -> Task 3 validation                      EXISTS
  -> EIP-712 signer recovery/authorization  EXISTS
  -> durable DB persistence                 EXISTS
  -> blockchain_outbox queued row           EXISTS
  -> Task 4 relayer                         DOES NOT EXIST
  -> AirSafetyLog.logIncident()              SOURCE EXISTS; RUNTIME NOT CONNECTED
  -> Sepolia                                 OLD CONTRACT ONLY
  -> receipt/event reconciliation           DOES NOT EXIST
  -> application-visible chain state        DB SHAPE/API EXISTS; NO INDEXER
```

Task 3 persists an incident and its outbox row transactionally. The current
repository has no process that consumes that row, submits a transaction, waits
for confirmations, reconciles contract events, or updates final chain state.

## 4. What Is Already Compatible

| Area | Status | Notes |
|---|---|---|
| Schema v2 | PASS | Firmware, backend, contract constants and golden fixtures use version 2. |
| `deviceIdHash` | PASS | `keccak256` of the canonical lowercase device ID bytes. |
| `incidentId` | PASS | `keccak256(abi.encodePacked("AIR-INCIDENT-2", deviceIdHash, uint64(sequence)))`. |
| 33-field `evidenceHash` | PASS | Type string, field order, widths and fixtures match. |
| EIP-712 name/version | PASS | `AirSafetyLog` / `1`. |
| Sepolia chain ID | PASS | `11155111`. |
| `IncidentAttestation` order | PASS | `deviceIdHash`, `incidentId`, `sequence`, `observedAt`, `severity`, `evidenceHash`. |
| Signature layout | PASS | 65-byte `r || s || v`, with `v` 27/28. |
| Low-s enforcement | PASS | Firmware produces canonical signatures; backend and contract reject high-s. |
| Severity | PASS | Warning `1`, danger `2`; critical remains policy-gated and has no Task 1 producer. |
| MQTT topics | PASS | `device/{deviceId}/incident` and `device/{deviceId}/incident/ack`, QoS 1. |
| ACK contract | PASS | Required string fields, including `error_code:""` on acceptance; firmware deletes only on matching accepted ACK. |
| Task 1 -> Task 3 wire payload | PASS | Exact firmware fixture verifies, authorizes, persists, queues and produces a parser-compatible ACK. |
| Task 1/3 sequence policy | PASS | Valid unseen sequences may arrive out of order; exact/conflicting reuse is constrained. |
| Task 2 sequence source after latest fix | PASS | Uses exact per-device `sequenceUsed`; accepts unseen lower values; sequence 0 is rejected; `lastSequence` is metadata. |
| ABI after regeneration | PASS | Exported ABI matches the current clean-compiled contract artifact. |

These PASS results describe source/tests. They do not make the old Sepolia
deployment compatible with the new source.

## 5. Resolved Integration Conflicts

| Conflict | Old behavior | Fix | Current status |
|---|---|---|---|
| `calibration_canonical` mismatch | Task 3 required a value Task 1 never sends. | Migration 018 makes the legacy column optional; Task 3 commits the signed `calibration_hash` supplied by Task 1. | RESOLVED |
| ACK `error_code:null` | Firmware requires `error_code` to be a string. | Accepted ACKs now use `error_code:""`. | RESOLVED |
| Task 3 strict arrival sequence | Lower unseen incidents could be rejected after a higher arrival. | Backend now accepts every valid unseen sequence and transactionally rejects reuse/conflict. | RESOLVED |
| Task 3 600-second delayed-delivery rejection | A valid first delivery older than the clock-skew window was rejected. | Delayed evidence is accepted indefinitely; only zero or too-far-future timestamps are rejected. | RESOLVED |
| Task 2 strict `lastSequence` rule | Contract rejected valid delivery `4 -> 3`. | Uncommitted source uses exact `sequenceUsed`, accepts unseen out-of-order delivery, rejects zero/reuse, and retains highest-seen `lastSequence` only as metadata. | RESOLVED IN SOURCE; NOT DEPLOYED |

Do not reintroduce any of these old assumptions.

## 6. Current Blocking Issues

| Severity | Blocker | Why It Blocks E2E | Required Action |
|---|---|---|---|
| CRITICAL | **A — Task 2 contract has not been redeployed** | Current source has the exact-use sequence fix, but Sepolia still contains the immutable old high-water-mark bytecode at `0x4E6e20bC0601CddD6Cb0C3AE8440e6933839A8Aa`. Editing Solidity cannot update that deployment. | Preserve/commit the reviewed fix, deploy a new contract, verify its source/bytecode and record the new address. |
| CRITICAL | **B — EIP-712 `verifyingContract` mismatch** | Firmware and the current backend runtime use `0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC`; deployed Task 2 uses `0x4E6e20bC0601CddD6Cb0C3AE8440e6933839A8Aa`. The address is part of the domain separator, so a signature for one address is invalid for another. | After redeployment, update backend and firmware to the same new address as one coordinated migration. |
| CRITICAL | **C — Pending old-domain incidents** | Persisted firmware queue records may already be signed for the `0xCcCC...` test domain. Their signed bytes are immutable and must not be silently re-signed. | Inspect the pending queue and choose an explicit old-domain handling policy before changing firmware configuration. Do not casually erase NVS. |
| CRITICAL | **D — No Task 4 relayer/outbox worker** | Task 3 inserts `blockchain_outbox` rows, but nothing calls `logIncident()`. Gas, nonce, RPC retry/backoff, revert classification, confirmation tracking and receipt/event reconciliation are absent. | Implement Task 4 after the new deployment/domain is stable. |
| HIGH | **E — Signer registry synchronization** | The private signer lives on the device, its active address is authorized in Task 3, and Task 2 has an independent on-chain device signer. Any disagreement causes backend rejection or on-chain `WrongSigner`. | Define an idempotent register/rotate/revoke workflow that keeps device, DB and chain state synchronized. Factory reset alone must not revoke the preserved signer. |
| HIGH | **F — Physical ESP32 E2E prerequisites** | A board test cannot pass without a provisioned signer, backend authorization, matching contract domain, database migration, network services and serial observability. | Keep the board signer/NVS, register the public address in DB and on-chain, confirm migration 018 on the target DB, use a working serial connection, and never erase NVS as a routine integration step. |

Migration `018_task1_task3_wire_compat.sql` exists and is exercised by backend
tests. No Docker services are currently running, so application of migration
018 to a particular live/retained Postgres instance was not verified while
writing this handoff. Run the normal migration command and inspect that target
database before physical E2E.

## 7. Domain Migration Problem

- Old/test domain used by current firmware/backend:
  `0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC`
- Old deployed Task 2 contract:
  `0x4E6e20bC0601CddD6Cb0C3AE8440e6933839A8Aa`
- Future domain:
  `<NEW TASK 2 DEPLOYMENT ADDRESS>`

The `verifyingContract` is hashed into the EIP-712 domain separator. Changing
it changes the digest even when every incident field and signer key remains the
same. Safe migration order:

1. Deploy the fixed Task 2 contract.
2. Verify deployed bytecode/source and the exported ABI.
3. Record the new address in deployment metadata.
4. Audit the firmware's pending old-domain queue.
5. Update backend `AIR_SAFETY_LOG_ADDRESS`.
6. Update firmware `CONFIG_SA_INCIDENT_VERIFYING_CONTRACT` to the same address.
7. Rebuild and flash without erasing NVS unless old records were intentionally handled.
8. Register/synchronize the board signer in Task 3 and Task 2.
9. Generate only new incidents under the new domain.
10. Run the full physical and chain E2E.

**Do not silently re-sign existing historical incidents.** Re-signing changes
their immutable evidence envelope and breaks Task 1's byte-identical retry and
audit guarantees.

## 8. Sequence Policy — Final Intended Behavior

Task 1:

- Allocates a persistent `uint64` beginning at 1.
- Commits allocation before use; gaps are allowed and values are never reused.
- Retries the exact persisted bytes.
- Delivery may be out of order after queueing, reboot or reconnect.

Task 3:

- Accepts a valid unseen lower sequence after a higher sequence.
- Enforces unique `(device_id, sequence)` and incident identity.
- Re-ACKs an identical stored retry and rejects conflicting reuse.

Task 2 current source:

- Uses exact `sequenceUsed[deviceIdHash][sequence]` tracking.
- Accepts unseen out-of-order sequences.
- Rejects reuse and rejects sequence 0.
- Keeps `lastSequence`, when present, only as highest-seen metadata.

Sequence is an identity and anti-reuse mechanism, not an arrival-order
requirement. Task 3's generic `uint64` parser still permits zero, but production
Task 1 never emits zero; this validation difference can be tightened separately
without changing the signed wire format.

## 9. Current Test Status

| Layer | Test | Status |
|---|---|---|
| Task 1 | Host incident suites: vectors, signatures, tamper/ABI, transition, persistence, ACK, queue-full and signer lifecycle | PASS — recorded in `final_task1.md` |
| Task 1 | Gas EWS golden regression | PASS — zero mismatches recorded in `final_task1.md` |
| Task 1 -> Task 3 | Exact firmware wire-contract and incident service tests | PASS — 44/44 relevant Node tests in the latest integration run |
| Task 1 + Task 3 | Real API + EMQX + TimescaleDB MQTT E2E | PASS in prior integration validation; reproducible test exists at `server/api/test/e2e/incident-mqtt.e2e.test.js`; not rerun here because the Docker stack is stopped |
| Task 2 | Clean compile and full Hardhat suite | PASS — 42/42 after the uncommitted sequence fix |
| Task 2 + Task 1 | Golden vector identity/hash/digest/signature tests | PASS |
| Task 2 | Reverse unseen sequence delivery | PASS — Task 1 vectors and explicit `4 -> 3` coverage |
| Task 2 | ABI regeneration/artifact comparison | PASS |
| Task 1 -> Task 3 -> Task 2 | Physical/MQTT/backend/relayer/Sepolia/receipt E2E | **NOT COMPLETE** |

## 10. What The Next Developer Should Do

1. Review and commit/preserve the current uncommitted Task 2 compatibility changes.
2. Configure the Sepolia deployment environment without committing or logging secrets.
3. Deploy the fixed `AirSafetyLog` contract to Sepolia.
4. Verify the new contract source and deployed bytecode.
5. Regenerate/check ABI and deployment metadata; record the new address.
6. Decide and document the pending old-domain incident policy.
7. Update firmware and backend EIP-712 domain addresses together.
8. Synchronize the device signer in the Task 3 database and Task 2 registry.
9. Implement the Task 4 relayer/outbox worker and reconciliation path.
10. Run a Task 3 outbox -> Task 2 transaction integration test.
11. Run physical ESP32 -> MQTT -> backend -> Sepolia E2E, including retry/reboot cases.
12. Merge into `main` only after the three-layer E2E is reproducible.

## 11. Do Not Break These Invariants

- Schema version 2.
- `AIR-INCIDENT-2` incident ID prefix and packed derivation.
- Exact 33-field evidence layout and field order.
- Exact Solidity ABI widths.
- Signed `int32` temperature encoding/sign extension.
- EIP-712 name `AirSafetyLog`, version `1`.
- Sepolia chain ID `11155111`.
- Exact `IncidentAttestation` field order.
- Canonical low-s signatures with `v` 27/28.
- Encrypted-NVS signer, sequence and queue preservation.
- Byte-identical retry of persisted records.
- Queue deletion only after a matching accepted ACK.
- Support for valid unseen out-of-order sequences.
- No silent re-signing during domain migration.
- Least-privilege MQTT ACLs; never grant device wildcards such as `device/#` or `#`.
- Never log device private keys, relayer keys, NVS encryption material, RPC credentials or other secrets.

## 12. Important Files To Read

- `final_task1.md`
- `TASK1_TASK2_TASK3_INTEGRATION_BLOCKERS.md`
- `docs/BLOCKCHAIN_INCIDENT_SCHEMA.md`
- `docs/test-vectors/`
- `firmware/components/core/incident/incident.c`
- `firmware/components/core/incident/include/incident.h`
- `firmware/sdkconfig.incident`
- `blockchain/contracts/AirSafetyLog.sol`
- `blockchain/abi/AirSafetyLog.json`
- `blockchain/deployments/sepolia.json`
- `blockchain/README.md`
- `blockchain/test/AirSafetyLog.test.js`
- `blockchain/test/vectors.test.js`
- `blockchain/scripts/deploy.js`
- `blockchain/scripts/verify.js`
- `server/api/src/services/incident-verify.js`
- `server/api/src/services/incident-intake.js`
- `server/api/src/services/incidents.js`
- `server/api/src/services/device-signers.js`
- `server/db/migrations/017_blockchain_incidents.sql`
- `server/db/migrations/018_task1_task3_wire_compat.sql`
- `server/api/test/firmware-wire-contract.test.js`
- `server/api/test/incident-intake.test.js`
- `server/api/test/e2e/incident-mqtt.e2e.test.js`

## 13. Current Final Status

```text
Task 1:                         COMPLETE
Task 1 + Task 3 integration:    PASS
Task 2 source compatibility:    PASS after sequence-policy fix
Task 2 redeployment:            NOT DONE
Three-layer E2E:                NOT COMPLETE
Task 4 relayer:                 NOT IMPLEMENTED
```

The single most important next action is to **deploy the fixed Task 2 contract
and obtain the new EIP-712 verifying contract address**.
