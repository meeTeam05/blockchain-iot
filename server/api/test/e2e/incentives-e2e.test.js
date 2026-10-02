// Local end-to-end of the token incentives backend over a real chain (Task5_8_plan.md,
// Task 7, step 7.6), following the one-day scenario of Token_incentive_task.md:
//   intake -> relayer -> AirSafetyLog -> indexer -> incentives indexer -> keeper -> API
//
// Skipped unless E2E_CHAIN_RPC_URL points at a hardhat node (chain 11155111):
//
//   cd blockchain && npx hardhat compile && npx hardhat node
//   cd server/api && E2E_CHAIN_RPC_URL=http://127.0.0.1:8545 node --test test/e2e/incentives-e2e.test.js
//
// Each run deploys fresh AirSafetyLog + AirSafeToken + SafetyIncentives from
// blockchain/artifacts with public hardhat accounts #6..#11 (admin/Treasury, relayer =
// incentives operator, device manager, owner, server keeper, outside keeper K). They differ
// from chain-e2e's #0..#3 because node --test runs files in parallel on the same node.
// Deadlines are crossed with evm_increaseTime. Nothing calls the reward or P1 functions
// by hand: the worker's keeper does it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { ContractFactory, HDNodeWallet, JsonRpcProvider, NonceManager, SigningKey, Wallet } from 'ethers';

import { ChainFatalError, createChainContext } from '../../src/chain/air-safety-log.js';
import { createIndexer } from '../../src/chain/indexer.js';
import { createRelayer } from '../../src/chain/relayer.js';
import { setupIncentives } from '../../src/worker.js';
import incentivesRoutes from '../../src/routes/incentives.js';
import incidentsRoutes from '../../src/routes/incidents.js';
import { handleIncident } from '../../src/services/incident-intake.js';
import { normalizeIncidentDomain } from '../../src/services/incident-verify.js';
import { deviceIdHash, requestSignerRegistration } from '../../src/services/signer-lifecycle.js';
import { DEVICE_ID, USER_ID, createIncidentDb, createIntakeFastify, loadVector, rawBytes, signIncident } from '../helpers/incident-fixtures.js';

const RPC_URL = process.env.E2E_CHAIN_RPC_URL;
const skip = RPC_URL ? false : 'set E2E_CHAIN_RPC_URL to a hardhat node to run the incentives E2E';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.resolve(HERE, '../../../../blockchain/artifacts/contracts');
// Public hardhat development accounts (default mnemonic), see the header for why #6..#11.
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';
const hardhatKey = (index) => HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).privateKey;
const KEYS = Object.freeze({
    admin: hardhatKey(6),
    relayer: hardhatKey(7),
    manager: hardhatKey(8),
    owner: hardhatKey(9),
    keeper: hardhatKey(10),
    outsider: hardhatKey(11),
});
const WORKER_CONFIG = Object.freeze({ confirmations: 1, batchSize: 20, maxAttempts: 10, maxRetryAgeHours: 24, logBatchBlocks: 2_000 });
const INCENTIVES_CONFIG = Object.freeze({ enabled: true, keeperEnabled: true, deployment: 'e2e', keeperBatchSize: 20, stateRefreshMs: 0 });
const A = (n) => BigInt(n) * 10n ** 18n;
const silent = process.env.E2E_DEBUG
    ? { info: (o, m) => console.log('INFO', m, JSON.stringify(o)), warn: (o, m) => console.log('WARN', m, JSON.stringify(o)), error: (o, m) => console.log('ERROR', m, JSON.stringify(o)) }
    : { info() {}, warn() {}, error() {} };

async function artifact(file, name) {
    return JSON.parse(await readFile(path.join(ARTIFACTS, file, `${name}.json`), 'utf8'));
}

async function deployContract(admin, file, name, args) {
    const { abi, bytecode } = await artifact(file, name);
    const contract = await new ContractFactory(abi, bytecode, admin).deploy(...args);
    await contract.waitForDeployment();
    return contract;
}

async function setup() {
    const provider = new JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true, cacheTimeout: -1 });
    const admin = new NonceManager(new Wallet(KEYS.admin, provider));
    const wallet = (key) => new Wallet(key, provider);
    const [relayer, manager, owner, keeper, outsider] = ['relayer', 'manager', 'owner', 'keeper', 'outsider'].map((k) => wallet(KEYS[k]));
    const adminAddress = await admin.getAddress();

    const startBlock = await provider.getBlockNumber();
    const log = await deployContract(admin, 'AirSafetyLog.sol', 'AirSafetyLog', [adminAddress]);
    for (const [role, account] of [['RELAYER_ROLE', relayer], ['DEVICE_MANAGER_ROLE', manager]]) {
        await (await log.grantRole(await log[role](), account.address)).wait();
    }
    const logAddress = await log.getAddress();
    const token = await deployContract(admin, 'AirSafeToken.sol', 'AirSafeToken', [adminAddress]);
    const tokenAddress = await token.getAddress();
    const incentives = await deployContract(admin, 'SafetyIncentives.sol', 'SafetyIncentives', [
        adminAddress, logAddress, tokenAddress, adminAddress, relayer.address,
    ]);
    const incentivesAddress = await incentives.getAddress();
    const deployBlock = (await incentives.deploymentTransaction().wait()).blockNumber;
    const deployments = {
        e2e: {
            airSafetyLog: logAddress,
            token: { address: tokenAddress, blockNumber: deployBlock - 1 },
            incentives: { address: incentivesAddress, blockNumber: deployBlock },
        },
    };

    const store = await createIncidentDb();
    const fastify = createIntakeFastify(store);
    const early = await loadVector('earlyWarning');
    const exceeded = await loadVector('exceeded');
    const deviceKey = new SigningKey(early.vector.test_private_key_only);
    const current = normalizeIncidentDomain({ name: 'AirSafetyLog', version: '1', chainId: '11155111', verifyingContract: logAddress });
    const domains = { current, legacy: [], deployment: null };
    const chain = createChainContext({ provider, address: logAddress, relayerPrivateKey: KEYS.relayer, deviceManagerPrivateKey: KEYS.manager });

    const inc = await setupIncentives({
        provider,
        chain,
        db: store,
        chainConfig: WORKER_CONFIG,
        log: silent,
        incentivesConfig: INCENTIVES_CONFIG,
        keeperPrivateKey: KEYS.keeper,
        deployments,
    });
    const relayerWorker = createRelayer({ db: store, chain, config: WORKER_CONFIG, log: silent });
    const indexer = createIndexer({ db: store, chain, config: WORKER_CONFIG, startBlock, log: silent });

    // One iteration of worker.js main loop.
    async function run(rounds = 4) {
        for (let i = 0; i < rounds; i++) {
            await indexer.catchUp();
            await relayerWorker.tick();
            await inc.indexer.catchUp();
            await inc.keeper.tick();
        }
    }
    async function chainNow() {
        return Number((await provider.getBlock('latest')).timestamp);
    }
    async function increaseTime(seconds) {
        await provider.send('evm_increaseTime', [seconds]);
        await provider.send('evm_mine', []);
    }
    // Signs like the firmware: warning (severity 1) from the early-warning vector, danger
    // (severity 2) from the exceeded vector.
    async function deliver(sequence, { danger = false, observedAgo = 60 } = {}) {
        const base = danger ? exceeded : early;
        const observedAt = (await chainNow()) - observedAgo;
        const payload = signIncident({
            vector: base.vector,
            domain: current,
            payload: base.payload,
            overrides: { sequence: String(sequence), observed_at: String(observedAt) },
            signingKey: deviceKey,
        });
        const result = await handleIncident(fastify, DEVICE_ID, payload, rawBytes(payload), {
            domains,
            incidentConfig: { maxPayloadBytes: 4096, clockSkewSeconds: 600 },
            now: () => new Date((observedAt + 5) * 1000),
        });
        assert.equal(result.accepted, true, `incident ${sequence} accepted`);
        const { rows: [row] } = await store.query(
            `SELECT o.incident_key, o.status, i.incident_id FROM blockchain_outbox o JOIN incidents i ON i.id = o.incident_row_id
             WHERE o.sequence = $1`,
            [sequence]
        );
        return { key: row.incident_key, incidentId: row.incident_id, observedAt };
    }
    async function incident(sequence) {
        const { rows: [row] } = await store.query(
            `SELECT i.*, o.status AS chain_status FROM incidents i JOIN blockchain_outbox o ON o.incident_row_id = i.id WHERE i.sequence = $1`,
            [sequence]
        );
        return row;
    }
    async function events(name, key = null) {
        const { rows } = await store.query(
            `SELECT * FROM incentive_events WHERE name = $1 AND ($2::text IS NULL OR incident_key = $2) ORDER BY id`,
            [name, key]
        );
        return rows;
    }
    const balance = (address) => token.balanceOf(address);

    return {
        provider, admin, adminAddress, relayer, manager, owner, keeper, outsider, log, token, incentives, deployments,
        store, chain, inc, run, chainNow, increaseTime, deliver, incident, events, balance, deviceKey,
    };
}

test('incentives E2E: keeper rewards (R1/R2) and slashes (P1) automatically, never P2; API reflects the day', { skip, timeout: 240_000 }, async (t) => {
    const env = await setup();
    const { store, owner, keeper, outsider, token, incentives, log } = env;
    const hash = deviceIdHash(DEVICE_ID);
    const incentivesAddress = await incentives.getAddress();
    const app = Fastify({ logger: false });
    app.decorate('db', store.db);
    app.decorate('authenticate', async (request) => {
        request.user = { sub: USER_ID };
    });
    await app.register(incidentsRoutes, { prefix: '/api' });
    await app.register(incentivesRoutes, { prefix: '/api' });
    await app.ready();
    const get = async (url) => {
        const res = await app.inject({ method: 'GET', url });
        assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
        return res.json();
    };

    try {
        await t.test('startup: a keeper wallet shared with the relayer or manager is fatal (exit code 2)', async () => {
            for (const key of [KEYS.relayer, KEYS.manager]) {
                await assert.rejects(
                    setupIncentives({
                        provider: env.provider, chain: env.chain, db: store, chainConfig: WORKER_CONFIG, log: silent,
                        incentivesConfig: INCENTIVES_CONFIG, keeperPrivateKey: key, deployments: env.deployments,
                    }),
                    (err) => err instanceof ChainFatalError && /use a dedicated KEEPER_PRIVATE_KEY/.test(err.message)
                );
            }
            const wrongLog = { e2e: { ...env.deployments.e2e, airSafetyLog: '0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A' } };
            await assert.rejects(
                setupIncentives({
                    provider: env.provider, chain: env.chain, db: store, chainConfig: WORKER_CONFIG, log: silent,
                    incentivesConfig: INCENTIVES_CONFIG, keeperPrivateKey: KEYS.keeper, deployments: wrongLog,
                }),
                ChainFatalError
            );
        });

        await t.test('08:00 setup: device registered, fund 50 000, operator bond 1 000, owner stake 100', async () => {
            const signer = new Wallet(env.deviceKey.privateKey).address;
            await requestSignerRegistration(store, DEVICE_ID, signer, { owner: owner.address });
            await env.run(2);
            assert.equal((await log.getDevice(hash)).owner, owner.address);

            await (await token.approve(incentivesAddress, A(51_000))).wait();
            await (await incentives.fundRewards(A(50_000))).wait();
            await (await incentives.depositOperatorBond(A(1_000))).wait();
            await (await token.transfer(owner.address, A(100))).wait();
            await (await token.connect(owner).approve(incentivesAddress, A(100))).wait();
            await (await incentives.connect(owner).stakeDevice(hash, A(100))).wait();
            env.treasuryStart = await env.balance(env.adminAddress);

            await env.run(1);
            const { rows: [bond] } = await store.query('SELECT * FROM device_bonds WHERE device_id_hash = $1', [hash]);
            assert.equal(bond.amount, String(A(100)));
            assert.equal(bond.device_id, DEVICE_ID);
            const params = await get('/api/incentives/params');
            assert.equal(params.reward_fund, String(A(50_000)));
            assert.equal(params.operator_bond.amount, String(A(1_000)));
        });

        await t.test('09:00 R1/R2: owner acks and resolves on chain, the keeper records both rewards', async () => {
            const i1 = await env.deliver(1, { observedAgo: 90 });
            await env.run();
            const row = await env.incident(1);
            assert.equal(row.chain_status, 'confirmed');
            assert.equal(row.incentive_covered, true);
            const s = await incentives.pendingSettlement(i1.key);
            assert.equal(Math.floor(new Date(row.ack_deadline_at).getTime() / 1000), Number(s.ackDeadline));
            assert.equal(Number(s.ackDeadline) - Number(s.loggedAt), 1800, 'warning: 30 minutes from loggedAt');

            await (await log.connect(owner).acknowledgeIncident(i1.key)).wait();
            await env.run();
            assert.equal(await env.balance(owner.address), A(5));
            assert.equal((await env.incident(1)).reward_status, 'ack_rewarded');

            await (await log.connect(owner).resolveIncident(i1.key)).wait();
            await env.run();
            assert.equal(await env.balance(owner.address), A(10));
            const done = await env.incident(1);
            assert.equal(done.reward_status, 'resolved_rewarded');
            assert.equal(done.incentive_flags, 7);

            // Recorded by the server keeper wallet, not by the owner.
            for (const name of ['AckRewarded', 'ResolveRewarded']) {
                const [event] = await env.events(name, i1.key);
                const tx = await env.provider.getTransaction(event.tx_hash);
                assert.equal(tx.from, keeper.address, `${name} sent by the keeper`);
            }
            const { rows: actions } = await store.query(`SELECT action, status FROM keeper_actions ORDER BY id`);
            assert.deepEqual(actions.map((a) => [a.action, a.status]), [['record_ack', 'done'], ['record_resolve', 'done']]);
            env.i1 = i1;
        });

        await t.test('13:00 P1: owner silent, the keeper slashes after the deadline; late ack and double slash rejected', async () => {
            const i2 = await env.deliver(2, { danger: true, observedAgo: 60 });
            await env.run();
            const s = await incentives.pendingSettlement(i2.key);
            assert.equal(Number(s.ackDeadline) - Number(s.loggedAt), 600, 'danger: 10 minutes from loggedAt');
            assert.equal((await env.events('MissedAckSlashed')).length, 0, 'not before the deadline');

            const keeperStart = await env.balance(keeper.address);
            await env.increaseTime(Number(s.ackDeadline) - (await env.chainNow()) + 30);
            await env.run();
            const [slash] = await env.events('MissedAckSlashed', i2.key);
            assert.ok(slash, 'slashed automatically');
            assert.equal(slash.account, keeper.address.toLowerCase());
            assert.equal(slash.amount, String(A(20)));
            assert.equal((await incentives.deviceBond(hash)).amount, A(80));
            assert.equal((await env.balance(keeper.address)) - keeperStart, A(10));
            assert.equal((await env.balance(env.adminAddress)) - env.treasuryStart, A(10));
            const row = await env.incident(2);
            assert.equal(row.reward_status, 'slashed');
            const { rows: [bond] } = await store.query('SELECT amount FROM device_bonds WHERE device_id_hash = $1', [hash]);
            assert.equal(bond.amount, String(A(80)));

            // 13:30 late ack: succeeds on AirSafetyLog, earns nothing, keeper does not try.
            await (await log.connect(owner).acknowledgeIncident(i2.key)).wait();
            await env.run();
            assert.equal((await env.events('AckRewarded', i2.key)).length, 0);
            assert.equal(await env.balance(owner.address), A(10));
            assert.equal((await env.incident(2)).owner_status, 'acknowledged');
            // 13:31 a second slash is rejected on chain.
            await assert.rejects(incentives.connect(outsider).slashMissedAck.staticCall(i2.key), /AlreadySettled/);
            env.i2 = i2;
        });

        await t.test('18:00 P2: relayed 25 min late; the keeper never slashes the operator, an outside wallet does', async () => {
            const i3 = await env.deliver(3, { observedAgo: 25 * 60 });
            await env.run(6);
            const s = await incentives.pendingSettlement(i3.key);
            assert.ok(Number(s.relayDelay) >= 25 * 60, 'logged 25 minutes after observedAt');
            assert.equal(s.canSlashLateRelay, true);
            assert.equal((await env.events('LateRelaySlashed')).length, 0, 'server keeper does not slash P2');
            const { rows: p2 } = await store.query(`SELECT 1 FROM keeper_actions WHERE incident_key = $1`, [i3.key]);
            assert.equal(p2.length, 0);

            const overdue = await get('/api/incentives/overdue');
            assert.deepEqual(overdue.slash_late_relay.map((r) => r.incident_key), [i3.key]);
            assert.equal(overdue.slash_late_relay[0].bounty, String(A(10)));

            await (await incentives.connect(outsider).slashLateRelay(i3.key)).wait();
            await env.run();
            const [event] = await env.events('LateRelaySlashed', i3.key);
            assert.equal(event.account, outsider.address.toLowerCase());
            assert.equal(event.amount, String(A(20)));
            assert.equal(event.device_id_hash, hash);
            assert.equal((await env.incident(3)).reward_status, 'late_relay_slashed');
            assert.equal(await env.balance(outsider.address), A(10));
            const { rows: [opBond] } = await store.query(`SELECT amount FROM device_bonds WHERE device_id_hash = $1`, [`0x${'0'.repeat(64)}`]);
            assert.equal(opBond.amount, String(A(980)));
            assert.deepEqual((await get('/api/incentives/overdue')).slash_late_relay, []);

            // 18:40 the owner's deadline counts from loggedAt: the ack is in time and rewarded.
            await (await log.connect(owner).acknowledgeIncident(i3.key)).wait();
            await env.run();
            assert.equal(await env.balance(owner.address), A(15));
            const row = await env.incident(3);
            assert.equal(row.reward_status, 'ack_rewarded');
            assert.equal(row.incentive_flags, 1 | 2 | 16);
            env.i3 = i3;
        });

        await t.test('API: device history, params, overdue, leaderboard and incident detail match the chain', async () => {
            const device = await get(`/api/devices/${DEVICE_ID}/incentives`);
            assert.equal(device.bond.amount, String(A(80)));
            assert.equal(device.bond.staker, owner.address.toLowerCase());
            assert.deepEqual(device.totals, { rewarded: String(A(15)), slashed: String(A(20)) });
            const day = Number(await incentives.currentDay());
            assert.equal(device.rewards_today.day, day);
            assert.equal(device.rewards_today.count, Number(await incentives.rewardsToday(hash, day)));
            assert.ok(device.warnings.includes('bond_below_owner_bond'));
            assert.deepEqual(
                device.events.map((e) => e.name).sort(),
                ['AckRewarded', 'AckRewarded', 'LateRelaySlashed', 'MissedAckSlashed', 'ResolveRewarded', 'Staked'].sort()
            );

            const params = await get('/api/incentives/params');
            assert.equal(params.reward_fund, String(await incentives.rewardFund()));
            assert.equal(params.reward_fund, String(A(50_000 - 15)));
            assert.equal(params.operator_bond.amount, String(A(980)));
            assert.equal(params.operator, env.relayer.address.toLowerCase());
            assert.equal(params.total_bonded, String(A(80 + 980)));

            const overdue = await get('/api/incentives/overdue');
            assert.deepEqual(overdue.slash_missed_ack, [], 'every incident is settled');

            const board = await get('/api/incentives/leaderboard');
            assert.deepEqual(board.owners, [{ account: owner.address.toLowerCase(), rewarded: String(A(15)), rewards: 3 }]);
            assert.deepEqual(board.keepers.map((k) => k.account).sort(), [keeper.address.toLowerCase(), outsider.address.toLowerCase()].sort());

            const detail = await get(`/api/devices/${DEVICE_ID}/incidents/${env.i2.incidentId}`);
            assert.equal(detail.owner_status, 'acknowledged');
            assert.equal(detail.incentive.reward_status, 'slashed');
            assert.equal(detail.incentive.flags.ack_slashed, true);
            assert.deepEqual(detail.incentive.events.map((e) => e.name), ['MissedAckSlashed']);
            const s2 = await incentives.pendingSettlement(env.i2.key);
            assert.equal(detail.incentive.deadline_at, new Date(Number(s2.ackDeadline) * 1000).toISOString());

            // Supply is conserved.
            const holders = [env.adminAddress, env.relayer.address, owner.address, keeper.address, outsider.address, incentivesAddress];
            let sum = 0n;
            for (const holder of holders) sum += await env.balance(holder);
            assert.equal(sum, await token.totalSupply());
        });

        await t.test('INCENTIVES_ENABLED=false: the worker pipeline confirms incidents without touching incentive tables', async () => {
            const disabled = await setupIncentives({
                provider: env.provider, chain: env.chain, db: store, chainConfig: WORKER_CONFIG, log: silent,
                incentivesConfig: { ...INCENTIVES_CONFIG, enabled: false }, keeperPrivateKey: KEYS.keeper,
            });
            assert.equal(disabled, null);
            const before = (await store.query('SELECT (SELECT COUNT(*) FROM incentive_events)::int AS e, (SELECT COUNT(*) FROM keeper_actions)::int AS k')).rows[0];
            await env.deliver(9);
            const relayerWorker = createRelayer({ db: store, chain: env.chain, config: WORKER_CONFIG, log: silent });
            const indexer = createIndexer({ db: store, chain: env.chain, config: WORKER_CONFIG, log: silent });
            for (let i = 0; i < 3; i++) {
                await indexer.catchUp();
                await relayerWorker.tick();
            }
            const row = await env.incident(9);
            assert.equal(row.chain_status, 'confirmed');
            assert.equal(row.incentive_covered, null);
            assert.equal(row.reward_status, 'none');
            const after = (await store.query('SELECT (SELECT COUNT(*) FROM incentive_events)::int AS e, (SELECT COUNT(*) FROM keeper_actions)::int AS k')).rows[0];
            assert.deepEqual(after, before);
        });
    } finally {
        await app.close();
        await store.close();
    }
});
