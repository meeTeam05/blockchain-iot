// Verify the deployed AirSafetyLog source on Etherscan and mark the
// deployment record as verified.
//
//   npx hardhat run scripts/verify.js --network sepolia
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  try {
    await hre.run("verify:verify", { address: record.address, constructorArguments: [record.admin] });
  } catch (err) {
    if (!/already verified/i.test(String(err.message))) throw err;
    console.log("Already verified");
  }
  record.verified = true;
  record.verifiedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  console.log(`Verified: ${record.explorer ?? record.address}#code`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
