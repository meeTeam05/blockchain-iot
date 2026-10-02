// Chain worker, write side (E2E_FIX_PLAN.md stage 5-6):
//   1. device_chain_ops (register/rotate/revoke/set_owner), in id order per device
//   2. waiting_signer rows whose signer became the on-chain signer -> queued
//   3. queued outbox rows -> logIncident
//   4. pending rows (ops and outbox) -> receipts / confirmations
//
// Invariants:
// * tx_hash + 'pending' are committed before waiting for anything, and every submission
//   is preceded by an on-chain existence check, so a restart never double-submits.
// * AirSafetyLog tracks exact (device, sequence) use, so a failed/blocked row never blocks
//   other rows of the same device. Ordering by (device, sequence) is only for predictability.
// * Only rows whose signer is the current on-chain signer are sent (signer gate).
// * Losing RELAYER_ROLE / DEVICE_MANAGER_ROLE stops the worker (ChainFatalError); rows stay queued.
import { createRealtimeEvent } from '../services/realtime-events.js';
import { applyConfirmedOp, deviceIdHash } from '../services/signer-lifecycle.js';
import { computeIncidentKey } from '../services/incident-intake.js';
import { ChainFatalError, INCIDENT_STATUS, decodeRevert } from './air-safety-log.js';

const FATAL_REVERTS = new Set(['AccessControlUnauthorizedAccount']);
// Reverts meaning "the signer on chain is not (yet) this row's signer".
const SIGNER_REVERTS = new Set(['WrongSigner', 'DeviceNotActive', 'DeviceNotRegistered']);
// Intake should have rejected these; they are bugs, not retryable.
const INTAKE_BUG_REVERTS = new Set(['InvalidSignature', 'IncidentIdMismatch', 'InvalidSeverity', 'InvalidSequence', 'ZeroEvidenceHash']);
const CONFLICT_REVERTS = new Set(['SequenceAlreadyUsed', 'IncidentAlreadyLogged']);

function lower(value) {
    return typeof value === 'string' ? value.toLowerCase() : value;
}

function errorText(err) {
    return String(err?.shortMessage ?? err?.message ?? err).slice(0, 500);
}

export function createRelayer({ db, chain, config, log = console }) {
    const currentAddress = chain.address.toLowerCase();
    let deviceCache = new Map();

    async function chainDevice(hash) {
        if (!deviceCache.has(hash)) deviceCache.set(hash, await chain.read.getDevice(hash));
        return deviceCache.get(hash);
    }

    function backoff(attempts) {
        const minutes = Math.min(2 ** attempts, 60);
        return new Date(Date.now() + minutes * 60_000);
    }

    async function recordSecurity(deviceId, type, row, details) {
        await db.query(
            `INSERT INTO security_events (device_id, type, incident_id, evidence_hash, details)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [deviceId, type, row.incident_id ?? null, row.evidence_hash ?? null, JSON.stringify(details)]
        );
    }

    // ------------------------------------------------------------------ outbox state
    async function setOutbox(row, status, fields = {}) {
        const sets = ['status = $2', 'updated_at = NOW()'];
        const values = [row.outbox_id, status];
        for (const [column, value] of Object.entries(fields)) {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
        }
        await db.query(`UPDATE blockchain_outbox SET ${sets.join(', ')} WHERE id = $1`, values);
    }

    async function markConfirmed(row, { txHash = row.tx_hash, blockNumber = null, confirmations = null, reconciled = false }) {
        await db.withTransaction(async (client) => {
            await client.query(
                `UPDATE blockchain_outbox
                 SET status = 'confirmed', tx_hash = COALESCE($2, tx_hash), block_number = COALESCE($3, block_number),
                     confirmations = COALESCE($4, confirmations), confirmed_at = NOW(), last_error = NULL,
                     fail_reason = NULL, updated_at = NOW()
                 WHERE id = $1 AND status <> 'confirmed'`,
                [row.outbox_id, txHash ? lower(txHash) : null, blockNumber, confirmations]
            );
            await createRealtimeEvent(client, {
                type: 'incident.chain_updated',
                deviceId: row.device_id,
                payload: {
                    incident_id: row.incident_id,
                    sequence: String(row.sequence),
                    chain_status: 'confirmed',
                    tx_hash: txHash ? lower(txHash) : null,
                    block_number: blockNumber != null ? String(blockNumber) : null,
                    reconciled,
                },
                idempotencyKey: `incident.chain_updated:${row.device_id}:${row.incident_id}:confirmed`,
            });
        });
        log.info({ deviceId: row.device_id, sequence: String(row.sequence), txHash, reconciled }, 'incident confirmed on chain');
    }

    async function retryLater(row, err) {
        const attempts = Number(row.attempts) + 1;
        const tooOld = Date.now() - new Date(row.created_at).getTime() > config.maxRetryAgeHours * 3_600_000;
        if (attempts >= config.maxAttempts || tooOld) {
            await setOutbox(row, 'blocked', { attempts, last_error: errorText(err), blocked_at: new Date(), fail_reason: 'retries exhausted' });
            log.error({ deviceId: row.device_id, sequence: String(row.sequence), err: errorText(err) }, 'outbox row blocked');
            return;
        }
        await setOutbox(row, 'queued', { attempts, last_error: errorText(err), next_attempt_at: backoff(attempts), last_attempt_at: new Date() });
        log.warn({ deviceId: row.device_id, sequence: String(row.sequence), attempts, err: errorText(err) }, 'outbox submission deferred');
    }

    // Maps a decoded revert to the outbox state machine (plan section 4, stage 6 table).
    async function classify(row, revert, err) {
        if (!revert) return retryLater(row, err);
        const reason = `${revert.name}(${revert.args.map(String).join(',')})`;
        if (FATAL_REVERTS.has(revert.name)) {
            throw new ChainFatalError(`relayer lost its role: ${reason}`, err);
        }
        if (SIGNER_REVERTS.has(revert.name)) {
            deviceCache.delete(row.device_id_hash);
            log.warn({ deviceId: row.device_id, reason }, 'device signer out of sync with chain');
            return setOutbox(row, 'waiting_signer', { fail_reason: reason, last_error: reason });
        }
        if (CONFLICT_REVERTS.has(revert.name)) {
            const onchain = await chain.read.getIncident(row.incident_key);
            if (onchain.status !== INCIDENT_STATUS.None && lower(onchain.evidenceHash) === row.evidence_hash) {
                return markConfirmed(row, { reconciled: true });
            }
            await recordSecurity(row.device_id, 'CHAIN_CONFLICT', row, { revert: reason, sequence: String(row.sequence) });
            log.error({ deviceId: row.device_id, reason }, 'on-chain conflict for incident');
            return setOutbox(row, 'failed', { fail_reason: reason, last_error: reason });
        }
        if (INTAKE_BUG_REVERTS.has(revert.name)) {
            log.error({ deviceId: row.device_id, reason }, 'contract rejected an incident the intake accepted');
            return setOutbox(row, 'failed', { fail_reason: reason, last_error: reason });
        }
        return setOutbox(row, 'failed', { fail_reason: reason, last_error: reason });
    }

    function claimOf(row) {
        return {
            deviceIdHash: row.device_id_hash,
            incidentId: row.incident_id,
            sequence: BigInt(row.sequence),
            observedAt: BigInt(row.observed_at),
            severity: Number(row.severity),
            evidenceHash: row.evidence_hash,
        };
    }

    const OUTBOX_COLUMNS = `
        o.id AS outbox_id, o.device_id, o.incident_id, o.sequence, o.status, o.attempts,
        o.tx_hash, o.incident_key, o.verifying_contract, o.signer_address, o.created_at,
        o.submitted_at, i.device_id_hash, i.observed_at, i.severity, i.evidence_hash, i.signature`;
    const OUTBOX_FROM = 'FROM blockchain_outbox o JOIN incidents i ON i.id = o.incident_row_id';
    const OUTBOX_SELECT = `SELECT ${OUTBOX_COLUMNS} ${OUTBOX_FROM}`;

    // True when the row's signer is the active on-chain signer of its device.
    async function signerGateOpen(row) {
        const device = await chainDevice(row.device_id_hash);
        return device.exists && device.active && lower(device.signer) === row.signer_address;
    }

    async function submitOutbox() {
        const { rows } = await db.query(
            `${OUTBOX_SELECT}
             WHERE o.status = 'queued' AND o.next_attempt_at <= NOW()
             ORDER BY o.device_id, o.sequence
             LIMIT $1`,
            [config.batchSize]
        );
        let submitted = 0;
        for (const row of rows) {
            if (!row.incident_key) {
                row.incident_key = computeIncidentKey(row.device_id_hash, row.incident_id);
                await setOutbox(row, 'queued', { incident_key: row.incident_key });
            }
            // Defense in depth: never relay evidence signed for another domain.
            if (row.verifying_contract && row.verifying_contract !== currentAddress) {
                await setOutbox(row, 'legacy_domain', { fail_reason: `signed for ${row.verifying_contract}` });
                continue;
            }
            if (!(await signerGateOpen(row))) {
                await setOutbox(row, 'waiting_signer', { fail_reason: 'signer is not the active on-chain signer' });
                continue;
            }
            // Pre-check: already on chain (restart after a lost receipt, or another path)?
            const onchain = await chain.read.getIncident(row.incident_key);
            if (onchain.status !== INCIDENT_STATUS.None) {
                if (lower(onchain.evidenceHash) === row.evidence_hash) {
                    await markConfirmed(row, { reconciled: true });
                } else {
                    await classify(row, { name: 'IncidentAlreadyLogged', args: [row.incident_key] }, null);
                }
                continue;
            }
            const claim = claimOf(row);
            try {
                await chain.relayer.logIncident.staticCall(claim, row.signature);
            } catch (err) {
                await classify(row, decodeRevert(err, chain.read), err);
                continue;
            }
            let tx;
            try {
                tx = await chain.relayer.logIncident(claim, row.signature);
            } catch (err) {
                await classify(row, decodeRevert(err, chain.read), err);
                continue;
            }
            // Committed before any waiting: a crash from here on is recovered by reconcile.
            await setOutbox(row, 'pending', {
                tx_hash: lower(tx.hash),
                attempts: Number(row.attempts) + 1,
                submitted_at: new Date(),
                last_attempt_at: new Date(),
                last_error: null,
            });
            submitted++;
            log.info({ deviceId: row.device_id, sequence: String(row.sequence), txHash: tx.hash }, 'incident submitted');
        }
        return submitted;
    }

    async function reconcileOutbox() {
        const { rows } = await db.query(`${OUTBOX_SELECT} WHERE o.status = 'pending' ORDER BY o.id LIMIT $1`, [config.batchSize]);
        if (rows.length === 0) return 0;
        const head = await chain.provider.getBlockNumber();
        let confirmed = 0;
        for (const row of rows) {
            const receipt = await chain.provider.getTransactionReceipt(row.tx_hash);
            if (!receipt) {
                const tx = await chain.provider.getTransaction(row.tx_hash);
                if (tx) continue; // still in the mempool
                // Dropped: decide from chain state, never blindly resend.
                const onchain = await chain.read.getIncident(row.incident_key);
                if (onchain.status !== INCIDENT_STATUS.None && lower(onchain.evidenceHash) === row.evidence_hash) {
                    await markConfirmed(row, { reconciled: true });
                    confirmed++;
                } else {
                    await setOutbox(row, 'queued', { tx_hash: null, last_error: 'transaction dropped', next_attempt_at: new Date() });
                }
                continue;
            }
            const confirmations = head - receipt.blockNumber + 1;
            if (receipt.status !== 1) {
                // Reverted on inclusion (race with another state change): re-evaluate from chain.
                await setOutbox(row, 'queued', { tx_hash: null, last_error: `reverted in block ${receipt.blockNumber}`, next_attempt_at: new Date() });
                continue;
            }
            if (confirmations >= config.confirmations) {
                await markConfirmed(row, { txHash: receipt.hash, blockNumber: receipt.blockNumber, confirmations });
                confirmed++;
            } else {
                await setOutbox(row, 'pending', { block_number: receipt.blockNumber, confirmations });
            }
        }
        return confirmed;
    }

    // waiting_signer rows are released when their signer is on chain, or retired as
    // stale_signer when the DB says that key was rotated away.
    async function recheckWaiting() {
        const { rows } = await db.query(
            `SELECT ${OUTBOX_COLUMNS}, s.status AS signer_status, s.revoke_reason
             ${OUTBOX_FROM}
             LEFT JOIN device_signers s ON s.device_id = o.device_id AND s.signer_address = o.signer_address
             WHERE o.status = 'waiting_signer'
             ORDER BY o.id LIMIT $1`,
            [config.batchSize * 5]
        );
        let released = 0;
        for (const row of rows) {
            if (row.signer_status === 'revoked') {
                const status = row.revoke_reason === 'rotated' ? 'stale_signer' : 'failed';
                await setOutbox(row, status, { fail_reason: `signer revoked (${row.revoke_reason})` });
                continue;
            }
            if (await signerGateOpen(row)) {
                await setOutbox(row, 'queued', { fail_reason: null, next_attempt_at: new Date() });
                released++;
            }
        }
        return released;
    }

    // ------------------------------------------------------------------ device ops
    async function setOp(op, status, fields = {}) {
        const sets = ['status = $2', 'updated_at = NOW()'];
        const values = [op.id, status];
        for (const [column, value] of Object.entries(fields)) {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
        }
        await db.query(`UPDATE device_chain_ops SET ${sets.join(', ')} WHERE id = $1`, values);
    }

    async function retryOpLater(op, err, { countAttempt = true, clearTx = false } = {}) {
        const attempts = Number(op.attempts) + (countAttempt ? 1 : 0);
        const tooOld = Date.now() - new Date(op.created_at).getTime() > config.maxRetryAgeHours * 3_600_000;
        const reason = errorText(err);
        if (attempts >= config.maxAttempts || tooOld) {
            await setOp(op, 'blocked', { attempts, last_error: reason, ...(clearTx ? { tx_hash: null } : {}) });
            log.error({ deviceId: op.device_id, op: op.op, attempts, err: reason }, 'device chain op blocked');
            return;
        }
        await setOp(op, 'queued', { attempts, last_error: reason, next_attempt_at: backoff(attempts), ...(clearTx ? { tx_hash: null } : {}) });
        log.warn({ deviceId: op.device_id, op: op.op, attempts, err: reason }, 'device chain op deferred');
    }

    async function confirmOp(op, fields = {}) {
        const hash = deviceIdHash(op.device_id);
        deviceCache.delete(hash);
        const device = await chain.read.getDevice(hash);
        await db.withTransaction(async (client) => {
            await client.query(
                `UPDATE device_chain_ops SET status = 'confirmed', last_error = NULL, updated_at = NOW(),
                        tx_hash = COALESCE($2, tx_hash), block_number = COALESCE($3, block_number)
                 WHERE id = $1`,
                [op.id, fields.tx_hash ?? null, fields.block_number ?? null]
            );
            await applyConfirmedOp(client, op, { lastSequence: device.hasLogged ? device.lastSequence : 0n });
        });
        log.info({ deviceId: op.device_id, op: op.op, opId: String(op.id) }, 'device chain op confirmed');
    }

    // Already applied on chain (retry after a crash, or done out-of-band)?
    function alreadyApplied(op, device) {
        switch (op.op) {
            case 'register':
            case 'rotate':
                return device.active && lower(device.signer) === op.signer_address;
            case 'revoke':
                return device.exists && !device.active;
            case 'set_owner':
                return device.exists && lower(device.owner) === op.owner_address;
            default:
                return false;
        }
    }

    function opCall(op, hash) {
        switch (op.op) {
            case 'register': return ['registerDevice', [hash, op.signer_address, op.owner_address]];
            case 'rotate': return ['rotateSigner', [hash, op.signer_address]];
            case 'revoke': return ['revokeDevice', [hash]];
            case 'set_owner': return ['setDeviceOwner', [hash, op.owner_address]];
            default: throw new Error(`unknown op ${op.op}`);
        }
    }

    async function submitOps() {
        const { rows } = await db.query(
            `SELECT o.* FROM device_chain_ops o
             WHERE o.status = 'queued' AND o.next_attempt_at <= NOW()
               AND NOT EXISTS (SELECT 1 FROM device_chain_ops p
                               WHERE p.device_id = o.device_id AND p.id < o.id AND p.status IN ('queued', 'pending', 'blocked', 'failed'))
             ORDER BY o.id LIMIT $1`,
            [config.batchSize]
        );
        if (rows.length && !chain.manager) {
            throw new ChainFatalError('device_chain_ops are queued but DEVICE_MANAGER_PRIVATE_KEY is not configured');
        }
        for (const op of rows) {
            const hash = deviceIdHash(op.device_id);
            try {
                const device = await chain.read.getDevice(hash);
                if (alreadyApplied(op, device)) {
                    await confirmOp(op);
                    continue;
                }
                if (Number(op.attempts) >= config.maxAttempts
                    || Date.now() - new Date(op.created_at).getTime() > config.maxRetryAgeHours * 3_600_000) {
                    await setOp(op, 'blocked', { last_error: op.last_error || 'retries exhausted' });
                    continue;
                }
                const [method, args] = opCall(op, hash);
                await chain.manager[method].staticCall(...args);
                const tx = await chain.manager[method](...args);
                await setOp(op, 'pending', { tx_hash: lower(tx.hash), attempts: Number(op.attempts) + 1 });
                log.info({ deviceId: op.device_id, op: op.op, txHash: tx.hash }, 'device chain op submitted');
            } catch (err) {
                const revert = decodeRevert(err, chain.read);
                if (revert && FATAL_REVERTS.has(revert.name)) throw new ChainFatalError(`device manager lost its role: ${revert.name}`, err);
                if (revert) {
                    await setOp(op, 'failed', { last_error: `${revert.name}(${revert.args.map(String).join(',')})` });
                    log.error({ deviceId: op.device_id, op: op.op, revert: revert.name }, 'device chain op failed');
                } else {
                    await retryOpLater(op, err);
                }
            }
        }
    }

    async function reconcileOps() {
        const { rows } = await db.query(`SELECT * FROM device_chain_ops WHERE status = 'pending' ORDER BY id LIMIT $1`, [config.batchSize]);
        if (rows.length === 0) return;
        const head = await chain.provider.getBlockNumber();
        for (const op of rows) {
            const receipt = await chain.provider.getTransactionReceipt(op.tx_hash);
            if (!receipt) {
                if (!(await chain.provider.getTransaction(op.tx_hash))) {
                    await retryOpLater(op, new Error('transaction dropped'), { countAttempt: false, clearTx: true });
                }
                continue;
            }
            if (receipt.status !== 1) {
                await retryOpLater(op, new Error(`reverted in block ${receipt.blockNumber}`), { countAttempt: false, clearTx: true });
                continue;
            }
            if (head - receipt.blockNumber + 1 >= config.confirmations) {
                await confirmOp(op, { tx_hash: lower(receipt.hash), block_number: receipt.blockNumber });
            }
        }
    }

    async function tick() {
        deviceCache = new Map();
        await reconcileOps();
        await submitOps();
        await recheckWaiting();
        await reconcileOutbox();
        await submitOutbox();
        await reconcileOutbox();
    }

    return { tick, submitOps, reconcileOps, recheckWaiting, submitOutbox, reconcileOutbox };
}
