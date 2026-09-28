// Operator tool for the incident signer registry (device_signers).
// The same address must also be registered on AirSafetyLog (Task 2/4); otherwise
// logIncident reverts and the chain worker blocks that device's outbox.
//
//   node scripts/device-signer.js register <device_id> <signer_address>
//   node scripts/device-signer.js rotate   <device_id> <signer_address>
//   node scripts/device-signer.js revoke   <device_id> [reason]
//   node scripts/device-signer.js show     <device_id>
import pg from 'pg';
import { config } from '../src/config.js';
import { registerSigner, revokeSigner } from '../src/services/device-signers.js';
import { normalizeDeviceId } from '../src/utils/device-id.js';

const { Pool } = pg;

function usage() {
    console.error('usage: node scripts/device-signer.js <register|rotate|revoke|show> <device_id> [address|reason]');
    process.exit(2);
}

async function run() {
    const [command, rawDeviceId, arg] = process.argv.slice(2);
    const deviceId = normalizeDeviceId(rawDeviceId);
    if (!command || !deviceId) usage();

    const pool = new Pool({
        host: config.db.host,
        port: config.db.port,
        database: config.db.database,
        user: config.db.user,
        password: config.db.password,
    });

    try {
        if (command === 'register' || command === 'rotate') {
            if (!arg) usage();
            const result = await registerSigner(pool, deviceId, arg, { rotate: command === 'rotate' });
            console.log(JSON.stringify(result));
        } else if (command === 'revoke') {
            const revoked = await revokeSigner(pool, deviceId, arg || 'revoked');
            console.log(revoked ? `revoked active signer of ${deviceId}` : `${deviceId} has no active signer`);
        } else if (command === 'show') {
            const { rows } = await pool.query(
                `SELECT signer_address, status, activated_at, revoked_at, revoke_reason
                 FROM device_signers
                 WHERE device_id = $1
                 ORDER BY id`,
                [deviceId]
            );
            console.log(JSON.stringify(rows, null, 2));
        } else {
            usage();
        }
    } finally {
        await pool.end();
    }
}

run().catch((err) => {
    console.error(`device-signer failed: ${err.message}`);
    process.exit(1);
});
