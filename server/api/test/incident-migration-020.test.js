import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { handleIncident } from '../src/services/incident-intake.js';
import { createIncidentDb, createIntakeFastify, loadVector, rawBytes } from './helpers/incident-fixtures.js';

const migration = new URL('../../db/migrations/020_positive_incident_sequence_and_bounded_chain_ops.sql', import.meta.url);

test('migration 020 refuses a historical zero sequence without deleting it', async () => {
    const { vector, domain, payload } = await loadVector('earlyWarning');
    const store = await createIncidentDb({ signerAddress: vector.expected.signer, applyLatestMigration: false });
    try {
        const result = await handleIncident(createIntakeFastify(store), payload.device_id, payload, rawBytes(payload), {
            domain,
            incidentConfig: { maxPayloadBytes: 4096, clockSkewSeconds: 600 },
            now: () => new Date((Number(payload.observed_at) + 5) * 1000),
        });
        assert.equal(result.accepted, true);
        await store.query('UPDATE incidents SET sequence = 0');
        await assert.rejects(store.pg.exec(await readFile(migration, 'utf8')), /incident sequence 0 exists/);
        const { rows } = await store.query('SELECT sequence::text AS sequence FROM incidents');
        assert.equal(rows[0].sequence, '0');

        await store.query('UPDATE incidents SET sequence = 43');
        await store.pg.exec(await readFile(migration, 'utf8'));
        await assert.rejects(store.query('UPDATE incidents SET sequence = 0'), /incidents_positive_sequence_check/);
        const { rows: ops } = await store.query("SELECT 1 FROM pg_constraint WHERE conname = 'device_chain_ops_status_check'");
        assert.equal(ops.length, 1);
    } finally {
        await store.close();
    }
});
