// One day of operation,
// replayed against the real AirSafetyLog with device-signed incidents. Every
// balance in the end-of-day table and every rejected call is asserted.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { makeClaim, signClaim } = require("./helpers");

const A = (n) => ethers.parseEther(String(n));
const DEVICE = ethers.id("dc:b4:d9:13:ed:8c");
const SKIP_DAILY_CAP = 0n;

// Scenario clock is UTC+7 on a fixed future day; the whole day stays inside
// one UTC day (08:00+7 = 01:00Z ... 20:30+7 = 13:30Z).
const DAY = BigInt(Date.UTC(2030, 0, 15) / 1000);
const at = (hh, mm, ss = 0) => DAY + BigInt((hh - 7) * 3600 + mm * 60 + ss);

describe("SafetyIncentives scenario: one day of operation", function () {
  let log, token, inc, logAddress;
  let admin, manager, relayer, owner, keeper, deviceKey;
  const keys = {};
  let treasuryStart;

  async function atTime(ts, fn) {
    await time.setNextBlockTimestamp(ts);
    return fn();
  }

  async function logIncident(n, sequence, { observedAt, loggedAt, severity }) {
    const claim = makeClaim(DEVICE, sequence, { observedAt, severity: BigInt(severity) });
    const sig = await signClaim(deviceKey, logAddress, claim);
    await atTime(loggedAt, () => log.connect(relayer).logIncident(claim, sig));
    keys[n] = await log.computeIncidentKey(DEVICE, claim.incidentId);
    const stored = await log.getIncident(keys[n]);
    expect(stored.loggedAt).to.equal(loggedAt);
    expect(stored.observedAt).to.equal(observedAt);
  }

  async function wallet(addr) {
    return token.balanceOf(addr);
  }

  async function ownerState() {
    return { wallet: await wallet(owner.address), stake: (await inc.deviceBond(DEVICE)).amount };
  }

  before(async function () {
    [admin, manager, relayer, owner, keeper] = await ethers.getSigners();
    deviceKey = ethers.Wallet.createRandom();

    log = await ethers.deployContract("AirSafetyLog", [admin.address]);
    logAddress = await log.getAddress();
    await log.grantRole(await log.DEVICE_MANAGER_ROLE(), manager.address);
    await log.grantRole(await log.RELAYER_ROLE(), relayer.address);
    await log.connect(manager).registerDevice(DEVICE, deviceKey.address, owner.address);
  });

  it("08:00 setup: deploy, fund 50 000, operator bond 1 000, owner stake 100", async function () {
    await time.increaseTo(at(8, 0));
    // Admin wallet is the Treasury.
    token = await ethers.deployContract("AirSafeToken", [admin.address]);
    inc = await ethers.deployContract("SafetyIncentives", [
      admin.address,
      logAddress,
      await token.getAddress(),
      admin.address,
      relayer.address,
    ]);
    const incAddr = await inc.getAddress();

    await token.approve(incAddr, A(50_000));
    await inc.fundRewards(A(50_000));

    await token.transfer(relayer.address, A(1_000));
    await token.connect(relayer).approve(incAddr, A(1_000));
    await inc.connect(relayer).depositOperatorBond(A(1_000));

    await token.transfer(owner.address, A(100));
    await token.connect(owner).approve(incAddr, A(100));
    await inc.connect(owner).stakeDevice(DEVICE, A(100));

    treasuryStart = await wallet(admin.address);
    expect(treasuryStart).to.equal(A(1_000_000 - 50_000 - 1_000 - 100));
    expect(await inc.rewardFund()).to.equal(A(50_000));
    expect((await inc.operatorBond()).amount).to.equal(A(1_000));
    expect(await ownerState()).to.deep.equal({ wallet: 0n, stake: A(100) });
  });

  it("09:00 incident #1 (warning): timely ack +5, timely resolve +5", async function () {
    await logIncident(1, 6, { observedAt: at(9, 0), loggedAt: at(9, 1, 30), severity: 1 });

    // 90 s relay delay is within 15 min: P2 does not apply.
    await expect(inc.connect(keeper).slashLateRelay(keys[1]))
      .to.be.revertedWithCustomError(inc, "RelayNotLate")
      .withArgs(keys[1], 90n);

    const s = await inc.pendingSettlement(keys[1]);
    expect(s.ackDeadline).to.equal(at(9, 31, 30));

    await atTime(at(9, 8), () => log.connect(owner).acknowledgeIncident(keys[1]));
    await expect(atTime(at(9, 8, 5), () => inc.connect(owner).recordTimelyAck(keys[1])))
      .to.emit(inc, "AckRewarded")
      .withArgs(keys[1], owner.address, A(5));
    expect(await ownerState()).to.deep.equal({ wallet: A(5), stake: A(100) });

    await atTime(at(10, 0), () => log.connect(owner).resolveIncident(keys[1]));
    await expect(atTime(at(10, 0, 5), () => inc.connect(owner).recordTimelyResolve(keys[1])))
      .to.emit(inc, "ResolveRewarded")
      .withArgs(keys[1], owner.address, A(5));
    expect(await ownerState()).to.deep.equal({ wallet: A(10), stake: A(100) });
  });

  it("13:00 incident #2 (danger): owner silent, keeper slashes; late ack and double slash rejected", async function () {
    await logIncident(2, 7, { observedAt: at(13, 0), loggedAt: at(13, 1), severity: 2 });
    expect((await inc.pendingSettlement(keys[2])).ackDeadline).to.equal(at(13, 11));

    await expect(atTime(at(13, 11, 30), () => inc.connect(keeper).slashMissedAck(keys[2])))
      .to.emit(inc, "MissedAckSlashed")
      .withArgs(keys[2], DEVICE, A(20), keeper.address);
    expect(await ownerState()).to.deep.equal({ wallet: A(10), stake: A(80) });
    expect(await wallet(keeper.address)).to.equal(A(10));
    expect(await wallet(admin.address)).to.equal(treasuryStart + A(10));

    // 13:30: the late ack itself succeeds on AirSafetyLog but earns nothing.
    await atTime(at(13, 30), () => log.connect(owner).acknowledgeIncident(keys[2]));
    await expect(inc.connect(owner).recordTimelyAck(keys[2]))
      .to.be.revertedWithCustomError(inc, "AckDeadlinePassed")
      .withArgs(keys[2], at(13, 11));

    await time.increaseTo(at(13, 31));
    await expect(inc.connect(keeper).slashMissedAck(keys[2]))
      .to.be.revertedWithCustomError(inc, "AlreadySettled")
      .withArgs(keys[2]);
    expect(await ownerState()).to.deep.equal({ wallet: A(10), stake: A(80) });
    expect(await wallet(keeper.address)).to.equal(A(10));
  });

  it("18:00 incident #3: relayed 25 min late, operator slashed; owner deadline counts from loggedAt", async function () {
    await logIncident(3, 8, { observedAt: at(18, 0), loggedAt: at(18, 25), severity: 1 });

    await expect(atTime(at(18, 26), () => inc.connect(keeper).slashLateRelay(keys[3])))
      .to.emit(inc, "LateRelaySlashed")
      .withArgs(keys[3], 25n * 60n, A(20), keeper.address);
    expect((await inc.operatorBond()).amount).to.equal(A(980));
    expect(await wallet(keeper.address)).to.equal(A(20));
    expect(await wallet(admin.address)).to.equal(treasuryStart + A(20));

    // Owner deadline is 18:55 (loggedAt + 30 min), not 18:30.
    expect((await inc.pendingSettlement(keys[3])).ackDeadline).to.equal(at(18, 55));
    await atTime(at(18, 40), () => log.connect(owner).acknowledgeIncident(keys[3]));
    await expect(atTime(at(18, 40, 5), () => inc.connect(owner).recordTimelyAck(keys[3])))
      .to.emit(inc, "AckRewarded")
      .withArgs(keys[3], owner.address, A(5));
    expect(await ownerState()).to.deep.equal({ wallet: A(15), stake: A(80) });
    expect(await inc.rewardsToday(DEVICE, await inc.currentDay())).to.equal(2n);

    await time.increaseTo(at(19, 0));
    await expect(inc.connect(keeper).slashMissedAck(keys[3])).to.be.revertedWithCustomError(inc, "AlreadySettled");
  });

  it("20:00 farming three fake incidents: only #4 pays, #5 and #6 hit the cap but are not slashed", async function () {
    const plan = [
      [4, 9, at(20, 0)],
      [5, 10, at(20, 10)],
      [6, 11, at(20, 20)],
    ];
    for (const [n, seq, observed] of plan) {
      await logIncident(n, seq, { observedAt: observed, loggedAt: observed + 30n, severity: 1 });
      await atTime(observed + 120n, () => log.connect(owner).acknowledgeIncident(keys[n]));
      const tx = atTime(observed + 125n, () => inc.connect(owner).recordTimelyAck(keys[n]));
      if (n === 4) {
        await expect(tx).to.emit(inc, "AckRewarded").withArgs(keys[n], owner.address, A(5));
      } else {
        await expect(tx).to.emit(inc, "RewardSkipped").withArgs(keys[n], owner.address, 1n, SKIP_DAILY_CAP);
      }
    }
    expect(await ownerState()).to.deep.equal({ wallet: A(20), stake: A(80) });
    expect(await inc.rewardsToday(DEVICE, await inc.currentDay())).to.equal(3n);

    // Over-cap acks are still timely: past the deadline nobody can slash them.
    await time.increaseTo(at(21, 0));
    for (const n of [5, 6]) {
      expect(await inc.settlementFlags(keys[n])).to.equal(await inc.TIMELY_ACK());
      await expect(inc.connect(keeper).slashMissedAck(keys[n])).to.be.revertedWithCustomError(inc, "AlreadySettled");
    }
  });

  it("end of day: every balance matches the summary table and supply is conserved", async function () {
    const incAddr = await inc.getAddress();
    expect(await ownerState()).to.deep.equal({ wallet: A(20), stake: A(80) });
    expect(await wallet(relayer.address)).to.equal(0n);
    expect((await inc.operatorBond()).amount).to.equal(A(980));
    expect(await wallet(keeper.address)).to.equal(A(20));
    expect((await wallet(admin.address)) - treasuryStart).to.equal(A(20));
    expect(await inc.rewardFund()).to.equal(A(49_980));
    expect(await inc.totalBonded()).to.equal(A(80 + 980));

    const supply = await token.totalSupply();
    expect(supply).to.equal(A(1_000_000));
    const holders = [admin, relayer, owner, keeper].map((s) => s.address).concat(incAddr);
    let sum = 0n;
    for (const h of holders) sum += await wallet(h);
    expect(sum).to.equal(supply);
  });
});
