const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { makeClaim, signClaim } = require("./helpers");

const A = (n) => ethers.parseEther(String(n));
const DEVICE = ethers.id("aa:bb:cc:dd:ee:ff");
const OTHER_DEVICE = ethers.id("11:22:33:44:55:66");
const MISSING_DEVICE = ethers.id("00:00:00:00:00:00");
const Skip = { DailyCap: 0n, InsufficientFund: 1n, NoBond: 2n, AckNotRewarded: 3n };
const RULE_ACK = 1n;
const RULE_RESOLVE = 2n;
const WARNING_DEADLINE = 30n * 60n;
const DANGER_DEADLINE = 10n * 60n;
const RESOLVE_DEADLINE = 24n * 3600n;
const COOLDOWN = 7n * 24n * 3600n;

const DEFAULT_PARAMS = {
  ackDeadlineWarning: WARNING_DEADLINE,
  ackDeadlineDanger: DANGER_DEADLINE,
  resolveDeadline: RESOLVE_DEADLINE,
  ownerBond: A(100),
  ackReward: A(5),
  resolveReward: A(5),
  missedAckPenalty: A(20),
  maxRelayDelay: 15n * 60n,
  lateRelayPenalty: A(20),
  keeperShareBps: 5000n,
  dailyRewardCap: 3n,
  unstakeCooldown: COOLDOWN,
};

async function baseFixture() {
  const [admin, manager, relayer, owner, keeper, stranger, newOwner, treasury] = await ethers.getSigners();
  const log = await ethers.deployContract("AirSafetyLog", [admin.address]);
  const logAddress = await log.getAddress();
  await log.grantRole(await log.DEVICE_MANAGER_ROLE(), manager.address);
  await log.grantRole(await log.RELAYER_ROLE(), relayer.address);
  const deviceKey = ethers.Wallet.createRandom();
  const otherKey = ethers.Wallet.createRandom();
  await log.connect(manager).registerDevice(DEVICE, deviceKey.address, owner.address);
  await log.connect(manager).registerDevice(OTHER_DEVICE, otherKey.address, owner.address);

  let seq = 0n;
  // Log a device-signed incident; observedAt defaults to the block time.
  async function logIncident({ device = DEVICE, key = deviceKey, severity = 1n, delay = 0n } = {}) {
    seq += 1n;
    const now = BigInt(await time.latest()) + 1n;
    await time.setNextBlockTimestamp(now);
    const claim = makeClaim(device, seq, { severity, observedAt: now - delay });
    await log.connect(relayer).logIncident(claim, await signClaim(key, logAddress, claim));
    const incidentKey = await log.computeIncidentKey(device, claim.incidentId);
    return { key: incidentKey, loggedAt: now, deadline: now + (severity === 1n ? WARNING_DEADLINE : DANGER_DEADLINE) };
  }

  return { log, logAddress, admin, manager, relayer, owner, keeper, stranger, newOwner, treasury, deviceKey, otherKey, logIncident };
}

async function deployFixture() {
  const base = await baseFixture();
  const { admin, relayer, owner, treasury, logAddress } = base;
  const token = await ethers.deployContract("AirSafeToken", [admin.address]);
  const inc = await ethers.deployContract("SafetyIncentives", [
    admin.address,
    logAddress,
    await token.getAddress(),
    treasury.address,
    relayer.address,
  ]);
  const incAddr = await inc.getAddress();
  await token.approve(incAddr, ethers.MaxUint256);
  await inc.fundRewards(A(1_000));
  await inc.depositOperatorBond(A(1_000));
  for (const s of [owner, base.newOwner, base.stranger]) {
    await token.transfer(s.address, A(500));
    await token.connect(s).approve(incAddr, ethers.MaxUint256);
  }
  return { ...base, token, inc, incAddr };
}

async function stakedFixture() {
  const f = await deployFixture();
  await f.inc.connect(f.owner).stakeDevice(DEVICE, A(100));
  return f;
}

describe("AirSafeToken", function () {
  it("mints the fixed supply to the treasury and has no mint function", async function () {
    const [admin] = await ethers.getSigners();
    const token = await ethers.deployContract("AirSafeToken", [admin.address]);
    expect(await token.name()).to.equal("AirSafe Token");
    expect(await token.symbol()).to.equal("ASAFE");
    expect(await token.decimals()).to.equal(18n);
    expect(await token.totalSupply()).to.equal(A(1_000_000));
    expect(await token.balanceOf(admin.address)).to.equal(A(1_000_000));
    expect(token.interface.getFunction("mint")).to.equal(null);
    expect(token.interface.getFunction("burn")).to.equal(null);
  });

  it("rejects a zero treasury", async function () {
    const F = await ethers.getContractFactory("AirSafeToken");
    await expect(F.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "ZeroAddress");
  });
});

describe("SafetyIncentives", function () {
  describe("deployment and admin", function () {
    it("stores wiring, MVP params and activation time", async function () {
      const { inc, token, logAddress, admin, relayer, treasury } = await loadFixture(deployFixture);
      expect(await inc.airSafetyLog()).to.equal(logAddress);
      expect(await inc.token()).to.equal(await token.getAddress());
      expect(await inc.treasury()).to.equal(treasury.address);
      expect(await inc.operator()).to.equal(relayer.address);
      expect(await inc.hasRole(ethers.ZeroHash, admin.address)).to.equal(true);
      expect(await inc.activatedAt()).to.be.greaterThan(0n);
      const p = await inc.params();
      for (const [k, v] of Object.entries(DEFAULT_PARAMS)) expect(p[k], k).to.equal(v);
    });

    it("rejects any zero constructor address", async function () {
      const { logAddress, admin, relayer, treasury } = await loadFixture(baseFixture);
      const F = await ethers.getContractFactory("SafetyIncentives");
      const ok = [admin.address, logAddress, logAddress, treasury.address, relayer.address];
      for (let i = 0; i < ok.length; i++) {
        const args = [...ok];
        args[i] = ethers.ZeroAddress;
        await expect(F.deploy(...args)).to.be.revertedWithCustomError(F, "ZeroAddress");
      }
    });

    it("lets only the admin update params, with validation", async function () {
      const { inc, stranger } = await loadFixture(deployFixture);
      const next = { ...DEFAULT_PARAMS, ackReward: A(7) };
      await expect(inc.connect(stranger).setParams(next)).to.be.revertedWithCustomError(
        inc,
        "AccessControlUnauthorizedAccount"
      );
      await expect(inc.setParams(next)).to.emit(inc, "ParamsUpdated");
      expect((await inc.params()).ackReward).to.equal(A(7));

      for (const bad of [
        { ackDeadlineWarning: 0n },
        { ackDeadlineDanger: 0n },
        { resolveDeadline: WARNING_DEADLINE - 1n },
        { ackDeadlineDanger: RESOLVE_DEADLINE + 1n },
        { keeperShareBps: 10_001n },
      ]) {
        await expect(inc.setParams({ ...DEFAULT_PARAMS, ...bad })).to.be.revertedWithCustomError(inc, "InvalidParams");
      }
    });

    it("changes operator and treasury (admin only, non-zero)", async function () {
      const { inc, relayer, stranger, treasury } = await loadFixture(deployFixture);
      await expect(inc.connect(stranger).setOperator(stranger.address)).to.be.revertedWithCustomError(
        inc,
        "AccessControlUnauthorizedAccount"
      );
      await expect(inc.setOperator(ethers.ZeroAddress)).to.be.revertedWithCustomError(inc, "ZeroAddress");
      await expect(inc.setOperator(stranger.address))
        .to.emit(inc, "OperatorChanged")
        .withArgs(relayer.address, stranger.address);

      await expect(inc.connect(stranger).setTreasury(stranger.address)).to.be.revertedWithCustomError(
        inc,
        "AccessControlUnauthorizedAccount"
      );
      await expect(inc.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(inc, "ZeroAddress");
      await expect(inc.setTreasury(stranger.address))
        .to.emit(inc, "TreasuryChanged")
        .withArgs(treasury.address, stranger.address);
    });

    it("funds rewards from anyone, rejecting zero", async function () {
      const { inc, stranger } = await loadFixture(deployFixture);
      await expect(inc.connect(stranger).fundRewards(0)).to.be.revertedWithCustomError(inc, "ZeroAmount");
      await expect(inc.connect(stranger).fundRewards(A(10)))
        .to.emit(inc, "RewardsFunded")
        .withArgs(stranger.address, A(10));
      expect(await inc.rewardFund()).to.equal(A(1_010));
    });
  });

  describe("device bonds", function () {
    it("stakes for the current owner, requiring the minimum bond", async function () {
      const { inc, owner, stranger } = await loadFixture(deployFixture);
      await expect(inc.connect(owner).stakeDevice(DEVICE, 0)).to.be.revertedWithCustomError(inc, "ZeroAmount");
      await expect(inc.connect(owner).stakeDevice(MISSING_DEVICE, A(100)))
        .to.be.revertedWithCustomError(inc, "DeviceNotFound")
        .withArgs(MISSING_DEVICE);
      await expect(inc.connect(stranger).stakeDevice(DEVICE, A(100)))
        .to.be.revertedWithCustomError(inc, "NotDeviceOwner")
        .withArgs(stranger.address);
      await expect(inc.connect(owner).stakeDevice(DEVICE, A(99)))
        .to.be.revertedWithCustomError(inc, "BondTooLow")
        .withArgs(A(99), A(100));

      await expect(inc.connect(owner).stakeDevice(DEVICE, A(100)))
        .to.emit(inc, "Staked")
        .withArgs(DEVICE, owner.address, A(100), A(100));
      // A top-up only needs the new total to reach the minimum.
      await expect(inc.connect(owner).stakeDevice(DEVICE, A(1)))
        .to.emit(inc, "Staked")
        .withArgs(DEVICE, owner.address, A(1), A(101));
      const b = await inc.deviceBond(DEVICE);
      expect(b.staker).to.equal(owner.address);
      expect(b.amount).to.equal(A(101));
      expect(await inc.totalBonded()).to.equal(A(1_101));
      // Bonded tokens never count as reward fund.
      expect(await inc.rewardFund()).to.equal(A(1_000));
    });

    it("unstakes only after the cooldown and stays slashable meanwhile", async function () {
      const { inc, token, owner, stranger, keeper, logIncident } = await loadFixture(stakedFixture);
      await expect(inc.connect(stranger).requestUnstake(DEVICE))
        .to.be.revertedWithCustomError(inc, "NotStaker")
        .withArgs(stranger.address);
      await expect(inc.connect(owner).withdraw(DEVICE)).to.be.revertedWithCustomError(inc, "NoUnstakeRequest");

      const { key, deadline } = await logIncident();
      const tx = await inc.connect(owner).requestUnstake(DEVICE);
      const requestedAt = BigInt((await tx.getBlock()).timestamp);
      await expect(tx)
        .to.emit(inc, "UnstakeRequested")
        .withArgs(DEVICE, owner.address, requestedAt + COOLDOWN);
      await expect(inc.connect(owner).requestUnstake(DEVICE)).to.be.revertedWithCustomError(
        inc,
        "UnstakeAlreadyRequested"
      );

      await time.increaseTo(deadline + 1n);
      await inc.connect(keeper).slashMissedAck(key);
      expect((await inc.deviceBond(DEVICE)).amount).to.equal(A(80));

      await time.increaseTo(requestedAt + COOLDOWN - 2n);
      await expect(inc.connect(owner).withdraw(DEVICE))
        .to.be.revertedWithCustomError(inc, "CooldownActive")
        .withArgs(requestedAt + COOLDOWN);
      await expect(inc.connect(stranger).withdraw(DEVICE)).to.be.revertedWithCustomError(inc, "NotStaker");

      const before = await token.balanceOf(owner.address);
      await expect(inc.connect(owner).withdraw(DEVICE))
        .to.emit(inc, "Withdrawn")
        .withArgs(DEVICE, owner.address, A(80));
      expect(await token.balanceOf(owner.address)).to.equal(before + A(80));
      expect((await inc.deviceBond(DEVICE)).staker).to.equal(ethers.ZeroAddress);
      expect(await inc.totalBonded()).to.equal(A(1_000)); // only the operator bond is left
    });

    it("a new stake cancels a pending unstake", async function () {
      const { inc, owner } = await loadFixture(stakedFixture);
      await inc.connect(owner).requestUnstake(DEVICE);
      await inc.connect(owner).stakeDevice(DEVICE, A(1));
      expect((await inc.deviceBond(DEVICE)).unstakeRequestedAt).to.equal(0n);
    });

    it("keeps the old owner's bond after an owner change; the new owner stakes once it is withdrawn", async function () {
      const { inc, log, manager, owner, newOwner, keeper, logIncident } = await loadFixture(stakedFixture);
      await log.connect(manager).setDeviceOwner(DEVICE, newOwner.address);

      await expect(inc.connect(owner).stakeDevice(DEVICE, A(100))).to.be.revertedWithCustomError(inc, "NotDeviceOwner");
      await expect(inc.connect(newOwner).stakeDevice(DEVICE, A(100)))
        .to.be.revertedWithCustomError(inc, "BondHeldByOther")
        .withArgs(owner.address);

      // The new owner's negligence never touches the old owner's bond.
      const { key, deadline } = await logIncident();
      await time.increaseTo(deadline + 1n);
      await expect(inc.connect(keeper).slashMissedAck(key))
        .to.emit(inc, "MissedAckSlashed")
        .withArgs(key, DEVICE, 0n, keeper.address)
        .and.to.emit(inc, "BondExhausted")
        .withArgs(DEVICE);
      expect((await inc.deviceBond(DEVICE)).amount).to.equal(A(100));

      await inc.connect(owner).requestUnstake(DEVICE);
      await time.increase(COOLDOWN);
      await inc.connect(owner).withdraw(DEVICE);
      await expect(inc.connect(newOwner).stakeDevice(DEVICE, A(100)))
        .to.emit(inc, "Staked")
        .withArgs(DEVICE, newOwner.address, A(100), A(100));
    });
  });

  describe("operator bond", function () {
    it("accepts deposits from anyone and withdraws to the operator after the cooldown", async function () {
      const { inc, token, admin, relayer, stranger } = await loadFixture(deployFixture);
      await expect(inc.depositOperatorBond(0)).to.be.revertedWithCustomError(inc, "ZeroAmount");
      await expect(inc.connect(stranger).depositOperatorBond(A(10)))
        .to.emit(inc, "Staked")
        .withArgs(ethers.ZeroHash, stranger.address, A(10), A(1_010));

      await expect(inc.connect(admin).requestOperatorUnstake())
        .to.be.revertedWithCustomError(inc, "NotOperator")
        .withArgs(admin.address);
      await expect(inc.connect(admin).withdrawOperator()).to.be.revertedWithCustomError(inc, "NotOperator");
      await expect(inc.connect(relayer).withdrawOperator()).to.be.revertedWithCustomError(inc, "NoUnstakeRequest");

      await expect(inc.connect(relayer).requestOperatorUnstake()).to.emit(inc, "UnstakeRequested");
      await expect(inc.connect(relayer).withdrawOperator()).to.be.revertedWithCustomError(inc, "CooldownActive");
      await time.increase(COOLDOWN);
      await expect(inc.connect(relayer).withdrawOperator())
        .to.emit(inc, "Withdrawn")
        .withArgs(ethers.ZeroHash, relayer.address, A(1_010));
      expect(await token.balanceOf(relayer.address)).to.equal(A(1_010));
      expect(await inc.totalBonded()).to.equal(0n);
      await expect(inc.connect(relayer).requestOperatorUnstake()).to.be.revertedWithCustomError(inc, "ZeroAmount");
    });

    it("setOperator cancels a pending operator unstake", async function () {
      const { inc, relayer, stranger } = await loadFixture(deployFixture);
      await inc.connect(relayer).requestOperatorUnstake();
      await inc.setOperator(stranger.address);
      expect((await inc.operatorBond()).unstakeRequestedAt).to.equal(0n);
      await expect(inc.connect(stranger).withdrawOperator()).to.be.revertedWithCustomError(inc, "NoUnstakeRequest");
    });
  });

  describe("R1 recordTimelyAck", function () {
    it("pays on the deadline second and rejects one second later", async function () {
      const { inc, log, owner, keeper, logIncident } = await loadFixture(stakedFixture);
      const a = await logIncident();
      const b = await logIncident();
      await log.connect(owner).acknowledgeIncident(a.key);
      await log.connect(owner).acknowledgeIncident(b.key);

      await time.increaseTo(a.deadline - 1n);
      await expect(inc.connect(keeper).recordTimelyAck(a.key))
        .to.emit(inc, "AckRewarded")
        .withArgs(a.key, owner.address, A(5));
      await time.increaseTo(b.deadline);
      await expect(inc.recordTimelyAck(b.key))
        .to.be.revertedWithCustomError(inc, "AckDeadlinePassed")
        .withArgs(b.key, b.deadline);
    });

    it("rejects a second call, an unacknowledged incident, unknown and pre-activation incidents", async function () {
      const { inc, log, owner, logIncident } = await loadFixture(stakedFixture);
      const { key } = await logIncident();
      await expect(inc.recordTimelyAck(key)).to.be.revertedWithCustomError(inc, "NotAcknowledged").withArgs(key);
      await log.connect(owner).acknowledgeIncident(key);
      await inc.recordTimelyAck(key);
      await expect(inc.recordTimelyAck(key)).to.be.revertedWithCustomError(inc, "AlreadySettled").withArgs(key);

      const unknown = ethers.id("nope");
      await expect(inc.recordTimelyAck(unknown)).to.be.revertedWithCustomError(inc, "IncidentNotFound").withArgs(unknown);
    });

    it("ignores incidents logged before deployment", async function () {
      const base = await loadFixture(baseFixture);
      const old = await base.logIncident();
      const token = await ethers.deployContract("AirSafeToken", [base.admin.address]);
      const inc = await ethers.deployContract("SafetyIncentives", [
        base.admin.address,
        base.logAddress,
        await token.getAddress(),
        base.treasury.address,
        base.relayer.address,
      ]);
      await time.increaseTo(old.deadline + 1n);
      for (const fn of ["recordTimelyAck", "recordTimelyResolve", "slashMissedAck", "slashLateRelay"]) {
        await expect(inc[fn](old.key))
          .to.be.revertedWithCustomError(inc, "IncidentNotCovered")
          .withArgs(old.key, old.loggedAt);
      }
      const s = await inc.pendingSettlement(old.key);
      expect(s.exists).to.equal(true);
      expect(s.covered).to.equal(false);
      expect(s.canSlashMissedAck).to.equal(false);
    });

    it("counts a direct resolve as an acknowledgement", async function () {
      const { inc, log, owner, logIncident } = await loadFixture(stakedFixture);
      const { key } = await logIncident();
      await log.connect(owner).resolveIncident(key);
      await expect(inc.recordTimelyAck(key)).to.emit(inc, "AckRewarded");
    });

    it("records but does not pay without a bond, so the owner cannot be slashed", async function () {
      const { inc, log, owner, keeper, logIncident } = await loadFixture(deployFixture);
      const { key, deadline } = await logIncident();
      await log.connect(owner).acknowledgeIncident(key);
      await expect(inc.recordTimelyAck(key))
        .to.emit(inc, "RewardSkipped")
        .withArgs(key, owner.address, RULE_ACK, Skip.NoBond);
      await time.increaseTo(deadline + 1n);
      await expect(inc.connect(keeper).slashMissedAck(key)).to.be.revertedWithCustomError(inc, "AlreadySettled");
    });

    it("does not pay while an unstake is pending or once the bond cannot cover a penalty", async function () {
      const { inc, log, owner, logIncident } = await loadFixture(stakedFixture);
      await inc.connect(owner).requestUnstake(DEVICE);
      const a = await logIncident();
      await log.connect(owner).acknowledgeIncident(a.key);
      await expect(inc.recordTimelyAck(a.key))
        .to.emit(inc, "RewardSkipped")
        .withArgs(a.key, owner.address, RULE_ACK, Skip.NoBond);

      await inc.connect(owner).stakeDevice(DEVICE, A(1)); // cancels the unstake
      await inc.setParams({ ...DEFAULT_PARAMS, missedAckPenalty: A(102) });
      const b = await logIncident();
      await log.connect(owner).acknowledgeIncident(b.key);
      await expect(inc.recordTimelyAck(b.key))
        .to.emit(inc, "RewardSkipped")
        .withArgs(b.key, owner.address, RULE_ACK, Skip.NoBond);
    });

    it("skips the reward without reverting when the fund is empty, leaving bonds intact", async function () {
      const { log, owner, logIncident, admin, relayer, treasury, logAddress } = await loadFixture(baseFixture);
      const token = await ethers.deployContract("AirSafeToken", [admin.address]);
      const inc = await ethers.deployContract("SafetyIncentives", [
        admin.address,
        logAddress,
        await token.getAddress(),
        treasury.address,
        relayer.address,
      ]);
      await token.transfer(owner.address, A(100));
      await token.connect(owner).approve(await inc.getAddress(), A(100));
      await inc.connect(owner).stakeDevice(DEVICE, A(100));
      await token.approve(await inc.getAddress(), A(4));
      await inc.fundRewards(A(4)); // below ACK_REWARD

      const { key } = await logIncident();
      await log.connect(owner).acknowledgeIncident(key);
      await expect(inc.recordTimelyAck(key))
        .to.emit(inc, "RewardSkipped")
        .withArgs(key, owner.address, RULE_ACK, Skip.InsufficientFund);
      expect(await inc.settlementFlags(key)).to.equal(1n);
      expect(await token.balanceOf(owner.address)).to.equal(0n);
      expect((await inc.deviceBond(DEVICE)).amount).to.equal(A(100));
      expect(await inc.rewardFund()).to.equal(A(4));
      expect(await inc.rewardsToday(DEVICE, await inc.currentDay())).to.equal(0n);
    });

    it("caps paid acks per device per UTC day and resets the next day", async function () {
      const { inc, log, owner, otherKey, logIncident } = await loadFixture(stakedFixture);
      await inc.connect(owner).stakeDevice(OTHER_DEVICE, A(100));
      // Start just after a UTC midnight so the four incidents share one day.
      const day = BigInt(await time.latest()) / 86400n + 1n;
      await time.increaseTo(day * 86400n + 60n);
      const results = [];
      for (let i = 0; i < 4; i++) {
        const { key } = await logIncident();
        await log.connect(owner).acknowledgeIncident(key);
        results.push(await (await inc.recordTimelyAck(key)).wait());
      }
      const names = results.map((r) => inc.interface.parseLog(r.logs.find((l) => l.address === r.to)).name);
      expect(names).to.deep.equal(["AckRewarded", "AckRewarded", "AckRewarded", "RewardSkipped"]);
      expect(await inc.rewardsToday(DEVICE, day)).to.equal(3n);

      // Another device has its own cap.
      const other = await logIncident({ device: OTHER_DEVICE, key: otherKey });
      await log.connect(owner).acknowledgeIncident(other.key);
      await expect(inc.recordTimelyAck(other.key)).to.emit(inc, "AckRewarded");

      await time.increaseTo((day + 1n) * 86400n + 60n);
      const { key } = await logIncident();
      await log.connect(owner).acknowledgeIncident(key);
      await expect(inc.recordTimelyAck(key)).to.emit(inc, "AckRewarded");
      expect(await inc.rewardsToday(DEVICE, day + 1n)).to.equal(1n);
    });
  });

  describe("R2 recordTimelyResolve", function () {
    it("pays once for a timely resolve after a rewarded ack", async function () {
      const { inc, log, owner, logIncident } = await loadFixture(stakedFixture);
      const { key, loggedAt } = await logIncident();
      await expect(inc.recordTimelyResolve(key)).to.be.revertedWithCustomError(inc, "NotAcknowledged");
      await log.connect(owner).acknowledgeIncident(key);
      await inc.recordTimelyAck(key);
      await expect(inc.recordTimelyResolve(key)).to.be.revertedWithCustomError(inc, "NotResolved").withArgs(key);

      await log.connect(owner).resolveIncident(key);
      await time.increaseTo(loggedAt + RESOLVE_DEADLINE - 1n);
      await expect(inc.recordTimelyResolve(key))
        .to.emit(inc, "ResolveRewarded")
        .withArgs(key, owner.address, A(5));
      await expect(inc.recordTimelyResolve(key)).to.be.revertedWithCustomError(inc, "AlreadySettled");
    });

    it("rejects a resolve recorded after the resolve deadline", async function () {
      const { inc, log, owner, logIncident } = await loadFixture(stakedFixture);
      const { key, loggedAt } = await logIncident();
      await log.connect(owner).acknowledgeIncident(key);
      await inc.recordTimelyAck(key);
      await log.connect(owner).resolveIncident(key);
      await time.increaseTo(loggedAt + RESOLVE_DEADLINE);
      await expect(inc.recordTimelyResolve(key))
        .to.be.revertedWithCustomError(inc, "ResolveDeadlinePassed")
        .withArgs(key, loggedAt + RESOLVE_DEADLINE);
    });

    it("does not pay when the ack was over the daily cap", async function () {
      const { inc, log, owner, logIncident } = await loadFixture(stakedFixture);
      await inc.setParams({ ...DEFAULT_PARAMS, dailyRewardCap: 0n });
      const { key } = await logIncident();
      await log.connect(owner).resolveIncident(key);
      await expect(inc.recordTimelyAck(key))
        .to.emit(inc, "RewardSkipped")
        .withArgs(key, owner.address, RULE_ACK, Skip.DailyCap);
      await expect(inc.recordTimelyResolve(key))
        .to.emit(inc, "RewardSkipped")
        .withArgs(key, owner.address, RULE_RESOLVE, Skip.AckNotRewarded);
    });

    it("skips when the bond is leaving or the fund ran dry", async function () {
      const { inc, log, owner, admin, logIncident } = await loadFixture(stakedFixture);
      const a = await logIncident();
      await log.connect(owner).resolveIncident(a.key);
      await inc.recordTimelyAck(a.key);
      await inc.connect(owner).requestUnstake(DEVICE);
      await expect(inc.recordTimelyResolve(a.key))
        .to.emit(inc, "RewardSkipped")
        .withArgs(a.key, owner.address, RULE_RESOLVE, Skip.NoBond);

      await inc.connect(owner).stakeDevice(DEVICE, A(1));
      const b = await logIncident();
      await log.connect(owner).resolveIncident(b.key);
      await inc.recordTimelyAck(b.key);
      await inc.setParams({ ...DEFAULT_PARAMS, resolveReward: A(10_000) });
      await expect(inc.recordTimelyResolve(b.key))
        .to.emit(inc, "RewardSkipped")
        .withArgs(b.key, owner.address, RULE_RESOLVE, Skip.InsufficientFund);
      expect(admin).to.be.ok;
    });
  });

  describe("P1 slashMissedAck", function () {
    it("waits for the deadline, splits 50/50 and slashes only once", async function () {
      const { inc, token, keeper, treasury, logIncident } = await loadFixture(stakedFixture);
      const { key, deadline } = await logIncident({ severity: 2n });
      await time.increaseTo(deadline - 1n);
      await expect(inc.connect(keeper).slashMissedAck(key))
        .to.be.revertedWithCustomError(inc, "AckDeadlineNotPassed")
        .withArgs(key, deadline);

      await expect(inc.connect(keeper).slashMissedAck(key))
        .to.emit(inc, "MissedAckSlashed")
        .withArgs(key, DEVICE, A(20), keeper.address)
        .and.not.to.emit(inc, "BondExhausted");
      expect(await token.balanceOf(keeper.address)).to.equal(A(10));
      expect(await token.balanceOf(treasury.address)).to.equal(A(10));
      expect((await inc.deviceBond(DEVICE)).amount).to.equal(A(80));
      await expect(inc.connect(keeper).slashMissedAck(key)).to.be.revertedWithCustomError(inc, "AlreadySettled");
    });

    it("takes what is left and emits BondExhausted when the bond is short", async function () {
      const { inc, token, keeper, logIncident } = await loadFixture(stakedFixture);
      await inc.setParams({ ...DEFAULT_PARAMS, missedAckPenalty: A(150) });
      const { key, deadline } = await logIncident();
      await time.increaseTo(deadline + 1n);
      await expect(inc.connect(keeper).slashMissedAck(key))
        .to.emit(inc, "MissedAckSlashed")
        .withArgs(key, DEVICE, A(100), keeper.address)
        .and.to.emit(inc, "BondExhausted")
        .withArgs(DEVICE);
      expect((await inc.deviceBond(DEVICE)).amount).to.equal(0n);
      expect(await token.balanceOf(keeper.address)).to.equal(A(50));
    });

    it("never reaches incidents logged before the current stake", async function () {
      const { inc, owner, keeper, logIncident } = await loadFixture(deployFixture);
      const { key, deadline } = await logIncident();
      await inc.connect(owner).stakeDevice(DEVICE, A(100));
      await time.increaseTo(deadline + 1n);
      await expect(inc.connect(keeper).slashMissedAck(key))
        .to.emit(inc, "MissedAckSlashed")
        .withArgs(key, DEVICE, 0n, keeper.address);
      expect((await inc.deviceBond(DEVICE)).amount).to.equal(A(100));
    });

    it("slashes an owner who acknowledged in time but whose ack was never recorded (ack time is not stored on chain)", async function () {
      const { inc, log, token, owner, keeper, treasury, logIncident } = await loadFixture(stakedFixture);
      const { key, deadline } = await logIncident({ severity: 2n });
      await time.increaseTo(deadline - 5n);
      await log.connect(owner).acknowledgeIncident(key);

      // Nobody called recordTimelyAck before the deadline: the chain cannot tell this ack from a late one.
      await time.increaseTo(deadline + 1n);
      await expect(inc.recordTimelyAck(key)).to.be.revertedWithCustomError(inc, "AckDeadlinePassed").withArgs(key, deadline);
      await expect(inc.connect(keeper).slashMissedAck(key))
        .to.emit(inc, "MissedAckSlashed")
        .withArgs(key, DEVICE, A(20), keeper.address);
      expect((await inc.deviceBond(DEVICE)).amount).to.equal(A(80));
      expect(await token.balanceOf(keeper.address)).to.equal(A(10));
      expect(await token.balanceOf(treasury.address)).to.equal(A(10));
    });

    it("honours keeper shares of 0% and 100%", async function () {
      const { inc, token, keeper, treasury, logIncident } = await loadFixture(stakedFixture);
      await inc.setParams({ ...DEFAULT_PARAMS, keeperShareBps: 0n });
      const a = await logIncident();
      await inc.setParams({ ...DEFAULT_PARAMS, keeperShareBps: 10_000n });
      const b = await logIncident();
      await time.increaseTo(b.deadline + 1n);
      await inc.setParams({ ...DEFAULT_PARAMS, keeperShareBps: 0n });
      await inc.connect(keeper).slashMissedAck(a.key);
      expect(await token.balanceOf(keeper.address)).to.equal(0n);
      expect(await token.balanceOf(treasury.address)).to.equal(A(20));
      await inc.setParams({ ...DEFAULT_PARAMS, keeperShareBps: 10_000n });
      await inc.connect(keeper).slashMissedAck(b.key);
      expect(await token.balanceOf(keeper.address)).to.equal(A(20));
      expect(await token.balanceOf(treasury.address)).to.equal(A(20));
    });
  });

  describe("P2 slashLateRelay", function () {
    it("slashes the operator once when loggedAt - observedAt exceeds 15 minutes", async function () {
      const { inc, token, keeper, treasury, logIncident } = await loadFixture(deployFixture);
      const onTime = await logIncident({ delay: 15n * 60n });
      await expect(inc.connect(keeper).slashLateRelay(onTime.key))
        .to.be.revertedWithCustomError(inc, "RelayNotLate")
        .withArgs(onTime.key, 15n * 60n);

      const late = await logIncident({ delay: 15n * 60n + 1n });
      await expect(inc.connect(keeper).slashLateRelay(late.key))
        .to.emit(inc, "LateRelaySlashed")
        .withArgs(late.key, 15n * 60n + 1n, A(20), keeper.address);
      expect((await inc.operatorBond()).amount).to.equal(A(980));
      expect(await token.balanceOf(keeper.address)).to.equal(A(10));
      expect(await token.balanceOf(treasury.address)).to.equal(A(10));
      await expect(inc.connect(keeper).slashLateRelay(late.key)).to.be.revertedWithCustomError(inc, "AlreadySettled");
    });

    it("counts device offline time as relay delay", async function () {
      const { inc, keeper, token, logIncident } = await loadFixture(deployFixture);
      // The device observed the incident an hour ago and flushed its stored queue on reconnect;
      // the relayer logged it in the very next block, yet observedAt is what the chain measures.
      const { key } = await logIncident({ delay: 3600n });
      await expect(inc.connect(keeper).slashLateRelay(key))
        .to.emit(inc, "LateRelaySlashed")
        .withArgs(key, 3600n, A(20), keeper.address);
      expect((await inc.operatorBond()).amount).to.equal(A(980));
      expect(await token.balanceOf(keeper.address)).to.equal(A(10));
    });

    it("treats a device clock ahead of the chain as zero delay", async function () {
      const { inc, logIncident } = await loadFixture(deployFixture);
      const { key } = await logIncident({ delay: -300n });
      await expect(inc.slashLateRelay(key)).to.be.revertedWithCustomError(inc, "RelayNotLate").withArgs(key, 0n);
    });

    it("emits BondExhausted when the operator bond runs out", async function () {
      const { inc, keeper, logIncident } = await loadFixture(deployFixture);
      await inc.setParams({ ...DEFAULT_PARAMS, lateRelayPenalty: A(1_500) });
      const { key } = await logIncident({ delay: 3600n });
      await expect(inc.connect(keeper).slashLateRelay(key))
        .to.emit(inc, "LateRelaySlashed")
        .withArgs(key, 3600n, A(1_000), keeper.address)
        .and.to.emit(inc, "BondExhausted")
        .withArgs(ethers.ZeroHash);
      const again = await logIncident({ delay: 3600n });
      await expect(inc.connect(keeper).slashLateRelay(again.key))
        .to.emit(inc, "LateRelaySlashed")
        .withArgs(again.key, 3600n, 0n, keeper.address);
    });
  });

  describe("pendingSettlement", function () {
    it("reports deadlines, flags and callable rules without reverting", async function () {
      const { inc, log, owner, logIncident } = await loadFixture(stakedFixture);
      const empty = await inc.pendingSettlement(ethers.id("missing"));
      expect(empty.exists).to.equal(false);

      const { key, loggedAt, deadline } = await logIncident({ severity: 2n, delay: 3600n });
      let s = await inc.pendingSettlement(key);
      expect(s.exists).to.equal(true);
      expect(s.covered).to.equal(true);
      expect(s.deviceIdHash).to.equal(DEVICE);
      expect(s.severity).to.equal(2n);
      expect(s.status).to.equal(1n);
      expect(s.loggedAt).to.equal(loggedAt);
      expect(s.observedAt).to.equal(loggedAt - 3600n);
      expect(s.ackDeadline).to.equal(deadline);
      expect(s.resolveDeadline).to.equal(loggedAt + RESOLVE_DEADLINE);
      expect(s.relayDelay).to.equal(3600n);
      expect([s.canRecordAck, s.canRecordResolve, s.canSlashMissedAck, s.canSlashLateRelay]).to.deep.equal([
        false,
        false,
        false,
        true,
      ]);

      await log.connect(owner).resolveIncident(key);
      s = await inc.pendingSettlement(key);
      expect([s.canRecordAck, s.canRecordResolve]).to.deep.equal([true, false]);
      await inc.recordTimelyAck(key);
      s = await inc.pendingSettlement(key);
      expect(s.flags).to.equal(3n);
      expect([s.canRecordAck, s.canRecordResolve]).to.deep.equal([false, true]);

      const late = await logIncident();
      await time.increaseTo(late.deadline + 1n);
      s = await inc.pendingSettlement(late.key);
      expect([s.canRecordAck, s.canSlashMissedAck, s.canSlashLateRelay]).to.deep.equal([false, true, false]);
    });
  });

  describe("reentrancy", function () {
    it("rejects a token that calls back into the contract during a transfer", async function () {
      const { admin, owner, relayer, treasury, logAddress, logIncident } = await loadFixture(baseFixture);
      const evil = await ethers.deployContract("ReentrantToken", [admin.address, A(10_000)]);
      const inc = await ethers.deployContract("SafetyIncentives", [
        admin.address,
        logAddress,
        await evil.getAddress(),
        treasury.address,
        relayer.address,
      ]);
      const incAddr = await inc.getAddress();
      await evil.approve(incAddr, ethers.MaxUint256);
      await inc.fundRewards(A(1_000));
      await inc.depositOperatorBond(A(1_000));
      await evil.transfer(owner.address, A(100));
      await evil.connect(owner).approve(incAddr, ethers.MaxUint256);
      await inc.connect(owner).stakeDevice(DEVICE, A(100));

      // While paying the R1 reward, the token tries to claim the same reward again.
      const { key } = await logIncident();
      await (await ethers.getContractAt("AirSafetyLog", logAddress)).connect(owner).acknowledgeIncident(key);
      await evil.arm(incAddr, inc.interface.encodeFunctionData("recordTimelyAck", [key]));
      await expect(inc.recordTimelyAck(key)).to.be.revertedWithCustomError(inc, "ReentrancyGuardReentrantCall");

      // Same for slashing: a re-entrant slash during the bounty transfer fails.
      const late = await logIncident({ delay: 3600n });
      await evil.arm(incAddr, inc.interface.encodeFunctionData("slashLateRelay", [late.key]));
      await expect(inc.slashLateRelay(late.key)).to.be.revertedWithCustomError(inc, "ReentrancyGuardReentrantCall");
      // The reverted call left the hook armed; disarm and the honest call works.
      await evil.arm(ethers.ZeroAddress, "0x");
      await expect(inc.slashLateRelay(late.key)).to.emit(inc, "LateRelaySlashed");
    });
  });
});
