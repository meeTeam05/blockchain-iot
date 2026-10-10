#!/usr/bin/env python3
"""Run the production incident candidate gate and AI ordering invariant."""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[5]
TOOLS = pathlib.Path(__file__).resolve().parent
BIN = pathlib.Path("/tmp/incident_transition_matrix")


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def local_safety_ordering() -> None:
    ai_source = (ROOT / "iot_code/components/core/ai/ai.c").read_text()
    block_start = ai_source.index("if (s_level > prev) {")
    block_end = ai_source.index("    if (changed ||", block_start)
    if "ai_alarm_dispatch((uint8_t)prev" not in ai_source[block_start:block_end]:
        raise AssertionError("AI upward transition does not use alarm dispatch")
    dispatch = (ROOT / "iot_code/components/core/ai/ai_alarm_dispatch.c").read_text()
    if dispatch.index("buzzer_beep_pattern") > dispatch.index("incident_on_gas_ews_transition"):
        raise AssertionError("incident submission precedes local buzzer action")
    if "local alert unaffected" not in (ROOT / "iot_code/components/core/incident/incident.c").read_text():
        raise AssertionError("queue failure safety invariant missing")
    print("LOCAL SAFETY ORDERING: PASS")


def main() -> int:
    run(["gcc", "-std=c99", "-Wall", "-Wextra", "-Werror", "-Wno-unused-function",
         "-I", str(TOOLS / "include"), "-I", str(TOOLS.parent / "include"),
         str(TOOLS / "incident_transition_cli.c"), "-lcrypto", "-o", str(BIN)])
    run([str(BIN)])
    local_safety_ordering()
    print("TRANSITION_MATRIX_TEST: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
