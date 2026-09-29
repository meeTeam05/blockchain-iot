// Deploy AirSafetyLog and record the hand-off artifacts:
//   blockchain/deployments/<network>.json      full deployment record
//   spec/incident/deployments/<network>.json   EIP-712 domain source of truth
//                                              (localhost/sepolia only)
//
//   npx hardhat run scripts/deploy.js --network sepolia
//   npx hardhat run scripts/deploy.js --network localhost   (after `npx hardhat node`)
//
// Afterwards run `node ../spec/incident/gen/gen-all.mjs` and commit the
// generated firmware/backend files in the same commit as the deployment.
//
// Env: ADMIN_ADDRESS (defaults to deployer), RELAYER_ADDRESS and
// DEVICE_MANAGER_ADDRESS (optional, granted only while the deployer is admin).
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const { exportAbi } = require("./export-abi");

const { ethers, network } = hre;
const CONFIRMATIONS = network.name === "hardhat" || network.name === "localhost" ? 1 : 5;
const SPEC_NETWORKS = new Set(["localhost", "sepolia"]);
const SPEC_DIR = path.join(__dirname, "..", "..", "spec", "incident", "deployments");

// Domains that devices may still have signed queued records for. They are
// accepted off-chain by the backend (outbox status legacy_domain), never relayed.
function legacyAddresses(networkName, newAddress) {
  const file = path.join(SPEC_DIR, `${networkName}.json`);
  const seedFile = path.join(SPEC_DIR, "..", "legacy-domains.json");
  const seed = fs.existsSync(seedFile) ? JSON.parse(fs.readFileSync(seedFile, "utf8"))[networkName] ?? [] : [];
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  const all = [...seed, ...(previous?.legacyAddresses ?? []), ...(previous?.address ? [previous.address] : [])];
  const seen = new Set([newAddress.toLowerCase()]);
  return all.filter((a) => {
    const k = a.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function main() {
  if (network.name === "sepolia") {
    const missing = ["SEPOLIA_RPC_URL", "DEPLOYER_PRIVATE_KEY"].filter((k) => !process.env[k]);
    if (missing.length) throw new Error(`Missing ${missing.join(", ")} in blockchain/.env`);
  }
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account: set DEPLOYER_PRIVATE_KEY");

  const admin = process.env.ADMIN_ADDRESS || deployer.address;
  const relayer = process.env.RELAYER_ADDRESS || "";
  const manager = process.env.DEVICE_MANAGER_ADDRESS || "";
  for (const [k, v] of Object.entries({ admin, relayer, manager })) {
    if (v && !ethers.isAddress(v)) throw new Error(`Invalid ${k} address: ${v}`);
  }

  if (network.name === "sepolia" && relayer && relayer.toLowerCase() === admin.toLowerCase()
      && process.env.ALLOW_SHARED_RELAYER !== "1") {
    throw new Error("RELAYER_ADDRESS must be a dedicated wallet, not the admin (set ALLOW_SHARED_RELAYER=1 to override)");
  }

  const { chainId } = await ethers.provider.getNetwork();
  console.log(`Network ${network.name} (chain ${chainId}), deployer ${deployer.address}`);
  console.log(`Balance ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);

  const log = await ethers.deployContract("AirSafetyLog", [admin]);
  const deployTx = log.deploymentTransaction();
  console.log(`Deploy tx ${deployTx.hash}`);
  const receipt = await deployTx.wait(CONFIRMATIONS);
  const address = await log.getAddress();
  console.log(`AirSafetyLog deployed at ${address} (block ${receipt.blockNumber})`);

  const grants = [];
  if (admin.toLowerCase() === deployer.address.toLowerCase()) {
    for (const [role, who] of [
      ["RELAYER_ROLE", relayer],
      ["DEVICE_MANAGER_ROLE", manager],
    ]) {
      if (!who) continue;
      const tx = await log.grantRole(await log[role](), who);
      await tx.wait(CONFIRMATIONS);
      grants.push({ role, account: who, tx: tx.hash });
      console.log(`Granted ${role} to ${who} (${tx.hash})`);
    }
  } else if (relayer || manager) {
    console.warn("ADMIN_ADDRESS is not the deployer: grant RELAYER_ROLE / DEVICE_MANAGER_ROLE from the admin wallet.");
  }

  const domain = await log.eip712Domain();
  const record = {
    contract: "AirSafetyLog",
    network: network.name,
    chainId: chainId.toString(),
    address,
    deployTxHash: deployTx.hash,
    blockNumber: receipt.blockNumber,
    deployer: deployer.address,
    admin,
    roleGrants: grants,
    eip712Domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId.toString(),
      verifyingContract: domain.verifyingContract,
    },
    schemaVersion: 2,
    compiler: hre.config.solidity.compilers[0],
    verified: false,
    explorer: chainId === 11155111n ? `https://sepolia.etherscan.io/address/${address}` : null,
    deployedAt: new Date().toISOString(),
  };

  const out = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  console.log(`Deployment record written to ${out}`);

  if (SPEC_NETWORKS.has(network.name)) {
    const spec = {
      network: network.name,
      chainId: chainId.toString(),
      domain: { name: domain.name, version: domain.version },
      address,
      domainSeparator: await log.domainSeparator(),
      legacyAddresses: legacyAddresses(network.name, address),
      deployTxHash: deployTx.hash,
      blockNumber: receipt.blockNumber,
      schemaVersion: 2,
    };
    const specOut = path.join(SPEC_DIR, `${network.name}.json`);
    fs.mkdirSync(SPEC_DIR, { recursive: true });
    fs.writeFileSync(specOut, JSON.stringify(spec, null, 2) + "\n");
    console.log(`Spec deployment written to ${specOut}; now run: node spec/incident/gen/gen-all.mjs`);
  }
  console.log(`ABI written to ${exportAbi()}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
