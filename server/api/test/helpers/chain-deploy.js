// Shared "deploy a fresh AirSafetyLog on a local hardhat node" helper.
// Extracted out of test/e2e/chain-e2e.test.js (decision #13,
// tmp/02_decisions/2026-10-01_task5-dapp-incident-decisions.md) so the
// web3/ integration test harness can reuse the exact same deploy logic
// instead of maintaining a second implementation that could drift.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractFactory, JsonRpcProvider, NonceManager, Wallet } from 'ethers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ARTIFACT = path.resolve(HERE, '../../../../contracts/artifacts/contracts/AirSafetyLog.sol/AirSafetyLog.json');

// Publicly known hardhat development keys (accounts #0-#3).
export const KEYS = Object.freeze({
    admin: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    relayer: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    manager: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    owner: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
});

// So callers (including web3/'s integration test) never need their own
// `ethers` import just to construct a provider.
export function createProvider(rpcUrl) {
    return new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true, cacheTimeout: -1 });
}

// Deploys a fresh AirSafetyLog from contracts/artifacts and grants
// RELAYER_ROLE / DEVICE_MANAGER_ROLE to the public hardhat relayer/manager
// keys. Returns the live ethers contract plus its deployed address.
export async function deploy(provider) {
    const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));
    const admin = new NonceManager(new Wallet(KEYS.admin, provider));
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, admin);
    const contract = await factory.deploy(await admin.getAddress());
    await contract.waitForDeployment();
    for (const [role, key] of [['RELAYER_ROLE', KEYS.relayer], ['DEVICE_MANAGER_ROLE', KEYS.manager]]) {
        await (await contract.grantRole(await contract[role](), new Wallet(key).address)).wait();
    }
    return { contract, admin, address: await contract.getAddress() };
}

// Registers a device using the manager key granted by deploy(). Kept here
// (not in the web3 integration test) so that test only needs this module,
// not a direct `ethers` dependency of its own.
export async function registerDevice(contract, provider, deviceIdHash, signerAddress, ownerAddress) {
    const manager = new Wallet(KEYS.manager, provider);
    const tx = await contract.connect(manager).registerDevice(deviceIdHash, signerAddress, ownerAddress);
    await tx.wait();
}

// Submits a device-signed incident (shape from test/helpers/incident-signing.js's
// signIncident()) through the relayer key granted by deploy(). Returns the
// computed incidentKey so callers can read back/act on the logged incident.
export async function logIncidentAsRelayer(contract, provider, signedPayload) {
    const relayer = new Wallet(KEYS.relayer, provider);
    const claim = {
        deviceIdHash: signedPayload.device_id_hash,
        incidentId: signedPayload.incident_id,
        sequence: signedPayload.sequence,
        observedAt: signedPayload.observed_at,
        severity: signedPayload.severity,
        evidenceHash: signedPayload.evidence_hash,
    };
    const tx = await contract.connect(relayer).logIncident(claim, signedPayload.signature);
    await tx.wait();
    return contract.computeIncidentKey(claim.deviceIdHash, claim.incidentId);
}
