// Chain worker metrics (Task 4), read from the DB only so the API never needs an RPC
// call to answer: chain_worker_status (heartbeat), chain_checkpoints (indexer progress),
// blockchain_outbox / device_chain_ops (queues) and chain_ops_alerts.
import { formatEther } from 'ethers';

export const OUTBOX_STATUSES = Object.freeze([
    'queued', 'pending', 'confirmed', 'failed', 'blocked', 'legacy_domain', 'waiting_signer', 'stale_signer',
]);
export const DEVICE_OP_STATUSES = Object.freeze(['queued', 'pending', 'confirmed', 'failed', 'blocked']);

function ageSeconds(now, at) {
    return at ? Math.max(0, Math.floor((now.getTime() - new Date(at).getTime()) / 1000)) : null;
}

function toNumber(value) {
    return value == null ? null : Number(value);
}

function countsByStatus(statuses, rows) {
    const counts = Object.fromEntries(statuses.map((status) => [status, 0]));
    for (const row of rows) counts[row.status] = Number(row.n);
    return counts;
}

export async function collectChainMetrics(db, { now = new Date() } = {}) {
    const [worker, outbox, ops, alerts] = await Promise.all([
        db.query(
            `SELECT w.*, c.last_block AS indexed_block
             FROM chain_worker_status w
             LEFT JOIN chain_checkpoints c ON c.contract_address = w.contract_address
             ORDER BY w.last_tick_at DESC LIMIT 1`
        ),
        db.query(
            `SELECT status, COUNT(*)::int AS n, MIN(created_at) AS oldest_created,
                    MIN(COALESCE(submitted_at, updated_at)) AS oldest_submitted, MAX(attempts)::int AS max_attempts
             FROM blockchain_outbox GROUP BY status`
        ),
        db.query(
            `SELECT status, COUNT(*)::int AS n, MIN(created_at) AS oldest_created,
                    MIN(updated_at) AS oldest_updated, MAX(attempts)::int AS max_attempts
             FROM device_chain_ops GROUP BY status`
        ),
        db.query(
            `SELECT COUNT(*) FILTER (WHERE acknowledged_at IS NULL)::int AS open,
                    COUNT(*) FILTER (WHERE delivered_at IS NULL)::int AS undelivered
             FROM chain_ops_alerts`
        ),
    ]);

    const w = worker.rows[0] ?? null;
    const outboxBy = new Map(outbox.rows.map((row) => [row.status, row]));
    const opsBy = new Map(ops.rows.map((row) => [row.status, row]));
    const openAttempts = (by, statuses) => Math.max(0, ...statuses.map((status) => Number(by.get(status)?.max_attempts ?? 0)));
    const head = toNumber(w?.head_block);
    const indexed = toNumber(w?.indexed_block);

    return {
        checked_at: now.toISOString(),
        worker: w && {
            contract_address: w.contract_address,
            relayer_address: w.relayer_address,
            started_at: w.started_at,
            last_tick_at: w.last_tick_at,
            last_tick_age_seconds: ageSeconds(now, w.last_tick_at),
            last_success_at: w.last_success_at,
            consecutive_failures: Number(w.consecutive_failures),
            rpc_errors_total: Number(w.rpc_errors_total),
            last_error: w.last_error,
            last_error_at: w.last_error_at,
            head_block: head,
            indexed_block: indexed,
            index_lag_blocks: head != null && indexed != null ? Math.max(0, head - indexed) : null,
            relayer_balance_wei: w.relayer_balance_wei == null ? null : String(w.relayer_balance_wei),
            balance_checked_at: w.balance_checked_at,
        },
        outbox: {
            by_status: countsByStatus(OUTBOX_STATUSES, outbox.rows),
            oldest_queued_age_seconds: ageSeconds(now, outboxBy.get('queued')?.oldest_created),
            oldest_waiting_signer_age_seconds: ageSeconds(now, outboxBy.get('waiting_signer')?.oldest_created),
            oldest_pending_age_seconds: ageSeconds(now, outboxBy.get('pending')?.oldest_submitted),
            max_attempts_open: openAttempts(outboxBy, ['queued', 'pending']),
        },
        device_ops: {
            by_status: countsByStatus(DEVICE_OP_STATUSES, ops.rows),
            oldest_queued_age_seconds: ageSeconds(now, opsBy.get('queued')?.oldest_created),
            oldest_pending_age_seconds: ageSeconds(now, opsBy.get('pending')?.oldest_updated),
            max_attempts_open: openAttempts(opsBy, ['queued', 'pending']),
        },
        alerts: {
            open: Number(alerts.rows[0]?.open ?? 0),
            undelivered: Number(alerts.rows[0]?.undelivered ?? 0),
        },
    };
}

// ok/degraded plus human-readable reasons; thresholds come from config.chain.health*.
export function evaluateChainHealth(metrics, { maxTickAgeSeconds, maxQueuedAgeSeconds, maxLagBlocks, minRelayerBalanceWei = 0n, failureStreak = 1 }) {
    const reasons = [];
    const w = metrics.worker;
    if (!w) {
        reasons.push('chain worker has never reported a heartbeat');
    } else {
        if (w.last_tick_age_seconds > maxTickAgeSeconds) reasons.push(`chain worker heartbeat is ${w.last_tick_age_seconds}s old`);
        if (w.consecutive_failures >= failureStreak) reasons.push(`chain worker failed ${w.consecutive_failures} iterations in a row`);
        if (w.index_lag_blocks != null && w.index_lag_blocks > maxLagBlocks) reasons.push(`indexer is ${w.index_lag_blocks} blocks behind the chain head`);
        if (w.relayer_balance_wei != null && minRelayerBalanceWei > 0n && BigInt(w.relayer_balance_wei) < minRelayerBalanceWei) {
            reasons.push(`relayer balance ${formatEther(BigInt(w.relayer_balance_wei))} ETH is below ${formatEther(minRelayerBalanceWei)} ETH`);
        }
    }
    for (const [label, section] of [['outbox', metrics.outbox], ['device op', metrics.device_ops]]) {
        if (section.by_status.blocked) reasons.push(`${section.by_status.blocked} ${label} item(s) blocked`);
        if (section.by_status.failed) reasons.push(`${section.by_status.failed} ${label} item(s) failed`);
        if (section.oldest_queued_age_seconds > maxQueuedAgeSeconds) reasons.push(`oldest queued ${label} item is ${section.oldest_queued_age_seconds}s old`);
    }
    return { status: reasons.length ? 'degraded' : 'ok', reasons };
}

function metricLines(name, help, type, samples) {
    const present = samples.filter(([, value]) => value != null && Number.isFinite(Number(value)));
    if (!present.length) return [];
    return [
        `# HELP ${name} ${help}`,
        `# TYPE ${name} ${type}`,
        ...present.map(([labels, value]) => `${name}${labels} ${value}`),
    ];
}

export function renderPrometheus(metrics, health) {
    const w = metrics.worker ?? {};
    const byStatus = (section) => Object.entries(section.by_status).map(([status, n]) => [`{status="${status}"}`, n]);
    return [
        ...metricLines('smartair_chain_healthy', '1 when /api/health/chain reports ok', 'gauge', [['', health.status === 'ok' ? 1 : 0]]),
        ...metricLines('smartair_chain_outbox_items', 'Incident outbox rows by status', 'gauge', byStatus(metrics.outbox)),
        ...metricLines('smartair_chain_outbox_oldest_queued_age_seconds', 'Age of the oldest queued outbox row', 'gauge', [['', metrics.outbox.oldest_queued_age_seconds]]),
        ...metricLines('smartair_chain_outbox_oldest_pending_age_seconds', 'Age of the oldest submitted, unconfirmed outbox row', 'gauge', [['', metrics.outbox.oldest_pending_age_seconds]]),
        ...metricLines('smartair_chain_outbox_max_attempts', 'Highest attempt count among queued/pending outbox rows', 'gauge', [['', metrics.outbox.max_attempts_open]]),
        ...metricLines('smartair_chain_device_ops_items', 'Device lifecycle ops by status', 'gauge', byStatus(metrics.device_ops)),
        ...metricLines('smartair_chain_device_ops_oldest_queued_age_seconds', 'Age of the oldest queued device op', 'gauge', [['', metrics.device_ops.oldest_queued_age_seconds]]),
        ...metricLines('smartair_chain_worker_last_tick_age_seconds', 'Seconds since the chain worker last finished an iteration', 'gauge', [['', w.last_tick_age_seconds]]),
        ...metricLines('smartair_chain_worker_consecutive_failures', 'Chain worker iterations failed in a row', 'gauge', [['', w.consecutive_failures]]),
        ...metricLines('smartair_chain_worker_rpc_errors_total', 'Chain worker iterations failed since the status row was created', 'counter', [['', w.rpc_errors_total]]),
        ...metricLines('smartair_chain_head_block', 'Chain head seen by the worker', 'gauge', [['', w.head_block]]),
        ...metricLines('smartair_chain_indexed_block', 'Last block committed by the indexer', 'gauge', [['', w.indexed_block]]),
        ...metricLines('smartair_chain_index_lag_blocks', 'Blocks between the chain head and the indexer checkpoint', 'gauge', [['', w.index_lag_blocks]]),
        ...metricLines('smartair_chain_relayer_balance_eth', 'Relayer wallet balance', 'gauge', [['', w.relayer_balance_wei == null ? null : formatEther(BigInt(w.relayer_balance_wei))]]),
        ...metricLines('smartair_chain_alerts_open', 'Operator alerts not yet acknowledged', 'gauge', [['', metrics.alerts.open]]),
        ...metricLines('smartair_chain_alerts_undelivered', 'Operator alerts not yet delivered to the webhook', 'gauge', [['', metrics.alerts.undelivered]]),
    ].join('\n') + '\n';
}
