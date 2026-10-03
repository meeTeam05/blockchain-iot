# Task 1 Signer Provisioning Bench Tool

## Purpose

This test-only UART tool provides an explicit first-time bridge to the existing
production `incident_provision_signer()` API. It imports one operator-generated
32-byte secp256k1 private key into the already encrypted default NVS partition.
It does not implement signing, key generation, rotation, or NVS storage itself.

## Security boundaries

- The feature is disabled by default and must never be enabled in production.
- It never generates, logs, or echoes the private key from firmware.
- It rejects malformed, zero, and out-of-range secp256k1 scalars.
- It refuses to overwrite an existing signer and does not call the rotation API.
- It does not erase NVS/flash, perform factory reset, or access eFuse secrets.
- The bounded UART command buffer and decoded key are compiler-safely zeroized.
- No command history is implemented. The host terminal still receives the key
  pasted by the operator, so use a controlled bench machine and close/clear the
  terminal session afterwards according to local secret-handling policy.

## Kconfig

Enable `CONFIG_SA_INCIDENT_SIGNER_PROVISION_BENCH=y` under **Smart Air
Configuration → Blockchain incidents → UART Signer Provisioning Bench Tool
(TEST ONLY)**. It requires blockchain incidents, NVS encryption, and the UART
console. Its default is `n`. The dedicated
`sdkconfig.incident.signer-provision.bench` overlay explicitly enables it and
contains no key material.

For the offline bench profile:

```bash
cd firmware
source "$HOME/esp/esp-idf/export.sh"
idf.py -B build-incident-signer-provision \
  -D SDKCONFIG=sdkconfig.incident.signer-provision.generated \
  -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident;sdkconfig.incident.bench;sdkconfig.incident.signer-provision.bench' \
  reconfigure
```

Verify that the opt-in took effect, and then build:

```bash
grep '^CONFIG_SA_INCIDENT_SIGNER_PROVISION_BENCH=y$' \
  sdkconfig.incident.signer-provision.generated
idf.py -B build-incident-signer-provision \
  -D SDKCONFIG=sdkconfig.incident.signer-provision.generated \
  -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident;sdkconfig.incident.bench;sdkconfig.incident.signer-provision.bench' \
  build
```

## Command syntax

```text
incident signer-provision <64-hex-private-key>
```

The placeholder means exactly 64 hexadecimal characters without `0x`. No real
key is included in this repository or document. Firmware does not echo UART
input and stores no command history.

## Precondition

- Encrypted NVS is enabled and successfully initialized.
- No signer is currently provisioned.
- `CONFIG_SA_INCIDENT_SIGNER_PROVISION_BENCH=y`.

## Host-side bench key generation

Generate a fresh scalar on the controlled host using Python's operating-system
CSPRNG and rejection-free sampling inside the secp256k1 range:

```bash
python3 - <<'PY'
import secrets
n = int("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", 16)
private_key = secrets.randbelow(n - 1) + 1
print(f"{private_key:064x}")
PY
```

Do not save the output in the repository, source code, shell command history,
or bench log. Do not use keys from `docs/test-vectors`.

## Provisioning procedure

1. Build and flash the dedicated bench image only after reviewing its generated
   config and selecting the correct serial port. Do not erase flash or NVS:

   ```bash
   export SA_BENCH_PORT=/dev/serial/by-id/<your-ESP32-S3-device>
   idf.py -B build-incident-signer-provision -p "$SA_BENCH_PORT" flash monitor
   ```

2. Confirm encrypted NVS is ready, `signer available=no`, and this line appears:

   ```text
   SIGNER_PROV: UART command ready; firmware input echo is disabled
   ```

3. Generate a new bench-only scalar using the host command above.
4. In the UART monitor, type/paste the command syntax with that scalar exactly
   once and press Enter. The firmware never prints the submitted command.
5. Record only the returned public signer address. Do not record UART input.
6. Reboot manually with the EN/reset button. Do not erase or factory reset.
7. Confirm the post-reboot address exactly matches the address from step 5.

## Expected UART output

Before:

```text
INC_BENCH: signer available=no
```

After provisioning:

```text
SIGNER_PROV: provisioning success
SIGNER_PROV: signer address=0x...
```

If a signer already exists, no write occurs:

```text
SIGNER_PROV: signer already provisioned
SIGNER_PROV: signer address=0x...
```

After reboot:

```text
INC_BENCH: signer available=yes
INC_BENCH: signer address=0x...
```

## Disabling the tool

Return to menuconfig, set `CONFIG_SA_INCIDENT_SIGNER_PROVISION_BENCH=n`, save,
rebuild, and deploy the resulting image. When disabled, the UART task, parser,
command strings, and provisioning call path are not compiled into the incident
component.

## Production warning

This UART provisioning command must not be enabled in production firmware. It
is an unauthenticated physical-bench operator mechanism intended only for the
first controlled signer import into encrypted NVS.
