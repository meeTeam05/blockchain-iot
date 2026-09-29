// Signer lifecycle (E2E_FIX_PLAN.md stage 5). The device signer lives in three places:
// the device NVS, device_signers (intake) and AirSafetyLog (chain). They only change
// through this module: every request writes device_signers AND a device_chain_ops row in
// one transaction; the chain worker executes the op and calls applyConfirmedOp().
//
//   register: signer 'pending' -> op register -> confirmed -> 'active' -> signer_activate{floor}
//   rotate:   new signer 'pending' -> op rotate -> confirmed -> old 'revoked'(rotated), new 'active'
//   revoke:   signer 'revoked' immediately (intake stops accepting it) -> op revoke
//
// Factory reset never calls revoke: it preserves the device signer.
import { keccak256, toUtf8Bytes } from 'ethers';

import { createRealtimeEvent } from './realtime-events.js';
import { normalizeSignerAddress } from './device-signers.js';

export const SIGNER_ACTIVATE_COMMAND = 'signer_activate';
export const REVOKE_REASONS = Object.freeze(['compromised', 'decommissioned', 'retired', 'revoked']);

function assertAddress(value, label) {
    const address = normalizeSignerAddress(value);
    if (!address) throw new TypeError(`${label} must be a valid Ethereum address`);
    return address;
}

async function insertOp(client, { deviceId, op, signerAddress = null, ownerAddress = null }) {
    const { rows } = await client.query(
        `INSERT INTO device_chain_ops (device_id, op, signer_address, owner_address)
         VALUES ($1, $2, $3, $4)
         RETURNING id, device_id, op, signer_address, owner_address, status`,
        [deviceId, op, signerAddress, ownerAddress]
    );
    return rows[0];
}

async function lockDevice(client, deviceId) {
    const { rows } = await client.query('SELECT id, owner_address FROM devices WHERE id = $1 FOR UPDATE', [deviceId]);
    if (rows.length === 0) throw new Error(`device ${deviceId} is not registered`);
    return rows[0];
}

// First registration, or rotation when the device already has an active signer.
// `owner` is required for a first registration (AirSafetyLog.registerDevice needs it).
export async function requestSignerRegistration(db, deviceId, signerAddress, { owner = null } = {}) {
    const signer = assertAddress(signerAddress, 'signer address');
    const ownerAddress = owner ? assertAddress(owner, 'owner address') : null;
    return db.withTransaction(async (client) => {
        const device = await lockDevice(client, deviceId);
        const { rows: current } = await client.query(
            `SELECT signer_address, status FROM device_signers
             WHERE device_id = $1 AND status IN ('active', 'pending')`,
            [deviceId]
        );
        if (current.some((row) => row.status === 'pending')) {
            throw new Error(`device ${deviceId} already has a pending signer operation`);
        }
        const active = current.find((row) => row.status === 'active') ?? null;
        const op = active ? 'rotate' : 'register';
        const resolvedOwner = ownerAddress ?? device.owner_address ?? null;
        if (op === 'register' && !resolvedOwner) {
            throw new Error('first registration needs --owner <wallet> (AirSafetyLog owner address)');
        }
        await client.query(
            `INSERT INTO device_signers (device_id, signer_address, status) VALUES ($1, $2, 'pending')`,
            [deviceId, signer]
        );
        const created = await insertOp(client, {
            deviceId,
            op,
            signerAddress: signer,
            ownerAddress: op === 'register' ? resolvedOwner : null,
        });
        return { op: created, rotatedFrom: active?.signer_address ?? null };
    });
}

// Registers the already-active DB signer on a (new) contract without touching the key,
// e.g. after the AirSafetyLog redeploy: device_signers says active, chain knows nothing.
export async function requestChainSync(db, deviceId, { owner = null } = {}) {
    const ownerAddress = owner ? assertAddress(owner, 'owner address') : null;
    return db.withTransaction(async (client) => {
        const device = await lockDevice(client, deviceId);
        const { rows } = await client.query(
            `SELECT signer_address FROM device_signers WHERE device_id = $1 AND status = 'active'`,
            [deviceId]
        );
        if (rows.length === 0) throw new Error(`device ${deviceId} has no active signer to sync`);
        const resolvedOwner = ownerAddress ?? device.owner_address ?? null;
        if (!resolvedOwner) throw new Error('sync needs --owner <wallet> (AirSafetyLog owner address)');
        const { rows: open } = await client.query(
            `SELECT 1 FROM device_chain_ops WHERE device_id = $1 AND status IN ('queued', 'pending')`,
            [deviceId]
        );
        if (open.length) throw new Error(`device ${deviceId} already has an open chain operation`);
        return { op: await insertOp(client, { deviceId, op: 'register', signerAddress: rows[0].signer_address, ownerAddress: resolvedOwner }) };
    });
}

export async function requestSignerRevocation(db, deviceId, reason = 'compromised') {
    if (!REVOKE_REASONS.includes(reason)) {
        throw new TypeError(`revoke reason must be one of ${REVOKE_REASONS.join(', ')} ('rotated' is set only by rotation)`);
    }
    return db.withTransaction(async (client) => {
        await lockDevice(client, deviceId);
        const { rows } = await client.query(
            `UPDATE device_signers
             SET status = 'revoked', revoked_at = NOW(), revoke_reason = $2
             WHERE device_id = $1 AND status IN ('active', 'pending')
             RETURNING signer_address`,
            [deviceId, reason]
        );
        if (rows.length === 0) throw new Error(`device ${deviceId} has no active or pending signer`);
        const op = await insertOp(client, { deviceId, op: 'revoke', signerAddress: rows[0].signer_address });
        return { op, revoked: rows.map((row) => row.signer_address) };
    });
}

export async function requestOwnerChange(db, deviceId, owner) {
    const ownerAddress = assertAddress(owner, 'owner address');
    return db.withTransaction(async (client) => {
        await lockDevice(client, deviceId);
        return { op: await insertOp(client, { deviceId, op: 'set_owner', ownerAddress }) };
    });
}

// floor = max(highest sequence stored for the device, on-chain lastSequence) + 1.
export async function computeSequenceFloor(client, deviceId, chainLastSequence = 0n) {
    const { rows } = await client.query(
        'SELECT COALESCE(MAX(sequence), 0)::text AS max_sequence FROM incidents WHERE device_id = $1',
        [deviceId]
    );
    const dbMax = BigInt(rows[0].max_sequence);
    const chainMax = BigInt(chainLastSequence ?? 0n);
    return (dbMax > chainMax ? dbMax : chainMax) + 1n;
}

// Queued through the normal command table; the API publishes it when the device is online.
// The firmware handler is raise-only, so duplicates or late delivery are harmless.
export async function queueSignerActivate(client, deviceId, floor) {
    const payload = { type: SIGNER_ACTIVATE_COMMAND, floor: String(floor) };
    const { rows } = await client.query(
        `INSERT INTO commands (device_id, user_id, payload, status)
         VALUES ($1, NULL, $2, 'pending') RETURNING id`,
        [deviceId, JSON.stringify(payload)]
    );
    return { commandId: rows[0].id, payload };
}

// Moves outbox rows between the signer-gated states after the signer set changed.
export async function releaseWaitingIncidents(client, deviceId, signerAddress) {
    const { rowCount } = await client.query(
        `UPDATE blockchain_outbox
         SET status = 'queued', next_attempt_at = NOW(), fail_reason = NULL, updated_at = NOW()
         WHERE device_id = $1 AND signer_address = $2 AND status = 'waiting_signer'`,
        [deviceId, signerAddress]
    );
    return rowCount;
}

async function markStale(client, deviceId, signerAddress) {
    const { rowCount } = await client.query(
        `UPDATE blockchain_outbox
         SET status = 'stale_signer', fail_reason = 'signer rotated before submission', updated_at = NOW()
         WHERE device_id = $1 AND signer_address = $2 AND status IN ('queued', 'waiting_signer')`,
        [deviceId, signerAddress]
    );
    return rowCount;
}

export function deviceIdHash(deviceId) {
    return keccak256(toUtf8Bytes(deviceId));
}

// Called by the chain worker inside a transaction once an op is confirmed on-chain.
// `chain.lastSequence` is AirSafetyLog.getDevice().lastSequence at confirmation time.
export async function applyConfirmedOp(client, op, { lastSequence = 0n } = {}) {
    const result = { op: op.op, released: 0, stale: 0, activate: null };
    if (op.op === 'register' || op.op === 'rotate') {
        let previous = null;
        if (op.op === 'rotate') {
            const { rows } = await client.query(
                `UPDATE device_signers
                 SET status = 'revoked', revoked_at = NOW(), revoke_reason = 'rotated'
                 WHERE device_id = $1 AND status = 'active' AND signer_address <> $2
                 RETURNING signer_address`,
                [op.device_id, op.signer_address]
            );
            previous = rows[0]?.signer_address ?? null;
        }
        await client.query(
            `UPDATE device_signers
             SET status = 'active', activated_at = NOW()
             WHERE device_id = $1 AND signer_address = $2 AND status = 'pending'`,
            [op.device_id, op.signer_address]
        );
        if (op.owner_address) {
            await client.query('UPDATE devices SET owner_address = $2 WHERE id = $1', [op.device_id, op.owner_address]);
        }
        if (previous) result.stale = await markStale(client, op.device_id, previous);
        result.released = await releaseWaitingIncidents(client, op.device_id, op.signer_address);
        if (op.op === 'register') {
            const floor = await computeSequenceFloor(client, op.device_id, lastSequence);
            result.activate = await queueSignerActivate(client, op.device_id, floor);
        }
    } else if (op.op === 'set_owner') {
        await client.query('UPDATE devices SET owner_address = $2 WHERE id = $1', [op.device_id, op.owner_address]);
    }
    await createRealtimeEvent(client, {
        type: 'device.signer_updated',
        deviceId: op.device_id,
        payload: { op: op.op, signer_address: op.signer_address ?? null, owner_address: op.owner_address ?? null },
        idempotencyKey: `device.signer_updated:${op.id}`,
    });
    return result;
}
