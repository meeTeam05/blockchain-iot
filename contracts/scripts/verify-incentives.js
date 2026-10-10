// Verify AirSafeToken and SafetyIncentives on Etherscan and mark the
// incentives deployment record as verified.
//
//   npx hardhat run scripts/verify-incentives.js --network sepolia
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

async function verify(address, constructorArguments) {
  try {
    await hre.run("verify:verify", { address, constructorArguments });
  } catch (err) {
    if (!/already verified/i.test(String(err.message))) throw err;
    console.log(`${address} already verified`);
  }
}

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${hre.network.name}.incentives.json`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  await verify(record.token.address, record.token.constructorArguments);
  await verify(record.incentives.address, record.incentives.constructorArguments);
  record.verified = true;
  record.verifiedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  console.log(`Verified: ${record.token.explorer ?? record.token.address}#code`);
  console.log(`Verified: ${record.incentives.explorer ?? record.incentives.address}#code`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
