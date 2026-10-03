# Task 1 firmware verification

Audit date: 2026-09-27 (Asia/Ho_Chi_Minh)

This is reproducible host/build evidence, not board certification or a claim
that Task 1 is complete.

## Host suites

| Suite | Command | Result |
|---|---|---|
| Schema-v2 codec | `python3 firmware/components/core/incident/tools/test_incident_vectors.py` | PASS |
| Exact signer/signature | `python3 firmware/components/core/incident/tools/test_incident_signatures.py` | PASS |
| Tamper/ABI negatives | `python3 firmware/components/core/incident/tools/test_incident_tamper_abi.py` | PASS |
| Transition matrix | `python3 firmware/components/core/incident/tools/test_incident_transitions.py` | PASS |
| NVS persistence/reboot/retry | `python3 firmware/components/core/incident/tools/test_incident_persistence_retry.py` | PASS |
| Strict ACK matrix | `python3 firmware/components/core/incident/tools/test_incident_ack_matrix.py` | PASS |
| Queue-full/boundaries | `python3 firmware/components/core/incident/tools/test_incident_queue_full.py` | PASS |
| Gas EWS golden regression | Build `test_gas_ews_host.c` with `-Wall -Wextra -Werror`, then run `golden` | PASS; all replay comparisons reported zero mismatches |

The crypto runner passes the designated fixture private key only at runtime.
It compiles the production signer/recovery code but does not embed that key in
the firmware or the runner. Both vectors match digest, `r`, `s`, `v`, complete
signature and recovered signer exactly. Low-s, deterministic three-process
repeatability and invalid/mutated/high-s rejection also pass.

The tamper suite covers every evidence field and attestation field, signed
`int32` extension, uint ABI padding/endian rules, bytes32, masks, enums, exact
type strings and the non-JSON/non-packed hash rule.

## Clean builds

Environment: ESP-IDF 5.4.2, ESP32-S3.

```sh
. "$HOME/esp/esp-idf/export.sh"
cd firmware
idf.py -B build fullclean
idf.py -B build reconfigure
idf.py -B build build

idf.py -B build-incident-enabled \
  -D SDKCONFIG=sdkconfig.incident.generated \
  -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident" fullclean
idf.py -B build-incident-enabled \
  -D SDKCONFIG=sdkconfig.incident.generated \
  -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident" reconfigure
idf.py -B build-incident-enabled \
  -D SDKCONFIG=sdkconfig.incident.generated \
  -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident" build
```

| Profile | Link/bin | Size/free | `compile_commands.json` |
|---|---|---|---|
| Incident disabled | PASS | `0x148d80`; `0xb7280` (36%) free | present |
| Incident enabled secure | PASS | `0x167a10`; `0x985f0` (30%) free | present |

The disabled build has no `CONFIG_SA_ENABLE_BLOCKCHAIN_INCIDENT` definition,
uses the no-op/API-not-supported stubs, links normal AI/Gas EWS, and imposes no
signer or encrypted-NVS requirement. The enabled generated profile contains:

- `CONFIG_SA_ENABLE_BLOCKCHAIN_INCIDENT=y`
- `CONFIG_SA_ENABLE_AI=y`
- `CONFIG_NVS_ENCRYPTION=y`
- `CONFIG_NVS_SEC_KEY_PROTECT_USING_HMAC=y`
- `CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID=5`
- `CONFIG_MBEDTLS_ECP_DP_SECP256K1_ENABLED=y`
- queue capacity 4 and a Kconfig-supplied verifying contract

The clean builds showed only known managed TFLite `-Wshadow` warnings. A final
incremental rebuild after isolating host-only recovery helpers emitted no
Task-1-specific warning.

## Lifecycle evidence

- Sequence commit precedes issuance; failure can create a gap but never reuse.
- Signing and complete queue-record commit precede MQTT QoS-1 publish.
- Offline and reboot retries preserve payload, IDs, hash, signature, sequence
  and timestamp byte-for-byte; they do not re-sign or allocate a sequence.
- Queue records have an immutable-field/payload checksum; corrupt records are
  neither loaded nor published.
- ACK deletion requires a complete strict JSON object and an exact
  `(incident_id, evidence_hash)` pair; delete commit failure remains durable.
- Work and persistent queues are bounded and non-overwriting; overflow does
  not undo the already-queued local buzzer action.

## Security and signer lifecycle

Production contains no private-key literal and logs neither private key nor
EIP-712 digest. Provisioning returns `ESP_ERR_NOT_SUPPORTED` without NVS
encryption. The known Hardhat test key exists only in the two designated JSON
fixtures. Provision, address inspection, rotation, local revoke and disabled
stubs compile in their respective profiles. Rotation rejects while any queue
slot is occupied; factory reset erases only `wifi_prov` and `device`, preserving
the signer namespace. Operator register/revoke ordering is documented in
`BLOCKCHAIN_INCIDENT_FIRMWARE.md`. Actual encrypted-flash lifecycle remains a
board test and is not simulated as hardware-backed storage.

## AI regression

The embedded model file is unchanged and hashes to
`d1a789f1e6ad1e2b5225fb8ed78876b5ef348c2a81741e46c8fcb50c85048dcc`.
No input shape, feature formula, thresholds, STEL/TWA/projection, debounce or
`ai_set` semantics changed. The AI diff adds raw snapshot validity metadata,
model SHA access and a buzzer-first incident dispatch. The golden Gas EWS test
and both firmware profiles pass.

## Boundary

Result: **PRE-BOARD TASK 1 READY**, not Task 1 complete. Physical-board
encrypted-NVS and real MQTT evidence is listed in `TASK1_PRE_BOARD_AUDIT.md`.
