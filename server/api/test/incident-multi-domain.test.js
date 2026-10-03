// Multi-domain intake (E2E_FIX_PLAN.md stage 3): authenticate by (domain, signer), decide
// chain eligibility at intake, never leave valid evidence stuck in the firmware queue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SigningKey, Wallet } from 'ethers';

import { computeIncidentKey, handleIncident } from '../src/services/incident-intake.js';
import { resolveIncidentDomains } from '../src/services/incident-domains.js';
import { INCIDENT_ERROR, normalizeIncidentDomain } from '../src/services/incident-verify.js';
import {
    DEVICE_ID,
    countRows,
    createIncidentDb,
    createIntakeFastify,
    loadVector,
    rawBytes,
    signIncident,
    testSigningKey,
} from './helpers/incident-fixtures.js';

const INCIDENT_CONFIG = Object.freeze({ maxPayloadBytes: 4096, clockSkewSeconds: 600 });
const CURRENT_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const LEGACY_ADDRESS = '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC';

function domainAt(address) {
    return normalizeIncidentDomain({ name: 'AirSafetyLog', version: '1', chainId: '11155111', verifyingContract: address });
}

const DOMAINS = Object.freeze({ current: domainAt(CURRENT_ADDRESS), legacy: Object.freeze([domainAt(LEGACY_ADDRESS)]), deployment: null });

async function setup(signers = []) {
    const early = await loadVector('earlyWarning');
    const store = await createIncidentDb();
    for (const { address, status, reason = null } of signers) {
        await store.db.query(
            `INSERT INTO device_signers (device_id, signer_address, status, revoked_at, revoke_reason)
             VALUES ($1, $2, $3, CASE WHEN $3 = 'revoked' THEN NOW() END, $4)`,
            [DEVICE_ID, address.toLowerCase(), status, reason]
        );
    }
    return { early, store, fastify: createIntakeFastify(store) };
}

function signed(early, { address = CURRENT_ADDRESS, sequence = '43', key } = {}) {
    return signIncident({
        vector: early.vector,
        domain: domainAt(address),
        payload: early.payload,
        overrides: { sequence },
        ...(key ? { signingKey: key } : {}),
    });
}

async function deliver(fastify, payload, raw = rawBytes(payload)) {
    return handleIncident(fastify, DEVICE_ID, payload, raw, {
        domains: DOMAINS,
        incidentConfig: INCIDENT_CONFIG,
        now: () => new Date((Number(payload.observed_at) + 5) * 1000),
    });
}

async function outboxRows(store) {
    const { rows } = await store.db.query(
        'SELECT status, verifying_contract, signer_address, incident_key, sequence FROM blockchain_outbox ORDER BY id'
    );
    return rows;
}

async function securityEvents(store) {
    const { rows } = await store.db.query('SELECT type, details FROM security_events ORDER BY id');
    return rows;
}

function testSigner(early) {
    return testSigningKey(early.vector);
}

test('current domain + active signer -> queued with incident key, domain and signer recorded', async () => {
    const early = await loadVector('earlyWarning');
    const address = new Wallet(early.vector.test_private_key_only).address;
    const { store, fastify } = await setup([{ address, status: 'active' }]);
    try {
        const payload = signed(early);
        const result = await deliver(fastify, payload);
        assert.equal(result.accepted, true);
        const [row] = await outboxRows(store);
        assert.equal(row.status, 'queued');
        assert.equal(row.verifying_contract, CURRENT_ADDRESS.toLowerCase());
        assert.equal(row.signer_address, address.toLowerCase());
        assert.equal(row.incident_key, computeIncidentKey(payload.device_id_hash, payload.incident_id));
        const incident = await store.db.query('SELECT domain_verifying_contract FROM incidents');
        assert.equal(incident.rows[0].domain_verifying_contract, CURRENT_ADDRESS.toLowerCase());
        const events = await store.db.query('SELECT payload FROM realtime_events');
        assert.equal(events.rows[0].payload.chain_status, 'queued');
    } finally {
        await store.close();
    }
});

test('record signed for the old test domain is ACKed and kept off-chain as legacy_domain (C\')', async () => {
    const early = await loadVector('earlyWarning');
    const address = new Wallet(early.vector.test_private_key_only).address;
    const { store, fastify } = await setup([{ address, status: 'active' }]);
    try {
        const result = await deliver(fastify, early.payload); // golden vector: 0xCccc domain
        assert.equal(result.accepted, true);
        assert.equal(result.ack.error_code, '');
        const [row] = await outboxRows(store);
        assert.equal(row.status, 'legacy_domain');
        assert.equal(row.verifying_contract, LEGACY_ADDRESS.toLowerCase());
        const incident = await store.db.query('SELECT eip712_digest FROM incidents');
        assert.equal(incident.rows[0].eip712_digest, early.vector.expected.eip712_digest);
    } finally {
        await store.close();
    }
});

test('pending signer (on-chain op not confirmed) -> waiting_signer', async () => {
    const early = await loadVector('earlyWarning');
    const address = new Wallet(early.vector.test_private_key_only).address;
    const { store, fastify } = await setup([{ address, status: 'pending' }]);
    try {
        assert.equal((await deliver(fastify, signed(early))).accepted, true);
        assert.equal((await outboxRows(store))[0].status, 'waiting_signer');
    } finally {
        await store.close();
    }
});

test('rotated-away key on the current domain -> stale_signer; on a legacy domain -> legacy_domain', async () => {
    const early = await loadVector('earlyWarning');
    const oldAddress = new Wallet(early.vector.test_private_key_only).address;
    const newAddress = Wallet.createRandom().address;
    const { store, fastify } = await setup([
        { address: oldAddress, status: 'revoked', reason: 'rotated' },
        { address: newAddress, status: 'active' },
    ]);
    try {
        assert.equal((await deliver(fastify, signed(early, { sequence: '50' }))).accepted, true);
        assert.equal((await deliver(fastify, signed(early, { address: LEGACY_ADDRESS, sequence: '51' }))).accepted, true);
        assert.deepEqual((await outboxRows(store)).map((r) => [String(r.sequence), r.status]), [
            ['50', 'stale_signer'],
            ['51', 'legacy_domain'],
        ]);
    } finally {
        await store.close();
    }
});

test('key revoked for compromise is rejected on every domain, with a security event and no outbox row', async () => {
    const early = await loadVector('earlyWarning');
    const address = new Wallet(early.vector.test_private_key_only).address;
    const { store, fastify } = await setup([{ address, status: 'revoked', reason: 'compromised' }]);
    try {
        for (const [domainAddress, sequence] of [[CURRENT_ADDRESS, '60'], [LEGACY_ADDRESS, '61']]) {
            const result = await deliver(fastify, signed(early, { address: domainAddress, sequence }));
            assert.equal(result.accepted, false);
            assert.equal(result.errorCode, INCIDENT_ERROR.SIGNER_NOT_ACTIVE);
        }
        assert.equal(await countRows(store, 'incidents'), 0);
        assert.equal(await countRows(store, 'blockchain_outbox'), 0);
        const events = await securityEvents(store);
        assert.equal(events.length, 2);
        assert.equal(events[0].details.signer_status, 'revoked');
        assert.equal(events[1].details.domain, LEGACY_ADDRESS.toLowerCase());
    } finally {
        await store.close();
    }
});

test('unknown key: security event lists tried domains and never a recovered signer', async () => {
    const early = await loadVector('earlyWarning');
    const address = new Wallet(early.vector.test_private_key_only).address;
    const { store, fastify } = await setup([{ address, status: 'active' }]);
    try {
        const stranger = new SigningKey(Wallet.createRandom().privateKey);
        const result = await deliver(fastify, signed(early, { key: stranger }));
        assert.equal(result.accepted, false);
        assert.equal(result.errorCode, INCIDENT_ERROR.SIGNER_NOT_ACTIVE);
        const [event] = await securityEvents(store);
        assert.deepEqual(event.details.tried_domains, [CURRENT_ADDRESS.toLowerCase(), LEGACY_ADDRESS.toLowerCase()]);
        assert.equal(JSON.stringify(event.details).includes('recovered'), false);
        assert.equal(JSON.stringify(event.details).includes(stranger.publicKey.slice(4, 20)), false);
    } finally {
        await store.close();
    }
});

test('high-s signature fails as INVALID_SIGNATURE before any domain is tried', async () => {
    const early = await loadVector('earlyWarning');
    const address = new Wallet(early.vector.test_private_key_only).address;
    const { store, fastify } = await setup([{ address, status: 'active' }]);
    try {
        const payload = signed(early);
        const hex = payload.signature.slice(2);
        const n = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
        const highS = (n - BigInt(`0x${hex.slice(64, 128)}`)).toString(16).padStart(64, '0');
        const v = hex.slice(128) === '1b' ? '1c' : '1b';
        const result = await deliver(fastify, { ...payload, signature: `0x${hex.slice(0, 64)}${highS}${v}` });
        assert.equal(result.accepted, false);
        assert.equal(result.errorCode, INCIDENT_ERROR.INVALID_SIGNATURE);
        const [event] = await securityEvents(store);
        assert.equal(event.details.tried_domains, undefined);
    } finally {
        await store.close();
    }
});

test('retry of a legacy_domain incident is checked against its stored domain and signer only', async () => {
    const early = await loadVector('earlyWarning');
    const address = new Wallet(early.vector.test_private_key_only).address;
    const { store, fastify } = await setup([{ address, status: 'active' }]);
    try {
        const raw = rawBytes(early.payload);
        assert.equal((await deliver(fastify, early.payload, raw)).accepted, true);

        const exact = await deliver(fastify, early.payload, raw);
        assert.equal(exact.accepted, true);
        assert.equal(exact.duplicate, true);

        // Same evidence, different JSON encoding: must verify to the stored legacy domain.
        const reordered = Object.fromEntries(Object.entries(early.payload).reverse());
        const reencoded = await deliver(fastify, reordered, Buffer.from(JSON.stringify(reordered)));
        assert.equal(reencoded.accepted, true);
        assert.equal(reencoded.duplicate, true);

        assert.equal(await countRows(store, 'incidents'), 1);
        assert.deepEqual((await outboxRows(store)).map((r) => r.status), ['legacy_domain']);

        // Signer later rotated away: the stored incident is still re-ACKed on retry.
        await store.db.query(`UPDATE device_signers SET status = 'revoked', revoked_at = NOW(), revoke_reason = 'rotated'`);
        assert.equal((await deliver(fastify, reordered, Buffer.from(JSON.stringify(reordered)))).accepted, true);
    } finally {
        await store.close();
    }
});

test('resolveIncidentDomains takes the deployment from the generated spec and rejects drift', () => {
    const deployments = {
        localhost: {
            network: 'localhost',
            chainId: '11155111',
            name: 'AirSafetyLog',
            version: '1',
            address: CURRENT_ADDRESS,
            legacyAddresses: [LEGACY_ADDRESS],
        },
    };
    const base = { deployment: 'localhost', domainName: 'AirSafetyLog', domainVersion: '1', chainId: '', verifyingContract: '', legacyVerifyingContracts: null };
    const resolved = resolveIncidentDomains(base, deployments);
    assert.equal(resolved.current.verifyingContract, CURRENT_ADDRESS);
    assert.deepEqual(resolved.legacy.map((d) => d.verifyingContract), [LEGACY_ADDRESS]);

    assert.throws(() => resolveIncidentDomains({ ...base, verifyingContract: LEGACY_ADDRESS }, deployments), /does not match/);
    assert.throws(() => resolveIncidentDomains({ ...base, chainId: '1' }, deployments), /does not match/);
    assert.throws(() => resolveIncidentDomains({ ...base, deployment: 'sepolia' }, deployments), /no spec/);
    assert.deepEqual(resolveIncidentDomains({ ...base, legacyVerifyingContracts: [] }, deployments).legacy, []);
    // The current domain is never also treated as legacy.
    assert.deepEqual(
        resolveIncidentDomains({ ...base, legacyVerifyingContracts: [CURRENT_ADDRESS.toLowerCase()] }, deployments).legacy,
        []
    );
    // Without a deployment the explicit env address is used (pre-redeploy behaviour).
    const envOnly = resolveIncidentDomains({ ...base, deployment: '', verifyingContract: LEGACY_ADDRESS }, deployments);
    assert.equal(envOnly.current.verifyingContract, LEGACY_ADDRESS);
    assert.equal(envOnly.current.chainId, '11155111');
});
