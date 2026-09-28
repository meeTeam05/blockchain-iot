import { isAddress } from 'ethers';

function queryTarget(target) {
    if (target?.query) return target;
    if (target?.db?.query) return target.db;
    throw new TypeError('device signer target must be a pg client or fastify instance with db');
}

export function normalizeSignerAddress(value) {
    if (typeof value !== 'string' || !isAddress(value)) return null;
    return value.toLowerCase();
}

export async function getActiveSigner(target, deviceId) {
    const { rows } = await queryTarget(target).query(
        `SELECT signer_address
         FROM device_signers
         WHERE device_id = $1 AND status = 'active'`,
        [deviceId]
    );
    return rows[0]?.signer_address ?? null;
}

export async function getSignerRecord(target, deviceId, signerAddress) {
    const { rows } = await queryTarget(target).query(
        `SELECT signer_address, status, activated_at, revoked_at
         FROM device_signers
         WHERE device_id = $1 AND signer_address = $2`,
        [deviceId, signerAddress]
    );
    return rows[0] ?? null;
}

// Registers a new signer. With rotate=true the current active signer is revoked in the
// same transaction; firmware must flush its incident queue before a rotation.
export async function registerSigner(fastifyOrPool, deviceId, signerAddress, { rotate = false } = {}) {
    const address = normalizeSignerAddress(signerAddress);
    if (!address) throw new TypeError('signer address must be a valid Ethereum address');

    const pool = fastifyOrPool?.db ?? fastifyOrPool;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const current = await client.query(
            `SELECT signer_address
             FROM device_signers
             WHERE device_id = $1 AND status = 'active'
             FOR UPDATE`,
            [deviceId]
        );
        if (current.rows.length > 0) {
            if (!rotate) {
                throw new Error(`device ${deviceId} already has an active signer; use rotate`);
            }
            await client.query(
                `UPDATE device_signers
                 SET status = 'revoked', revoked_at = NOW(), revoke_reason = 'rotated'
                 WHERE device_id = $1 AND status = 'active'`,
                [deviceId]
            );
        }
        await client.query(
            `INSERT INTO device_signers (device_id, signer_address, status)
             VALUES ($1, $2, 'active')`,
            [deviceId, address]
        );
        await client.query('COMMIT');
        return { deviceId, signerAddress: address, rotatedFrom: current.rows[0]?.signer_address ?? null };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Signer removal is an explicit lifecycle operation. Device factory reset preserves
// the Task 1 signer and must not implicitly call this function.
export async function revokeSigner(target, deviceId, reason = 'revoked') {
    const { rowCount } = await queryTarget(target).query(
        `UPDATE device_signers
         SET status = 'revoked', revoked_at = NOW(), revoke_reason = $2
         WHERE device_id = $1 AND status = 'active'`,
        [deviceId, reason]
    );
    return rowCount > 0;
}
