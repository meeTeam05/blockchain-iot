// Task 4 "event replay an toàn": the indexer can be rewound, can lose its event log, or can
// crash between batches, and the projection (outbox, incidents, device state, realtime
// events) ends up identical with nothing applied twice. Logs are real ABI encodings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';

import { createIndexer } from '../src/chain/indexer.js';
import { AIR_SAFETY_LOG_ABI } from '../src/generated/incident-deployments.js';
import { handleIncident } from '../src/services/incident-intake.js';
import { DEVICE_ID, createIncidentDb, createIntakeFastify, loadVector, rawBytes, signIncident } from './helpers/incident-fixtures.js';

const IFACE = new Interface(AIR_SAFETY_LOG_ABI);
const OWNER = `0x${'4a'.repeat(20)}`;
const CONTRACT = '0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A';
const CONFIG = { confirmations: 1, logBatchBlocks: 2 };
const LOG = { info() {}, warn() {}, error() {} };

function hex32(n) {
    return `0x${n.toString(16).padStart(64, '0')}`;
}

function logEntry(blockNumber, index, name, values) {
    const { data, topics } = IFACE.encodeEventLog(IFACE.getEvent(name), values);
    return { address: CONTRACT, data, topics, blockNumber, blockHash: hex32(blockNumber), transactionHash: hex32(1000 + blockNumber), index };
}

async function setup() {
    const early = await loadVector('earlyWarning');
    const store = await createIncidentDb({ signerAddress: early.vector.expected.signer });
    const payload = signIncident({ ...early, overrides: { sequence: '1' } });
    const result = await handleIncident(createIntakeFastify(store), DEVICE_ID, payload, rawBytes(payload), {
        domain: early.domain,
        incidentConfig: { maxPayloadBytes: 4096, clockSkewSeconds: 600 },
        now: () => new Date((Number(payload.observed_at) + 5) * 1000),
    });
    assert.equal(result.accepted, true);
    const { rows: [row] } = await store.query(
        `SELECT o.incident_key, i.device_id_hash, i.incident_id, i.observed_at::text AS observed_at, i.severity, i.evidence_hash, i.signer_address
         FROM blockchain_outbox o JOIN incidents i ON i.id = o.incident_row_id`
    );
    const logs = [
        logEntry(3, 0, 'DeviceRegistered', [row.device_id_hash, row.signer_address, OWNER]),
        logEntry(5, 0, 'IncidentLogged', [row.incident_key, row.device_id_hash, row.incident_id, 1n, BigInt(row.observed_at), row.severity, row.evidence_hash, row.signer_address]),
        logEntry(7, 1, 'IncidentAcknowledged', [row.incident_key, row.device_id_hash, OWNER]),
    ];
    return { store, logs };
}

function mockChain(logs, { head = 8, failRange = null } = {}) {
    return {
        address: CONTRACT,
        read: { interface: IFACE },
        provider: {
            getBlockNumber: async () => head,
            getBlock: async (n) => ({ timestamp: 1_790_000_000n + BigInt(n) * 12n }),
            getLogs: async ({ fromBlock, toBlock }) => {
                if (failRange && fromBlock <= failRange && failRange <= toBlock) throw new Error('RPC timeout');
                return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
            },
        },
    };
}

async function projection(store) {
    const q = async (sql) => (await store.query(sql)).rows;
    return {
        outbox: await q('SELECT status, tx_hash, block_number::int AS block_number FROM blockchain_outbox'),
        incident: await q('SELECT owner_status, acknowledged_by, acknowledged_tx_hash, acknowledged_at FROM incidents'),
        state: await q('SELECT owner_address, active, last_sequence::text AS last_sequence FROM device_chain_state'),
        owner: await q('SELECT owner_address FROM devices WHERE id = \'' + DEVICE_ID + '\''),
        realtime: await q("SELECT type, COUNT(*)::int AS n FROM realtime_events WHERE type LIKE 'incident.%' GROUP BY type ORDER BY type"),
        events: (await q('SELECT COUNT(*)::int AS n FROM chain_events'))[0].n,
        checkpoint: (await q('SELECT last_block::int AS b FROM chain_checkpoints'))[0]?.b ?? null,
    };
}

test('indexer projects logged + acknowledged events across several batches', async () => {
    const { store, logs } = await setup();
    try {
        await createIndexer({ db: store, chain: mockChain(logs), config: CONFIG, startBlock: 1, log: LOG }).catchUp();
        const p = await projection(store);
        assert.equal(p.checkpoint, 8);
        assert.equal(p.events, 3);
        assert.equal(p.outbox[0].status, 'confirmed');
        assert.equal(p.outbox[0].block_number, 5);
        assert.equal(p.incident[0].owner_status, 'acknowledged');
        assert.equal(p.incident[0].acknowledged_by, OWNER);
        assert.equal(p.state[0].last_sequence, '1');
        assert.deepEqual(p.realtime.map((r) => [r.type, r.n]), [['incident.chain_updated', 1], ['incident.created', 1], ['incident.owner_updated', 1]]);
    } finally {
        await store.close();
    }
});

test('rewinding the checkpoint or losing chain_events replays without applying anything twice', async () => {
    const { store, logs } = await setup();
    try {
        const run = () => createIndexer({ db: store, chain: mockChain(logs), config: CONFIG, startBlock: 1, log: LOG }).catchUp();
        await run();
        const first = await projection(store);

        await store.query('UPDATE chain_checkpoints SET last_block = 0');
        assert.equal(await run(), 0, 'already-stored events are not re-applied');
        assert.deepEqual(await projection(store), first);

        // DB restored from a backup that lacks the event log: full replay from scratch.
        await store.query('DELETE FROM chain_events');
        await store.query('DELETE FROM chain_checkpoints');
        await run();
        assert.deepEqual(await projection(store), first, 'replay converges to the same projection, no duplicate realtime events');
    } finally {
        await store.close();
    }
});

test('an RPC failure mid-catch-up keeps the last committed batch; a restarted indexer resumes from it', async () => {
    const { store, logs } = await setup();
    try {
        const crashing = createIndexer({ db: store, chain: mockChain(logs, { failRange: 5 }), config: CONFIG, startBlock: 1, log: LOG });
        await assert.rejects(crashing.catchUp(), /RPC timeout/);
        let p = await projection(store);
        assert.equal(p.checkpoint, 4, 'batch [1,2] and [3,4] committed, [5,6] rolled back');
        assert.equal(p.events, 1);
        assert.equal(p.outbox[0].status, 'queued');

        await createIndexer({ db: store, chain: mockChain(logs), config: CONFIG, startBlock: 1, log: LOG }).catchUp();
        p = await projection(store);
        assert.equal(p.checkpoint, 8);
        assert.equal(p.events, 3);
        assert.equal(p.outbox[0].status, 'confirmed');
        assert.equal(p.incident[0].owner_status, 'acknowledged');
    } finally {
        await store.close();
    }
});

test('the indexer never reads past the confirmation depth', async () => {
    const { store, logs } = await setup();
    try {
        await createIndexer({ db: store, chain: mockChain(logs, { head: 7 }), config: { ...CONFIG, confirmations: 3 }, startBlock: 1, log: LOG }).catchUp();
        const p = await projection(store);
        assert.equal(p.checkpoint, 5, 'head 7 with 3 confirmations: block 5 is the last safe block');
        assert.equal(p.outbox[0].status, 'confirmed');
        assert.equal(p.incident[0].owner_status, 'open', 'the block-7 acknowledgement is not final yet');
    } finally {
        await store.close();
    }
});
