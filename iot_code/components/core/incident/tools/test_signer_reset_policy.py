#!/usr/bin/env python3
"""Guard the production signer against implicit/default-NVS erase paths."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[5]
FIRMWARE = ROOT / "firmware"


def source(path: str) -> str:
    return (FIRMWARE / path).read_text(encoding="utf-8")


factory = source("components/general/factory_reset/factory_reset.c")
config = source("components/config/config.c")
ble = source("components/general/ble_prov/ble_prov.c")
sysload = source("components/core/sysload/sysload.c")
incident = source("components/core/incident/incident.c")
partitions = source("main/partitions.csv")

# Physical reset is namespace-scoped: it may clear Wi-Fi and the shared device
# namespace, but it must never erase the default partition containing incidentv2.
assert "config_factory_reset_erase_provisioning()" in factory
assert "nvs_flash_erase" not in factory
reset_erase = config.split("esp_err_t config_factory_reset_erase_provisioning(void)", 1)[1]
reset_erase = reset_erase.split("esp_err_t config_get_mqtt_creds", 1)[0]
assert "erase_namespace(SA_NVS_WIFI_NAMESPACE)" in reset_erase
assert "erase_namespace(SA_NVS_DEVICE_NAMESPACE)" in reset_erase
assert "incidentv2" not in reset_erase

# BLE credential reset owns only wifi_prov; it cannot reach incidentv2.
ble_reset = ble.split("esp_err_t ble_prov_reset(void)", 1)[1]
ble_reset = ble_reset.split("static void cleanup_start_failure", 1)[0]
assert "nvs_open(SA_NVS_WIFI_NAMESPACE" in ble_reset
assert "nvs_erase_all(h)" in ble_reset
assert "incidentv2" not in ble_reset
assert "nvs_flash_erase" not in ble_reset

# An incident-enabled normal boot must fail closed instead of accepting the
# destructive default-NVS recovery used by non-incident builds.
nvs_init = sysload.split("static void init_nvs_stage(void)", 1)[1]
nvs_init = nvs_init.split("static void NETWORK_ONLY_UNUSED init_network_stack_stage", 1)[0]
assert "#if SA_ENABLE_BLOCKCHAIN_INCIDENT" in nvs_init
assert "refusing automatic erase to preserve signer and incidents" in nvs_init

# Explicit revocation remains the sole production path that deletes signer.
revoke = incident.split("esp_err_t incident_revoke_local_signer(void)", 1)[1]
revoke = revoke.split("#endif /* !INCIDENT_HOST_TEST", 1)[0]
assert "nvs_erase_key(h,INCIDENT_KEY_SIGNER)" in revoke
assert "#if CONFIG_NVS_ENCRYPTION" in incident
assert "signer unavailable: encrypted NVS is not enabled" in incident

# Calibration remains on its dedicated partition and keeps its existing boot
# initialization/recovery behavior.
assert "calib,    data, nvs" in partitions
assert "nvs_flash_init_partition(SA_NVS_CALIB_PARTITION)" in nvs_init
assert "nvs_flash_erase_partition(SA_NVS_CALIB_PARTITION)" in nvs_init
assert "nvs_flash_erase_partition" not in factory

print("signer/factory-reset NVS policy: PASS")
