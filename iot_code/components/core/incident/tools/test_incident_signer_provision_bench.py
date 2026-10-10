#!/usr/bin/env python3
"""Host parser/lifecycle tests for the test-only UART signer provisioner."""
import os
import pathlib
import subprocess
import sys

TOOLS = pathlib.Path(__file__).resolve().parent
BUILD = pathlib.Path("/tmp/incident-mbedtls-host")
BIN = pathlib.Path("/tmp/incident_signer_provision_bench")
IDF_PATH = pathlib.Path(os.environ.get("IDF_PATH", pathlib.Path.home() / "esp/esp-idf"))
MBEDTLS = IDF_PATH / "components/mbedtls/mbedtls"


def main() -> int:
    if not MBEDTLS.is_dir():
        raise SystemExit(f"ESP-IDF mbedTLS source not found: {MBEDTLS}; set IDF_PATH.")
    subprocess.run([
        "cmake", "-S", str(MBEDTLS), "-B", str(BUILD), "-DENABLE_PROGRAMS=OFF",
        "-DENABLE_TESTING=OFF", "-DUSE_SHARED_MBEDTLS_LIBRARY=OFF",
        "-DUSE_STATIC_MBEDTLS_LIBRARY=ON",
    ], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["cmake", "--build", str(BUILD), "--target", "mbedcrypto", "-j2"],
                   check=True, stdout=subprocess.DEVNULL)
    subprocess.run([
        "gcc", "-std=c99", "-Wall", "-Wextra", "-Werror", "-Wno-unused-function",
        "-I", str(TOOLS / "include"), "-I", str(TOOLS.parent / "include"),
        "-I", str(MBEDTLS / "include"), str(TOOLS / "incident_signer_provision_bench_cli.c"),
        str(BUILD / "library/libmbedcrypto.a"), "-lpthread", "-o", str(BIN),
    ], check=True)
    subprocess.run([str(BIN)], check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
