// Operator alerts for the chain worker (Task 4). Raising is an INSERT that is idempotent by
// dedupe_key, so a retried tick never alerts twice. Delivery to OPS_ALERT_WEBHOOK_URL is a
// separate step that retries until the webhook accepts; alerts stay in chain_ops_alerts
// until acknowledged (scripts/chain-ops.js ack-alert).

export const ALERT_KIND = Object.freeze({
    OUTBOX_BLOCKED: 'outbox_blocked',
    OUTBOX_FAILED: 'outbox_failed',
    DEVICE_OP_BLOCKED: 'device_op_blocked',
    DEVICE_OP_FAILED: 'device_op_failed',
    WORKER_FAILING: 'worker_failing',
    WORKER_STOPPED: 'worker_stopped',
    RELAYER_LOW_BALANCE: 'relayer_low_balance',
});

const MAX_DELIVERY_ATTEMPTS = 50;

function errorText(err) {
    return String(err?.message ?? err).slice(0, 500);
}

// Returns the new alert id, or null when the same dedupe_key was already raised.
export async function raiseOpsAlert(db, { kind, severity = 'critical', dedupeKey, deviceId = null, subjectId = null, message, details = {} }) {
    const { rows } = await db.query(
        `INSERT INTO chain_ops_alerts (dedupe_key, kind, severity, device_id, subject_id, message, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING id`,
        [dedupeKey, kind, severity, deviceId, subjectId == null ? null : String(subjectId), message, JSON.stringify(details)]
    );
    return rows[0]?.id ?? null;
}

// Slack reads `text`, Discord reads `content`; both ignore the structured `alert`.
export function webhookBody(alert) {
    const line = `[${String(alert.severity).toUpperCase()}] ${alert.kind}: ${alert.message}`;
    return {
        text: line,
        content: line,
        alert: {
            id: String(alert.id),
            kind: alert.kind,
            severity: alert.severity,
            device_id: alert.device_id,
            subject_id: alert.subject_id,
            message: alert.message,
            details: alert.details,
            created_at: alert.created_at,
        },
    };
}

export function createAlertDelivery({ db, webhookUrl, fetchImpl = globalThis.fetch, timeoutMs = 5_000, batchSize = 20, log = console }) {
    // Delivers undelivered alerts in id order; stops at the first failure so a down
    // webhook costs one request per tick and alerts arrive in order once it recovers.
    async function deliverPending() {
        if (!webhookUrl) return 0;
        const { rows } = await db.query(
            `SELECT * FROM chain_ops_alerts
             WHERE delivered_at IS NULL AND delivery_attempts < $1
             ORDER BY id LIMIT $2`,
            [MAX_DELIVERY_ATTEMPTS, batchSize]
        );
        let delivered = 0;
        for (const alert of rows) {
            try {
                const response = await fetchImpl(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(webhookBody(alert)),
                    signal: AbortSignal.timeout(timeoutMs),
                });
                if (!response.ok) throw new Error(`webhook responded HTTP ${response.status}`);
                await db.query(
                    `UPDATE chain_ops_alerts
                     SET delivered_at = NOW(), delivery_attempts = delivery_attempts + 1, delivery_error = NULL
                     WHERE id = $1`,
                    [alert.id]
                );
                delivered++;
            } catch (err) {
                await db.query(
                    'UPDATE chain_ops_alerts SET delivery_attempts = delivery_attempts + 1, delivery_error = $2 WHERE id = $1',
                    [alert.id, errorText(err)]
                );
                log.warn({ alertId: String(alert.id), err: errorText(err) }, 'ops alert delivery failed');
                break;
            }
        }
        return delivered;
    }

    return { deliverPending };
}
