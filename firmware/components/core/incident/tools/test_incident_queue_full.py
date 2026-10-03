#!/usr/bin/env python3
"""Exercise production work-queue and persistent-queue saturation paths."""
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[5]
TOOLS = pathlib.Path(__file__).resolve().parent
SOURCE = TOOLS / "incident_queue_full_cli.c"
BIN = pathlib.Path("/tmp/incident_queue_full")
ALT_BIN = pathlib.Path("/tmp/incident_queue_full_capacity_2")


def compile_runner(output: pathlib.Path, capacity: int | None = None) -> None:
    idf_path = pathlib.Path(os.environ.get("IDF_PATH", pathlib.Path.home() / "esp/esp-idf"))
    cjson = idf_path / "components/json/cJSON"
    command = ["gcc", "-std=c99", "-Wall", "-Wextra", "-Werror", "-Wno-unused-function"]
    if capacity is not None:
        command.append(f"-DCONFIG_SA_INCIDENT_QUEUE_CAPACITY={capacity}")
    command += [
        "-I", str(TOOLS / "include"), "-I", str(TOOLS.parent / "include"),
        "-I", str(ROOT / "firmware/components/core/ai/include"),
        "-I", str(ROOT / "firmware/components/general/buzzer/include"),
        "-I", str(ROOT / "firmware/components/general/sa_mqtt/include"),
        "-I", str(cjson), str(SOURCE), str(cjson / "cJSON.c"),
        "-lcrypto", "-lm", "-o", str(output),
    ]
    subprocess.run(command, check=True)


def assert_production_local_path() -> None:
    source = (ROOT / "firmware/components/core/ai/ai.c").read_text()
    start = source.index("if (s_level > prev) {")
    end = source.index("    if (changed ||", start)
    if "ai_alarm_dispatch((uint8_t)prev" not in source[start:end]:
        raise AssertionError("AI upward transition does not use production alarm dispatch")


def main() -> int:
    assert_production_local_path()
    compile_runner(ALT_BIN, capacity=2)
    alternate = subprocess.run([str(ALT_BIN)], capture_output=True, text=True)
    if alternate.returncode != 0 or "QUEUE_FULL_TEST: PASS" not in alternate.stdout:
        sys.stderr.write(alternate.stdout + alternate.stderr)
        return 1
    compile_runner(BIN)
    subprocess.run([str(BIN)], check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
