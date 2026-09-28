#!/usr/bin/env python3
"""Run Schema-v2 tamper and ABI negatives against production incident.c code."""
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[5]
TOOLS = pathlib.Path(__file__).resolve().parent
BUILD = pathlib.Path("/tmp/incident-mbedtls-host")
BIN = pathlib.Path("/tmp/incident_tamper_abi")
IDF_PATH = pathlib.Path(os.environ.get("IDF_PATH", pathlib.Path.home() / "esp/esp-idf"))
MBEDTLS = IDF_PATH / "components/mbedtls/mbedtls"


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def main() -> int:
    if not MBEDTLS.is_dir():
        raise SystemExit(f"ESP-IDF mbedTLS source not found: {MBEDTLS}; set IDF_PATH.")
    run(["cmake", "-S", str(MBEDTLS), "-B", str(BUILD), "-DENABLE_PROGRAMS=OFF",
         "-DENABLE_TESTING=OFF", "-DUSE_SHARED_MBEDTLS_LIBRARY=OFF",
         "-DUSE_STATIC_MBEDTLS_LIBRARY=ON"])
    run(["cmake", "--build", str(BUILD), "--target", "mbedcrypto", "-j2"])
    run(["gcc", "-std=c99", "-Wall", "-Wextra", "-Werror", "-Wno-unused-function",
         "-I", str(TOOLS / "include"), "-I", str(TOOLS.parent / "include"),
         "-I", str(MBEDTLS / "include"), str(TOOLS / "incident_tamper_abi_cli.c"),
         str(BUILD / "library/libmbedcrypto.a"), "-lcrypto", "-lpthread", "-o", str(BIN)])
    run([str(BIN)])
    run([sys.executable, str(TOOLS / "test_incident_vectors.py")])
    print("GOLDEN VECTOR REGRESSION:\nPASS\n")
    run([sys.executable, str(TOOLS / "test_incident_signatures.py")])
    print("SIGNATURE REGRESSION:\nPASS\n")
    print("TAMPER_ABI_NEGATIVE_TEST: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
