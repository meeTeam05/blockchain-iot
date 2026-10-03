import { createRealtimeEvent } from '../services/realtime-events.js';
import { registerNonOverlappingIntervalJob } from './scheduler.js';
import { config } from '../config.js';

export function registerCommandTimeoutJob(fastify, options = {}) {
    const timeoutSeconds = options.timeoutSeconds ?? config.commands.sentTimeoutSeconds;
    const pendingTimeoutSeconds = options.pendingTimeoutSeconds ?? config.commands.pendingTimeoutSeconds;
    const sweepIntervalMs = options.sweepIntervalMs ?? config.commands.timeoutSweepIntervalMs;

    const runSweep = async () => {
        let client;

        try {
            client = await fastify.db.connect();
            await client.query('BEGIN');
            const result = await client.query(
                `UPDATE commands
                 SET status = 'timeout', executed_at = NOW()
                 WHERE (status = 'sent'    AND sent_at IS NOT NULL AND sent_at < NOW() - ($1 * INTERVAL '1 second'))
                    OR (status = 'pending' AND created_at < NOW() - ($2 * INTERVAL '1 second')
                        AND payload->>'type' IS DISTINCT FROM 'signer_activate')
                 RETURNING id, device_id, payload`,
                [timeoutSeconds, pendingTimeoutSeconds]
            );

            for (const command of result.rows) {
                await createRealtimeEvent(client, {
                    type: 'command.updated',
                    deviceId: command.device_id,
                    payload: {
                        command_id: command.id,
                        status: 'timeout',
                        payload: command.payload,
                    },
                    idempotencyKey: `command.updated:${command.id}:timeout`,
                });
            }

            await client.query('COMMIT');

            if (result.rowCount > 0) {
                fastify.log.info(
                    { updated: result.rowCount, timeoutSeconds, pendingTimeoutSeconds },
                    'command timeout sweep updated stale commands'
                );
            }
        } catch (err) {
            if (client) {
                try {
                    await client.query('ROLLBACK');
                } catch (rollbackErr) {
                    fastify.log.error({ err: rollbackErr }, 'command timeout sweep rollback failed');
                }
            }
            fastify.log.error({ err }, 'command timeout sweep failed');
        } finally {
            client?.release();
        }
    };

    registerNonOverlappingIntervalJob(fastify, {
        intervalMs: sweepIntervalMs,
        jobName: 'command timeout',
        runImmediately: true,
        task: runSweep,
    });
}
