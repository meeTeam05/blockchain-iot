// Read side of the token incentives (Task5_8_plan.md, Task 7). Everything here comes from
// tables the chain worker projects from SafetyIncentives (migration 020); the API needs
// no RPC connection. Token amounts are wei decimal strings (ASAFE has 18 decimals),
// durations are seconds as decimal strings, times are ISO strings.
import { SETTLEMENT_FLAGS } from '../chain/incentives.js';
import { incidentEffect, REWARD_STATUS_RANK } from '../chain/incentives-indexer.js';
import { config } from '../config.js';
import { INCENTIVES_DEPLOYMENTS } from '../generated/incentives-deployments.js';
import { computeDeviceIdHash } from './incident-verify.js';

const BPS = 10_000n;
// Web3_task.md risk table: warn when the reward fund drops below 1 000 ASAFE.
export const LOW_FUND_WEI = 1_000n * 10n ** 18n;

// Events that belong to a device's history (B7 wallet page, B9 incident labels).
const DEVICE_EVENTS = Object.freeze([
    'Staked',
    'UnstakeRequested',
    'Withdrawn',
    'AckRewarded',
    'ResolveRewarded',
    'RewardSkipped',
    'MissedAckSlashed',
    'LateRelaySlashed',
    'BondExhausted',
]);

function isoOrNull(value) {
    return value ? new Date(value).toISOString() : null;
}

function str(value) {
    return value === null || value === undefined ? null : String(value);
}

function minBig(a, b) {
    return a < b ? a : b;
}

export function decodeFlags(flags) {
    const value = Number(flags ?? 0);
    return {
        timely_ack: (value & SETTLEMENT_FLAGS.TIMELY_ACK) !== 0,
        ack_rewarded: (value & SETTLEMENT_FLAGS.ACK_REWARDED) !== 0,
        resolve_settled: (value & SETTLEMENT_FLAGS.RESOLVE_SETTLED) !== 0,
        ack_slashed: (value & SETTLEMENT_FLAGS.ACK_SLASHED) !== 0,
        relay_slashed: (value & SETTLEMENT_FLAGS.RELAY_SLASHED) !== 0,
    };
}

export function formatIncentiveEvent(row) {
    return {
        id: String(row.id),
        name: row.name,
        incident_key: row.incident_key ?? null,
        incident_id: row.incident_id ?? null,
        account: row.account ?? null,
        amount: str(row.amount),
        data: row.data ?? {},
        tx_hash: row.tx_hash,
        log_index: row.log_index,
        block_number: String(row.block_number),
        block_time: isoOrNull(row.block_time),
    };
}

// Only the deployment selected for this process may supply API data. Older contract
// snapshots remain in the DB after a deployment change, and the whole feature is off
// (every incentives answer is "not available") while INCENTIVES_ENABLED is not true, even
// when a snapshot from an earlier enabled run is still in the DB. An explicit
// `incentivesContractAddress` decoration (tests, local harness) selects one deployment.
export function activeContract(fastify) {
    if (fastify.incentivesContractAddress !== undefined) return fastify.incentivesContractAddress?.toLowerCase() ?? null;
    if (!config.incentives.enabled) return null;
    return INCENTIVES_DEPLOYMENTS[config.incentives.deployment]?.incentives.address?.toLowerCase() ?? null;
}

export async function getIncentiveState(fastify) {
    const contract = activeContract(fastify);
    if (!contract) return null;
    const { rows } = await fastify.db.query('SELECT * FROM incentive_state WHERE contract = $1', [contract]);
    return rows[0] ?? null;
}

// UTC day index of the chain (block.timestamp / 1 days), as the daily cap counts it.
function chainDay(state) {
    return state ? Number(state.current_day) : Math.floor(Date.now() / 86_400_000);
}

// "now" for deadline comparisons: chain time can run ahead of the wall clock (hardhat).
function chainNow(state) {
    const wall = Date.now();
    const block = state ? new Date(state.block_time).getTime() : 0;
    return new Date(Math.max(wall, block));
}

function bounty(penalty, available, state) {
    const taken = minBig(penalty, available);
    return (taken * BigInt(state.params.keeper_share_bps)) / BPS;
}

// `incentive` block of GET /api/devices/:id/incidents/:incidentId (row from getIncidentRow).
// null while incentives are disabled or the configured deployment is not indexed yet.
export async function getIncidentIncentive(fastify, row) {
    const state = await getIncentiveState(fastify);
    if (!state) return null;
    const covered = row.logged_at ? new Date(row.logged_at) >= new Date(state.activated_at) : null;
    const events = covered && row.chain_incident_key
        ? (await fastify.db.query(
            `SELECT * FROM incentive_events WHERE contract = $1 AND incident_key = $2 ORDER BY block_number, log_index`,
            [state.contract, row.chain_incident_key]
        )).rows
        : [];
    // The legacy incident projection has no contract key. Reconstruct settlement
    // from this deployment's events rather than trusting its shared flags/status.
    let flags = 0;
    let status = 'none';
    for (const event of events) {
        const effect = incidentEffect(event.name, event.data);
        if (!effect) continue;
        flags |= effect.flags;
        if (REWARD_STATUS_RANK.indexOf(effect.status) > REWARD_STATUS_RANK.indexOf(status)) status = effect.status;
    }
    const loggedAt = row.logged_at ? new Date(row.logged_at).getTime() : 0;
    const ackSeconds = state.params[Number(row.severity) === 1 ? 'ack_deadline_warning' : 'ack_deadline_danger'];
    return {
        incident_key: row.chain_incident_key ?? null,
        covered,
        logged_at: isoOrNull(row.logged_at),
        deadline_at: covered ? isoOrNull(loggedAt + Number(ackSeconds) * 1000) : null,
        resolve_deadline_at: covered ? isoOrNull(loggedAt + Number(state.params.resolve_deadline) * 1000) : null,
        reward_status: status,
        flags: decodeFlags(flags),
        events: events.map(formatIncentiveEvent),
    };
}

// GET /api/devices/:id/incentives: bond, today's reward count and reward/penalty history.
// null (404) while incentives are disabled or not indexed, like the public routes.
export async function getDeviceIncentives(fastify, deviceId, { limit = 50, beforeId = null } = {}) {
    const state = await getIncentiveState(fastify);
    if (!state) return null;
    const hash = computeDeviceIdHash(deviceId);
    const contract = state.contract;

    const { rows: bonds } = await fastify.db.query(
        'SELECT * FROM device_bonds WHERE contract = $1 AND device_id_hash = $2',
        [contract, hash]
    );
    const { rows: events } = await fastify.db.query(
        `SELECT e.*, i.incident_id
         FROM incentive_events e
         LEFT JOIN blockchain_outbox o ON o.incident_key = e.incident_key
         LEFT JOIN incidents i ON i.id = o.incident_row_id
         WHERE e.contract = $1 AND e.device_id_hash = $2 AND e.name = ANY($3::text[])
           AND ($4::bigint IS NULL OR e.id < $4::bigint)
         ORDER BY e.id DESC
         LIMIT $5`,
        [contract, hash, DEVICE_EVENTS, beforeId, limit]
    );
    const day = chainDay(state);
    const { rows: [counts] } = await fastify.db.query(
        `SELECT
             COUNT(*) FILTER (WHERE name = 'AckRewarded'
                              AND FLOOR(EXTRACT(EPOCH FROM block_time) / 86400) = $3)::int AS rewards_today,
             COALESCE(SUM(amount) FILTER (WHERE name IN ('AckRewarded', 'ResolveRewarded')), 0)::text AS rewarded,
             COALESCE(SUM(amount) FILTER (WHERE name = 'MissedAckSlashed'), 0)::text AS slashed
         FROM incentive_events
         WHERE contract = $1 AND device_id_hash = $2`,
        [contract, hash, day]
    );

    const bond = bonds[0] && BigInt(bonds[0].amount) > 0n ? bonds[0] : null;
    const params = state.params;
    const cap = params.daily_reward_cap;
    const warnings = [];
    {
        if (!bond) warnings.push('no_bond');
        else if (BigInt(bond.amount) < BigInt(params.owner_bond)) warnings.push('bond_below_owner_bond');
        if (bond && BigInt(bond.amount) < BigInt(params.missed_ack_penalty)) warnings.push('bond_cannot_cover_penalty');
        if (bond?.unstake_requested_at) warnings.push('unstake_pending');
        if (cap !== null && counts.rewards_today >= cap) warnings.push('daily_cap_reached');
    }

    return {
        device_id: deviceId,
        device_id_hash: hash,
        enabled: true,
        contract,
        bond: bond
            ? {
                staker: bond.staker,
                amount: String(bond.amount),
                since: isoOrNull(bond.since),
                unstake_requested_at: isoOrNull(bond.unstake_requested_at),
                unstake_available_at: isoOrNull(bond.unstake_available_at),
                updated_block: String(bond.updated_block),
            }
            : null,
        rewards_today: { day, count: counts.rewards_today, cap },
        totals: { rewarded: counts.rewarded, slashed: counts.slashed },
        params: {
            owner_bond: params.owner_bond,
            missed_ack_penalty: params.missed_ack_penalty,
            ack_reward: params.ack_reward,
            resolve_reward: params.resolve_reward,
            daily_reward_cap: params.daily_reward_cap,
            unstake_cooldown: params.unstake_cooldown,
        },
        warnings,
        events: events.map(formatIncentiveEvent),
    };
}

// GET /api/incentives/overdue: what an outside keeper can call right now. Public, so it
// carries only on-chain facts (keys, deadlines, severity, amounts) and never a device id
// or a measurement.
export async function listOverdue(fastify, { limit = 100 } = {}) {
    const state = await getIncentiveState(fastify);
    if (!state) return null;
    const now = chainNow(state);
    const params = state.params;

    const { rows: missed } = await fastify.db.query(
        `SELECT o.incident_key, i.device_id_hash, i.severity, i.logged_at, deadline.ack_deadline_at, i.owner_status,
                b.amount AS bond_amount, b.since AS bond_since
         FROM incidents i
         JOIN blockchain_outbox o ON o.incident_row_id = i.id
         LEFT JOIN device_bonds b ON b.contract = $1 AND b.device_id_hash = i.device_id_hash
         CROSS JOIN LATERAL (
             SELECT i.logged_at + (CASE WHEN i.severity = 1 THEN $5::bigint ELSE $6::bigint END)
                    * INTERVAL '1 second' AS ack_deadline_at
         ) deadline
         WHERE o.status = 'confirmed' AND o.incident_key IS NOT NULL
           AND i.logged_at >= $4
           AND NOT EXISTS (
               SELECT 1 FROM incentive_events e WHERE e.contract = $1 AND e.incident_key = o.incident_key
                 AND (e.name IN ('AckRewarded', 'MissedAckSlashed')
                      OR (e.name = 'RewardSkipped' AND e.data->>'rule' = '1'))
           )
           AND deadline.ack_deadline_at < $2
         ORDER BY deadline.ack_deadline_at
         LIMIT $3`,
        [state.contract, now, limit, state.activated_at, params.ack_deadline_warning, params.ack_deadline_danger]
    );
    const { rows: late } = await fastify.db.query(
        `SELECT o.incident_key, i.device_id_hash, i.severity, i.observed_at, i.logged_at,
                (EXTRACT(EPOCH FROM i.logged_at)::bigint - i.observed_at)::bigint AS relay_delay
         FROM incidents i
         JOIN blockchain_outbox o ON o.incident_row_id = i.id
         WHERE o.status = 'confirmed' AND o.incident_key IS NOT NULL
           AND i.logged_at >= $3
           AND NOT EXISTS (
               SELECT 1 FROM incentive_events e WHERE e.contract = $4 AND e.incident_key = o.incident_key
                 AND e.name = 'LateRelaySlashed'
           )
           AND i.logged_at IS NOT NULL
           AND EXTRACT(EPOCH FROM i.logged_at)::bigint - i.observed_at > $1::bigint
         ORDER BY i.logged_at
         LIMIT $2`,
        [params.max_relay_delay, limit, state.activated_at, state.contract]
    );

    const missedPenalty = BigInt(params.missed_ack_penalty);
    const latePenalty = BigInt(params.late_relay_penalty);
    const operatorBond = BigInt(state.operator_bond.amount);
    return {
        as_of: now.toISOString(),
        contract: state.contract,
        keeper_share_bps: params.keeper_share_bps,
        slash_missed_ack: missed.map((row) => {
            const covering = row.bond_amount !== null
                && (!row.bond_since || new Date(row.bond_since) <= new Date(row.logged_at));
            const available = covering ? BigInt(row.bond_amount) : 0n;
            return {
                incident_key: row.incident_key,
                device_id_hash: row.device_id_hash,
                severity: Number(row.severity),
                owner_acknowledged_late: row.owner_status !== 'open',
                logged_at: isoOrNull(row.logged_at),
                deadline_at: isoOrNull(row.ack_deadline_at),
                penalty: missedPenalty.toString(),
                bond_available: available.toString(),
                bounty: bounty(missedPenalty, available, state).toString(),
            };
        }),
        slash_late_relay: late.map((row) => ({
            incident_key: row.incident_key,
            device_id_hash: row.device_id_hash,
            severity: Number(row.severity),
            observed_at: isoOrNull(new Date(Number(row.observed_at) * 1000)),
            logged_at: isoOrNull(row.logged_at),
            relay_delay_seconds: String(row.relay_delay),
            max_relay_delay: params.max_relay_delay,
            penalty: latePenalty.toString(),
            bond_available: operatorBond.toString(),
            bounty: bounty(latePenalty, operatorBond, state).toString(),
        })),
    };
}

// GET /api/incentives/params: B11 read-only params, reward fund and operator bond.
export async function getIncentiveParams(fastify, { historyLimit = 20 } = {}) {
    const state = await getIncentiveState(fastify);
    if (!state) return null;
    const { rows: history } = await fastify.db.query(
        `SELECT * FROM incentive_events WHERE contract = $1 AND name = 'ParamsUpdated' ORDER BY id DESC LIMIT $2`,
        [state.contract, historyLimit]
    );
    const fund = BigInt(state.reward_fund);
    return {
        contract: state.contract,
        token: state.token,
        air_safety_log: state.air_safety_log,
        treasury: state.treasury,
        operator: state.operator,
        activated_at: isoOrNull(state.activated_at),
        params: state.params,
        reward_fund: fund.toString(),
        low_reward_fund: fund < LOW_FUND_WEI,
        total_bonded: String(state.total_bonded),
        operator_bond: {
            amount: state.operator_bond.amount,
            unstake_requested_at: state.operator_bond.unstake_requested_at === '0'
                ? null
                : isoOrNull(new Date(Number(state.operator_bond.unstake_requested_at) * 1000)),
        },
        current_day: Number(state.current_day),
        block_number: String(state.block_number),
        block_time: isoOrNull(state.block_time),
        updated_at: isoOrNull(state.updated_at),
        params_history: history.map(formatIncentiveEvent),
    };
}

// GET /api/incentives/leaderboard (Token_incentive_task.md): owners by rewards earned and
// keepers by bounty actually received. Addresses only; never device ids.
// Each slash pays floor(amount * keeperShareBps / 10000) with the keeperShareBps of the
// latest ParamsUpdated at or before it, as the contract does. The indexer backfills the
// constructor ParamsUpdated even when INCENTIVES_START_BLOCK is later, so a slash always
// has one; should it not, the slash is still listed (count and unpriced_slashes), never dropped.
export async function getLeaderboard(fastify, { limit = 10 } = {}) {
    const state = await getIncentiveState(fastify);
    if (!state) return null;
    const { rows: owners } = await fastify.db.query(
        `SELECT account, SUM(amount)::text AS rewarded, COUNT(*)::int AS rewards
         FROM incentive_events
         WHERE contract = $1 AND name IN ('AckRewarded', 'ResolveRewarded')
         GROUP BY account
         ORDER BY SUM(amount) DESC, account
         LIMIT $2`,
        [state.contract, limit]
    );
    const { rows: keepers } = await fastify.db.query(
        `SELECT e.account,
                COALESCE(SUM(FLOOR(e.amount * (p.data->'params'->>'keeperShareBps')::numeric / 10000)), 0)::text AS slashed,
                COUNT(*)::int AS slashes,
                COUNT(*) FILTER (WHERE p.data IS NULL)::int AS unpriced_slashes
         FROM incentive_events e
         LEFT JOIN LATERAL (
             SELECT data FROM incentive_events p
             WHERE p.contract = e.contract AND p.name = 'ParamsUpdated'
               AND (p.block_number, p.log_index) <= (e.block_number, e.log_index)
             ORDER BY p.block_number DESC, p.log_index DESC LIMIT 1
         ) p ON TRUE
         WHERE e.contract = $1 AND e.name IN ('MissedAckSlashed', 'LateRelaySlashed') AND e.amount > 0
         GROUP BY e.account
         ORDER BY COALESCE(SUM(FLOOR(e.amount * (p.data->'params'->>'keeperShareBps')::numeric / 10000)), 0) DESC, e.account
         LIMIT $2`,
        [state.contract, limit]
    );
    return { contract: state.contract, owners, keepers };
}
