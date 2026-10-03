// Migration 022: settlement projection and keeper work log become per incentives
// deployment. Upgrading a 020-era DB keeps every row, splits state by contract from each
// deployment's own events, and the migration can run twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { MIGRATION_022_FILE, createIncidentDb } from './helpers/incident-fixtures.js';
import { DEFAULT_PARAMS, OWNER, KEEPER, insertChainIncident } from './helpers/incentive-fixtures.js';
import { formatParams } from '../src/chain/incentives.js';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const T = 1_900_000_000;

async function state(store, contract, activatedAt) {
    await store.query(
        `INSERT INTO incentive_state (contract, token, air_safety_log, treasury, operator, params, reward_fund, total_bonded,
                                      operator_bond, activated_at, current_day, block_number, block_time)
         VALUES ($1, $1, $1, $1, $1, $2::jsonb, 0, 0, '{"amount":"0"}'::jsonb, to_timestamp($3::double precision), 0, 1, NOW())`,
        [contract, JSON.stringify(formatParams(DEFAULT_PARAMS)), activatedAt]
    );
}

async function event(store, contract, index, name, incidentKey, data = {}) {
    await store.query(
        `INSERT INTO incentive_events (contract, tx_hash, log_index, block_number, block_hash, block_time, name, incident_key, account, amount, data)
         VALUES ($1, $2, 0, $3, $2, NOW(), $4, $5, $6, 1, $7::jsonb)`,
        [contract, `0x${String(index).padStart(64, '0')}`, index, name, incidentKey, name.endsWith('Slashed') ? KEEPER : OWNER, JSON.stringify(data)]
    );
}

test('022 upgrades 020-era data per deployment and is rerunnable', async () => {
    const store = await createIncidentDb({ applyScopeMigration: false });
    try {
        // Two synced incidents (logged at T and T + 1000) and one never synced.
        const early = await insertChainIncident(store, { sequence: 1, observedAt: T - 60, loggedAt: T, covered: null });
        const late = await insertChainIncident(store, { sequence: 2, severity: 2, observedAt: T + 940, loggedAt: T + 1_000, covered: null });
        const unsynced = await insertChainIncident(store, { sequence: 3, observedAt: T + 2_000, covered: null });
        await store.query('UPDATE incidents SET logged_at = to_timestamp($2::double precision) WHERE id = $1', [early.id, T]);
        await store.query('UPDATE incidents SET logged_at = to_timestamp($2::double precision) WHERE id = $1', [late.id, T + 1_000]);
        // The 020 shared columns, last written by deployment A.
        await store.query(`UPDATE incidents SET incentive_covered = TRUE, incentive_flags = 3, reward_status = 'ack_rewarded'`);

        await state(store, A, T - 10);      // A covers both
        await state(store, B, T + 500);     // B only covers `late`
        await event(store, A, 1, 'AckRewarded', early.key);
        await event(store, A, 2, 'RewardSkipped', late.key, { rule: '1', reason: '0' });
        await event(store, B, 3, 'MissedAckSlashed', late.key);
        await store.query(
            `INSERT INTO keeper_actions (incident_row_id, incident_key, action, status) VALUES ($1, $2, 'record_ack', 'done')`,
            [early.id, early.key]
        );

        const sql = await readFile(MIGRATION_022_FILE, 'utf8');
        await store.pg.exec(sql);
        await store.pg.exec(sql); // rerun: no error, no duplicates

        const { rows } = await store.query(
            `SELECT contract, incident_row_id::int AS id, covered, flags, reward_status,
                    EXTRACT(EPOCH FROM ack_deadline_at)::bigint AS ack, EXTRACT(EPOCH FROM resolve_deadline_at)::bigint AS resolve
             FROM incident_incentives ORDER BY contract, incident_row_id`
        );
        assert.deepEqual(rows, [
            { contract: A, id: Number(early.id), covered: true, flags: 3, reward_status: 'ack_rewarded', ack: T + 1_800, resolve: T + 86_400 },
            { contract: A, id: Number(late.id), covered: true, flags: 1, reward_status: 'over_cap', ack: T + 1_000 + 600, resolve: T + 1_000 + 86_400 },
            { contract: B, id: Number(early.id), covered: false, flags: 0, reward_status: 'none', ack: null, resolve: null },
            { contract: B, id: Number(late.id), covered: true, flags: 8, reward_status: 'slashed', ack: T + 1_000 + 600, resolve: T + 1_000 + 86_400 },
        ]);
        assert.ok(!rows.some((r) => r.id === Number(unsynced.id)), 'unsynced incidents are left to the indexer');

        // Two deployments indexed: the legacy keeper row cannot be attributed and stays NULL.
        const { rows: actions } = await store.query('SELECT contract, status FROM keeper_actions');
        assert.deepEqual(actions, [{ contract: null, status: 'done' }]);
        // New uniqueness is per contract.
        await store.query(
            `INSERT INTO keeper_actions (contract, incident_row_id, incident_key, action, status) VALUES ($1, $2, $3, 'record_ack', 'pending'), ($4, $2, $3, 'record_ack', 'pending')`,
            [A, early.id, early.key, B]
        );
        await assert.rejects(store.query(
            `INSERT INTO keeper_actions (contract, incident_row_id, incident_key, action, status) VALUES ($1, $2, $3, 'record_ack', 'pending')`,
            [A, early.id, early.key]
        ));
    } finally {
        await store.close();
    }
});

test('022 attributes legacy keeper rows when exactly one deployment was indexed', async () => {
    const store = await createIncidentDb({ applyScopeMigration: false });
    try {
        const one = await insertChainIncident(store, { sequence: 1, observedAt: T - 60, loggedAt: T, covered: null });
        await state(store, A, T - 10);
        await store.query(
            `INSERT INTO keeper_actions (incident_row_id, incident_key, action, status) VALUES ($1, $2, 'slash_missed_ack', 'done')`,
            [one.id, one.key]
        );
        await store.pg.exec(await readFile(MIGRATION_022_FILE, 'utf8'));
        const { rows } = await store.query('SELECT contract FROM keeper_actions');
        assert.deepEqual(rows, [{ contract: A }]);
    } finally {
        await store.close();
    }
});
