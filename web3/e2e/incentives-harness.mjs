import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ContractFactory, NonceManager, Wallet, SigningKey, computeAddress, keccak256 } from 'ethers';
import { createProvider, KEYS } from '../../server/api/test/helpers/chain-deploy.js';
import { DEVICE_ID, USER_ID, createIncidentDb, createIntakeFastify, loadVector, rawBytes, signIncident } from '../../server/api/test/helpers/incident-fixtures.js';
import { handleIncident } from '../../server/api/src/services/incident-intake.js';
import { normalizeIncidentDomain } from '../../server/api/src/services/incident-verify.js';
import { createChainContext } from '../../server/api/src/chain/air-safety-log.js';
import { createRelayer } from '../../server/api/src/chain/relayer.js';
import { createIndexer } from '../../server/api/src/chain/indexer.js';
import { createIncentivesContext } from '../../server/api/src/chain/incentives.js';
import { createIncentivesIndexer } from '../../server/api/src/chain/incentives-indexer.js';
import incidentsRoutes from '../../server/api/src/routes/incidents.js';
import incentivesRoutes from '../../server/api/src/routes/incentives.js';
import { formatSseEvent } from '../../server/api/src/services/realtime-events.js';
import { INCIDENT_DEPLOYMENTS, AIR_SAFETY_LOG_ABI } from '../../server/api/src/generated/incident-deployments.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const web = path.join(root, 'web3');
const require = createRequire(path.join(root, 'server/api/package.json'));
const Fastify = require('fastify');
const cors = require('@fastify/cors');
const node = spawn(process.execPath, [path.join(root, 'blockchain/node_modules/hardhat/internal/cli/cli.js'), 'node', '--hostname', '127.0.0.1', '--port', '18545'],
  { cwd: path.join(root, 'blockchain'), stdio: 'ignore' });
const provider = createProvider('http://127.0.0.1:18545');
let app, store;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  node.kill('SIGTERM');
  provider.destroy();
  await app?.close();
  await store?.close();
  process.exit(0);
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await provider.send('eth_chainId', []); ready = true; break; } catch { await new Promise((done) => setTimeout(done, 200)); }
  }
  if (!ready) throw new Error('Isolated Hardhat node failed to start');
  const admin = new NonceManager(new Wallet(KEYS.admin, provider));
  const owner = new Wallet(KEYS.owner, provider);
  const manager = new Wallet(KEYS.manager, provider);
  const relayer = new Wallet(KEYS.relayer, provider);
  async function deploy(name, args) {
    const artifact = JSON.parse(await readFile(path.join(root, `blockchain/artifacts/contracts/${name}.sol/${name}.json`), 'utf8'));
    const contract = await new ContractFactory(artifact.abi, artifact.bytecode, admin).deploy(...args);
    await contract.waitForDeployment(); return contract;
  }
  // Deploy first, before granting roles, preserving the canonical local nonce/address sequence.
  const log = await deploy('AirSafetyLog', [await admin.getAddress()]);
  const token = await deploy('AirSafeToken', [await admin.getAddress()]);
  const incentives = await deploy('SafetyIncentives', [await admin.getAddress(), await log.getAddress(), await token.getAddress(), await admin.getAddress(), relayer.address]);
  const record = INCIDENT_DEPLOYMENTS.localhost;
  const logAddress = await log.getAddress();
  if (logAddress !== record.address) throw new Error('Local deployment address mismatch');
  const runtimeCodeHash = keccak256(await provider.getCode(logAddress));
  if (runtimeCodeHash !== '0xf504c6cd815e3692a008fea42979045966d0623fc1548e83c7675723d8e6c29f') throw new Error('Local AirSafetyLog runtime hash changed');
  const receipt = await log.deploymentTransaction().wait();
  await mkdir(path.join(web, '.incentives-e2e'), { recursive: true });
  const deployments = { ...INCIDENT_DEPLOYMENTS, localhost: { ...record, deployTxHash: receipt.hash, blockNumber: receipt.blockNumber, domainSeparator: await log.domainSeparator() } };
  await writeFile(path.join(web, '.incentives-e2e/incident-deployments.ts'),
    `// Ephemeral real-chain fixture, never included in production.\nexport const INCIDENT_DEPLOYMENTS = ${JSON.stringify(deployments)} as const;\nexport const AIR_SAFETY_LOG_ABI = ${JSON.stringify(AIR_SAFETY_LOG_ABI)} as const;\n`);
  await (await log.grantRole(await log.RELAYER_ROLE(), relayer.address)).wait();
  await (await log.grantRole(await log.DEVICE_MANAGER_ROLE(), manager.address)).wait();
  const amount = (n) => BigInt(n) * 10n ** 18n;
  await (await token.approve(await incentives.getAddress(), amount(51000))).wait();
  await (await incentives.fundRewards(amount(50000))).wait();
  await (await incentives.depositOperatorBond(amount(1000))).wait();
  await (await token.transfer(owner.address, amount(100))).wait();

  store = await createIncidentDb();
  const vector = await loadVector('earlyWarning');
  const signingKey = new SigningKey(vector.vector.test_private_key_only);
  const hash = vector.payload.device_id_hash;
  const signerAddress = computeAddress(signingKey);
  await (await log.connect(manager).registerDevice(hash, signerAddress, owner.address)).wait();
  await store.query(`INSERT INTO device_signers(device_id, signer_address, status) VALUES ($1, $2, 'active') ON CONFLICT DO NOTHING`, [DEVICE_ID, signerAddress.toLowerCase()]);
  const current = normalizeIncidentDomain({ name: 'AirSafetyLog', version: '1', chainId: '11155111', verifyingContract: logAddress });
  const chain = createChainContext({ provider, address: logAddress, relayerPrivateKey: KEYS.relayer, deviceManagerPrivateKey: KEYS.manager });
  const config = { confirmations: 1, batchSize: 20, maxAttempts: 10, maxRetryAgeHours: 24, logBatchBlocks: 2000, stateRefreshMs: 1 };
  const silent = { info() {}, warn() {}, error() {} };
  const relay = createRelayer({ db: store, chain, config, log: silent });
  const indexer = createIndexer({ db: store, chain, config, startBlock: 1, log: silent });
  const inc = createIncentivesIndexer({ db: store, chain: createIncentivesContext({ provider, address: await incentives.getAddress(), tokenAddress: await token.getAddress() }), config, startBlock: 3, log: silent });
  let serial = Promise.resolve();
  function exclusive(task) { const job = serial.then(task); serial = job.catch(() => {}); return job; }
  async function sync() { await indexer.catchUp(); await relay.tick(); await indexer.catchUp(); await inc.catchUp(); }
  await sync();
  app = Fastify({ logger: false });
  await app.register(cors, { origin: 'http://127.0.0.1:5176', credentials: true });
  app.decorate('db', store.db);
  app.decorate('incentivesContractAddress', (await incentives.getAddress()).toLowerCase());
  app.decorate('authenticate', async (request, reply) => {
    if (request.headers.authorization !== 'Bearer fixture-access') return reply.code(401).send({ error: 'Unauthorized fixture' });
    request.user = { sub: USER_ID };
  });
  app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/api/') && !request.url.includes('/realtime')) await exclusive(sync);
  });
  app.post('/api/auth/login', async () => ({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh', user: { id: USER_ID, email: 'task8@local.test' } }));
  app.get('/api/devices', { preHandler: app.authenticate }, async () => [{ id: DEVICE_ID, name: 'Task 8 sensor', online: true }]);
  await app.register(incidentsRoutes, { prefix: '/api' });
  await app.register(incentivesRoutes, { prefix: '/api' });
  app.get('/api/realtime', { preHandler: app.authenticate }, async (request, reply) => {
    reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': 'http://127.0.0.1:5176', 'Access-Control-Allow-Credentials': 'true' });
    let last = request.headers['last-event-id'] ?? '0';
    let reading = false;
    const timer = setInterval(async () => {
      if (reading) return; reading = true;
      try {
        const { rows } = await store.query('SELECT * FROM realtime_events WHERE id > $1 ORDER BY id', [last]);
        for (const row of rows) { reply.raw.write(formatSseEvent(row)); last = String(row.id); }
      } finally { reading = false; }
    }, 100);
    request.raw.on('close', () => clearInterval(timer));
  });
  app.get('/__test/ready', async () => ({ ready: true }));
  app.post('/__test/time', async (request) => exclusive(async () => {
    await provider.send('evm_increaseTime', [Number(request.body.seconds)]); await provider.send('evm_mine', []); await sync(); return { ok: true };
  }));
  app.post('/__test/incident', async (request) => exclusive(async () => {
    const { sequence, danger = false, observedAgo = 60 } = request.body;
    const base = danger ? await loadVector('exceeded') : vector;
    const observedAt = Number((await provider.getBlock('latest')).timestamp) - observedAgo;
    const payload = signIncident({ vector: base.vector, domain: current, payload: base.payload,
      overrides: { sequence: String(sequence), observed_at: String(observedAt) }, signingKey });
    const result = await handleIncident(createIntakeFastify(store), DEVICE_ID, payload, rawBytes(payload), {
      domains: { current, legacy: [] }, incidentConfig: { maxPayloadBytes: 4096, clockSkewSeconds: 600 }, now: () => new Date((observedAt + 1) * 1000),
    });
    if (!result.accepted) throw new Error('Fixture incident intake rejected');
    for (let round = 0; round < 4; round++) await sync();
    return { deviceId: DEVICE_ID, incidentId: payload.incident_id };
  }));
  app.post('/__test/set-params', async (request) => exclusive(async () => {
    const params = await incentives.params();
    const fields = ['ackDeadlineWarning', 'ackDeadlineDanger', 'resolveDeadline', 'ownerBond', 'ackReward', 'resolveReward', 'missedAckPenalty', 'maxRelayDelay', 'lateRelayPenalty', 'keeperShareBps', 'dailyRewardCap', 'unstakeCooldown'];
    await (await incentives.setParams(fields.map((name) => request.body[name] ?? params[name]))).wait(); await sync(); return { ok: true };
  }));
  await app.listen({ port: 3006, host: '127.0.0.1' });
  console.log('Task 8 local harness ready (real contracts, intake, relayer, indexers and incentives API).');
} catch (error) {
  console.error(error.message); node.kill('SIGTERM'); provider.destroy(); await app?.close(); await store?.close(); process.exit(1);
}
