import { createRealtimeEvent } from './realtime-events.js';
import { config } from '../config.js';

export async function sendCommand(fastify, deviceId, payload, userId) {
    const { rows } = await fastify.db.query(
        `INSERT INTO commands (device_id, user_id, payload, status)
         VALUES ($1, $2, $3, 'pending') RETURNING id`,
        [deviceId, userId, JSON.stringify(payload)]
    );
    const commandId = rows[0].id;

    await createRealtimeEvent(fastify, {
        type: 'command.updated',
        deviceId,
        payload: {
            command_id: commandId,
            status: 'pending',
            payload,
        },
    });

    if (typeof fastify.mqttIsReady === 'function' && fastify.mqttIsReady()) {
        flushPending(fastify, deviceId).catch((err) => {
            fastify.log.warn({ err, deviceId, commandId }, 'command DB queue flush failed after enqueue');
        });
    }

    return commandId;
}

function pendingTimeoutSeconds() {
    return config.commands.pendingTimeoutSeconds;
}

function advisoryLockKey(deviceId) {
    return BigInt(`0x${deviceId.replace(/:/g, '')}`).toString();
}

export function commandMessage(commandId, payload) {
    return JSON.stringify({ command_id: commandId, ...payload });
}

async function revertSentCommand(fastify, deviceId, command) {
    const { rowCount } = await fastify.db.query(
        `UPDATE commands
         SET status = 'pending',
             sent_at = NULL
         WHERE id = $1 AND device_id = $2 AND status = 'sent' AND executed_at IS NULL`,
        [command.id, deviceId]
    );
    if (rowCount === 0) return false;

    await createRealtimeEvent(fastify, {
        type: 'command.updated',
        deviceId,
        payload: {
            command_id: command.id,
            status: 'pending',
            payload: command.payload,
        },
    });
    return true;
}

async function tryAcquireFlushLock(client, deviceId) {
    const { rows } = await client.query(
        'SELECT pg_try_advisory_lock($1::bigint) AS locked',
        [advisoryLockKey(deviceId)]
    );
    return rows[0]?.locked === true;
}

async function releaseFlushLock(client, deviceId) {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [advisoryLockKey(deviceId)]);
}

export async function flushPending(fastify, deviceId) {
    const client = await fastify.db.connect();
    let locked = false;

    try {
        locked = await tryAcquireFlushLock(client, deviceId);
        if (!locked) return;

        for (;;) {
            let command;
            await client.query('BEGIN');
            try {
                const { rows } = await client.query(
                    `SELECT id, payload,
                            (created_at < NOW() - ($2 * INTERVAL '1 second')
                             AND payload->>'type' IS DISTINCT FROM 'signer_activate') AS pending_expired
                     FROM commands
                     WHERE device_id = $1 AND status = 'pending'
                     ORDER BY created_at ASC
                     LIMIT 1
                     FOR UPDATE`,
                    [deviceId, pendingTimeoutSeconds()]
                );

                if (rows.length === 0) {
                    await client.query('COMMIT');
                    break;
                }

                command = rows[0];

                if (command.pending_expired) {
                    await client.query(
                        `UPDATE commands
                         SET status = 'timeout', executed_at = NOW()
                         WHERE id = $1 AND device_id = $2 AND status = 'pending'`,
                        [command.id, deviceId]
                    );
                    await createRealtimeEvent(client, {
                        type: 'command.updated',
                        deviceId,
                        payload: {
                            command_id: command.id,
                            status: 'timeout',
                            payload: command.payload,
                        },
                        idempotencyKey: `command.updated:${command.id}:timeout`,
                    });
                    await client.query('COMMIT');
                    fastify.log.warn({ deviceId, commandId: command.id }, 'expired pending command dropped before publish');
                    continue;
                }

                await client.query(
                    `UPDATE commands
                     SET status = 'sent',
                         sent_at = NOW()
                     WHERE id = $1 AND device_id = $2 AND status = 'pending'`,
                    [command.id, deviceId]
                );
                await createRealtimeEvent(client, {
                    type: 'command.updated',
                    deviceId,
                    payload: {
                        command_id: command.id,
                        status: 'sent',
                        payload: command.payload,
                    },
                });
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                fastify.log.warn({ err, deviceId, commandId: command?.id }, 'pending command publish failed; leaving DB row pending');
                break;
            }

            try {
                await fastify.mqttPublish(
                    `device/${deviceId}/command`,
                    commandMessage(command.id, command.payload),
                    { qos: 1 }
                );
            } catch (err) {
                try {
                    const reverted = await revertSentCommand(fastify, deviceId, command);
                    fastify.log.warn(
                        { err, deviceId, commandId: command.id, reverted },
                        reverted
                            ? 'pending command publish failed after dispatch commit; command reverted to pending'
                            : 'pending command publish failed after dispatch commit; command state already advanced'
                    );
                } catch (revertErr) {
                    fastify.log.error(
                        { err: revertErr, deviceId, commandId: command.id },
                        'failed to revert sent command after publish failure'
                    );
                    fastify.log.warn(
                        { err, deviceId, commandId: command.id },
                        'pending command publish failed after dispatch commit; command left as sent'
                    );
                }
                break;
            }
        }
    } finally {
        if (locked) {
            await releaseFlushLock(client, deviceId);
        }
        client.release();
    }
}
