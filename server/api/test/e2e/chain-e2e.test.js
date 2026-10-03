// Local end-to-end over a real chain (E2E_FIX_PLAN.md stage 8):
//   intake -> incidents/outbox -> signer lifecycle ops -> relayer -> AirSafetyLog -> indexer
//
// Skipped unless E2E_CHAIN_RPC_URL points at a hardhat node (chain 11155111):
//
//   cd blockchain && npx hardhat compile && npx hardhat node
//   cd server/api && E2E_CHAIN_RPC_URL=http://127.0.0.1:8545 node --test test/e2e/chain-e2e.test.js
//
// Each run deploys a fresh AirSafetyLog from blockchain/artifacts with the public hardhat
// accounts (#0 admin, #1 relayer, #2 device manager, #3 owner). The DB is PGlite with the
// real migrations. MQTT is represented by handleIncident(); the firmware side of the
// scenarios (rotate guard, sequence floor) is covered by the firmware host tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpcProvider, SigningKey, Wallet } from 'ethers';

import { AIR_SAFETY_LOG_ABI } from '../../src/generated/incident-deployments.js';
import { ChainFatalError, assertDomainMatchesChain, createChainContext } from '../../src/chain/air-safety-log.js';
import { createIndexer } from '../../src/chain/indexer.js';
import { createRelayer } from '../../src/chain/relayer.js';
import { handleIncident, computeIncidentKey } from '../../src/services/incident-intake.js';
import { normalizeIncidentDomain } from '../../src/services/incident-verify.js';
import {
    deviceIdHash,
    requestSignerRegistration,
    requestSignerRevocation,
} from '../../src/services/signer-lifecycle.js';
import { DEVICE_ID, createIncidentDb, createIntakeFastify, loadVector, rawBytes, signIncident } from '../helpers/incident-fixtures.js';
import { KEYS, deploy } from '../helpers/chain-deploy.js';

const RPC_URL = process.env.E2E_CHAIN_RPC_URL;
const skip = RPC_URL ? false : 'set E2E_CHAIN_RPC_URL to a hardhat node to run the chain E2E';

const LEGACY_ADDRESS = '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC';
const WORKER_CONFIG = Object.freeze({ confirmations: 1, batchSize: 20, maxAttempts: 10, maxRetryAgeHours: 24, logBatchBlocks: 2_000 });
const silent = process.env.E2E_DEBUG
    ? { info: (o, m) => console.log("INFO", m, JSON.stringify(o)), warn: (o, m) => console.log("WARN", m, JSON.stringify(o)), error: (o, m) => console.log("ERROR", m, JSON.stringify(o)) }
    : { info() {}, warn() {}, error() {} };

async function setup() {
    const provider = new JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true, cacheTimeout: -1 });
    const { contract, address } = await deploy(provider);
    const store = await createIncidentDb();
    const fastify = createIntakeFastify(store);
    const early = await loadVector('earlyWarning');
    const deviceKey = new SigningKey(early.vector.test_private_key_only); // same key as the golden vectors
    const current = normalizeIncidentDomain({ name: 'AirSafetyLog', version: '1', chainId: '11155111', verifyingContract: address });
    const legacy = normalizeIncidentDomain({ name: 'AirSafetyLog', version: '1', chainId: '11155111', verifyingContract: LEGACY_ADDRESS });
    const domains = { current, legacy: [legacy], deployment: null };
    const chain = createChainContext({ provider, address, relayerPrivateKey: KEYS.relayer, deviceManagerPrivateKey: KEYS.manager });
    const startBlock = await provider.getBlockNumber();
    const worker = () => ({
        relayer: createRelayer({ db: store, chain, config: WORKER_CONFIG, log: silent }),
        indexer: createIndexer({ db: store, chain, config: WORKER_CONFIG, startBlock, log: silent }),
    });

    async function deliver(payload, raw = rawBytes(payload)) {
        return handleIncident(fastify, DEVICE_ID, payload, raw, {
            domains,
            incidentConfig: { maxPayloadBytes: 4096, clockSkewSeconds: 600 },
            now: () => new Date((Number(payload.observed_at) + 5) * 1000),
        });
    }
    function sign(sequence, { key = deviceKey, domain = current } = {}) {
        return signIncident({ vector: early.vector, domain, payload: early.payload, overrides: { sequence: String(sequence) }, signingKey: key });
    }
    async function run(w = worker(), rounds = 3) {
        for (let i = 0; i < rounds; i++) {
            await w.relayer.tick();
            await w.indexer.catchUp();
        }
    }
    async function outbox() {
        const { rows } = await store.db.query(
            'SELECT sequence::text AS sequence, status, tx_hash, incident_key FROM blockchain_outbox o ORDER BY o.sequence'
        );
        return rows;
    }
    async function loggedEvents() {
        return contract.queryFilter(contract.filters.IncidentLogged(), startBlock);
    }
    return { provider, contract, address, store, early, deviceKey, current, domains, chain, worker, deliver, sign, run, outbox, loggedEvents };
}

test('chain E2E: register, relay, out-of-order, retries, legacy domain, rotation, restart, role loss, indexer', { skip, timeout: 180_000 }, async (t) => {
    const env = await setup();
    const { store, contract } = env;
    const owner = new Wallet(KEYS.owner, env.provider);
    const signerAddress = new Wallet(env.early.vector.test_private_key_only).address.toLowerCase();

    try {
        await t.test('10: backend refuses a domain the chain does not have', async () => {
            await assertDomainMatchesChain(env.provider, env.current);
            await assert.rejects(assertDomainMatchesChain(env.provider, env.domains.legacy[0]), /no contract deployed/);
            const wrongChain = normalizeIncidentDomain({ ...env.current, chainId: '1' });
            await assert.rejects(assertDomainMatchesChain(env.provider, wrongChain), /chainId/);
        });

        await t.test('6/register: incident signed before the on-chain register waits, then confirms; floor is sent', async () => {
            await requestSignerRegistration(store, DEVICE_ID, signerAddress, { owner: owner.address });
            const early = await env.deliver(env.sign(7));
            assert.equal(early.accepted, true);
            assert.deepEqual((await env.outbox()).map((r) => r.status), ['waiting_signer']);

            await env.run();
            const [row] = await env.outbox();
            assert.equal(row.status, 'confirmed');
            const { rows: signers } = await store.db.query('SELECT status FROM device_signers');
            assert.deepEqual(signers.map((s) => s.status), ['active']);
            const { rows: commands } = await store.db.query('SELECT payload FROM commands');
            assert.deepEqual(commands.map((c) => c.payload), [{ type: 'signer_activate', floor: '8' }]);
            const onchain = await contract.getIncident(row.incident_key);
            assert.equal(onchain.status, 1n);
        });

        await t.test('1/2: golden-shaped incidents confirm, including out-of-order sequence 12 then 11', async () => {
            for (const sequence of [12, 11]) assert.equal((await env.deliver(env.sign(sequence))).accepted, true);
            await env.run();
            const rows = await env.outbox();
            assert.deepEqual(rows.map((r) => [r.sequence, r.status]), [['7', 'confirmed'], ['11', 'confirmed'], ['12', 'confirmed']]);
            const events = await env.loggedEvents();
            assert.equal(events.length, 3);
            for (const event of events) {
                const match = rows.find((r) => r.incident_key === event.args.incidentKey);
                assert.ok(match, 'every IncidentLogged maps to an outbox row');
                assert.equal(event.transactionHash.toLowerCase(), match.tx_hash);
            }
        });

        await t.test('3: exact retry of sequence 11 is re-ACKed without new rows or transactions', async () => {
            const payload = env.sign(11);
            const before = (await env.loggedEvents()).length;
            const result = await env.deliver(payload);
            assert.equal(result.accepted, true);
            assert.equal(result.duplicate, true);
            await env.run();
            assert.equal((await env.outbox()).length, 3);
            assert.equal((await env.loggedEvents()).length, before);
        });

        await t.test('4: record signed for the old 0xCccc domain is ACKed, stays legacy_domain, never sent', async () => {
            const before = (await env.loggedEvents()).length;
            const result = await env.deliver(env.early.payload); // golden vector, sequence 43, legacy domain
            assert.equal(result.accepted, true);
            await env.run();
            const row = (await env.outbox()).find((r) => r.sequence === '43');
            assert.equal(row.status, 'legacy_domain');
            assert.equal(row.tx_hash, null);
            assert.equal((await env.loggedEvents()).length, before);
        });

        await t.test('8: worker killed between submit and receipt does not double-submit', async () => {
            assert.equal((await env.deliver(env.sign(20))).accepted, true);
            assert.equal((await env.deliver(env.sign(21))).accepted, true);
            // Crash right after the tx hash was committed ('pending').
            await env.worker().relayer.submitOutbox();
            // Crash after the tx was sent but before 'pending' was committed: row still queued.
            const pendingRow = (await env.outbox()).find((r) => r.sequence === '21');
            assert.equal(pendingRow.status, 'pending');
            await store.db.query(`UPDATE blockchain_outbox SET status = 'queued', tx_hash = NULL WHERE sequence = 21`);

            await env.run(env.worker()); // fresh worker = restart
            const rows = await env.outbox();
            assert.deepEqual(rows.filter((r) => ['20', '21'].includes(r.sequence)).map((r) => r.status), ['confirmed', 'confirmed']);
            const events = await env.loggedEvents();
            for (const sequence of [20n, 21n]) {
                assert.equal(events.filter((e) => e.args.sequence === sequence).length, 1, `exactly one tx for sequence ${sequence}`);
            }
        });

        await t.test('indexer: device state, lastSequence and owner acknowledgement are projected', async () => {
            const { rows: [state] } = await store.db.query('SELECT * FROM device_chain_state');
            assert.equal(state.device_id, DEVICE_ID);
            assert.equal(state.signer_address, signerAddress);
            assert.equal(state.owner_address, owner.address.toLowerCase());
            assert.equal(state.active, true);
            assert.equal(String(state.last_sequence), '21');

            const row = (await env.outbox()).find((r) => r.sequence === '12');
            await (await contract.connect(owner).acknowledgeIncident(row.incident_key)).wait();
            await env.run();
            const { rows: [incident] } = await store.db.query(
                'SELECT owner_status, acknowledged_by FROM incidents WHERE sequence = 12'
            );
            assert.equal(incident.owner_status, 'acknowledged');
            assert.equal(incident.acknowledged_by, owner.address.toLowerCase());
        });

        await t.test('6/rotate: new-key incident waits for the rotation, old-key leftovers become stale_signer', async () => {
            // Old key signs sequence 30; the relayer has not picked it up when the rotation is requested.
            assert.equal((await env.deliver(env.sign(30))).accepted, true);
            const newKey = new SigningKey(Wallet.createRandom().privateKey);
            const newAddress = new Wallet(newKey.privateKey).address.toLowerCase();
            await requestSignerRegistration(store, DEVICE_ID, newAddress);
            assert.equal((await env.deliver(env.sign(31, { key: newKey }))).accepted, true);
            const beforeRotation = await env.outbox();
            assert.equal(beforeRotation.find((r) => r.sequence === '31').status, 'waiting_signer');

            // Run ops first so the rotation lands before the old-key row is attempted.
            const w = env.worker();
            await w.relayer.submitOps();
            await env.run(w);
            const rows = await env.outbox();
            assert.equal(rows.find((r) => r.sequence === '31').status, 'confirmed');
            assert.equal(rows.find((r) => r.sequence === '30').status, 'stale_signer');
            const device = await contract.getDevice(deviceIdHash(DEVICE_ID));
            assert.equal(device.signer.toLowerCase(), newAddress);
            env.rotatedKey = newKey;
        });

        await t.test('9: losing RELAYER_ROLE stops the worker and leaves the row queued', async () => {
            const relayerAddress = new Wallet(KEYS.relayer).address;
            const role = await contract.RELAYER_ROLE();
            await (await contract.revokeRole(role, relayerAddress)).wait();
            assert.equal((await env.deliver(env.sign(40, { key: env.rotatedKey }))).accepted, true);
            await assert.rejects(env.worker().relayer.submitOutbox(), ChainFatalError);
            const row = (await env.outbox()).find((r) => r.sequence === '40');
            assert.equal(row.status, 'queued');
            await (await contract.grantRole(role, relayerAddress)).wait();
            await env.run();
            assert.equal((await env.outbox()).find((r) => r.sequence === '40').status, 'confirmed');
        });

        await t.test('7: device lost its key/NVS; re-provisioning gets a floor above every used sequence', async () => {
            await requestSignerRevocation(store, DEVICE_ID, 'retired');
            await env.run();
            const replacement = new Wallet(Wallet.createRandom().privateKey);
            await requestSignerRegistration(store, DEVICE_ID, replacement.address);
            await env.run();
            const { rows } = await store.db.query(`SELECT payload FROM commands ORDER BY created_at`);
            assert.deepEqual(rows.at(-1).payload, { type: 'signer_activate', floor: '44' }); // max(db 43, chain 40) + 1
            const device = await contract.getDevice(deviceIdHash(DEVICE_ID));
            assert.equal(device.active, true);
            assert.equal(device.signer, replacement.address);
            const { rows: events } = await store.db.query(`SELECT COUNT(*)::int AS n FROM security_events`);
            assert.equal(events[0].n, 0);
        });

        await t.test('incident key used by the backend equals the contract computation', async () => {
            const payload = env.sign(99);
            const expected = await contract.computeIncidentKey(payload.device_id_hash, payload.incident_id);
            assert.equal(computeIncidentKey(payload.device_id_hash, payload.incident_id), expected);
            assert.ok(AIR_SAFETY_LOG_ABI.some((item) => item.name === 'logIncident'));
        });
    } finally {
        await store.close();
    }
});
