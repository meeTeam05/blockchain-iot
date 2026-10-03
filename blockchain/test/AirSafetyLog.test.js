const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { computeIncidentId, makeClaim, signClaim } = require("./helpers");

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const DEVICE = ethers.id("aa:bb:cc:dd:ee:ff");
const OTHER_DEVICE = ethers.id("11:22:33:44:55:66");

async function deployFixture() {
  const [admin, manager, relayer, owner, stranger, newOwner] = await ethers.getSigners();
  const log = await (await ethers.getContractFactory("AirSafetyLog")).deploy(admin.address);
  const address = await log.getAddress();
  await log.grantRole(await log.DEVICE_MANAGER_ROLE(), manager.address);
  await log.grantRole(await log.RELAYER_ROLE(), relayer.address);

  const deviceKey = ethers.Wallet.createRandom();
  await log.connect(manager).registerDevice(DEVICE, deviceKey.address, owner.address);

  async function submit(claim, key = deviceKey, from = relayer) {
    const sig = await signClaim(key, address, claim);
    return log.connect(from).logIncident(claim, sig);
  }

  return { log, address, admin, manager, relayer, owner, stranger, newOwner, deviceKey, submit };
}

describe("AirSafetyLog", function () {
  describe("deployment", function () {
    it("rejects a zero admin and grants DEFAULT_ADMIN_ROLE", async function () {
      const Factory = await ethers.getContractFactory("AirSafetyLog");
      await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(Factory, "ZeroAddress");
      const { log, admin } = await loadFixture(deployFixture);
      expect(await log.hasRole(ethers.ZeroHash, admin.address)).to.equal(true);
      expect(await log.SCHEMA_VERSION()).to.equal(2n);
      expect(await log.criticalPolicyEnabled()).to.equal(false);
    });

    it("uses EIP-712 domain AirSafetyLog / 1 / chain 11155111 / contract address", async function () {
      const { log, address } = await loadFixture(deployFixture);
      const d = await log.eip712Domain();
      expect(d.name).to.equal("AirSafetyLog");
      expect(d.version).to.equal("1");
      expect(d.chainId).to.equal(11155111n);
      expect(d.verifyingContract).to.equal(address);
    });
  });

  describe("logIncident", function () {
    it("logs a valid warning and stores only the minimal claim", async function () {
      const { log, submit, deviceKey } = await loadFixture(deployFixture);
      const claim = makeClaim(DEVICE, 1);
      const key = await log.computeIncidentKey(DEVICE, claim.incidentId);
      await expect(submit(claim))
        .to.emit(log, "IncidentLogged")
        .withArgs(key, DEVICE, claim.incidentId, 1n, claim.observedAt, 1n, claim.evidenceHash, deviceKey.address);
      const inc = await log.getIncident(key);
      expect(inc.deviceIdHash).to.equal(DEVICE);
      expect(inc.sequence).to.equal(1n);
      expect(inc.severity).to.equal(1n);
      expect(inc.status).to.equal(1n);
      expect(inc.signer).to.equal(deviceKey.address);
    });

    it("reserves sequence 0 and allows gaps from the production first sequence", async function () {
      const { log, submit } = await loadFixture(deployFixture);
      await expect(submit(makeClaim(DEVICE, 0)))
        .to.be.revertedWithCustomError(log, "InvalidSequence")
        .withArgs(0n);
      await expect(submit(makeClaim(DEVICE, 1))).to.emit(log, "IncidentLogged");
      await expect(submit(makeClaim(DEVICE, 5))).to.not.be.reverted;
      await expect(submit(makeClaim(DEVICE, 100))).to.not.be.reverted;
    });

    it("rejects a signature from a key that is not the device signer", async function () {
      const { log, submit, deviceKey } = await loadFixture(deployFixture);
      const attacker = ethers.Wallet.createRandom();
      await expect(submit(makeClaim(DEVICE, 1), attacker))
        .to.be.revertedWithCustomError(log, "WrongSigner")
        .withArgs(deviceKey.address, attacker.address);
    });

    it("rejects a signature bound to another contract / domain", async function () {
      const { log, relayer, deviceKey } = await loadFixture(deployFixture);
      const claim = makeClaim(DEVICE, 1);
      const sig = await signClaim(deviceKey, "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC", claim);
      await expect(log.connect(relayer).logIncident(claim, sig)).to.be.revertedWithCustomError(log, "WrongSigner");
    });

    it("rejects malformed, high-s and bad-v signatures", async function () {
      const { log, address, relayer, deviceKey } = await loadFixture(deployFixture);
      const claim = makeClaim(DEVICE, 1);
      const sig = ethers.Signature.from(await signClaim(deviceKey, address, claim));

      const highS = ethers.concat([sig.r, ethers.toBeHex(SECP256K1_N - BigInt(sig.s), 32), sig.v === 27 ? "0x1c" : "0x1b"]);
      const badV = ethers.concat([sig.r, sig.s, "0x01"]);
      const short = ethers.dataSlice(sig.serialized, 0, 64);
      for (const bad of [highS, badV, short, "0x"]) {
        await expect(log.connect(relayer).logIncident(claim, bad)).to.be.revertedWithCustomError(log, "InvalidSignature");
      }
    });

    it("rejects duplicates (replay of the same incident)", async function () {
      const { log, address, relayer, deviceKey } = await loadFixture(deployFixture);
      const claim = makeClaim(DEVICE, 7);
      const sig = await signClaim(deviceKey, address, claim);
      await log.connect(relayer).logIncident(claim, sig);
      const key = await log.computeIncidentKey(DEVICE, claim.incidentId);
      await expect(log.connect(relayer).logIncident(claim, sig))
        .to.be.revertedWithCustomError(log, "IncidentAlreadyLogged")
        .withArgs(key);
    });

    it("accepts unseen sequences out of order and rejects reuse", async function () {
      const { log, submit } = await loadFixture(deployFixture);
      const four = makeClaim(DEVICE, 4);
      const three = makeClaim(DEVICE, 3);

      await expect(submit(four)).to.emit(log, "IncidentLogged");
      await expect(submit(three)).to.emit(log, "IncidentLogged");
      expect(await log.sequenceUsed(DEVICE, 4)).to.equal(true);
      expect(await log.sequenceUsed(DEVICE, 3)).to.equal(true);
      expect((await log.getDevice(DEVICE)).lastSequence).to.equal(4n);

      await expect(submit(four)).to.be.revertedWithCustomError(log, "IncidentAlreadyLogged");
      await expect(submit(three)).to.be.revertedWithCustomError(log, "IncidentAlreadyLogged");

      const changedEvidence = makeClaim(DEVICE, 4, { evidenceHash: ethers.id("different evidence") });
      await expect(submit(changedEvidence)).to.be.revertedWithCustomError(log, "IncidentAlreadyLogged");

      const changedIncident = { ...makeClaim(DEVICE, 4), incidentId: computeIncidentId(DEVICE, 5n) };
      await expect(submit(changedIncident)).to.be.revertedWithCustomError(log, "IncidentIdMismatch");
    });

    it("accepts the uint64 maximum and still accepts a lower unseen sequence", async function () {
      const { log, submit } = await loadFixture(deployFixture);
      const max = (1n << 64n) - 1n;
      await expect(submit(makeClaim(DEVICE, max))).to.emit(log, "IncidentLogged");
      await expect(submit(makeClaim(DEVICE, 1))).to.emit(log, "IncidentLogged");
      expect((await log.getDevice(DEVICE)).lastSequence).to.equal(max);
    });

    it("tracks sequence independently per device", async function () {
      const { log, manager, owner, submit } = await loadFixture(deployFixture);
      const otherKey = ethers.Wallet.createRandom();
      await log.connect(manager).registerDevice(OTHER_DEVICE, otherKey.address, owner.address);
      await submit(makeClaim(DEVICE, 10));
      await expect(submit(makeClaim(OTHER_DEVICE, 1), otherKey)).to.not.be.reverted;
    });

    it("rejects a claim whose incidentId does not match (device, sequence)", async function () {
      const { log, submit } = await loadFixture(deployFixture);
      const claim = { ...makeClaim(DEVICE, 1), incidentId: computeIncidentId(DEVICE, 2n) };
      await expect(submit(claim)).to.be.revertedWithCustomError(log, "IncidentIdMismatch");
      const v1Style = { ...makeClaim(DEVICE, 1), incidentId: ethers.solidityPackedKeccak256(["string", "bytes32", "uint64"], ["AIR-INCIDENT-1", DEVICE, 1n]) };
      await expect(submit(v1Style)).to.be.revertedWithCustomError(log, "IncidentIdMismatch");
    });

    it("rejects zero evidence hash and invalid severities", async function () {
      const { log, submit } = await loadFixture(deployFixture);
      await expect(submit(makeClaim(DEVICE, 1, { evidenceHash: ethers.ZeroHash }))).to.be.revertedWithCustomError(
        log,
        "ZeroEvidenceHash"
      );
      for (const severity of [0n, 3n, 4n, 255n]) {
        await expect(submit(makeClaim(DEVICE, 1, { severity })))
          .to.be.revertedWithCustomError(log, "InvalidSeverity")
          .withArgs(severity);
      }
      await expect(submit(makeClaim(DEVICE, 1, { severity: 2n }))).to.not.be.reverted;
    });

    it("emits EmergencyTriggered for critical only when the policy is enabled", async function () {
      const { log, admin, manager, submit } = await loadFixture(deployFixture);
      await expect(log.connect(manager).setCriticalPolicyEnabled(true)).to.be.revertedWithCustomError(
        log,
        "AccessControlUnauthorizedAccount"
      );
      await expect(log.connect(admin).setCriticalPolicyEnabled(true)).to.emit(log, "CriticalPolicyChanged").withArgs(true);
      const claim = makeClaim(DEVICE, 1, { severity: 3n });
      const key = await log.computeIncidentKey(DEVICE, claim.incidentId);
      await expect(submit(claim)).to.emit(log, "EmergencyTriggered").withArgs(key, DEVICE, claim.observedAt);
    });

    it("rejects unregistered devices", async function () {
      const { log, submit } = await loadFixture(deployFixture);
      await expect(submit(makeClaim(OTHER_DEVICE, 1)))
        .to.be.revertedWithCustomError(log, "DeviceNotRegistered")
        .withArgs(OTHER_DEVICE);
    });

    it("only RELAYER_ROLE may log", async function () {
      const { log, submit, stranger, owner, admin } = await loadFixture(deployFixture);
      for (const who of [stranger, owner, admin]) {
        await expect(submit(makeClaim(DEVICE, 1), undefined, who)).to.be.revertedWithCustomError(
          log,
          "AccessControlUnauthorizedAccount"
        );
      }
    });
  });

  describe("device lifecycle", function () {
    it("revoked devices cannot log", async function () {
      const { log, manager, submit, deviceKey } = await loadFixture(deployFixture);
      await expect(log.connect(manager).revokeDevice(DEVICE))
        .to.emit(log, "DeviceRevoked")
        .withArgs(DEVICE, deviceKey.address);
      await expect(submit(makeClaim(DEVICE, 1)))
        .to.be.revertedWithCustomError(log, "DeviceNotActive")
        .withArgs(DEVICE);
      await expect(log.connect(manager).revokeDevice(DEVICE)).to.be.revertedWithCustomError(log, "DeviceNotActive");
    });

    it("re-provisioning after explicit revoke requires a new signer and preserves exact sequence history", async function () {
      const { log, manager, owner, submit, deviceKey } = await loadFixture(deployFixture);
      await submit(makeClaim(DEVICE, 20));
      await log.connect(manager).revokeDevice(DEVICE);

      await expect(log.connect(manager).registerDevice(DEVICE, deviceKey.address, owner.address))
        .to.be.revertedWithCustomError(log, "SignerAlreadyUsed")
        .withArgs(deviceKey.address);

      const fresh = ethers.Wallet.createRandom();
      await expect(log.connect(manager).registerDevice(DEVICE, fresh.address, owner.address))
        .to.emit(log, "DeviceRegistered")
        .withArgs(DEVICE, fresh.address, owner.address);

      // The old key can no longer sign; old incidents are not re-signed.
      await expect(submit(makeClaim(DEVICE, 21))).to.be.revertedWithCustomError(log, "WrongSigner");
      await expect(submit(makeClaim(DEVICE, 20), fresh)).to.be.revertedWithCustomError(log, "IncidentAlreadyLogged");
      await expect(submit(makeClaim(DEVICE, 15), fresh)).to.not.be.reverted;
      await expect(submit(makeClaim(DEVICE, 21), fresh)).to.not.be.reverted;
      expect((await log.getDevice(DEVICE)).lastSequence).to.equal(21n);
    });

    it("rotate switches the signer; the old key is rejected and cannot be reused", async function () {
      const { log, manager, submit, deviceKey } = await loadFixture(deployFixture);
      await submit(makeClaim(DEVICE, 1));
      const next = ethers.Wallet.createRandom();
      await expect(log.connect(manager).rotateSigner(DEVICE, next.address))
        .to.emit(log, "DeviceSignerRotated")
        .withArgs(DEVICE, deviceKey.address, next.address);
      await expect(submit(makeClaim(DEVICE, 2))).to.be.revertedWithCustomError(log, "WrongSigner");
      await expect(submit(makeClaim(DEVICE, 2), next)).to.not.be.reverted;
      await expect(log.connect(manager).rotateSigner(DEVICE, deviceKey.address)).to.be.revertedWithCustomError(
        log,
        "SignerAlreadyUsed"
      );
      expect((await log.getDevice(DEVICE)).signer).to.equal(next.address);
    });

    it("rotate requires an active device", async function () {
      const { log, manager } = await loadFixture(deployFixture);
      await log.connect(manager).revokeDevice(DEVICE);
      await expect(log.connect(manager).rotateSigner(DEVICE, ethers.Wallet.createRandom().address))
        .to.be.revertedWithCustomError(log, "DeviceNotActive");
      await expect(log.connect(manager).rotateSigner(OTHER_DEVICE, ethers.Wallet.createRandom().address))
        .to.be.revertedWithCustomError(log, "DeviceNotRegistered");
    });

    it("validates register inputs and refuses to overwrite an active device", async function () {
      const { log, manager, owner } = await loadFixture(deployFixture);
      const k = ethers.Wallet.createRandom().address;
      await expect(log.connect(manager).registerDevice(DEVICE, k, owner.address))
        .to.be.revertedWithCustomError(log, "DeviceAlreadyActive")
        .withArgs(DEVICE);
      await expect(log.connect(manager).registerDevice(ethers.ZeroHash, k, owner.address)).to.be.revertedWithCustomError(
        log,
        "ZeroDeviceIdHash"
      );
      await expect(log.connect(manager).registerDevice(OTHER_DEVICE, ethers.ZeroAddress, owner.address)).to.be.revertedWithCustomError(log, "ZeroAddress");
      await expect(log.connect(manager).registerDevice(OTHER_DEVICE, k, ethers.ZeroAddress)).to.be.revertedWithCustomError(log, "ZeroAddress");
    });

    it("only DEVICE_MANAGER_ROLE manages devices", async function () {
      const { log, stranger, admin, relayer, owner } = await loadFixture(deployFixture);
      const k = ethers.Wallet.createRandom().address;
      for (const who of [stranger, admin, relayer, owner]) {
        await expect(log.connect(who).registerDevice(OTHER_DEVICE, k, owner.address)).to.be.revertedWithCustomError(log, "AccessControlUnauthorizedAccount");
        await expect(log.connect(who).rotateSigner(DEVICE, k)).to.be.revertedWithCustomError(log, "AccessControlUnauthorizedAccount");
        await expect(log.connect(who).revokeDevice(DEVICE)).to.be.revertedWithCustomError(log, "AccessControlUnauthorizedAccount");
        await expect(log.connect(who).setDeviceOwner(DEVICE, k)).to.be.revertedWithCustomError(log, "AccessControlUnauthorizedAccount");
      }
    });
  });

  describe("acknowledge / resolve", function () {
    async function loggedFixture() {
      const f = await deployFixture();
      const claim = makeClaim(DEVICE, 1);
      await f.submit(claim);
      const key = await f.log.computeIncidentKey(DEVICE, claim.incidentId);
      return { ...f, key };
    }

    it("owner acknowledges then resolves", async function () {
      const { log, owner, key } = await loadFixture(loggedFixture);
      await expect(log.connect(owner).acknowledgeIncident(key))
        .to.emit(log, "IncidentAcknowledged")
        .withArgs(key, DEVICE, owner.address);
      expect((await log.getIncident(key)).status).to.equal(2n);
      await expect(log.connect(owner).resolveIncident(key))
        .to.emit(log, "IncidentResolved")
        .withArgs(key, DEVICE, owner.address);
      expect((await log.getIncident(key)).status).to.equal(3n);
    });

    it("owner may resolve directly; terminal states reject further actions", async function () {
      const { log, owner, key } = await loadFixture(loggedFixture);
      await log.connect(owner).resolveIncident(key);
      await expect(log.connect(owner).resolveIncident(key)).to.be.revertedWithCustomError(log, "InvalidStatus").withArgs(3n);
      await expect(log.connect(owner).acknowledgeIncident(key)).to.be.revertedWithCustomError(log, "InvalidStatus");
    });

    it("cannot acknowledge twice", async function () {
      const { log, owner, key } = await loadFixture(loggedFixture);
      await log.connect(owner).acknowledgeIncident(key);
      await expect(log.connect(owner).acknowledgeIncident(key)).to.be.revertedWithCustomError(log, "InvalidStatus").withArgs(2n);
    });

    it("only the device ownerAddress may act, not admin/relayer/manager", async function () {
      const { log, admin, manager, relayer, stranger, key } = await loadFixture(loggedFixture);
      for (const who of [admin, manager, relayer, stranger]) {
        await expect(log.connect(who).acknowledgeIncident(key))
          .to.be.revertedWithCustomError(log, "NotDeviceOwner")
          .withArgs(who.address);
        await expect(log.connect(who).resolveIncident(key)).to.be.revertedWithCustomError(log, "NotDeviceOwner");
      }
    });

    it("follows owner changes", async function () {
      const { log, manager, owner, newOwner, key } = await loadFixture(loggedFixture);
      await expect(log.connect(manager).setDeviceOwner(DEVICE, newOwner.address))
        .to.emit(log, "DeviceOwnerChanged")
        .withArgs(DEVICE, owner.address, newOwner.address);
      await expect(log.connect(owner).acknowledgeIncident(key)).to.be.revertedWithCustomError(log, "NotDeviceOwner");
      await expect(log.connect(newOwner).acknowledgeIncident(key)).to.emit(log, "IncidentAcknowledged");
    });

    it("rejects unknown incident keys", async function () {
      const { log, owner } = await loadFixture(loggedFixture);
      const bogus = ethers.id("nope");
      await expect(log.connect(owner).acknowledgeIncident(bogus))
        .to.be.revertedWithCustomError(log, "IncidentNotFound")
        .withArgs(bogus);
      await expect(log.connect(owner).resolveIncident(bogus)).to.be.revertedWithCustomError(log, "IncidentNotFound");
    });
  });
});
