// Chain worker, keeper. Runs after relayer.tick() when
// KEEPER_ENABLED, from its own wallet (never the relayer/manager/operator wallet):
//   1. record_ack       recordTimelyAck for incidents acknowledged (or resolved) in time (R1)
//   2. record_resolve   recordTimelyResolve for resolved incidents whose ack was paid (R2)
//   3. slash_missed_ack slashMissedAck for incidents nobody acknowledged in time (P1)
// It never calls slashLateRelay: the operator does not slash itself; late relays are
// left to outside keepers (dApp /keeper, independent bots).
//
// Invariants:
// * Every call is decided from pendingSettlement() on chain and simulated first.
// * keeper_actions holds one row per (contract, incident, action) and the settlement
//   projection comes from incident_incentives of the same contract: an incident is never
//   processed twice by one deployment, and a redeployed SafetyIncentives evaluates it
//   independently of any earlier deployment. Someone else settling first (AlreadySettled) or a passed deadline
//   (AckDeadlinePassed) is a normal outcome: logged and stored as 'skipped'.
// * The tx hash is committed as 'pending' before anything waits on it; reconcile turns
//   it into 'done' after CHAIN_CONFIRMATIONS, or back to 'retry' when dropped/reverted.
// * RPC errors back off exponentially per row (in seconds: deadlines are minutes long).
// * Deadlines are compared with the latest block timestamp, as the contract does.
import { decodeRevert } from './air-safety-log.js';
import { SETTLEMENT_FLAGS as F, readSettlement } from './incentives.js';

const LOGGED = 1;

export const KEEPER_ACTIONS = Object.freeze({
    record_ack: 'recordTimelyAck',
    record_resolve: 'recordTimelyResolve',
    slash_missed_ack: 'slashMissedAck',
});

// Expected outcomes when racing other keepers or the clock: never retried.
export const NORMAL_REVERTS = new Set(['AlreadySettled', 'AckDeadlinePassed', 'ResolveDeadlinePassed', 'IncidentNotCovered']);
// The chain is not (yet) in the state the DB reported: re-evaluated on a later tick.
export const WAIT_REVERTS = new Set(['NotAcknowledged', 'NotResolved', 'AckDeadlineNotPassed', 'IncidentNotFound']);

function lower(value) {
    return typeof value === 'string' ? value.toLowerCase() : value;
}

function errorText(err) {
    return String(err?.shortMessage ?? err?.message ?? err).slice(0, 500);
}

function seconds(value) {
    return value ? Math.floor(new Date(value).getTime() / 1000) : null;
}

// What to do with one candidate, from the on-chain settlement `s` (see readSettlement)
// and the DB row. Returns { kind: 'call' } | { kind: 'skip', reason } | { kind: 'wait', reason }.
export function decideAction(action, s, row, nowSeconds) {
    if (!s.exists) return { kind: 'wait', reason: 'IncidentNotFound' };
    if (!s.covered) return { kind: 'skip', reason: 'IncidentNotCovered' };
    switch (action) {
        case 'record_ack':
            if (s.flags & (F.TIMELY_ACK | F.ACK_SLASHED)) return { kind: 'skip', reason: 'AlreadySettled' };
            if (nowSeconds > s.ackDeadline) return { kind: 'skip', reason: 'AckDeadlinePassed' };
            return s.canRecordAck ? { kind: 'call' } : { kind: 'wait', reason: 'NotAcknowledged' };
        case 'record_resolve':
            if (s.flags & F.RESOLVE_SETTLED) return { kind: 'skip', reason: 'AlreadySettled' };
            if (!(s.flags & F.TIMELY_ACK)) return { kind: 'wait', reason: 'NotAcknowledged' };
            // R2 only pays when R1 paid; calling it otherwise burns gas for RewardSkipped.
            if (!(s.flags & F.ACK_REWARDED)) return { kind: 'skip', reason: 'AckNotRewarded' };
            if (nowSeconds > s.resolveDeadline) return { kind: 'skip', reason: 'ResolveDeadlinePassed' };
            return s.canRecordResolve ? { kind: 'call' } : { kind: 'wait', reason: 'NotResolved' };
        case 'slash_missed_ack': {
            if (s.flags & (F.TIMELY_ACK | F.ACK_SLASHED)) return { kind: 'skip', reason: 'AlreadySettled' };
            if (nowSeconds <= s.ackDeadline) return { kind: 'wait', reason: 'AckDeadlineNotPassed' };
            if (s.status !== LOGGED) {
                // Acknowledged on chain: only slash when the indexed reaction was late.
                const reactedAt = seconds(row.reacted_at);
                if (reactedAt === null) return { kind: 'wait', reason: 'acknowledgement not indexed yet' };
                if (reactedAt <= s.ackDeadline) return { kind: 'skip', reason: 'owner acknowledged in time' };
            }
            return { kind: 'call' };
        }
        default:
            throw new TypeError(`unknown keeper action ${action}`);
    }
}

export function createKeeper({ db, chain, config, log = console }) {
    const batchSize = config.batchSize ?? 20;
    const contract = chain.address.toLowerCase();

    function backoff(attempts) {
        const delaySeconds = Math.min(15 * 2 ** attempts, 300);
        return new Date(Date.now() + delaySeconds * 1000);
    }

    async function setAction(row, action, status, fields = {}) {
        await db.query(
            `INSERT INTO keeper_actions (incident_row_id, incident_key, action, status, tx_hash, block_number, attempts,
                                         next_attempt_at, last_error, contract)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (contract, incident_row_id, action) DO UPDATE SET
                 status = EXCLUDED.status, tx_hash = EXCLUDED.tx_hash, block_number = EXCLUDED.block_number,
                 attempts = EXCLUDED.attempts, next_attempt_at = EXCLUDED.next_attempt_at,
                 last_error = EXCLUDED.last_error, updated_at = NOW()`,
            [
                row.id,
                row.incident_key,
                action,
                status,
                fields.tx_hash ?? null,
                fields.block_number ?? null,
                fields.attempts ?? Number(row.keeper_attempts ?? 0),
                fields.next_attempt_at ?? new Date(),
                fields.last_error ?? null,
                contract,
            ]
        );
    }

    async function retryLater(row, action, err) {
        const attempts = Number(row.keeper_attempts ?? 0) + 1;
        if (attempts >= (config.maxAttempts ?? 10)) {
            await setAction(row, action, 'failed', { attempts, last_error: errorText(err) });
            log.error({ deviceId: row.device_id, action, err: errorText(err) }, 'keeper action failed after retries');
            return 'failed';
        }
        await setAction(row, action, 'retry', { attempts, last_error: errorText(err), next_attempt_at: backoff(attempts) });
        log.warn({ deviceId: row.device_id, action, attempts, err: errorText(err) }, 'keeper action deferred');
        return 'retry';
    }

    async function skip(row, action, reason) {
        await setAction(row, action, 'skipped', { last_error: reason });
        log.info({ deviceId: row.device_id, sequence: String(row.sequence), action, reason }, 'keeper action not needed');
        return 'skipped';
    }

    async function onRevert(row, action, err) {
        const revert = decodeRevert(err, chain.read);
        if (!revert) return retryLater(row, action, err);
        const reason = `${revert.name}(${revert.args.map(String).join(',')})`;
        if (NORMAL_REVERTS.has(revert.name)) return skip(row, action, reason);
        if (WAIT_REVERTS.has(revert.name)) {
            log.info({ deviceId: row.device_id, action, reason }, 'keeper action waiting for chain state');
            return 'wait';
        }
        await setAction(row, action, 'failed', { last_error: reason });
        log.error({ deviceId: row.device_id, action, reason }, 'keeper action reverted');
        return 'failed';
    }

    // A slash only moves tokens when the device bond covers the incident (as in the
    // contract: held by the current owner, in place when the incident was logged);
    // otherwise it would cost gas for a zero penalty and a zero bounty. An owner the
    // indexer has not seen yet (null) is not checked here; the contract still decides.
    async function bondCovers(s, row) {
        const bond = await chain.read.deviceBond(s.deviceIdHash);
        if (!(bond.amount > 0n && Number(bond.since) <= s.loggedAt)) return false;
        return !row.owner_address || lower(bond.staker) === lower(row.owner_address);
    }

    async function handle(action, row, nowSeconds) {
        let s;
        try {
            s = await readSettlement(chain, row.incident_key);
        } catch (err) {
            return retryLater(row, action, err);
        }
        const decision = decideAction(action, s, row, nowSeconds);
        if (decision.kind === 'skip') return skip(row, action, decision.reason);
        if (decision.kind === 'wait') return 'wait';
        if (action === 'slash_missed_ack') {
            try {
                if (!(await bondCovers(s, row))) return skip(row, action, 'no covering bond');
            } catch (err) {
                return retryLater(row, action, err);
            }
        }

        const method = KEEPER_ACTIONS[action];
        try {
            await chain.keeper[method].staticCall(row.incident_key);
        } catch (err) {
            return onRevert(row, action, err);
        }
        let tx;
        try {
            tx = await chain.keeper[method](row.incident_key);
        } catch (err) {
            return onRevert(row, action, err);
        }
        // Committed before any waiting: reconcile picks it up after a restart.
        await setAction(row, action, 'pending', {
            tx_hash: lower(tx.hash),
            attempts: Number(row.keeper_attempts ?? 0) + 1,
        });
        log.info({ deviceId: row.device_id, sequence: String(row.sequence), action, txHash: tx.hash }, 'keeper transaction sent');
        return 'sent';
    }

    const CANDIDATE_SELECT = `
        SELECT i.id, i.device_id, i.incident_id, i.sequence, i.owner_status, ii.ack_deadline_at, ii.resolve_deadline_at,
               ii.flags AS incentive_flags, COALESCE(i.acknowledged_at, i.resolved_at) AS reacted_at, o.incident_key,
               COALESCE(k.attempts, 0) AS keeper_attempts, dv.owner_address
        FROM incidents i
        JOIN blockchain_outbox o ON o.incident_row_id = i.id
        LEFT JOIN devices dv ON dv.id = i.device_id
        JOIN incident_incentives ii ON ii.incident_row_id = i.id AND ii.contract = $4
        LEFT JOIN keeper_actions k ON k.incident_row_id = i.id AND k.action = $2 AND k.contract = $4
        WHERE o.status = 'confirmed' AND o.incident_key IS NOT NULL AND ii.covered = TRUE
          AND (k.id IS NULL OR (k.status = 'retry' AND k.next_attempt_at <= NOW()))`;

    // DB pre-filter; the chain has the final say in decideAction().
    const CANDIDATES = Object.freeze({
        record_ack: `${CANDIDATE_SELECT}
            AND i.owner_status IN ('acknowledged', 'resolved')
            AND (ii.flags & ${F.TIMELY_ACK | F.ACK_SLASHED}) = 0
            AND ii.ack_deadline_at >= $1
            ORDER BY ii.ack_deadline_at LIMIT $3`,
        record_resolve: `${CANDIDATE_SELECT}
            AND i.owner_status = 'resolved'
            AND (ii.flags & ${F.ACK_REWARDED}) <> 0
            AND (ii.flags & ${F.RESOLVE_SETTLED}) = 0
            AND ii.resolve_deadline_at >= $1
            ORDER BY ii.resolve_deadline_at LIMIT $3`,
        // Not acknowledged before the deadline: still open, or acknowledged late.
        slash_missed_ack: `${CANDIDATE_SELECT}
            AND (ii.flags & ${F.TIMELY_ACK | F.ACK_SLASHED}) = 0
            AND ii.ack_deadline_at < $1
            AND (COALESCE(i.acknowledged_at, i.resolved_at) IS NULL
                 OR COALESCE(i.acknowledged_at, i.resolved_at) > ii.ack_deadline_at)
            ORDER BY ii.ack_deadline_at LIMIT $3`,
    });

    async function candidates(action, now, limit) {
        const { rows } = await db.query(CANDIDATES[action], [now, action, limit, contract]);
        return rows;
    }

    async function reconcile() {
        const { rows } = await db.query(
            `SELECT k.id, k.incident_row_id AS row_id, k.incident_key, k.action, k.tx_hash, k.attempts, i.device_id
             FROM keeper_actions k JOIN incidents i ON i.id = k.incident_row_id
             WHERE k.status = 'pending' AND k.contract = $2
             ORDER BY k.id LIMIT $1`,
            [batchSize, contract]
        );
        if (rows.length === 0) return 0;
        const head = await chain.provider.getBlockNumber();
        let done = 0;
        for (const action of rows) {
            const row = { id: action.row_id, incident_key: action.incident_key, device_id: action.device_id, keeper_attempts: action.attempts };
            const receipt = await chain.provider.getTransactionReceipt(action.tx_hash);
            if (!receipt) {
                if (await chain.provider.getTransaction(action.tx_hash)) continue; // still in the mempool
                await setAction(row, action.action, 'retry', { last_error: 'transaction dropped' });
                continue;
            }
            if (receipt.status !== 1) {
                // Lost a race on inclusion: re-evaluate from chain on the next tick.
                await setAction(row, action.action, 'retry', { last_error: `reverted in block ${receipt.blockNumber}` });
                continue;
            }
            if (head - receipt.blockNumber + 1 >= config.confirmations) {
                await setAction(row, action.action, 'done', { tx_hash: action.tx_hash, block_number: receipt.blockNumber });
                log.info({ deviceId: action.device_id, action: action.action, txHash: action.tx_hash }, 'keeper transaction confirmed');
                done++;
            } else {
                await setAction(row, action.action, 'pending', { tx_hash: action.tx_hash, block_number: receipt.blockNumber });
            }
        }
        return done;
    }

    // One round: reconcile sent txs, then at most KEEPER_BATCH_SIZE incidents, rewards first.
    async function tick() {
        const result = { confirmed: await reconcile(), sent: 0, skipped: 0 };
        const block = await chain.provider.getBlock('latest');
        const nowSeconds = Number(block.timestamp);
        const now = new Date(nowSeconds * 1000);
        let budget = batchSize;
        for (const action of Object.keys(KEEPER_ACTIONS)) {
            if (budget <= 0) break;
            for (const row of await candidates(action, now, budget)) {
                budget--;
                const outcome = await handle(action, row, nowSeconds);
                if (outcome === 'sent') result.sent++;
                if (outcome === 'skipped') result.skipped++;
            }
        }
        return result;
    }

    return { tick, reconcile, candidates, handle };
}
