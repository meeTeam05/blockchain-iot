// Deploy AirSafetyLog and record the hand-off artifact in
// blockchain/deployments/<network>.json.
//
//   npx hardhat run scripts/deploy.js --network sepolia
//
// Env: ADMIN_ADDRESS (defaults to deployer), RELAYER_ADDRESS and
// DEVICE_MANAGER_ADDRESS (optional, granted only while the deployer is admin).
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const { exportAbi } = require("./export-abi");

const { ethers, network } = hre;
const CONFIRMATIONS = network.name === "hardhat" || network.name === "localhost" ? 1 : 5;

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
  console.log(`ABI written to ${exportAbi()}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
