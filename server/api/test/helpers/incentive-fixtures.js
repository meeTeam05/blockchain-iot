// Fixtures for the Task 7 incentives tests: chain-confirmed incident rows in PGlite and a
// scriptable SafetyIncentives double built on the real ABI (events, errors, structs).
import { Interface } from 'ethers';

import { SAFETY_INCENTIVES_ABI } from '../../src/generated/incentives-deployments.js';
import { computeIncidentKey } from '../../src/services/incident-intake.js';
import { computeDeviceIdHash, computeIncidentId } from '../../src/services/incident-verify.js';
import { DEVICE_ID } from './incident-fixtures.js';

export const INCENTIVES_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
export const TOKEN_ADDRESS = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
export const LOG_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
export const OWNER = '0x90f79bf6eb2c4f870365e785982e1f101e93b906';
export const KEEPER = '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65';
export const OPERATOR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
export const ASAFE = 10n ** 18n;
export const iface = new Interface(SAFETY_INCENTIVES_ABI);

export const silentLog = { info() {}, warn() {}, error() {} };

export const DEFAULT_PARAMS = Object.freeze({
    ackDeadlineWarning: 1800n,
    ackDeadlineDanger: 600n,
    resolveDeadline: 86_400n,
    ownerBond: 100n * ASAFE,
    ackReward: 5n * ASAFE,
    resolveReward: 5n * ASAFE,
    missedAckPenalty: 20n * ASAFE,
    maxRelayDelay: 900n,
    lateRelayPenalty: 20n * ASAFE,
    keeperShareBps: 5000n,
    dailyRewardCap: 3n,
    unstakeCooldown: 604_800n,
});

function iso(seconds) {
    return seconds === null || seconds === undefined ? null : new Date(seconds * 1000);
}

// An incident already logged on chain (outbox confirmed) with its incentive columns.
// Times are unix seconds.
export async function insertChainIncident(store, {
    deviceId = DEVICE_ID,
    sequence,
    severity = 1,
    observedAt,
    loggedAt = observedAt + 60,
    ownerStatus = 'open',
    acknowledgedAt = null,
    resolvedAt = null,
    covered = true,
    ackDeadline = loggedAt + (severity === 1 ? 1800 : 600),
    resolveDeadline = loggedAt + 86_400,
    flags = 0,
    rewardStatus = 'none',
    outboxStatus = 'confirmed',
} = {}) {
    const hash = computeDeviceIdHash(deviceId);
    const incidentId = computeIncidentId(hash, String(sequence));
    const key = computeIncidentKey(hash, incidentId);
    const bytes = `0x${'1'.repeat(64)}`;
    const { rows: [row] } = await store.query(
        `INSERT INTO incidents (device_id, schema_version, device_id_hash, incident_id, sequence, observed_at, time_source,
             sensor_valid_mask, detection_method, temperature_c_x100, humidity_pct_x100, co_ppm_x1000, no2_ppm_x1000,
             overall_level, co_level, no2_level, co_alarm_source_mask, no2_alarm_source_mask, derived_valid_mask,
             co_stel15_ppm_x1000, no2_stel15_ppm_x1000, co_twa8h_ppm_x1000, no2_twa8h_ppm_x1000, co_proj10_ppm_x1000,
             no2_proj10_ppm_x1000, model_probability_valid_mask, co_model_probability_bps, no2_model_probability_bps,
             incident_kind, severity, firmware_version_hash, model_sha256, calibration_revision, calibration_hash,
             firmware_version, evidence_hash, eip712_digest, signature, signer_address, domain_name, domain_version,
             domain_chain_id, domain_verifying_contract, raw_payload, payload, observed_at_ts, received_at,
             owner_status, acknowledged_at, resolved_at, incentive_covered, logged_at, ack_deadline_at,
             resolve_deadline_at, incentive_flags, reward_status)
         VALUES ($1, 2, $2, $3, $4, $5, 1, 15, 2, 2500, 6000, 52000, 100, $6, $6, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                 $6, $6, $7, $7, 1, $7, 'fw', $7, $7, $8, $9, 'AirSafetyLog', '1', 11155111, $10, '\\x00', '{}',
                 $11, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         RETURNING id`,
        [
            deviceId, hash, incidentId, sequence, observedAt, severity, bytes, `0x${'2'.repeat(130)}`,
            '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', LOG_ADDRESS.toLowerCase(), iso(observedAt),
            ownerStatus, iso(acknowledgedAt), iso(resolvedAt), covered,
            covered === null ? null : iso(loggedAt),
            covered ? iso(ackDeadline) : null,
            covered ? iso(resolveDeadline) : null,
            flags, rewardStatus,
        ]
    );
    await store.query(
        `INSERT INTO blockchain_outbox (incident_row_id, device_id, incident_id, sequence, status, incident_key, tx_hash, confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [row.id, deviceId, incidentId, sequence, outboxStatus, key, `0x${sequence.toString(16).padStart(64, 'a')}`]
    );
    return { id: row.id, key, incidentId, hash, sequence, severity, observedAt, loggedAt, ackDeadline, resolveDeadline };
}

// pendingSettlement() result for an inserted incident, as readSettlement() returns it.
export function settlementFor(incident, overrides = {}) {
    return {
        exists: true,
        covered: true,
        deviceIdHash: incident.hash,
        severity: incident.severity,
        status: 1,
        observedAt: incident.observedAt,
        loggedAt: incident.loggedAt,
        ackDeadline: incident.ackDeadline,
        resolveDeadline: incident.resolveDeadline,
        relayDelay: incident.loggedAt - incident.observedAt,
        flags: 0,
        canRecordAck: false,
        canRecordResolve: false,
        canSlashMissedAck: false,
        canSlashLateRelay: false,
        ...overrides,
    };
}

// Revert error shaped like ethers' CALL_EXCEPTION (decodeRevert reads `data`).
export function revertError(name, args) {
    const err = new Error(`execution reverted: ${name}`);
    err.code = 'CALL_EXCEPTION';
    err.data = iface.encodeErrorResult(name, args);
    return err;
}

function settlementStruct(s) {
    return {
        ...s,
        severity: BigInt(s.severity),
        status: BigInt(s.status),
        observedAt: BigInt(s.observedAt),
        loggedAt: BigInt(s.loggedAt),
        ackDeadline: BigInt(s.ackDeadline),
        resolveDeadline: BigInt(s.resolveDeadline),
        relayDelay: BigInt(s.relayDelay),
        flags: BigInt(s.flags),
    };
}

// Scriptable stand-in for an incentives chain context (createIncentivesContext shape).
// settlements: Map incidentKey -> settlement (see settlementFor); bonds: Map deviceIdHash ->
// { amount, since }; calls: rule calls that reached "send"; reverts: Map key -> Error for staticCall.
export function createFakeIncentivesChain({ now, head = 100 } = {}) {
    const state = {
        now,
        head,
        settlements: new Map(),
        bonds: new Map(),
        reverts: new Map(),
        sendErrors: new Map(),
        calls: [],
        receipts: new Map(),
        mempool: new Set(),
        logs: [],
        blocks: new Map(),
        params: { ...DEFAULT_PARAMS },
        operatorBond: 1_000n * ASAFE,
        rpcError: null,
    };
    let txCount = 0;

    function rule(method) {
        const fn = async (key) => {
            if (state.sendErrors.has(key)) throw state.sendErrors.get(key);
            const hash = `0x${(++txCount).toString(16).padStart(64, '0')}`;
            state.calls.push({ method, key, hash });
            state.mempool.add(hash);
            return { hash };
        };
        fn.staticCall = async (key) => {
            if (state.reverts.has(key)) throw state.reverts.get(key);
        };
        return fn;
    }

    const read = {
        interface: iface,
        async pendingSettlement(key) {
            if (state.rpcError) throw state.rpcError;
            const s = state.settlements.get(key);
            if (!s) {
                return settlementStruct({
                    exists: false, covered: false, deviceIdHash: `0x${'0'.repeat(64)}`, severity: 0, status: 0, observedAt: 0,
                    loggedAt: 0, ackDeadline: 0, resolveDeadline: 0, relayDelay: 0, flags: 0, canRecordAck: false,
                    canRecordResolve: false, canSlashMissedAck: false, canSlashLateRelay: false,
                });
            }
            return settlementStruct(s);
        },
        async deviceBond(hash) {
            const bond = state.bonds.get(hash) ?? { amount: 0n, since: 0 };
            return { staker: OWNER, amount: bond.amount, since: BigInt(bond.since), unstakeRequestedAt: 0n };
        },
        async operator() { return OPERATOR; },
        async token() { return TOKEN_ADDRESS; },
        async airSafetyLog() { return LOG_ADDRESS; },
        async activatedAt() { return 1_700_000_000n; },
        async params() { return state.params; },
        async rewardFund() { return 50_000n * ASAFE; },
        async totalBonded() { return 1_100n * ASAFE; },
        async operatorBond() { return { staker: '0x0000000000000000000000000000000000000000', amount: state.operatorBond, since: 0n, unstakeRequestedAt: 0n }; },
        async treasury() { return '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; },
        async currentDay() { return BigInt(Math.floor(state.now / 86_400)); },
    };
    const keeper = {
        recordTimelyAck: rule('recordTimelyAck'),
        recordTimelyResolve: rule('recordTimelyResolve'),
        slashMissedAck: rule('slashMissedAck'),
        slashLateRelay: rule('slashLateRelay'),
    };
    const provider = {
        async getBlock(tag) {
            if (tag === 'latest') return { number: state.head, timestamp: state.now };
            return { number: tag, timestamp: state.blocks.get(tag) ?? state.now };
        },
        async getBlockNumber() { return state.head; },
        async getTransactionReceipt(hash) { return state.receipts.get(hash) ?? null; },
        async getTransaction(hash) { return state.mempool.has(hash) ? { hash } : null; },
        async getLogs({ fromBlock, toBlock }) {
            return state.logs.filter((entry) => entry.blockNumber >= fromBlock && entry.blockNumber <= toBlock);
        },
    };
    return {
        state,
        chain: { address: INCENTIVES_ADDRESS, provider, read, keeper, keeperWallet: { address: KEEPER } },
        // Appends an encoded SafetyIncentives event at `blockNumber` (block time `time`).
        emit(name, values, { blockNumber, time = state.now, txHash } = {}) {
            const fragment = iface.getEvent(name);
            const { data, topics } = iface.encodeEventLog(fragment, values);
            const index = state.logs.filter((entry) => entry.blockNumber === blockNumber).length;
            state.blocks.set(blockNumber, time);
            state.logs.push({
                address: INCENTIVES_ADDRESS,
                topics,
                data,
                blockNumber,
                blockHash: `0x${blockNumber.toString(16).padStart(64, 'b')}`,
                transactionHash: txHash ?? `0x${(state.logs.length + 1).toString(16).padStart(64, 'c')}`,
                index,
            });
        },
        mine(hash, { status = 1, blockNumber = state.head } = {}) {
            state.mempool.delete(hash);
            state.receipts.set(hash, { hash, status, blockNumber });
        },
    };
}
