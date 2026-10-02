// Chain worker heartbeat (Task 4): one chain_worker_status row per contract, written after
// every iteration, is what /api/health/chain and /api/metrics/chain read. It also raises
// the worker-level alerts: a failure streak, a fatal stop and a low relayer balance.
import { formatEther } from 'ethers';

import { chainErrorText as errorText } from './air-safety-log.js';
import { ALERT_KIND, raiseOpsAlert } from './ops-alerts.js';

export function createWorkerStatus({ db, chain, config, log = console, now = () => new Date() }) {
    const contract = chain.address.toLowerCase();
    const relayer = chain.relayerWallet?.address ?? null;
    let startedAt = now();
    let streak = 0; // serial of the current failure streak within this process, 0 = none
    let streakCount = 0;
    let lastBalanceCheck = 0;

    async function start() {
        streak = 0;
        const at = now();
        startedAt = at;
        await db.query(
            `INSERT INTO chain_worker_status (contract_address, relayer_address, started_at, last_tick_at, consecutive_failures)
             VALUES ($1, $2, $3, $3, 0)
             ON CONFLICT (contract_address) DO UPDATE
                 SET relayer_address = EXCLUDED.relayer_address, started_at = EXCLUDED.started_at,
                     last_tick_at = EXCLUDED.last_tick_at, consecutive_failures = 0, updated_at = NOW()`,
            [contract, relayer ? relayer.toLowerCase() : null, at]
        );
    }

    async function checkBalance(at) {
        if (!relayer || at.getTime() - lastBalanceCheck < config.balanceCheckIntervalMs) return;
        lastBalanceCheck = at.getTime();
        const balance = await chain.provider.getBalance(relayer);
        await db.query(
            `UPDATE chain_worker_status SET relayer_balance_wei = $2, balance_checked_at = $3, updated_at = NOW()
             WHERE contract_address = $1`,
            [contract, balance.toString(), at]
        );
        if (config.minRelayerBalanceWei > 0n && balance < config.minRelayerBalanceWei) {
            await raiseOpsAlert(db, {
                kind: ALERT_KIND.RELAYER_LOW_BALANCE,
                severity: 'warning',
                // At most one reminder per relayer per UTC day.
                dedupeKey: `relayer_low_balance:${relayer.toLowerCase()}:${at.toISOString().slice(0, 10)}`,
                subjectId: relayer.toLowerCase(),
                message: `relayer ${relayer} has ${formatEther(balance)} ETH, below ${formatEther(config.minRelayerBalanceWei)} ETH`,
                details: { relayer: relayer.toLowerCase(), balance_wei: balance.toString(), min_balance_wei: config.minRelayerBalanceWei.toString() },
            });
        }
    }

    async function success() {
        const at = now();
        streak = 0;
        const head = await chain.provider.getBlockNumber();
        await db.query(
            `UPDATE chain_worker_status
             SET last_tick_at = $2, last_success_at = $2, head_block = $3, consecutive_failures = 0, updated_at = NOW()
             WHERE contract_address = $1`,
            [contract, at, head]
        );
        await checkBalance(at);
    }

    async function failure(err) {
        const at = now();
        if (streak === 0) streak = ++streakCount;
        const { rows } = await db.query(
            `UPDATE chain_worker_status
             SET last_tick_at = $2, consecutive_failures = consecutive_failures + 1,
                 rpc_errors_total = rpc_errors_total + 1, last_error = $3, last_error_at = $2, updated_at = NOW()
             WHERE contract_address = $1
             RETURNING consecutive_failures`,
            [contract, at, errorText(err)]
        );
        const failures = rows[0]?.consecutive_failures ?? 0;
        if (failures >= config.alertFailureStreak) {
            await raiseOpsAlert(db, {
                kind: ALERT_KIND.WORKER_FAILING,
                // One alert per streak: process start + streak serial identify it.
                dedupeKey: `worker_failing:${contract}:${startedAt.toISOString()}:${streak}`,
                subjectId: contract,
                message: `chain worker failed ${failures} iterations in a row: ${errorText(err)}`,
                details: { consecutive_failures: failures, last_error: errorText(err) },
            });
        }
    }

    async function stopped(err) {
        await raiseOpsAlert(db, {
            kind: ALERT_KIND.WORKER_STOPPED,
            dedupeKey: `worker_stopped:${contract}:${now().toISOString()}`,
            subjectId: contract,
            message: `chain worker stopped: ${errorText(err)}`,
            details: { error: errorText(err) },
        }).catch((alertErr) => log.error({ err: errorText(alertErr) }, 'could not record worker_stopped alert'));
    }

    return { start, success, failure, stopped };
}
