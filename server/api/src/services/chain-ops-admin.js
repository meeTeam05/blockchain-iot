// Operator actions on the chain queues (scripts/chain-ops.js, runbook section "Unblock").
// Requeueing never touches chain state: the relayer re-checks the chain before every
// submission, so a requeued item that is already on chain is simply confirmed.

const REQUEUE_NOTE = 'requeued by operator';

function statusesFor(includeFailed) {
    return includeFailed ? ['blocked', 'failed'] : ['blocked'];
}

function idList(ids) {
    return (ids ?? []).map((id) => String(id));
}

export async function listStuckItems(db) {
    const [outbox, ops] = await Promise.all([
        db.query(
            `SELECT id, device_id, sequence::text AS sequence, status, attempts, fail_reason, last_error,
                    created_at, retry_window_started_at, blocked_at
             FROM blockchain_outbox WHERE status IN ('blocked', 'failed') ORDER BY device_id, sequence`
        ),
        db.query(
            `SELECT id, device_id, op, status, attempts, last_error, created_at, retry_window_started_at
             FROM device_chain_ops WHERE status IN ('blocked', 'failed') ORDER BY device_id, id`
        ),
    ]);
    return { outbox: outbox.rows, deviceOps: ops.rows };
}

// Gives the rows a fresh retry window (attempts 0, retry_window_started_at NOW()).
export async function requeueOutbox(db, { ids = [], allBlocked = false, includeFailed = false }) {
    if (!allBlocked && ids.length === 0) throw new TypeError('pass outbox ids or allBlocked');
    const { rows } = await db.query(
        `UPDATE blockchain_outbox
         SET status = 'queued', attempts = 0, next_attempt_at = NOW(), retry_window_started_at = NOW(),
             blocked_at = NULL, fail_reason = NULL, tx_hash = NULL, updated_at = NOW(),
             last_error = '${REQUEUE_NOTE}; was: ' || COALESCE(fail_reason, last_error, 'unknown')
         WHERE status = ANY($1::text[]) AND ($2::boolean OR id::text = ANY($3::text[]))
         RETURNING id, device_id, sequence::text AS sequence`,
        [statusesFor(includeFailed), allBlocked, idList(ids)]
    );
    return rows;
}

// Device ops are ordered per device, so requeueing the head op also releases the ops
// queued behind it.
export async function requeueDeviceOps(db, { ids = [], includeFailed = false }) {
    if (ids.length === 0) throw new TypeError('pass device op ids');
    const { rows } = await db.query(
        `UPDATE device_chain_ops
         SET status = 'queued', attempts = 0, next_attempt_at = NOW(), retry_window_started_at = NOW(),
             tx_hash = NULL, updated_at = NOW(),
             last_error = '${REQUEUE_NOTE}; was: ' || COALESCE(last_error, 'unknown')
         WHERE status = ANY($1::text[]) AND id::text = ANY($2::text[])
         RETURNING id, device_id, op`,
        [statusesFor(includeFailed), idList(ids)]
    );
    return rows;
}

export async function listAlerts(db, { includeAcknowledged = false, limit = 50 } = {}) {
    const { rows } = await db.query(
        `SELECT id, kind, severity, device_id, subject_id, message, created_at, delivered_at, delivery_error, acknowledged_at
         FROM chain_ops_alerts
         WHERE $1::boolean OR acknowledged_at IS NULL
         ORDER BY id DESC LIMIT $2`,
        [includeAcknowledged, limit]
    );
    return rows;
}

export async function acknowledgeAlerts(db, { ids = [], all = false }) {
    if (!all && ids.length === 0) throw new TypeError('pass alert ids or all');
    const { rows } = await db.query(
        `UPDATE chain_ops_alerts SET acknowledged_at = NOW()
         WHERE acknowledged_at IS NULL AND ($1::boolean OR id::text = ANY($2::text[]))
         RETURNING id`,
        [all, idList(ids)]
    );
    return rows.map((row) => String(row.id));
}
