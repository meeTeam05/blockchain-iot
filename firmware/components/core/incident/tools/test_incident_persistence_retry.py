#!/usr/bin/env python3
"""Run production incident NVS/retry paths against a transactional host shim."""
import pathlib
import subprocess
import sys

TOOLS = pathlib.Path(__file__).resolve().parent
BIN = pathlib.Path("/tmp/incident_persistence_retry")


def main() -> int:
    subprocess.run([
        "gcc", "-std=c99", "-Wall", "-Wextra", "-Werror", "-Wno-unused-function",
        "-I", str(TOOLS / "include"), "-I", str(TOOLS.parent / "include"),
        str(TOOLS / "incident_persistence_cli.c"), "-lcrypto", "-o", str(BIN),
    ], check=True)
    subprocess.run([str(BIN)], check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
