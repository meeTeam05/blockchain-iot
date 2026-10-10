// SafetyIncentives / AirSafeToken bindings for the chain worker.
// The incentives contracts only read AirSafetyLog; the deployment record comes from
// blockchain/deployments/<network>.incentives.json through the generated module.
import { Contract, Wallet, getAddress } from 'ethers';

import { AIR_SAFE_TOKEN_ABI, INCENTIVES_DEPLOYMENTS, SAFETY_INCENTIVES_ABI } from '../generated/incentives-deployments.js';
import { ChainFatalError } from './air-safety-log.js';

// SafetyIncentives.settlementFlags bits.
export const SETTLEMENT_FLAGS = Object.freeze({
    TIMELY_ACK: 1,
    ACK_REWARDED: 2,
    RESOLVE_SETTLED: 4,
    ACK_SLASHED: 8,
    RELAY_SLASHED: 16,
});

// deviceIdHash used by bond events for the operator bond.
export const OPERATOR_BOND_ID = `0x${'0'.repeat(64)}`;

// SafetyIncentives.SkipReason, by enum index.
export const SKIP_REASONS = Object.freeze(['DailyCap', 'InsufficientFund', 'NoBond', 'AckNotRewarded']);

export const RULE_ACK = 1;
export const RULE_RESOLVE = 2;

// Below this the keeper still runs but warns.
export const KEEPER_LOW_BALANCE_WEI = 2_000_000_000_000_000n; // 0.002 ETH

// Params struct field -> API key. Durations and amounts are uint64/uint128 and are
// reported as decimal strings; the two small fields as numbers.
const PARAM_FIELDS = Object.freeze([
    ['ackDeadlineWarning', 'ack_deadline_warning'],
    ['ackDeadlineDanger', 'ack_deadline_danger'],
    ['resolveDeadline', 'resolve_deadline'],
    ['ownerBond', 'owner_bond'],
    ['ackReward', 'ack_reward'],
    ['resolveReward', 'resolve_reward'],
    ['missedAckPenalty', 'missed_ack_penalty'],
    ['maxRelayDelay', 'max_relay_delay'],
    ['lateRelayPenalty', 'late_relay_penalty'],
    ['keeperShareBps', 'keeper_share_bps'],
    ['dailyRewardCap', 'daily_reward_cap'],
    ['unstakeCooldown', 'unstake_cooldown'],
]);
const NUMERIC_PARAMS = new Set(['keeper_share_bps', 'daily_reward_cap']);

export function formatParams(params) {
    const out = {};
    for (const [field, key] of PARAM_FIELDS) {
        const value = params[field];
        out[key] = NUMERIC_PARAMS.has(key) ? Number(value) : String(value);
    }
    return out;
}

// Picks the incentives deployment of the same network as the AirSafetyLog the worker uses.
export function resolveIncentivesDeployment(name, airSafetyLogAddress, deployments = INCENTIVES_DEPLOYMENTS) {
    if (!name) {
        throw new ChainFatalError('INCENTIVES_ENABLED=true needs INCENTIVES_DEPLOYMENT (or INCIDENT_DEPLOYMENT)');
    }
    const deployment = deployments[name];
    if (!deployment) {
        throw new ChainFatalError(
            `no blockchain/deployments/${name}.incentives.json (known: ${Object.keys(deployments).join(', ') || 'none'})`
        );
    }
    if (getAddress(deployment.airSafetyLog) !== getAddress(airSafetyLogAddress)) {
        throw new ChainFatalError(
            `${name} incentives read AirSafetyLog ${deployment.airSafetyLog}, but the worker uses ${airSafetyLogAddress}`
        );
    }
    return deployment;
}

// read: views and event parsing; keeper: rule calls (only with KEEPER_PRIVATE_KEY).
export function createIncentivesContext({ provider, address, tokenAddress = null, keeperPrivateKey = '' }) {
    const read = new Contract(getAddress(address), SAFETY_INCENTIVES_ABI, provider);
    const keeperWallet = keeperPrivateKey ? new Wallet(keeperPrivateKey, provider) : null;
    return {
        provider,
        address: getAddress(address),
        tokenAddress: tokenAddress ? getAddress(tokenAddress) : null,
        read,
        token: tokenAddress ? new Contract(getAddress(tokenAddress), AIR_SAFE_TOKEN_ABI, provider) : null,
        keeperWallet,
        keeper: keeperWallet ? read.connect(keeperWallet) : null,
    };
}

// Refuses an address that is not a SafetyIncentives wired to this AirSafetyLog/token.
export async function assertIncentivesContract(ctx, airSafetyLogAddress) {
    const code = await ctx.provider.getCode(ctx.address);
    if (!code || code === '0x') throw new ChainFatalError(`no contract deployed at ${ctx.address}`);
    const log = getAddress(await ctx.read.airSafetyLog());
    if (log !== getAddress(airSafetyLogAddress)) {
        throw new ChainFatalError(`SafetyIncentives ${ctx.address} reads AirSafetyLog ${log}, expected ${airSafetyLogAddress}`);
    }
    if (ctx.tokenAddress) {
        const token = getAddress(await ctx.read.token());
        if (token !== ctx.tokenAddress) {
            throw new ChainFatalError(`SafetyIncentives ${ctx.address} uses token ${token}, expected ${ctx.tokenAddress}`);
        }
    }
}

// Names of the other worker wallets the keeper wallet collides with.
export function keeperWalletClashes(keeper, { relayer = null, manager = null, operator = null } = {}) {
    const self = getAddress(keeper);
    return [['relayer', relayer], ['device manager', manager], ['incentives operator', operator]]
        .filter(([, address]) => address && getAddress(address) === self)
        .map(([name]) => name);
}

// The keeper must not share a wallet (and nonce) with the relayer or manager, and must
// not be the operator (no self-slashing or self-paid bounties). It needs ETH for gas.
export async function assertKeeperWallet(ctx, { relayer = null, manager = null, requireBalance = true } = {}) {
    const keeper = ctx.keeperWallet?.address;
    if (!keeper) throw new ChainFatalError('KEEPER_PRIVATE_KEY is required when KEEPER_ENABLED=true');
    const operator = await ctx.read.operator();
    const clashes = keeperWalletClashes(keeper, { relayer, manager, operator });
    if (clashes.length) {
        throw new ChainFatalError(`keeper wallet ${keeper} is also the ${clashes.join(' and ')} wallet; use a dedicated KEEPER_PRIVATE_KEY`);
    }
    const balance = await ctx.provider.getBalance(keeper);
    if (requireBalance && balance === 0n) throw new ChainFatalError(`keeper wallet ${keeper} has no ETH for gas`);
    return { address: keeper, balance, lowBalance: balance < KEEPER_LOW_BALANCE_WEI };
}

// pendingSettlement() with uint64/uint8 as numbers. Never reverts on chain.
export async function readSettlement(ctx, incidentKey) {
    const s = await ctx.read.pendingSettlement(incidentKey);
    return {
        exists: s.exists,
        covered: s.covered,
        deviceIdHash: s.deviceIdHash.toLowerCase(),
        severity: Number(s.severity),
        status: Number(s.status),
        observedAt: Number(s.observedAt),
        loggedAt: Number(s.loggedAt),
        ackDeadline: Number(s.ackDeadline),
        resolveDeadline: Number(s.resolveDeadline),
        relayDelay: Number(s.relayDelay),
        flags: Number(s.flags),
        canRecordAck: s.canRecordAck,
        canRecordResolve: s.canRecordResolve,
        canSlashMissedAck: s.canSlashMissedAck,
        canSlashLateRelay: s.canSlashLateRelay,
    };
}
