// Re-applies the current EMQX ACL (including device/{id}/incident and incident/ack)
// to every registered device. Run once after deploying Task 3, before firmware
// starts publishing incidents: EMQX disconnects a device on a denied publish.
//
//   node scripts/sync-device-acl.js [device_id ...]
import pg from 'pg';
import { config } from '../src/config.js';
import { clearEmqxAuthorizationCache, syncDeviceRules } from '../src/services/emqx.js';
import { normalizeDeviceId } from '../src/utils/device-id.js';

const { Pool } = pg;

async function run() {
    const requested = process.argv.slice(2).map((value) => {
        const deviceId = normalizeDeviceId(value);
        if (!deviceId) throw new Error(`invalid device id: ${value}`);
        return deviceId;
    });

    const pool = new Pool({
        host: config.db.host,
        port: config.db.port,
        database: config.db.database,
        user: config.db.user,
        password: config.db.password,
    });

    let failed = 0;
    try {
        const { rows } = requested.length > 0
            ? await pool.query('SELECT id FROM devices WHERE id = ANY($1::text[]) ORDER BY id', [requested])
            : await pool.query('SELECT id FROM devices ORDER BY id');

        for (const { id } of rows) {
            try {
                await syncDeviceRules(id);
                console.log(`synced ACL for ${id}`);
            } catch (err) {
                failed += 1;
                console.error(`failed to sync ACL for ${id}: ${err.message}`);
            }
        }
        await clearEmqxAuthorizationCache();
        console.log(`done: ${rows.length - failed}/${rows.length} devices synced`);
    } finally {
        await pool.end();
    }

    if (failed > 0) process.exit(1);
}

run().catch((err) => {
    console.error('ACL sync failed');
    console.error(err);
    process.exit(1);
});
