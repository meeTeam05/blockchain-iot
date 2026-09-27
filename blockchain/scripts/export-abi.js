// Export the AirSafetyLog ABI to blockchain/abi/AirSafetyLog.json for the
// backend (worker/indexer) and the app. Run after `npx hardhat compile`.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function exportAbi() {
  const artifactPath = path.join(ROOT, "artifacts", "contracts", "AirSafetyLog.sol", "AirSafetyLog.json");
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const out = path.join(ROOT, "abi", "AirSafetyLog.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(artifact.abi, null, 2) + "\n");
  return out;
}

if (require.main === module) {
  console.log(`ABI written to ${exportAbi()}`);
}

module.exports = { exportAbi };
