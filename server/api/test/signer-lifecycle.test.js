// Signer lifecycle (E2E_FIX_PLAN.md stage 5): DB and chain change only through
// device_chain_ops; the signer becomes active only after the op is confirmed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';

import {
    applyConfirmedOp,
    computeSequenceFloor,
    requestChainSync,
    requestOwnerChange,
    requestSignerRegistration,
    requestSignerRevocation,
} from '../src/services/signer-lifecycle.js';
import { DEVICE_ID, createIncidentDb } from './helpers/incident-fixtures.js';

const OWNER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

function address() {
    return Wallet.createRandom().address;
}

async function signers(store) {
    const { rows } = await store.query('SELECT signer_address, status, revoke_reason FROM device_signers ORDER BY id');
    return rows.map((row) => [row.signer_address, row.status, row.revoke_reason]);
}

async function ops(store) {
    const { rows } = await store.query('SELECT id, device_id, op, signer_address, owner_address, status FROM device_chain_ops ORDER BY id');
    return rows;
}

async function addOutbox(store, sequence, signer, status) {
    const { rows } = await store.query(
        `INSERT INTO incidents (device_id, schema_version, device_id_hash, incident_id, sequence, observed_at, time_source,
             sensor_valid_mask, detection_method, temperature_c_x100, humidity_pct_x100, co_ppm_x1000, no2_ppm_x1000,
             overall_level, co_level, no2_level, co_alarm_source_mask, no2_alarm_source_mask, derived_valid_mask,
             co_stel15_ppm_x1000, no2_stel15_ppm_x1000, co_twa8h_ppm_x1000, no2_twa8h_ppm_x1000, co_proj10_ppm_x1000,
             no2_proj10_ppm_x1000, model_probability_valid_mask, co_model_probability_bps, no2_model_probability_bps,
             incident_kind, severity, firmware_version_hash, model_sha256, calibration_revision, calibration_hash,
             firmware_version, evidence_hash, eip712_digest, signature, signer_address, domain_name, domain_version,
             domain_chain_id, domain_verifying_contract, raw_payload, payload, observed_at_ts, received_at)
         VALUES ($1, 2, $2, $3, $4, 1700000000, 1, 15, 2, 0, 0, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                 1, 1, $2, $2, 1, $2, 'fw', $2, $2, $5, $6, 'AirSafetyLog', '1', 11155111, $7, '\\x00', '{}', NOW(), NOW())
         RETURNING id, incident_id, sequence`,
        [
            DEVICE_ID,
            `0x${'1'.repeat(64)}`,
            `0x${sequence.toString(16).padStart(64, '0')}`,
            sequence,
            `0x${'2'.repeat(130)}`,
            signer.toLowerCase(),
            '0x5fbdb2315678afecb367f032d93f642f64180aa3',
        ]
    );
    await store.query(
        `INSERT INTO blockchain_outbox (incident_row_id, device_id, incident_id, sequence, status, signer_address)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [rows[0].id, DEVICE_ID, rows[0].incident_id, sequence, status, signer.toLowerCase()]
    );
}

async function outboxStatuses(store) {
    const { rows } = await store.query('SELECT sequence::int AS sequence, status FROM blockchain_outbox o ORDER BY o.sequence');
    return rows.map((row) => [row.sequence, row.status]);
}

test('first registration: pending signer + register op, active only after confirmation, floor queued', async () => {
    const store = await createIncidentDb();
    try {
        const signer = address();
        await assert.rejects(requestSignerRegistration(store, DEVICE_ID, signer), /--owner/);
        const { op } = await requestSignerRegistration(store, DEVICE_ID, signer, { owner: OWNER });
        assert.equal(op.op, 'register');
        assert.deepEqual(await signers(store), [[signer.toLowerCase(), 'pending', null]]);
        await assert.rejects(requestSignerRegistration(store, DEVICE_ID, address(), { owner: OWNER }), /pending signer/);

        await addOutbox(store, 5, signer, 'waiting_signer');
        const [row] = await ops(store);
        const result = await store.withTransaction((client) => applyConfirmedOp(client, row, { lastSequence: 9n }));
        assert.equal(result.released, 1);
        assert.deepEqual(result.activate.payload, { type: 'signer_activate', floor: '10' });
        assert.deepEqual(await signers(store), [[signer.toLowerCase(), 'active', null]]);
        assert.deepEqual(await outboxStatuses(store), [[5, 'queued']]);
        const { rows } = await store.query('SELECT owner_address FROM devices WHERE id = $1', [DEVICE_ID]);
        assert.equal(rows[0].owner_address, OWNER.toLowerCase());
    } finally {
        await store.close();
    }
});

test('rotation: old key stays active until confirmation, then its unsent rows become stale_signer', async () => {
    const store = await createIncidentDb();
    try {
        const oldSigner = address();
        const newSigner = address();
        await requestSignerRegistration(store, DEVICE_ID, oldSigner, { owner: OWNER });
        const [register] = await ops(store);
        await store.withTransaction((client) => applyConfirmedOp(client, register));
        const { op } = await requestSignerRegistration(store, DEVICE_ID, newSigner);
        assert.equal(op.op, 'rotate');
        assert.deepEqual((await signers(store)).map((s) => s[1]), ['active', 'pending']);

        await addOutbox(store, 20, oldSigner, 'queued');
        await addOutbox(store, 21, oldSigner, 'confirmed');
        await addOutbox(store, 22, newSigner, 'waiting_signer');
        const rotate = (await ops(store))[1];
        const result = await store.withTransaction((client) => applyConfirmedOp(client, rotate));
        assert.equal(result.activate, null, 'rotation keeps the device counter; no floor needed');
        assert.deepEqual(await signers(store), [
            [oldSigner.toLowerCase(), 'revoked', 'rotated'],
            [newSigner.toLowerCase(), 'active', null],
        ]);
        assert.deepEqual(await outboxStatuses(store), [[20, 'stale_signer'], [21, 'confirmed'], [22, 'queued']]);
    } finally {
        await store.close();
    }
});

test('revocation takes effect in the DB immediately and queues the chain op; rotated is not an operator reason', async () => {
    const store = await createIncidentDb();
    try {
        const signer = address();
        await requestSignerRegistration(store, DEVICE_ID, signer, { owner: OWNER });
        await assert.rejects(requestSignerRevocation(store, DEVICE_ID, 'rotated'), /revoke reason/);
        const { op, revoked } = await requestSignerRevocation(store, DEVICE_ID, 'compromised');
        assert.equal(op.op, 'revoke');
        assert.deepEqual(revoked, [signer.toLowerCase()]);
        assert.deepEqual(await signers(store), [[signer.toLowerCase(), 'revoked', 'compromised']]);
        // A late confirmation of the earlier register op must not resurrect the key.
        const [register] = await ops(store);
        await store.withTransaction((client) => applyConfirmedOp(client, register));
        assert.deepEqual((await signers(store)).map((s) => s[1]), ['revoked']);
        await assert.rejects(requestSignerRevocation(store, DEVICE_ID), /no active or pending signer/);
    } finally {
        await store.close();
    }
});

test('chain sync registers the existing active signer on a new contract without a key change', async () => {
    const store = await createIncidentDb({ signerAddress: address() });
    try {
        await assert.rejects(requestChainSync(store, DEVICE_ID), /--owner/);
        const { op } = await requestChainSync(store, DEVICE_ID, { owner: OWNER });
        assert.equal(op.op, 'register');
        await assert.rejects(requestChainSync(store, DEVICE_ID, { owner: OWNER }), /open chain operation/);
        const { op: ownerOp } = await requestOwnerChange(store, DEVICE_ID, address());
        assert.equal(ownerOp.op, 'set_owner');
        assert.deepEqual((await signers(store)).map((s) => s[1]), ['active']);
    } finally {
        await store.close();
    }
});

test('sequence floor is above both the DB and the chain high-water marks', async () => {
    const store = await createIncidentDb();
    try {
        assert.equal(await computeSequenceFloor(store, DEVICE_ID, 0n), 1n);
        await addOutbox(store, 41, address(), 'confirmed');
        assert.equal(await computeSequenceFloor(store, DEVICE_ID, 0n), 42n);
        assert.equal(await computeSequenceFloor(store, DEVICE_ID, 100n), 101n);
    } finally {
        await store.close();
    }
});
