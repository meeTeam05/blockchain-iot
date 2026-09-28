#!/usr/bin/env python3
"""Exercise the firmware EIP-712 signer/recovery against both v2 fixtures.

The fixture key is read only at test time and passed to a host executable. The
production firmware never compiles this file or the fixture key.
"""
import json
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[5]
TOOLS = pathlib.Path(__file__).resolve().parent
BUILD = pathlib.Path("/tmp/incident-mbedtls-host")
BIN = pathlib.Path("/tmp/incident_signature_vectors")
IDF_PATH = pathlib.Path(os.environ.get("IDF_PATH", pathlib.Path.home() / "esp/esp-idf"))
MBEDTLS = IDF_PATH / "components/mbedtls/mbedtls"
FIXTURES = [
    ROOT / "docs/test-vectors/incident-v2-model-early-warning.json",
    ROOT / "docs/test-vectors/incident-v2-qcvn-exceeded.json",
]


def run(command: list[str]) -> str:
    return subprocess.check_output(command, text=True, stderr=subprocess.STDOUT)


def build_runner() -> None:
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
        "-I", str(MBEDTLS / "include"), str(TOOLS / "incident_signature_cli.c"),
        str(BUILD / "library/libmbedcrypto.a"), "-lcrypto", "-lpthread", "-o", str(BIN),
    ], check=True)


def recover(digest: str, signature: bytes) -> str:
    return run([str(BIN), "recover", digest, "0x" + signature.hex()]).strip()


def expect_rejected_or_other(label: str, digest: str, signature: bytes, signer: str) -> None:
    recovered = recover(digest, signature)
    if recovered != "invalid" and recovered.lower() == signer.lower():
        raise AssertionError(f"{label}: tampered signature still recovered the expected signer")


def verify_vector(number: int, path: pathlib.Path) -> None:
    data = json.loads(path.read_text())
    expected = data["expected"]
    # Run the exact firmware signing routine three independent times. Each CLI
    # invocation also signs twice internally, so this catches accidental RNG
    # dependence across process and call boundaries.
    runs = []
    for _ in range(3):
        output = run([str(BIN), str(number), data["test_private_key_only"], expected["signature"]])
        runs.append(dict(line.split("=", 1) for line in output.splitlines() if "=" in line))
    actual = runs[0]
    runs_identical = all(item.get("signature") == actual.get("signature") for item in runs)
    signature = bytes.fromhex(expected["signature"][2:])

    checks = {
        "digest": actual.get("digest") == expected["eip712_digest"],
        "r": actual.get("signature", "")[2:66] == expected["signature"][2:66],
        "s": actual.get("signature", "")[66:130] == expected["signature"][66:130],
        "v": actual.get("signature", "")[130:132] == expected["signature"][130:132],
        "signature": actual.get("signature") == expected["signature"],
        "deterministic": actual.get("deterministic") == "true" and runs_identical,
        "v format": signature[64] in (27, 28),
        "low-s": actual.get("low_s") == "true",
        "recovered signer": actual.get("recovered", "").lower() == expected["signer"].lower(),
    }
    failed = [name for name, result in checks.items() if not result]
    print(f"VECTOR: {path.stem}")
    print(f"digest:\n  expected: {expected['eip712_digest']}\n  actual:   {actual.get('digest', '<missing>')}")
    print(f"r:\n  expected: 0x{expected['signature'][2:66]}\n  actual:   0x{actual.get('signature', '')[2:66]}")
    print(f"s:\n  expected: 0x{expected['signature'][66:130]}\n  actual:   0x{actual.get('signature', '')[66:130]}")
    print(f"v:\n  expected: 0x{expected['signature'][130:132]}\n  actual:   0x{actual.get('signature', '')[130:132]}")
    print(f"signature:\n  expected: {expected['signature']}\n  actual:   {actual.get('signature', '<missing>')}")
    print(f"signer:\n  expected: {expected['signer']}\n  actual:   {actual.get('recovered', '<missing>')}")
    for name, result in checks.items():
        print(f"  {name}: {'PASS' if result else 'FAIL'}")
    if failed:
        raise AssertionError(f"{path.name}: {', '.join(failed)}")

    # Negative recovery checks use the production recovery helper in the host
    # binary; they do not use a Python crypto implementation.
    modified = bytearray(signature); modified[0] ^= 0x01
    expect_rejected_or_other("flip r", expected["eip712_digest"], modified, expected["signer"])
    modified = bytearray(signature); modified[32] ^= 0x01
    expect_rejected_or_other("flip s", expected["eip712_digest"], modified, expected["signer"])
    modified = bytearray(signature); modified[64] = 55 - modified[64]  # 27 <-> 28
    expect_rejected_or_other("flip v", expected["eip712_digest"], modified, expected["signer"])
    modified = bytearray(signature); modified[64] = 0
    if recover(expected["eip712_digest"], modified) != "invalid":
        raise AssertionError("invalid v was accepted")
    modified = bytearray(signature); modified[:32] = b"\0" * 32
    if recover(expected["eip712_digest"], modified) != "invalid":
        raise AssertionError("zero r was accepted")
    modified = bytearray(signature); modified[32:64] = b"\0" * 32
    if recover(expected["eip712_digest"], modified) != "invalid":
        raise AssertionError("zero s was accepted")
    # n - s is the mathematically equivalent high-s form. It must be refused.
    order = int("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", 16)
    modified = bytearray(signature)
    modified[32:64] = (order - int.from_bytes(signature[32:64], "big")).to_bytes(32, "big")
    if recover(expected["eip712_digest"], modified) != "invalid":
        raise AssertionError("high-s signature was accepted")
    print("  deterministic three-run check: PASS")
    print("  negative r/s/v/zero/high-s checks: PASS\n")


def main() -> int:
    build_runner()
    for index, fixture in enumerate(FIXTURES, 1):
        verify_vector(index, fixture)
    print("SIGNER_SIGNATURE_EXACT_TEST: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
