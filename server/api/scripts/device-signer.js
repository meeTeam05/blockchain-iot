// Operator tool for the incident signer lifecycle. Every change goes through
// device_chain_ops, so the DB (intake) and AirSafetyLog (chain) cannot drift apart:
// the chain worker executes the op and activates the signer only once it is on-chain.
//
//   node scripts/device-signer.js register  <device_id> <signer_address> --owner <wallet>
//   node scripts/device-signer.js rotate    <device_id> <new_signer_address>
//   node scripts/device-signer.js revoke    <device_id> <compromised|decommissioned|retired>
//   node scripts/device-signer.js set-owner <device_id> <owner_wallet>
//   node scripts/device-signer.js sync-chain <device_id> --owner <wallet>
//        register the already-active DB signer on the current contract (after a redeploy)
//   node scripts/device-signer.js activate  <device_id>    re-send signer_activate {floor}
//   node scripts/device-signer.js show      <device_id>
//
// rotate requires the device to have flushed its incident queue first (the firmware
// refuses to rotate otherwise). Factory reset is NOT a reason to revoke.
import pg from 'pg';

import { config } from '../src/config.js';
import {
    computeSequenceFloor,
    deviceIdHash,
    queueSignerActivate,
    requestChainSync,
    requestOwnerChange,
    requestSignerRegistration,
    requestSignerRevocation,
} from '../src/services/signer-lifecycle.js';
import { resolveIncidentDomains } from '../src/services/incident-domains.js';
import { createChainContext, createProvider } from '../src/chain/air-safety-log.js';
import { poolAdapter } from '../src/worker.js';
import { normalizeDeviceId } from '../src/utils/device-id.js';

const { Pool } = pg;

function usage() {
    console.error('usage: node scripts/device-signer.js <register|rotate|revoke|set-owner|sync-chain|activate|show> <device_id> [arg] [--owner <wallet>]');
    process.exit(2);
}

function option(args, name) {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
}

// On-chain lastSequence when an RPC is configured; the floor must never be below it.
async function chainLastSequence(deviceId) {
    if (!config.chain.rpcUrl) return 0n;
    const { current } = resolveIncidentDomains(config.incident);
    const chain = createChainContext({ provider: createProvider(config.chain.rpcUrl), address: current.verifyingContract });
    const device = await chain.read.getDevice(deviceIdHash(deviceId));
    return device.hasLogged ? device.lastSequence : 0n;
}

async function run() {
    const args = process.argv.slice(2);
    const [command, rawDeviceId, arg] = args;
    const deviceId = normalizeDeviceId(rawDeviceId);
    if (!command || !deviceId) usage();

    const pool = new Pool({
        host: config.db.host,
        port: config.db.port,
        database: config.db.database,
        user: config.db.user,
        password: config.db.password,
    });
    const db = poolAdapter(pool);

    try {
        if (command === 'register' || command === 'rotate') {
            if (!arg || arg.startsWith('--')) usage();
            const result = await requestSignerRegistration(db, deviceId, arg, { owner: option(args, '--owner') });
            if (command === 'rotate' && result.op.op !== 'rotate') {
                console.warn(`${deviceId} had no active signer; queued a first registration instead`);
            }
            console.log(JSON.stringify(result, null, 2));
            console.log('queued: the chain worker registers it on-chain, then activates it and sends signer_activate');
        } else if (command === 'revoke') {
            console.log(JSON.stringify(await requestSignerRevocation(db, deviceId, arg || 'compromised'), null, 2));
        } else if (command === 'sync-chain') {
            console.log(JSON.stringify(await requestChainSync(db, deviceId, { owner: option(args, '--owner') }), null, 2));
        } else if (command === 'set-owner') {
            if (!arg) usage();
            console.log(JSON.stringify(await requestOwnerChange(db, deviceId, arg), null, 2));
        } else if (command === 'activate') {
            const lastSequence = await chainLastSequence(deviceId);
            const result = await db.withTransaction(async (client) => {
                const floor = await computeSequenceFloor(client, deviceId, lastSequence);
                return queueSignerActivate(client, deviceId, floor);
            });
            console.log(JSON.stringify(result, null, 2));
        } else if (command === 'show') {
            const signers = await pool.query(
                `SELECT signer_address, status, activated_at, revoked_at, revoke_reason
                 FROM device_signers WHERE device_id = $1 ORDER BY id`,
                [deviceId]
            );
            const ops = await pool.query(
                `SELECT id, op, signer_address, owner_address, status, tx_hash, last_error, created_at
                 FROM device_chain_ops WHERE device_id = $1 ORDER BY id`,
                [deviceId]
            );
            const chain = await pool.query(
                `SELECT contract_address, signer_address, owner_address, active, last_sequence, updated_block
                 FROM device_chain_state WHERE device_id = $1 ORDER BY contract_address`,
                [deviceId]
            );
            console.log(JSON.stringify({ signers: signers.rows, ops: ops.rows, chain: chain.rows }, null, 2));
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
