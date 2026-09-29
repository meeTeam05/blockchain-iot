// Chain worker, read side (E2E_FIX_PLAN.md stage 7). Follows AirSafetyLog events from the
// deployment block and projects them into the DB:
//   device_chain_state   signer / owner / active / lastSequence per device (app + gate)
//   blockchain_outbox    IncidentLogged reconciles rows confirmed by any path
//   incidents            IncidentAcknowledged / IncidentResolved owner lifecycle
//   devices.owner_address
//
// Only blocks at least CHAIN_CONFIRMATIONS deep are read, so shallow reorgs never reach
// the DB. Events are stored idempotently by (contract, tx_hash, log_index) and a batch
// commits together with its checkpoint.
import { keccak256, toUtf8Bytes } from 'ethers';

import { createRealtimeEvent } from '../services/realtime-events.js';

const EVENTS = new Set([
    'DeviceRegistered',
    'DeviceSignerRotated',
    'DeviceRevoked',
    'DeviceOwnerChanged',
    'IncidentLogged',
    'IncidentAcknowledged',
    'IncidentResolved',
]);

function lower(value) {
    return typeof value === 'string' ? value.toLowerCase() : value;
}

function jsonArgs(parsed) {
    const out = {};
    parsed.fragment.inputs.forEach((input, index) => {
        const value = parsed.args[index];
        out[input.name] = typeof value === 'bigint' ? value.toString() : lower(value);
    });
    return out;
}

export function createIndexer({ db, chain, config, startBlock = 0, log = console }) {
    const contract = chain.address.toLowerCase();
    let deviceIds = new Map();
    const blockTimes = new Map();

    async function resolveDeviceId(client, hash) {
        if (!deviceIds.has(hash)) {
            const { rows } = await client.query('SELECT id FROM devices');
            deviceIds = new Map(rows.map((row) => [keccak256(toUtf8Bytes(row.id)), row.id]));
        }
        return deviceIds.get(hash) ?? null;
    }

    async function blockTime(blockNumber) {
        if (!blockTimes.has(blockNumber)) {
            const block = await chain.provider.getBlock(blockNumber);
            blockTimes.set(blockNumber, new Date(Number(block.timestamp) * 1000));
            if (blockTimes.size > 256) blockTimes.delete(blockTimes.keys().next().value);
        }
        return blockTimes.get(blockNumber);
    }

    async function upsertState(client, hash, fields, blockNumber) {
        const deviceId = await resolveDeviceId(client, hash);
        await client.query(
            `INSERT INTO device_chain_state (contract_address, device_id_hash, device_id, updated_block)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (contract_address, device_id_hash) DO UPDATE
                 SET device_id = COALESCE(EXCLUDED.device_id, device_chain_state.device_id)`,
            [contract, hash, deviceId, blockNumber]
        );
        const sets = ['updated_block = $3', 'updated_at = NOW()'];
        const values = [contract, hash, blockNumber];
        for (const [column, value] of Object.entries(fields)) {
            values.push(value);
            sets.push(column === 'last_sequence'
                ? `last_sequence = GREATEST(COALESCE(last_sequence, 0), $${values.length}::numeric)`
                : `${column} = $${values.length}`);
        }
        await client.query(
            `UPDATE device_chain_state SET ${sets.join(', ')} WHERE contract_address = $1 AND device_id_hash = $2`,
            values
        );
        return deviceId;
    }

    async function apply(client, name, args, logEntry) {
        const blockNumber = logEntry.blockNumber;
        switch (name) {
            case 'DeviceRegistered':
                await upsertState(client, args.deviceIdHash, { signer_address: args.signer, owner_address: args.owner, active: true }, blockNumber);
                break;
            case 'DeviceSignerRotated':
                await upsertState(client, args.deviceIdHash, { signer_address: args.newSigner }, blockNumber);
                break;
            case 'DeviceRevoked':
                await upsertState(client, args.deviceIdHash, { active: false }, blockNumber);
                break;
            case 'DeviceOwnerChanged': {
                const deviceId = await upsertState(client, args.deviceIdHash, { owner_address: args.newOwner }, blockNumber);
                if (deviceId) await client.query('UPDATE devices SET owner_address = $2 WHERE id = $1', [deviceId, args.newOwner]);
                break;
            }
            case 'IncidentLogged': {
                await upsertState(client, args.deviceIdHash, { last_sequence: args.sequence }, blockNumber);
                const { rows } = await client.query(
                    `UPDATE blockchain_outbox o
                     SET status = 'confirmed', tx_hash = $2, block_number = $3, confirmed_at = COALESCE(o.confirmed_at, NOW()),
                         fail_reason = NULL, updated_at = NOW()
                     FROM incidents i
                     WHERE i.id = o.incident_row_id AND o.incident_key = $1 AND i.evidence_hash = $4
                       AND o.status <> 'confirmed'
                     RETURNING o.device_id, o.incident_id, o.sequence`,
                    [args.incidentKey, lower(logEntry.transactionHash), blockNumber, args.evidenceHash]
                );
                for (const row of rows) {
                    await createRealtimeEvent(client, {
                        type: 'incident.chain_updated',
                        deviceId: row.device_id,
                        payload: {
                            incident_id: row.incident_id,
                            sequence: String(row.sequence),
                            chain_status: 'confirmed',
                            tx_hash: lower(logEntry.transactionHash),
                            block_number: String(blockNumber),
                            reconciled: true,
                        },
                        idempotencyKey: `incident.chain_updated:${row.device_id}:${row.incident_id}:confirmed`,
                    });
                }
                break;
            }
            case 'IncidentAcknowledged':
            case 'IncidentResolved': {
                const acknowledged = name === 'IncidentAcknowledged';
                const at = await blockTime(blockNumber);
                const { rows } = await client.query(
                    acknowledged
                        ? `UPDATE incidents i SET owner_status = 'acknowledged', acknowledged_at = $2, acknowledged_by = $3, acknowledged_tx_hash = $4
                           FROM blockchain_outbox o
                           WHERE o.incident_row_id = i.id AND o.incident_key = $1 AND i.owner_status = 'open'
                           RETURNING i.device_id, i.incident_id`
                        : `UPDATE incidents i SET owner_status = 'resolved', resolved_at = $2, resolved_by = $3, resolved_tx_hash = $4
                           FROM blockchain_outbox o
                           WHERE o.incident_row_id = i.id AND o.incident_key = $1 AND i.owner_status <> 'resolved'
                           RETURNING i.device_id, i.incident_id`,
                    [args.incidentKey, at, args.owner, lower(logEntry.transactionHash)]
                );
                for (const row of rows) {
                    await createRealtimeEvent(client, {
                        type: 'incident.owner_updated',
                        deviceId: row.device_id,
                        payload: { incident_id: row.incident_id, owner_status: acknowledged ? 'acknowledged' : 'resolved' },
                        idempotencyKey: `incident.owner_updated:${row.device_id}:${row.incident_id}:${name}`,
                    });
                }
                break;
            }
            default:
                break;
        }
    }

    async function checkpoint() {
        const { rows } = await db.query('SELECT last_block FROM chain_checkpoints WHERE contract_address = $1', [contract]);
        return rows.length ? Number(rows[0].last_block) : startBlock - 1;
    }

    // Processes at most one batch; returns the number of new events.
    async function tick() {
        const head = await chain.provider.getBlockNumber();
        const safe = head - (config.confirmations - 1);
        const from = (await checkpoint()) + 1;
        if (from > safe) return 0;
        const to = Math.min(safe, from + config.logBatchBlocks - 1);
        const logs = await chain.provider.getLogs({ address: chain.address, fromBlock: from, toBlock: to });
        let applied = 0;
        await db.withTransaction(async (client) => {
            for (const entry of logs) {
                let parsed;
                try {
                    parsed = chain.read.interface.parseLog(entry);
                } catch {
                    parsed = null;
                }
                if (!parsed) continue;
                const args = jsonArgs(parsed);
                const { rows } = await client.query(
                    `INSERT INTO chain_events (contract_address, block_number, block_hash, tx_hash, log_index, event_name, args)
                     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
                     ON CONFLICT (contract_address, tx_hash, log_index) DO NOTHING
                     RETURNING id`,
                    [contract, entry.blockNumber, lower(entry.blockHash), lower(entry.transactionHash), entry.index, parsed.name, JSON.stringify(args)]
                );
                if (rows.length === 0 || !EVENTS.has(parsed.name)) continue;
                await apply(client, parsed.name, args, entry);
                applied++;
            }
            await client.query(
                `INSERT INTO chain_checkpoints (contract_address, last_block) VALUES ($1, $2)
                 ON CONFLICT (contract_address) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = NOW()`,
                [contract, to]
            );
        });
        if (applied) log.info({ from, to, applied }, 'chain events indexed');
        return applied;
    }

    // Runs batches until caught up with the safe head.
    async function catchUp() {
        let total = 0;
        for (;;) {
            const before = await checkpoint();
            total += await tick();
            if ((await checkpoint()) === before) return total;
        }
    }

    return { tick, catchUp };
}
