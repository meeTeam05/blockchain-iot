// Deploy AirSafeToken + SafetyIncentives next to an existing AirSafetyLog and
// record the hand-off artifacts:
//   contracts/deployments/<network>.incentives.json   addresses, blocks, params
//   contracts/abi/{AirSafeToken,SafetyIncentives}.json
//
//   npx hardhat run scripts/deploy-incentives.js --network localhost
//   npx hardhat run scripts/deploy-incentives.js --network sepolia
//
// AirSafetyLog, its EIP-712 domain and deployments/<network>.json are only
// read, never changed. Afterwards run scripts/fund-incentives.js and
// `node ../spec/incident/gen/gen-all.mjs`, and commit the outputs together.
//
// Env: AIR_SAFETY_LOG_ADDRESS (defaults to spec/incident/deployments/<network>.json),
// ADMIN_ADDRESS (defaults to deployer), TREASURY_ADDRESS (defaults to admin),
// OPERATOR_ADDRESS (defaults to RELAYER_ADDRESS, then the RELAYER_ROLE grant
// recorded in deployments/<network>.json).
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const { exportAbi } = require("./export-abi");

const { ethers, network } = hre;
const LOCAL = network.name === "hardhat" || network.name === "localhost";
const CONFIRMATIONS = LOCAL ? 1 : 5;
const DEPLOYMENTS_DIR = path.join(__dirname, "..", "deployments");
const SPEC_DIR = path.join(__dirname, "..", "..", "spec", "incident", "deployments");

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

async function resolveAirSafetyLog() {
  const address = process.env.AIR_SAFETY_LOG_ADDRESS || readJson(path.join(SPEC_DIR, `${network.name}.json`))?.address;
  if (address) return address;
  if (network.name !== "hardhat") {
    throw new Error(`No AirSafetyLog for ${network.name}: set AIR_SAFETY_LOG_ADDRESS or run scripts/deploy.js first`);
  }
  // In-process network: deploy a throwaway log so the script can be smoke-tested.
  const [deployer] = await ethers.getSigners();
  const log = await ethers.deployContract("AirSafetyLog", [deployer.address]);
  return log.getAddress();
}

function resolveOperator() {
  const explicit = process.env.OPERATOR_ADDRESS || process.env.RELAYER_ADDRESS;
  if (explicit) return explicit;
  const record = readJson(path.join(DEPLOYMENTS_DIR, `${network.name}.json`));
  return record?.roleGrants?.find((g) => g.role === "RELAYER_ROLE")?.account || "";
}

async function main() {
  if (network.name === "sepolia") {
    const missing = ["SEPOLIA_RPC_URL", "DEPLOYER_PRIVATE_KEY"].filter((k) => !process.env[k]);
    if (missing.length) throw new Error(`Missing ${missing.join(", ")} in contracts/.env`);
  }
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account: set DEPLOYER_PRIVATE_KEY");

  const logAddress = await resolveAirSafetyLog();
  const admin = process.env.ADMIN_ADDRESS || deployer.address;
  const treasury = process.env.TREASURY_ADDRESS || admin;
  let operator = resolveOperator();
  if (!operator && LOCAL) operator = (await ethers.getSigners())[1].address;
  for (const [k, v] of Object.entries({ airSafetyLog: logAddress, admin, treasury, operator })) {
    if (!v || !ethers.isAddress(v)) throw new Error(`Invalid ${k} address: ${v || "(empty)"}`);
  }

  // Refuse to wire the incentives to something that is not AirSafetyLog.
  if ((await ethers.provider.getCode(logAddress)) === "0x") throw new Error(`No contract at ${logAddress}`);
  const log = await ethers.getContractAt("AirSafetyLog", logAddress);
  const domain = await log.eip712Domain();
  if (domain.name !== "AirSafetyLog") throw new Error(`${logAddress} is not AirSafetyLog (domain ${domain.name})`);

  const { chainId } = await ethers.provider.getNetwork();
  console.log(`Network ${network.name} (chain ${chainId}), deployer ${deployer.address}`);
  console.log(`Balance ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log(`AirSafetyLog ${logAddress}, admin ${admin}, treasury ${treasury}, operator ${operator}`);

  const token = await ethers.deployContract("AirSafeToken", [treasury]);
  const tokenReceipt = await token.deploymentTransaction().wait(CONFIRMATIONS);
  const tokenAddress = await token.getAddress();
  console.log(`AirSafeToken deployed at ${tokenAddress} (block ${tokenReceipt.blockNumber})`);

  const inc = await ethers.deployContract("SafetyIncentives", [admin, logAddress, tokenAddress, treasury, operator]);
  const incReceipt = await inc.deploymentTransaction().wait(CONFIRMATIONS);
  const incAddress = await inc.getAddress();
  console.log(`SafetyIncentives deployed at ${incAddress} (block ${incReceipt.blockNumber})`);

  const p = await inc.params();
  const params = Object.fromEntries(Object.keys(p.toObject()).map((k) => [k, p[k].toString()]));
  const explorer = chainId === 11155111n && !LOCAL ? "https://sepolia.etherscan.io/address/" : null;
  const record = {
    network: network.name,
    chainId: chainId.toString(),
    airSafetyLog: logAddress,
    token: {
      contract: "AirSafeToken",
      address: tokenAddress,
      deployTxHash: tokenReceipt.hash,
      blockNumber: tokenReceipt.blockNumber,
      constructorArguments: [treasury],
      explorer: explorer && `${explorer}${tokenAddress}`,
    },
    incentives: {
      contract: "SafetyIncentives",
      address: incAddress,
      deployTxHash: incReceipt.hash,
      blockNumber: incReceipt.blockNumber,
      activatedAt: (await inc.activatedAt()).toString(),
      constructorArguments: [admin, logAddress, tokenAddress, treasury, operator],
      explorer: explorer && `${explorer}${incAddress}`,
    },
    deployer: deployer.address,
    admin,
    treasury,
    operator,
    params,
    compiler: hre.config.solidity.compilers[0],
    verified: false,
    deployedAt: new Date().toISOString(),
  };

  const out = path.join(DEPLOYMENTS_DIR, `${network.name}.incentives.json`);
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  console.log(`Deployment record written to ${out}`);
  for (const name of ["AirSafeToken", "SafetyIncentives"]) console.log(`ABI written to ${exportAbi(name)}`);
  console.log("Next: scripts/fund-incentives.js, then node ../spec/incident/gen/gen-all.mjs");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
