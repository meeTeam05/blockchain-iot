const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
  ATTESTATION_TYPES,
  EVIDENCE_FIELDS,
  claimFromEvidence,
  computeIncidentId,
  domainFor,
  evidenceFromVector,
  hashEvidence,
  loadVectors,
} = require("./helpers");

const vectors = loadVectors();
const VECTOR_ADDRESS = vectors[0].domain.verifying_contract;

// Place the compiled AirSafetyLog at the vector's verifying_contract so the
// EIP-712 domain equals the one the vectors were signed with. The constructor
// does not run there, so DEFAULT_ADMIN_ROLE is written directly into
// AccessControl's `_roles` mapping (slot 0).
async function deployAtVectorAddress(admin) {
  const Factory = await ethers.getContractFactory("AirSafetyLog");
  const template = await Factory.deploy(admin.address);
  const code = await ethers.provider.getCode(await template.getAddress());
  await network.provider.send("hardhat_setCode", [VECTOR_ADDRESS, code]);

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const roleSlot = ethers.keccak256(coder.encode(["bytes32", "uint256"], [ethers.ZeroHash, 0]));
  const memberSlot = ethers.keccak256(coder.encode(["address", "bytes32"], [admin.address, roleSlot]));
  await network.provider.send("hardhat_setStorageAt", [VECTOR_ADDRESS, memberSlot, ethers.toBeHex(1, 32)]);

  const log = Factory.attach(VECTOR_ADDRESS);
  expect(await log.hasRole(ethers.ZeroHash, admin.address)).to.equal(true);
  return log;
}

describe("Schema v2 test vectors", function () {
  for (const v of vectors) {
    describe(v.file, function () {
      const e = evidenceFromVector(v);

      it("recomputes identity, firmware and calibration hashes", function () {
        expect(ethers.keccak256(ethers.toUtf8Bytes(v.transport.device_id))).to.equal(v.evidence.device_id_hash);
        expect(ethers.keccak256(ethers.toUtf8Bytes(v.transport.firmware_version))).to.equal(
          v.evidence.firmware_version_hash
        );
        expect(ethers.sha256(ethers.toUtf8Bytes(v.transport.calibration_canonical))).to.equal(
          v.evidence.calibration_hash
        );
        expect(computeIncidentId(e.deviceIdHash, e.sequence)).to.equal(v.evidence.incident_id);
      });

      it("recomputes evidence hash, digest and signer off-chain", function () {
        const evidenceHash = hashEvidence(e);
        expect(evidenceHash).to.equal(v.expected.evidence_hash);
        const claim = claimFromEvidence(e, evidenceHash);
        const domain = domainFor(v.domain.verifying_contract, BigInt(v.domain.chain_id));
        expect(ethers.TypedDataEncoder.hash(domain, ATTESTATION_TYPES, claim)).to.equal(v.expected.eip712_digest);
        expect(ethers.verifyTypedData(domain, ATTESTATION_TYPES, claim, v.expected.signature)).to.equal(
          v.expected.signer
        );
        expect(new ethers.Wallet(v.test_private_key_only).address).to.equal(v.expected.signer);
      });

      it("matches the contract's hashEvidence, computeIncidentId and typehashes", async function () {
        const [admin] = await ethers.getSigners();
        const log = await (await ethers.getContractFactory("AirSafetyLog")).deploy(admin.address);
        expect(await log.EVIDENCE_TYPEHASH()).to.equal(ethers.id(v.type_strings.incident_evidence));
        expect(await log.ATTESTATION_TYPEHASH()).to.equal(ethers.id(v.type_strings.incident_attestation));
        expect(await log.hashEvidence(e)).to.equal(v.expected.evidence_hash);
        expect(await log.computeIncidentId(e.deviceIdHash, e.sequence)).to.equal(v.evidence.incident_id);
      });

      it("changes the evidence hash when any single evidence field is tampered", async function () {
        const [admin] = await ethers.getSigners();
        const log = await (await ethers.getContractFactory("AirSafetyLog")).deploy(admin.address);
        for (const [name, type] of EVIDENCE_FIELDS) {
          const t = { ...e };
          t[name] = type === "bytes32" ? ethers.toBeHex(BigInt(e[name]) ^ 1n, 32) : e[name] ^ 1n;
          expect(await log.hashEvidence(t), name).to.not.equal(v.expected.evidence_hash);
        }
      });
    });
  }

  it("does not confuse source masks / valid masks between the two vectors", function () {
    const [early, exceeded] = vectors.map(evidenceFromVector);
    // Model-triggered early warning: CO source = model (bit 2), both model outputs valid.
    expect(early.coAlarmSourceMask).to.equal(4n);
    expect(early.modelProbabilityValidMask).to.equal(3n);
    // Rule-triggered exceed: CO source = QCVN rule (bit 0), model output invalid -> 0 bps is not "probability 0".
    expect(exceeded.coAlarmSourceMask).to.equal(1n);
    expect(exceeded.modelProbabilityValidMask).to.equal(0n);
    expect(exceeded.coModelProbabilityBps).to.equal(0n);

    // Flipping only the valid mask (keeping 0 bps) must change the committed hash.
    const forged = { ...exceeded, modelProbabilityValidMask: 3n };
    expect(hashEvidence(forged)).to.not.equal(vectors[1].expected.evidence_hash);
    const forgedSource = { ...exceeded, coAlarmSourceMask: 4n };
    expect(hashEvidence(forgedSource)).to.not.equal(vectors[1].expected.evidence_hash);
  });

  describe("on-chain verification at the vector domain", function () {
    let log, relayer;

    // loadFixture snapshots/reverts chain state, so the fixed vector address
    // starts clean in every test.
    async function vectorDomainFixture() {
      const [admin, relayer, owner] = await ethers.getSigners();
      const log = await deployAtVectorAddress(admin);
      await log.connect(admin).grantRole(await log.DEVICE_MANAGER_ROLE(), admin.address);
      await log.connect(admin).grantRole(await log.RELAYER_ROLE(), relayer.address);
      await log.connect(admin).registerDevice(vectors[0].evidence.device_id_hash, vectors[0].expected.signer, owner.address);
      return { log, relayer };
    }

    beforeEach(async function () {
      ({ log, relayer } = await loadFixture(vectorDomainFixture));
    });

    it("exposes the vector domain separator and EIP-712 digest", async function () {
      for (const v of vectors) {
        const claim = claimFromEvidence(evidenceFromVector(v));
        expect(await log.attestationDigest(claim)).to.equal(v.expected.eip712_digest);
      }
      expect(await log.domainSeparator()).to.equal(
        ethers.TypedDataEncoder.hashDomain(domainFor(VECTOR_ADDRESS))
      );
    });

    it("logs both vector incidents in sequence order with the vector signatures", async function () {
      for (const v of vectors) {
        const e = evidenceFromVector(v);
        const claim = claimFromEvidence(e);
        const key = await log.computeIncidentKey(claim.deviceIdHash, claim.incidentId);
        await expect(log.connect(relayer).logIncident(claim, v.expected.signature))
          .to.emit(log, "IncidentLogged")
          .withArgs(
            key,
            claim.deviceIdHash,
            claim.incidentId,
            claim.sequence,
            claim.observedAt,
            claim.severity,
            v.expected.evidence_hash,
            v.expected.signer
          )
          .and.not.to.emit(log, "EmergencyTriggered");

        const stored = await log.getIncident(key);
        expect(stored.evidenceHash).to.equal(v.expected.evidence_hash);
        expect(stored.status).to.equal(1n); // Logged
      }
      expect((await log.getDevice(vectors[0].evidence.device_id_hash)).lastSequence).to.equal(44n);
    });

    it("rejects the vector signature when any attestation field is tampered", async function () {
      const v = vectors[0];
      const claim = claimFromEvidence(evidenceFromVector(v));
      const tampered = [
        ["observedAt", { observedAt: claim.observedAt + 1n }, "WrongSigner"],
        ["severity", { severity: 2n }, "WrongSigner"],
        ["evidenceHash", { evidenceHash: vectors[1].expected.evidence_hash }, "WrongSigner"],
        ["incidentId", { incidentId: vectors[1].evidence.incident_id }, "IncidentIdMismatch"],
        ["sequence", { sequence: claim.sequence + 1n }, "IncidentIdMismatch"],
      ];
      for (const [field, patch, error] of tampered) {
        await expect(log.connect(relayer).logIncident({ ...claim, ...patch }, v.expected.signature), field)
          .to.be.revertedWithCustomError(log, error);
      }
      // A consistent (id, sequence) pair that was not signed must also fail.
      const moved = { ...claim, sequence: 99n, incidentId: computeIncidentId(claim.deviceIdHash, 99n) };
      await expect(log.connect(relayer).logIncident(moved, v.expected.signature)).to.be.revertedWithCustomError(
        log,
        "WrongSigner"
      );
    });

    it("rejects an evidence-hash computed from tampered evidence", async function () {
      const v = vectors[1];
      const e = { ...evidenceFromVector(v), modelProbabilityValidMask: 3n };
      const claim = claimFromEvidence(e);
      await expect(log.connect(relayer).logIncident(claim, v.expected.signature)).to.be.revertedWithCustomError(
        log,
        "WrongSigner"
      );
    });
  });
});
