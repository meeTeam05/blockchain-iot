#!/usr/bin/env python3
"""Execute the production incident codec against both Schema-v2 fixtures."""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[5]
TOOLS = pathlib.Path(__file__).resolve().parent
BIN = pathlib.Path("/tmp/test_incident_vectors")

subprocess.run([
    "gcc", "-std=c99", "-Wall", "-Wextra", "-Wno-unused-function",
    "-I", str(TOOLS / "include"),
    "-I", str(TOOLS.parent / "include"),
    str(TOOLS / "incident_hash_cli.c"), "-o", str(BIN), "-lcrypto",
], check=True)

fixtures = [
    ROOT / "docs/test-vectors/incident-v2-model-early-warning.json",
    ROOT / "docs/test-vectors/incident-v2-qcvn-exceeded.json",
]
for index, path in enumerate(fixtures, 1):
    data = json.loads(path.read_text())
    actual = subprocess.check_output([str(BIN), str(index)], text=True).splitlines()
    expected = data["evidence"]
    wanted = [
        expected["device_id_hash"], expected["incident_id"],
        expected["firmware_version_hash"], expected["calibration_hash"],
        data["expected"]["evidence_hash"], data["expected"]["eip712_digest"],
    ]
    if actual != wanted:
        raise SystemExit(f"{path.name}: production codec mismatch\nactual={actual}\nexpected={wanted}")

    signature = bytes.fromhex(data["expected"]["signature"][2:])
    order_half = int("7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0", 16)
    assert len(signature) == 65 and signature[64] in (27, 28)
    assert 0 < int.from_bytes(signature[32:64], "big") <= order_half

print("incident Schema-v2 production codec vectors: PASS")
