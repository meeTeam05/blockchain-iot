// Chain worker, incentives read side. Extends the indexer to
// SafetyIncentives with the same scheme as indexer.js: only blocks CHAIN_CONFIRMATIONS
// deep are read, events are stored idempotently by (contract, tx_hash, log_index) and a
// batch commits together with its own chain_checkpoints row (key = incentives address).
//
//   incentive_events     every SafetyIncentives event
//   incident_incentives  per (contract, incident): flags / reward_status per event;
//                        coverage and deadlines from pendingSettlement() (syncIncidents).
//                        incidents.logged_at (the AirSafetyLog loggedAt) is shared.
//   device_bonds       device bonds and the operator bond (OPERATOR_BOND_ID)
//   incentive_state    params, reward fund and operator bond snapshot for the API
//
// Every event that maps to a device in the DB emits realtime `incentive.updated`.
// Everything is keyed by this contract address, so a redeployed SafetyIncentives (B) never
// reads or overwrites the state of an earlier deployment (A) in the same database.
// When startBlock lies after the deployment block, the ParamsUpdated events of that gap
// (at least the constructor one) are backfilled first, so every later event has the
// params that were in force when it happened (keeper share for the leaderboard).
import { keccak256, toUtf8Bytes } from 'ethers';

import { createRealtimeEvent } from '../services/realtime-events.js';
import {
    OPERATOR_BOND_ID,
    RULE_ACK,
    RULE_RESOLVE,
    SETTLEMENT_FLAGS as F,
    SKIP_REASONS,
    formatParams,
    readSettlement,
} from './incentives.js';

// reward_status precedence: an outcome only ever replaces a less significant one.
export const REWARD_STATUS_RANK = Object.freeze(['none', 'late_relay_slashed', 'over_cap', 'ack_rewarded', 'resolved_rewarded', 'slashed']);

function lower(value) {
    return typeof value === 'string' ? value.toLowerCase() : value;
}

function plain(value, param) {
    if (param.baseType === 'tuple') {
        return Object.fromEntries(param.components.map((c, index) => [c.name, plain(value[index], c)]));
    }
    if (param.baseType === 'array') return [...value].map((item) => plain(item, param.arrayChildren));
    return typeof value === 'bigint' ? value.toString() : lower(value);
}

function jsonArgs(parsed) {
    return Object.fromEntries(parsed.fragment.inputs.map((input, index) => [input.name, plain(parsed.args[index], input)]));
}

function bondPayload(bond) {
    return {
        amount: bond.amount.toString(),
        since: bond.since.toString(),
        unstake_requested_at: bond.unstakeRequestedAt.toString(),
    };
}

// Incident-level effect of an event: settlement bits to set and reward_status candidate.
export function incidentEffect(name, args) {
    switch (name) {
        case 'AckRewarded':
            return { flags: F.TIMELY_ACK | F.ACK_REWARDED, status: 'ack_rewarded' };
        case 'ResolveRewarded':
            return { flags: F.RESOLVE_SETTLED, status: 'resolved_rewarded' };
        case 'RewardSkipped':
            if (Number(args.rule) === RULE_ACK) {
                return { flags: F.TIMELY_ACK, status: SKIP_REASONS[Number(args.reason)] === 'DailyCap' ? 'over_cap' : null };
            }
            return Number(args.rule) === RULE_RESOLVE ? { flags: F.RESOLVE_SETTLED, status: null } : null;
        case 'MissedAckSlashed':
            return { flags: F.ACK_SLASHED, status: 'slashed' };
        case 'LateRelaySlashed':
            return { flags: F.RELAY_SLASHED, status: 'late_relay_slashed' };
        default:
            return null;
    }
}

// Columns of incentive_events derived from the event arguments.
function eventColumns(name, args) {
    switch (name) {
        case 'Staked':
            return { deviceIdHash: args.deviceIdHash, account: args.staker, amount: args.amount };
        case 'UnstakeRequested':
            return { deviceIdHash: args.deviceIdHash, account: args.staker, amount: null };
        case 'Withdrawn':
            return { deviceIdHash: args.deviceIdHash, account: args.staker, amount: args.amount };
        case 'RewardsFunded':
            return { account: args.from, amount: args.amount };
        case 'AckRewarded':
        case 'ResolveRewarded':
            return { incidentKey: args.incidentKey, account: args.owner, amount: args.amount };
        case 'RewardSkipped':
            return { incidentKey: args.incidentKey, account: args.owner, amount: null };
        case 'MissedAckSlashed':
            return { incidentKey: args.incidentKey, deviceIdHash: args.deviceIdHash, account: args.keeper, amount: args.amount };
        case 'LateRelaySlashed':
            return { incidentKey: args.incidentKey, account: args.keeper, amount: args.amount };
        case 'BondExhausted':
            return { deviceIdHash: args.deviceIdHash };
        default:
            return {};
    }
}

export function createIncentivesIndexer({ db, chain, config, startBlock = 0, deploymentBlock = null, log = console }) {
    const contract = chain.address.toLowerCase();
    let deviceIds = new Map();
    const blockTimes = new Map();
    let constants = null;
    let stateRefreshedAt = 0;
    let stateDirty = true;
    let paramsBackfilled = deploymentBlock === null || startBlock <= deploymentBlock;

    async function resolveDeviceId(client, hash) {
        if (!hash || hash === OPERATOR_BOND_ID) return null;
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

    async function incidentByKey(client, incidentKey) {
        const { rows } = await client.query(
            `SELECT i.id, i.device_id, i.device_id_hash, i.incident_id
             FROM blockchain_outbox o JOIN incidents i ON i.id = o.incident_row_id
             WHERE o.incident_key = $1
             LIMIT 1`,
            [incidentKey]
        );
        return rows[0] ?? null;
    }

    async function markIncident(client, incidentRowId, effect) {
        const { rows } = await client.query(
            `INSERT INTO incident_incentives AS ii (contract, incident_row_id, flags, reward_status)
             VALUES ($1, $2, $3::smallint, COALESCE($4::text, 'none'))
             ON CONFLICT (contract, incident_row_id) DO UPDATE SET
                 flags = ii.flags | EXCLUDED.flags,
                 reward_status = CASE
                     WHEN $4::text IS NOT NULL
                          AND array_position($5::text[], $4::text) > array_position($5::text[], ii.reward_status)
                     THEN $4::text ELSE ii.reward_status END,
                 updated_at = NOW()
             RETURNING reward_status, flags AS incentive_flags`,
            [contract, incidentRowId, effect.flags, effect.status, REWARD_STATUS_RANK]
        );
        return rows[0] ?? null;
    }

    async function updateBond(client, name, hash, args, at, blockNumber) {
        const deviceId = await resolveDeviceId(client, hash);
        switch (name) {
            case 'Staked':
                await client.query(
                    `INSERT INTO device_bonds (contract, device_id_hash, device_id, staker, amount, since, updated_block)
                     VALUES ($1, $2, $3, $4, $5::numeric, $6, $7)
                     ON CONFLICT (contract, device_id_hash) DO UPDATE SET
                         device_id = COALESCE(EXCLUDED.device_id, device_bonds.device_id),
                         staker = EXCLUDED.staker,
                         amount = EXCLUDED.amount,
                         since = CASE WHEN device_bonds.amount = 0 THEN EXCLUDED.since ELSE device_bonds.since END,
                         unstake_requested_at = NULL,
                         unstake_available_at = NULL,
                         updated_block = EXCLUDED.updated_block,
                         updated_at = NOW()`,
                    // The operator bond belongs to `operator`, not to whoever topped it up.
                    [contract, hash, deviceId, hash === OPERATOR_BOND_ID ? null : args.staker, args.total, at, blockNumber]
                );
                break;
            case 'UnstakeRequested':
                await client.query(
                    `UPDATE device_bonds SET unstake_requested_at = $3, unstake_available_at = to_timestamp($4::double precision),
                            updated_block = $5, updated_at = NOW()
                     WHERE contract = $1 AND device_id_hash = $2`,
                    [contract, hash, at, Number(args.availableAt), blockNumber]
                );
                break;
            case 'Withdrawn':
                await client.query(
                    `UPDATE device_bonds SET amount = 0, staker = NULL, since = NULL, unstake_requested_at = NULL,
                            unstake_available_at = NULL, updated_block = $3, updated_at = NOW()
                     WHERE contract = $1 AND device_id_hash = $2`,
                    [contract, hash, blockNumber]
                );
                break;
            case 'MissedAckSlashed':
            case 'LateRelaySlashed':
                await client.query(
                    `UPDATE device_bonds SET amount = GREATEST(amount - $3::numeric, 0), updated_block = $4, updated_at = NOW()
                     WHERE contract = $1 AND device_id_hash = $2`,
                    [contract, hash, args.amount, blockNumber]
                );
                break;
            default:
                break;
        }
        return deviceId;
    }

    // Deadlines move with the params (the contract reads them at call time).
    async function recomputeDeadlines(client, params) {
        await client.query(
            `UPDATE incident_incentives ii
             SET ack_deadline_at = i.logged_at + (CASE WHEN i.severity = 1 THEN $1::bigint ELSE $2::bigint END) * INTERVAL '1 second',
                 resolve_deadline_at = i.logged_at + $3::bigint * INTERVAL '1 second',
                 updated_at = NOW()
             FROM incidents i
             WHERE ii.contract = $4 AND ii.incident_row_id = i.id AND ii.covered = TRUE AND i.logged_at IS NOT NULL`,
            [params.ackDeadlineWarning, params.ackDeadlineDanger, params.resolveDeadline, contract]
        );
    }

    async function apply(client, name, args, cols, entry, at) {
        let deviceId = null;
        let incident = null;
        let outcome = null;
        if (cols.incidentKey) {
            incident = await incidentByKey(client, cols.incidentKey);
            const effect = incidentEffect(name, args);
            if (incident && effect) outcome = await markIncident(client, incident.id, effect);
            deviceId = incident?.device_id ?? null;
        }
        switch (name) {
            case 'Staked':
            case 'UnstakeRequested':
            case 'Withdrawn':
            case 'MissedAckSlashed':
                deviceId = (await updateBond(client, name, args.deviceIdHash, args, at, entry.blockNumber)) ?? deviceId;
                break;
            case 'LateRelaySlashed':
                await updateBond(client, name, OPERATOR_BOND_ID, args, at, entry.blockNumber);
                break;
            case 'BondExhausted':
                deviceId = await resolveDeviceId(client, args.deviceIdHash);
                break;
            case 'ParamsUpdated':
                await recomputeDeadlines(client, args.params);
                break;
            default:
                break;
        }
        if (!deviceId) return;
        await createRealtimeEvent(client, {
            type: 'incentive.updated',
            deviceId,
            occurredAt: at,
            payload: {
                contract,
                event: name,
                incident_id: incident?.incident_id ?? null,
                incident_key: cols.incidentKey ?? null,
                account: cols.account ?? null,
                amount: cols.amount ?? null,
                reward_status: outcome?.reward_status ?? null,
                tx_hash: lower(entry.transactionHash),
                block_number: String(entry.blockNumber),
            },
            idempotencyKey: `incentive.updated:${contract}:${lower(entry.transactionHash)}:${entry.index}`,
        });
    }

    // Fills device_id_hash for incident events when the incident is not in the DB.
    async function deviceHashFor(client, cols) {
        if (cols.deviceIdHash) return cols.deviceIdHash;
        if (!cols.incidentKey) return null;
        const incident = await incidentByKey(client, cols.incidentKey);
        if (incident) return incident.device_id_hash;
        const settlement = await readSettlement(chain, cols.incidentKey);
        return settlement.exists ? settlement.deviceIdHash : null;
    }

    async function checkpoint() {
        const { rows } = await db.query('SELECT last_block FROM chain_checkpoints WHERE contract_address = $1', [contract]);
        return rows.length ? Number(rows[0].last_block) : startBlock - 1;
    }

    // Stores one parsed log; returns false when it was already stored.
    async function insertEvent(client, entry, parsed, args, cols, at) {
        const { rows } = await client.query(
            `INSERT INTO incentive_events (contract, tx_hash, log_index, block_number, block_hash, block_time, name,
                                           incident_key, device_id_hash, account, amount, data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric, $12::jsonb)
             ON CONFLICT (contract, tx_hash, log_index) DO NOTHING
             RETURNING id`,
            [
                contract,
                lower(entry.transactionHash),
                entry.index,
                entry.blockNumber,
                lower(entry.blockHash),
                at,
                parsed.name,
                cols.incidentKey ?? null,
                await deviceHashFor(client, cols),
                cols.account ?? null,
                cols.amount ?? null,
                JSON.stringify(args),
            ]
        );
        return rows.length > 0;
    }

    function parse(entry) {
        try {
            return chain.read.interface.parseLog(entry);
        } catch {
            return null;
        }
    }

    // startBlock after the deployment block skipped the constructor ParamsUpdated (and
    // any params change before startBlock). Index those, and only those, once, before
    // any other event, so keeper shares and deadlines always have their params.
    async function backfillParams() {
        if (paramsBackfilled) return;
        const { rows } = await db.query(
            `SELECT 1 FROM incentive_events WHERE contract = $1 AND name = 'ParamsUpdated' AND block_number <= $2 LIMIT 1`,
            [contract, deploymentBlock]
        );
        if (rows.length === 0) {
            const topic = chain.read.interface.getEvent('ParamsUpdated').topicHash;
            const logs = [];
            for (let from = deploymentBlock; from < startBlock; from += config.logBatchBlocks) {
                const to = Math.min(startBlock - 1, from + config.logBatchBlocks - 1);
                logs.push(...await chain.provider.getLogs({ address: chain.address, topics: [topic], fromBlock: from, toBlock: to }));
            }
            let stored = 0;
            await db.withTransaction(async (client) => {
                for (const entry of logs) {
                    const parsed = parse(entry);
                    if (parsed?.name !== 'ParamsUpdated') continue;
                    if (await insertEvent(client, entry, parsed, jsonArgs(parsed), {}, await blockTime(entry.blockNumber))) stored++;
                }
            });
            if (stored === 0) {
                throw new Error(`no ParamsUpdated found between deployment block ${deploymentBlock} and start block ${startBlock}`);
            }
            log.info({ from: deploymentBlock, to: startBlock - 1, stored }, 'initial incentive params backfilled');
        }
        paramsBackfilled = true;
    }

    // Processes at most one batch; returns the number of new events.
    async function tick() {
        await backfillParams();
        const head = await chain.provider.getBlockNumber();
        const safe = head - (config.confirmations - 1);
        const from = (await checkpoint()) + 1;
        if (from > safe) return 0;
        const to = Math.min(safe, from + config.logBatchBlocks - 1);
        const logs = await chain.provider.getLogs({ address: chain.address, fromBlock: from, toBlock: to });
        let applied = 0;
        await db.withTransaction(async (client) => {
            for (const entry of logs) {
                const parsed = parse(entry);
                if (!parsed) continue;
                const args = jsonArgs(parsed);
                if (parsed.name === 'RewardSkipped') args.reason_name = SKIP_REASONS[Number(args.reason)] ?? null;
                const cols = eventColumns(parsed.name, args);
                const at = await blockTime(entry.blockNumber);
                if (!(await insertEvent(client, entry, parsed, args, cols, at))) continue;
                await apply(client, parsed.name, args, cols, entry, at);
                applied++;
            }
            await client.query(
                `INSERT INTO chain_checkpoints (contract_address, last_block) VALUES ($1, $2)
                 ON CONFLICT (contract_address) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = NOW()`,
                [contract, to]
            );
        });
        if (applied) {
            stateDirty = true;
            log.info({ from, to, applied }, 'incentive events indexed');
        }
        return applied;
    }

    // Logged-on-chain incidents this deployment has not checked yet: coverage and deadlines
    // from its pendingSettlement(), plus the shared AirSafetyLog loggedAt. Pre-activation
    // incidents are marked once (covered = FALSE) and never re-read for this contract.
    async function syncIncidents(limit = config.batchSize) {
        const { rows } = await db.query(
            `SELECT i.id, o.incident_key
             FROM incidents i JOIN blockchain_outbox o ON o.incident_row_id = i.id
             WHERE o.status = 'confirmed' AND o.incident_key IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM incident_incentives ii
                   WHERE ii.contract = $2 AND ii.incident_row_id = i.id AND ii.covered IS NOT NULL
               )
             ORDER BY i.id
             LIMIT $1`,
            [limit, contract]
        );
        let synced = 0;
        for (const row of rows) {
            const s = await readSettlement(chain, row.incident_key);
            if (!s.exists) continue;
            await db.withTransaction(async (client) => {
                await client.query('UPDATE incidents SET logged_at = to_timestamp($2::double precision) WHERE id = $1', [row.id, s.loggedAt]);
                await client.query(
                    `INSERT INTO incident_incentives AS ii (contract, incident_row_id, covered, ack_deadline_at, resolve_deadline_at)
                     VALUES ($1, $2, $3, CASE WHEN $3 THEN to_timestamp($4::double precision) END,
                             CASE WHEN $3 THEN to_timestamp($5::double precision) END)
                     ON CONFLICT (contract, incident_row_id) DO UPDATE SET
                         covered = EXCLUDED.covered,
                         ack_deadline_at = EXCLUDED.ack_deadline_at,
                         resolve_deadline_at = EXCLUDED.resolve_deadline_at,
                         updated_at = NOW()`,
                    [contract, row.id, s.covered, s.ackDeadline, s.resolveDeadline]
                );
            });
            synced++;
        }
        return synced;
    }

    // Contract-wide snapshot for GET /api/incentives/params, read at one block.
    async function refreshState() {
        const block = await chain.provider.getBlock('latest');
        const at = { blockTag: block.number };
        if (!constants) {
            const [token, airSafetyLog, activatedAt] = await Promise.all([
                chain.read.token(),
                chain.read.airSafetyLog(),
                chain.read.activatedAt(),
            ]);
            constants = { token: lower(token), airSafetyLog: lower(airSafetyLog), activatedAt: Number(activatedAt) };
        }
        const [params, rewardFund, totalBonded, operator, operatorBond, treasury, currentDay] = await Promise.all([
            chain.read.params(at),
            chain.read.rewardFund(at),
            chain.read.totalBonded(at),
            chain.read.operator(at),
            chain.read.operatorBond(at),
            chain.read.treasury(at),
            chain.read.currentDay(at),
        ]);
        await db.query(
            `INSERT INTO incentive_state (contract, token, air_safety_log, treasury, operator, params, reward_fund, total_bonded,
                                          operator_bond, activated_at, current_day, block_number, block_time)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::numeric, $8::numeric, $9::jsonb, to_timestamp($10::double precision),
                     $11, $12, to_timestamp($13::double precision))
             ON CONFLICT (contract) DO UPDATE SET
                 token = EXCLUDED.token, air_safety_log = EXCLUDED.air_safety_log, treasury = EXCLUDED.treasury,
                 operator = EXCLUDED.operator, params = EXCLUDED.params, reward_fund = EXCLUDED.reward_fund,
                 total_bonded = EXCLUDED.total_bonded, operator_bond = EXCLUDED.operator_bond,
                 activated_at = EXCLUDED.activated_at, current_day = EXCLUDED.current_day,
                 block_number = EXCLUDED.block_number, block_time = EXCLUDED.block_time, updated_at = NOW()`,
            [
                contract,
                constants.token,
                constants.airSafetyLog,
                lower(treasury),
                lower(operator),
                JSON.stringify(formatParams(params)),
                rewardFund.toString(),
                totalBonded.toString(),
                JSON.stringify(bondPayload(operatorBond)),
                constants.activatedAt,
                Number(currentDay),
                block.number,
                Number(block.timestamp),
            ]
        );
        stateRefreshedAt = Date.now();
        stateDirty = false;
    }

    // Runs batches until caught up with the safe head, then syncs new incidents and
    // refreshes the snapshot when something changed or it is older than stateRefreshMs.
    async function catchUp() {
        let total = 0;
        for (;;) {
            const before = await checkpoint();
            total += await tick();
            if ((await checkpoint()) === before) break;
        }
        const synced = await syncIncidents();
        if (stateDirty || synced || Date.now() - stateRefreshedAt >= (config.stateRefreshMs ?? 60_000)) {
            await refreshState();
        }
        return total;
    }

    return { tick, catchUp, syncIncidents, refreshState };
}
