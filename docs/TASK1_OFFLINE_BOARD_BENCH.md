# Task 1 Offline Board Incident Bench Mode

## Purpose

`CONFIG_SA_INCIDENT_OFFLINE_BENCH` is a test-only ESP32-S3 mode for verifying the complete local Task 1 path without BLE provisioning, Wi-Fi, or MQTT:

```text
embedded replay -> production Gas EWS/model -> upward transition
-> buzzer -> production incident gate -> sequence/evidence/EIP-712/signature
-> encrypted-NVS record -> exact stored payload on UART
```

It does not implement a synthetic incident or alternate signer. The only shortcut is boot orchestration around network provisioning.

## Safety boundaries

- The mode never provisions, replaces, or logs a private signer.
- It never logs an NVS encryption key, HMAC secret, or EIP-712 digest.
- It performs no eFuse operation, factory reset, NVS erase, or fake MQTT ACK.
- If default or calibration NVS reports that an erase is required, bench mode refuses the automatic erase and stops through the existing boot-error path.
- It uses the existing signer already stored in encrypted NVS. A missing signer is reported and normal signing rejection remains in force.
- It uses valid DS3231 time only. Build time may seed the system clock for display purposes but is not accepted as incident provenance.
- Queued records remain stored; bench mode does not delete or rewrite them.
- The AI model, replay data, thresholds, STEL/TWA, projection, debounce, evidence codec, EIP-712 implementation, and secp256k1 implementation are unchanged.

## Kconfig

Menu text: `Offline Board Incident Bench Mode (TEST ONLY)`

Symbol:

```text
CONFIG_SA_INCIDENT_OFFLINE_BENCH
```

It defaults to `n` and depends on:

- `CONFIG_SA_ENABLE_AI=y`
- `CONFIG_SA_AI_REPLAY=y`
- `CONFIG_SA_ENABLE_BLOCKCHAIN_INCIDENT=y`
- `CONFIG_SA_ENABLE_BUZZER=y`
- `CONFIG_NVS_ENCRYPTION=y`

The tracked `firmware/sdkconfig.incident.bench` overlay enables replay scenario 0 at 60x, the buzzer, and bench mode. It must be combined with `sdkconfig.defaults` and the secure `sdkconfig.incident` profile. It contains no key material.

## Startup behavior

Before this mode, the startup call chain was:

```text
app_main -> sysload_init
-> NVS and hardware
-> wifi_sta_init
-> run_ble_provisioning_stage (blocks when not provisioned)
-> load credentials -> connect Wi-Fi
-> resolve device ID/MQTT config -> HTTP/SNTP -> require MQTT secret
-> incident_init -> mqtt_start -> sensor_task_start -> ai_start -> replay
```

Thus an unprovisioned board could not reach incident or replay initialization.

With bench mode enabled, startup is:

```text
app_main -> sysload_init
-> secure NVS (no automatic erase in bench mode)
-> local display/I2C/DS3231/sensors/calibration hardware
-> immutable device ID from STA MAC
-> system clock seed + approved DS3231 incident time source when valid
-> buzzer/device mode/incident_init
-> inspect existing production signer and restored queued records
-> sensor task where applicable
-> ai_start -> gas_ews_model_init -> ai_replay_task
```

The network stack, Wi-Fi initialization/connection, BLE provisioning, HTTP server, MQTT start, network time sync, and OTA network task are skipped. Local OTA validation remains after subsystem startup. When bench mode is disabled, the original BLE -> Wi-Fi -> MQTT ordering is unchanged.

## Production-path guarantee

Replay still executes this call chain:

```text
ai_replay_task -> replay_sample -> gas_ews_feed
-> ai_task -> ai_handle_step -> gas_ews_model_infer
-> incident_snapshot_from_status -> ai_alarm_dispatch
-> buzzer_beep_pattern
-> incident_on_gas_ews_transition -> prepare_incident_work
-> production incident work queue -> process_work
-> signer_available -> next_sequence -> hash_incident_id
-> hash_evidence -> hash_digest -> sign_digest
-> make_payload -> save_record -> mqtt_publish (returns offline)
```

The buzzer is submitted before incident work. Candidate eligibility remains limited to SAFE -> EARLY_WARNING, SAFE -> EXCEEDED, and EARLY_WARNING -> EXCEEDED. Persistent-queue-full rejection occurs before sequence allocation and cannot overwrite an existing record.

## What is tested offline

| Function | Offline bench verifies |
|---|---|
| replay | yes |
| Gas EWS | yes |
| model inference | yes |
| buzzer | yes |
| transition gate | yes |
| sequence | yes |
| evidenceHash | yes |
| EIP-712 signing | yes |
| encrypted NVS persistence | yes |
| reboot restore | yes |
| MQTT publish | no |
| ACK delete | no |

“Reboot restore” means the existing exact signed NVS record is loaded and reported again without a new sequence, timestamp, incident ID, or signature. Broker receipt and application ACK remain separate network tests.

## Required preconditions

- Replay, AI, Blockchain Incident v2, buzzer, and offline bench mode enabled.
- NVS encryption using the board's existing HMAC protection is working.
- A production signer has already been provisioned through the existing encrypted-NVS lifecycle.
- `CONFIG_SA_INCIDENT_VERIFYING_CONTRACT` contains the intended valid address.
- DS3231 is available and contains a Unix timestamp at or after 2000-01-01. Without approved time, replay and buzzer continue but the production incident gate rejects the candidate.
- Persistent incident queue capacity is available.
- Do not erase the default NVS partition between signer provisioning and this test.

## UART logs

Startup diagnostics use tag `INC_BENCH`:

```text
INC_BENCH: mode enabled
INC_BENCH: network provisioning bypassed
INC_BENCH: replay scenario=0 speed=60x
INC_BENCH: encrypted NVS ready
INC_BENCH: time source=DS3231
INC_BENCH: signer available=yes
INC_BENCH: signer address=0x...
INC_BENCH: queue_depth=...
INC_BENCH: MQTT unavailable/offline; queued records retained
```

If the prerequisites are absent, expect `no valid incident time source; signing cannot proceed` or `signer available=no`. Neither condition stops replay or the local alarm.

For an eligible incident:

```text
INC_BENCH: transition SAFE->EARLY_WARNING
INC_BENCH: incident accepted
INC_BENCH: sequence=...
INC_BENCH: incident_id=0x...
INC_BENCH: evidence_hash=0x...
INC_BENCH: signature created
INC_BENCH: signature=0x...
INC_BENCH: persisted
INC_BENCH: queue_depth=...
INC_BENCH_PAYLOAD: {exact stored Schema-v2 MQTT payload}
INC_BENCH: MQTT unavailable/offline; record retained
```

The payload line is the same immutable text stored in NVS and passed to `mqtt_publish()`; it is not reconstructed debug JSON. On reboot, each valid queued record logs `restored queued incident` followed by the same sequence, incident ID, evidence hash, signature, and payload.

When full, expect `INC_BENCH: incident queue full; local safety unaffected`. No sequence or signature is created for that rejected candidate.

## How to enable

From `firmware/`, load ESP-IDF 5.4.2 and open the dedicated profile:

```bash
source "$HOME/esp/esp-idf/export.sh"
idf.py -B build-incident-bench \
  -D SDKCONFIG=sdkconfig.incident.bench.generated \
  -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident;sdkconfig.incident.bench' \
  menuconfig
```

The option is under `Smart Air Configuration -> Blockchain incidents`. The tracked overlay already selects it. Save and exit, then verify:

```bash
grep -E '^(CONFIG_SA_ENABLE_AI|CONFIG_SA_ENABLE_BLOCKCHAIN_INCIDENT|CONFIG_SA_ENABLE_BUZZER|CONFIG_SA_AI_REPLAY|CONFIG_SA_AI_REPLAY_SPEED|CONFIG_SA_AI_REPLAY_SCENARIO|CONFIG_SA_INCIDENT_OFFLINE_BENCH|CONFIG_NVS_ENCRYPTION|CONFIG_NVS_SEC_KEY_PROTECT_USING_HMAC|CONFIG_MBEDTLS_ECP_DP_SECP256K1_ENABLED)=' sdkconfig.incident.bench.generated
```

Build without flashing:

```bash
idf.py -B build-incident-bench \
  -D SDKCONFIG=sdkconfig.incident.bench.generated \
  -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident;sdkconfig.incident.bench' \
  fullclean reconfigure build
```

Only when ready to perform the manual board test, set the correct port and flash the application normally. Do not use `erase-flash` or any eFuse command:

```bash
PORT=/dev/ttyACM0
idf.py -B build-incident-bench -p "$PORT" flash
```

Capture UART to a timestamped log:

```bash
bench_log="task1-offline-bench-$(date +%Y%m%d-%H%M%S).log"
idf.py -B build-incident-bench -p "$PORT" monitor 2>&1 | tee "$bench_log"
```

Exit the monitor with `Ctrl+]`.

## How to disable

Use the normal profile/build directory, or disable `Offline Board Incident Bench Mode (TEST ONLY)` in menuconfig. Do not reuse the bench-generated sdkconfig for production.

```bash
idf.py -B build-normal \
  -D SDKCONFIG=sdkconfig.normal.generated \
  -D SDKCONFIG_DEFAULTS=sdkconfig.defaults \
  fullclean reconfigure build
```

With `CONFIG_SA_INCIDENT_OFFLINE_BENCH=n`, BLE provisioning, Wi-Fi, SNTP, HTTP, MQTT, and OTA startup follow the original path.

## Expected scenario-0 timing at 60x

The embedded/generated `co_event` replay starts 10 seconds after `ai_start()`.

| Event | Simulated time from first replay sample | Approximate wall time after replay starts | Approximate time after `ai_start()` |
|---|---:|---:|---:|
| CO SAFE -> EARLY_WARNING (model source) | 40:00 | 40.0 s | 50.0 s |
| CO EARLY_WARNING -> EXCEEDED | 47:20 | 47.3 s | 57.3 s |
| Replay completes | about 72 min | about 72 s | about 82 s |

These values come from the existing replay expected CSV/summary and are not newly estimated thresholds.

## Verification performed

- ESP-IDF 5.4.2 normal clean build: PASS; `smart-air.bin` `0x148d80`, `0xb7280` bytes (36%) free in the 2 MiB app partition.
- ESP-IDF 5.4.2 secure bench clean build: PASS; `smart-air.bin` `0xa7c80`, `0x158380` bytes (67%) free.
- Bench config verified with AI, replay scenario 0 at 60x, buzzer, Blockchain Incident, encrypted NVS/HMAC, deterministic secp256k1 support, and offline bench enabled.
- Incident codec, exact signer/recovery, tamper/ABI, transition, NVS persistence/reboot/retry, strict ACK, and queue-full regressions: PASS.
- Gas EWS host/golden regression: PASS with zero mismatches.
- No board flash or destructive NVS/eFuse operation was performed.

## Limitations

- Offline mode cannot prove MQTT broker delivery, server validation, MQTT/application ACK, or ACK-driven deletion.
- Host tests and compilation do not prove that the physical board still contains the expected signer or a valid RTC timestamp; confirm both in UART logs.
- UART signatures and payloads are public evidence but may still be operationally sensitive. Capture and store bench logs appropriately.
