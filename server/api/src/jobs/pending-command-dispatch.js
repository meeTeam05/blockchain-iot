// Publishes commands that were queued by another process (the chain worker queues
// signer_activate) or while the MQTT bridge was down, for devices that are already
// online. Devices that come online later are flushed by the device-status handler.
import { flushPending } from '../services/commands.js';
import { registerNonOverlappingIntervalJob } from './scheduler.js';

export function registerPendingCommandDispatchJob(fastify, { intervalMs = 30_000, limit = 100 } = {}) {
    registerNonOverlappingIntervalJob(fastify, {
        intervalMs,
        jobName: 'pending command dispatch',
        task: async () => {
            if (typeof fastify.mqttIsReady === 'function' && !fastify.mqttIsReady()) return;
            const { rows } = await fastify.db.query(
                `SELECT DISTINCT c.device_id
                 FROM commands c
                 JOIN devices d ON d.id = c.device_id
                 WHERE c.status = 'pending' AND d.online = TRUE
                 LIMIT $1`,
                [limit]
            );
            for (const { device_id: deviceId } of rows) {
                try {
                    await flushPending(fastify, deviceId);
                } catch (err) {
                    fastify.log.warn({ err, deviceId }, 'pending command dispatch failed');
                }
            }
        },
    });
}
