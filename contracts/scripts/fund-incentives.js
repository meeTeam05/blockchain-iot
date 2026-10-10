// Treasury tops up the reward fund and the operator bond to their targets.
// Re-running is safe: only the missing amount is transferred.
//
//   npx hardhat run scripts/fund-incentives.js --network sepolia
//
// The signer (DEPLOYER_PRIVATE_KEY on Sepolia, account #0 locally) must hold
// the ASAFE, i.e. be the Treasury. Env: REWARD_FUND_ASAFE (default 50000),
// OPERATOR_BOND_ASAFE (default 1000).
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

const CONFIRMATIONS = network.name === "hardhat" || network.name === "localhost" ? 1 : 2;

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.incentives.json`);
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}: run scripts/deploy-incentives.js first`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));

  const [signer] = await ethers.getSigners();
  const token = await ethers.getContractAt("AirSafeToken", record.token.address, signer);
  const inc = await ethers.getContractAt("SafetyIncentives", record.incentives.address, signer);
  const fundTarget = ethers.parseEther(process.env.REWARD_FUND_ASAFE || "50000");
  const bondTarget = ethers.parseEther(process.env.OPERATOR_BOND_ASAFE || "1000");

  const fundMissing = fundTarget - (await inc.rewardFund());
  const bondMissing = bondTarget - (await inc.operatorBond()).amount;
  const need = (fundMissing > 0n ? fundMissing : 0n) + (bondMissing > 0n ? bondMissing : 0n);
  const balance = await token.balanceOf(signer.address);
  console.log(`Signer ${signer.address} holds ${ethers.formatEther(balance)} ASAFE, needs ${ethers.formatEther(need)}`);
  if (balance < need) throw new Error("Signer does not hold enough ASAFE (is it the Treasury?)");

  async function send(label, fn) {
    const tx = await fn();
    await tx.wait(CONFIRMATIONS);
    console.log(`${label}: ${tx.hash}`);
  }

  if (need > 0n && (await token.allowance(signer.address, record.incentives.address)) < need) {
    await send("approve", () => token.approve(record.incentives.address, need));
  }
  if (fundMissing > 0n) await send(`fundRewards ${ethers.formatEther(fundMissing)}`, () => inc.fundRewards(fundMissing));
  if (bondMissing > 0n) {
    await send(`depositOperatorBond ${ethers.formatEther(bondMissing)}`, () => inc.depositOperatorBond(bondMissing));
  }

  console.log(`Reward fund ${ethers.formatEther(await inc.rewardFund())} ASAFE`);
  console.log(`Operator ${await inc.operator()} bond ${ethers.formatEther((await inc.operatorBond()).amount)} ASAFE`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
