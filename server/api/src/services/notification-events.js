const TERMINAL_COMMAND_STATUS = new Set(['done', 'error', 'timeout']);
const TERMINAL_OTA_STATUS = new Set(['rebooting', 'failed']);

function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function relayLabel(relay) {
    return Number.isInteger(relay) ? `Relay ${relay}` : 'Relay';
}

function commandPayload(payload) {
    const nested = asObject(payload.payload);
    return Object.keys(nested).length > 0 ? nested : asObject(payload.command_payload);
}

function commandSuccessTitle(payload) {
    const command = commandPayload(payload);
    switch (command.type) {
    case 'relay_set':
        return `${relayLabel(command.relay)} turned ${command.state === true ? 'on' : 'off'}`;
    case 'device_mode':
        return `Mode changed to ${(command.mode ?? '?').toString().toUpperCase()}`;
    case 'calibrate_co':
        return 'CO calibration completed';
    case 'calibrate_no2':
        return 'NO2 calibration completed';
    case 'set_time':
        return 'Device time synchronized';
    case 'ai_set':
        return `AI ${command.state === true ? 'enabled' : 'disabled'}`;
    default:
        return 'Command completed';
    }
}

function commandErrorTitle(payload, status) {
    const command = commandPayload(payload);
    switch (command.type) {
    case 'relay_set':
        return `${relayLabel(command.relay)} command ${status === 'timeout' ? 'timed out' : 'failed'}`;
    case 'device_mode':
        return `Mode change ${status === 'timeout' ? 'timed out' : 'failed'}`;
    case 'calibrate_co':
        return `CO calibration ${status === 'timeout' ? 'timed out' : 'failed'}`;
    case 'calibrate_no2':
        return `NO2 calibration ${status === 'timeout' ? 'timed out' : 'failed'}`;
    case 'set_time':
        return `Time sync ${status === 'timeout' ? 'timed out' : 'failed'}`;
    case 'ai_set':
        return `AI toggle ${status === 'timeout' ? 'timed out' : 'failed'}`;
    default:
        return `Command ${status === 'timeout' ? 'timed out' : 'failed'}`;
    }
}

function commandBody(payload, status) {
    if (status === 'done') {
        return 'Command completed successfully.';
    }

    const errorMessage = typeof payload.error_message === 'string'
        ? payload.error_message.trim()
        : '';
    if (status === 'error' && errorMessage) {
        return errorMessage;
    }
    if (status === 'timeout') {
        return 'The device did not acknowledge the command in time.';
    }
    return 'Device reported a command error.';
}

function notificationDefinition(event) {
    const payload = asObject(event.payload);

    if (event.type === 'device.status') {
        const online = payload.online === true;
        return {
            type: online ? 'device.online' : 'device.offline',
            title: online ? 'Device came online' : 'Device went offline',
            body: online
                ? 'Device is connected and reporting.'
                : 'Device is no longer reporting.',
            severity: online ? 'success' : 'warning',
            payload,
        };
    }

    if (event.type === 'command.updated') {
        const status = typeof payload.status === 'string' ? payload.status : '';
        if (!TERMINAL_COMMAND_STATUS.has(status)) return null;

        return {
            type: `command.${status}`,
            title: status === 'done'
                ? commandSuccessTitle(payload)
                : commandErrorTitle(payload, status),
            body: commandBody(payload, status),
            severity: status === 'done'
                ? 'success'
                : status === 'timeout'
                    ? 'warning'
                    : 'danger',
            payload,
        };
    }

    if (event.type === 'ota.progress') {
        const status = typeof payload.status === 'string' ? payload.status : '';
        if (!TERMINAL_OTA_STATUS.has(status)) return null;

        return {
            type: `ota.${status}`,
            title: status === 'rebooting' ? 'OTA update applied' : 'OTA update failed',
            body: status === 'failed'
                ? (typeof payload.reason === 'string' && payload.reason.trim()
                    ? payload.reason.trim()
                    : 'Device reported an OTA failure.')
                : 'Device is rebooting to finish the update.',
            severity: status === 'failed' ? 'danger' : 'success',
            payload,
        };
    }

    if (event.type === 'incident.created') {
        const severity = payload.severity === 'danger' ? 'danger' : payload.severity === 'warning' ? 'warning' : null;
        if (!severity) return null;
        const level = severity === 'danger' ? 2 : 1;
        const gases = [
            payload.co_level === level ? 'CO' : null,
            payload.no2_level === level ? 'NO2' : null,
        ].filter(Boolean);
        const gasLabel = gases.length > 0 ? gases.join(' and ') : 'Gas';

        return {
            type: `incident.${severity}`,
            title: severity === 'danger' ? 'Gas threshold exceeded' : 'Gas early warning',
            body: severity === 'danger'
                ? `${gasLabel} exceeded the QCVN 03:2019/BYT limit.`
                : `${gasLabel} entered early warning.`,
            severity,
            payload,
        };
    }

    return null;
}

export async function projectNotificationEvent(db, event) {
    const definition = notificationDefinition(event);
    if (!definition) return;

    const { rows } = await db.query(
        'SELECT name FROM devices WHERE id = $1',
        [event.device_id]
    );
    const deviceName = typeof rows[0]?.name === 'string' ? rows[0].name.trim() : '';
    if (!deviceName) return;

    await db.query(
        `INSERT INTO notification_events (
             source_event_id,
             type,
             device_id,
             device_name_snapshot,
             title,
             body,
             severity,
             payload,
             occurred_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         ON CONFLICT (source_event_id) DO NOTHING`,
        [
            event.id,
            definition.type,
            event.device_id,
            deviceName,
            definition.title,
            definition.body,
            definition.severity,
            JSON.stringify(definition.payload),
            event.occurred_at,
        ]
    );
}

export async function listNotificationEventsForUser(fastify, userId, { beforeId = null, limit = 50 } = {}) {
    const { rows } = await fastify.db.query(
        `SELECT n.source_event_id::text AS id,
                n.type,
                n.device_id,
                n.device_name_snapshot AS device_name,
                n.title,
                n.body,
                n.severity,
                n.occurred_at,
                n.payload
         FROM notification_events n
         JOIN devices d ON d.id = n.device_id
         JOIN home_members hm ON hm.home_id = d.home_id
         JOIN users u ON u.id = hm.user_id
         WHERE hm.user_id = $1
           AND u.is_active = TRUE
           AND ($2::bigint IS NULL OR n.source_event_id < $2::bigint)
         ORDER BY n.source_event_id DESC
         LIMIT $3`,
        [userId, beforeId, limit]
    );
    return rows;
}
