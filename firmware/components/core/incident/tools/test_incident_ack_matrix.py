#!/usr/bin/env python3
"""Exercise the production MQTT ACK dispatch, parser, queue lookup, and NVS erase."""
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[5]
TOOLS = pathlib.Path(__file__).resolve().parent
BIN = pathlib.Path("/tmp/incident_ack_matrix")


def assert_production_route() -> None:
    mqtt = (ROOT / "firmware/components/general/sa_mqtt/mqtt.c").read_text()
    sysload = (ROOT / "firmware/components/core/sysload/sysload.c").read_text()
    if "strcmp(topic, s_incident_ack_topic) == 0" not in mqtt:
        raise AssertionError("production MQTT incident ACK topic route missing")
    if "mqtt_dispatch_incident_ack(s_incident_ack_cb, payload)" not in mqtt:
        raise AssertionError("production MQTT ACK callback dispatch missing")
    if "mqtt_register_incident_ack_cb(incident_handle_ack)" not in sysload:
        raise AssertionError("incident ACK handler is not registered during startup")


def main() -> int:
    idf_path = pathlib.Path(os.environ.get("IDF_PATH", pathlib.Path.home() / "esp/esp-idf"))
    cjson = idf_path / "components/json/cJSON"
    assert_production_route()
    subprocess.run([
        "gcc", "-std=c99", "-Wall", "-Wextra", "-Werror", "-Wno-unused-function",
        "-I", str(TOOLS / "include"), "-I", str(TOOLS.parent / "include"),
        "-I", str(ROOT / "firmware/components/general/sa_mqtt/include"),
        "-I", str(cjson), str(TOOLS / "incident_ack_matrix_cli.c"),
        str(cjson / "cJSON.c"), "-lcrypto", "-lm", "-o", str(BIN),
    ], check=True)
    subprocess.run([str(BIN)], check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
