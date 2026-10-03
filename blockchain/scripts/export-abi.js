// Export contract ABIs to blockchain/abi/<Contract>.json for the backend
// (worker/indexer) and the dApp. Run after `npx hardhat compile`.
//
//   node scripts/export-abi.js        # every contract in CONTRACTS
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const CONTRACTS = ["AirSafetyLog", "AirSafeToken", "SafetyIncentives"];

function exportAbi(name = "AirSafetyLog") {
  const artifactPath = path.join(ROOT, "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const out = path.join(ROOT, "abi", `${name}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(artifact.abi, null, 2) + "\n");
  return out;
}

if (require.main === module) {
  for (const name of CONTRACTS) console.log(`ABI written to ${exportAbi(name)}`);
}

module.exports = { CONTRACTS, exportAbi };
