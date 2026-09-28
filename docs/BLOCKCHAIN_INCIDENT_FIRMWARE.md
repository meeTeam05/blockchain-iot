# Firmware incidents (Schema v2)

`core/incident` is feature-gated by `SA_ENABLE_BLOCKCHAIN_INCIDENT`. It accepts only `SAFE → EARLY_WARNING`, `SAFE → EXCEEDED`, and `EARLY_WARNING → EXCEEDED`. In `ai.c`, the established buzzer pattern is queued first; the copied Gas EWS snapshot is then handed to the lower-priority incident task. Heartbeats, warmup, falling/same levels, invalid trigger-gas bits, and invalid clocks are rejected.

The snapshot uses raw T/RH/CO/NO2 validity bits, derived validity bits, model-output validity bits, source masks, levels, and the SHA-256 of the embedded `.tflite`. Values not covered by a validity bit are zero. Evidence is encoded as 32-byte Solidity ABI words and Keccak-256, never JSON. `incidentId` uses packed `AIR-INCIDENT-2 || deviceIdHash || uint64(sequence)`. The EIP-712 domain is `AirSafetyLog` / `1` / Sepolia `11155111` and requires the configured `SA_INCIDENT_VERIFYING_CONTRACT` address.

`device_id` is the lowercase Wi-Fi STA MAC only; the component rejects any
other string before computing `device_id_hash`. Calibration is read atomically
from `calib/gas_calib` (`r0_co`, `r0_no2`, `revision`) and commits the R0
update and incremented persistent revision together. Its exact hash material
is `AIR-CAL-1|co_r0_q10000=<CO>|no2_r0_q10000=<NO2>|revision=<REV>` and is
SHA-256, not JSON. Existing devices with legacy R0-only records read as
revision 0; their next successful calibration creates and commits revision 1.

Time source is set only after successful SNTP (`1`) or a valid DS3231 read (`2`). Build-time/system-clock fallback is not accepted.

## Durable storage and delivery

Default NVS namespace `incidentv2` stores `sequence` (`uint64`), signer material (`signer`), and queue records `q0` through `q7` (the configured capacity defaults to four). The sequence is committed before it is returned, so a power loss can create a gap but cannot reuse a sequence. A complete signed record, including exact transport bytes, is committed before QoS 1 MQTT publication. The worker retries exact records every 60 seconds after boot/offline failures. Valid ACKs must be schema `2`, `accepted:true`, and match both persisted `incident_id` and `evidence_hash`; every other ACK is retained.

The queue is bounded. A full queue increments a safe operational counter and does not block the buzzer or state publish.

## Signer lifecycle

Private keys are never compiled or logged. `incident_provision_signer()` refuses to store a key unless ESP-IDF NVS Encryption is enabled (`CONFIG_NVS_ENCRYPTION=y`); this repository's checked-in defaults do not enable it, so deployment must provision encrypted NVS first. Rotation refuses while queue entries remain. Physical factory reset clears only the `wifi_prov` and `device` namespaces; it preserves the encrypted `incidentv2` signer, sequence, and pending queue. Signer removal remains an explicit revoke operation, and signer replacement remains an explicit rotate/provision operation coordinated with the backend/operator. Historical queued records are never re-signed.

## Build/test status

Useful commands once ESP-IDF is installed:

```sh
cd firmware
idf.py build
idf.py -B build-incident-enabled \
  -D SDKCONFIG=sdkconfig.incident.generated \
  -D SDKCONFIG_DEFAULTS='sdkconfig.defaults;sdkconfig.incident' build
```

`sdkconfig.incident` enables deterministic secp256k1, encrypted NVS and HMAC
key protection, but contains no signer material and never burns an eFuse.
Provision the selected HMAC block and signer using the board provisioning
procedure before deployment. Hardware delivery is intentionally not claimed by
this document.
