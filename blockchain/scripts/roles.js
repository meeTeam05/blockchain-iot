// Hardhat task to inspect and manage AirSafetyLog roles on a deployed network.
// Must be sent from a DEFAULT_ADMIN_ROLE holder (DEPLOYER_PRIVATE_KEY) for
// grant/revoke.
//
//   npx hardhat roles --network sepolia
//   npx hardhat roles --network sepolia --action grant  --role RELAYER_ROLE --account 0x...
//   npx hardhat roles --network sepolia --action revoke --role RELAYER_ROLE --account 0x...
const fs = require("node:fs");
const path = require("node:path");
const { task } = require("hardhat/config");

const ROLES = ["DEFAULT_ADMIN_ROLE", "DEVICE_MANAGER_ROLE", "RELAYER_ROLE"];
const LOCAL_NETWORKS = new Set(["hardhat", "localhost"]);

function loadDeployment(networkName) {
  const file = path.join(__dirname, "..", "deployments", `${networkName}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment record at ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Role members from RoleGranted/RoleRevoked events since the deploy block.
async function roleMembers(log, fromBlock) {
  const members = Object.fromEntries(ROLES.map((r) => [r, new Set()]));
  const names = {};
  for (const r of ROLES) names[await log[r]()] = r;
  const [granted, revoked] = await Promise.all([
    log.queryFilter(log.filters.RoleGranted(), fromBlock),
    log.queryFilter(log.filters.RoleRevoked(), fromBlock),
  ]);
  const events = [...granted, ...revoked].sort(
    (a, b) => a.blockNumber - b.blockNumber || a.index - b.index
  );
  for (const ev of events) {
    const name = names[ev.args.role];
    if (!name) continue;
    if (ev.fragment.name === "RoleGranted") members[name].add(ev.args.account);
    else members[name].delete(ev.args.account);
  }
  return members;
}

async function printStatus(log, fromBlock) {
  const members = await roleMembers(log, fromBlock);
  for (const r of ROLES) {
    const list = [...members[r]];
    console.log(`${r.padEnd(20)} ${list.length ? list.join(", ") : "(none)"}`);
  }
}

task("roles", "Show, grant or revoke AirSafetyLog roles")
  .addOptionalParam("action", "status | grant | revoke", "status")
  .addOptionalParam("role", `One of ${ROLES.join(", ")}`)
  .addOptionalParam("account", "Target account address")
  .setAction(async ({ action, role, account }, hre) => {
    const { ethers, network } = hre;
    const record = loadDeployment(network.name);
    const log = await ethers.getContractAt("AirSafetyLog", record.address);
    console.log(`AirSafetyLog ${record.address} on ${network.name}\n`);

    if (action === "status") {
      await printStatus(log, record.blockNumber);
      return;
    }
    if (action !== "grant" && action !== "revoke") throw new Error(`Unknown action: ${action}`);
    if (!ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(", ")}`);
    if (!account || !ethers.isAddress(account)) throw new Error("--account must be a valid address");

    const [sender] = await ethers.getSigners();
    const roleHash = await log[role]();
    if (!(await log.hasRole(ethers.ZeroHash, sender.address))) {
      throw new Error(`${sender.address} does not hold DEFAULT_ADMIN_ROLE`);
    }
    const has = await log.hasRole(roleHash, account);
    if (action === "grant" && has) return console.log(`${account} already has ${role}`);
    if (action === "revoke" && !has) return console.log(`${account} does not have ${role}`);
    if (action === "revoke" && role === "DEFAULT_ADMIN_ROLE" && account.toLowerCase() === sender.address.toLowerCase()) {
      throw new Error("Refusing to revoke DEFAULT_ADMIN_ROLE from the sender; grant it to another admin first and revoke from there");
    }

    const tx = action === "grant" ? await log.grantRole(roleHash, account) : await log.revokeRole(roleHash, account);
    console.log(`${action} ${role} -> ${account}: ${tx.hash}`);
    await tx.wait(LOCAL_NETWORKS.has(network.name) ? 1 : 2);
    console.log("Confirmed.\n");
    await printStatus(log, record.blockNumber);
  });
