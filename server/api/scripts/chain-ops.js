// Operator tool for the chain worker queues (docs/ops/CHAIN_WORKER_RUNBOOK.md).
//
//   node scripts/chain-ops.js status                      health + metrics (same as /api/health/chain)
//   node scripts/chain-ops.js stuck                       blocked/failed outbox rows and device ops
//   node scripts/chain-ops.js requeue-outbox <id...>      fresh retry window for blocked rows
//   node scripts/chain-ops.js requeue-outbox --all-blocked
//   node scripts/chain-ops.js requeue-op <id...>          fresh retry window for blocked device ops
//   node scripts/chain-ops.js alerts [--all]              open (or all) operator alerts
//   node scripts/chain-ops.js ack-alert <id...> | --all   acknowledge alerts
//
// requeue-* only touch `blocked` items; add --include-failed for `failed` ones after the
// cause (a revert) has been fixed. The relayer re-checks the chain before sending, so a
// requeue can never log an incident twice.
import pg from 'pg';

import { config } from '../src/config.js';
import { collectChainMetrics, evaluateChainHealth } from '../src/services/chain-metrics.js';
import {
    acknowledgeAlerts,
    listAlerts,
    listStuckItems,
    requeueDeviceOps,
    requeueOutbox,
} from '../src/services/chain-ops-admin.js';
import { poolAdapter } from '../src/worker.js';

const { Pool } = pg;

function usage() {
    console.error('usage: node scripts/chain-ops.js <status|stuck|requeue-outbox|requeue-op|alerts|ack-alert> [ids...] [--all-blocked|--all|--include-failed]');
    process.exit(2);
}

function print(value) {
    console.log(JSON.stringify(value, null, 2));
}

async function run() {
    const args = process.argv.slice(2);
    const [command] = args;
    if (!command) usage();
    const ids = args.slice(1).filter((arg) => !arg.startsWith('--'));
    const flag = (name) => args.includes(name);

    const pool = new Pool({
        host: config.db.host,
        port: config.db.port,
        database: config.db.database,
        user: config.db.user,
        password: config.db.password,
    });
    const db = poolAdapter(pool);

    try {
        if (command === 'status') {
            const metrics = await collectChainMetrics(db);
            const health = evaluateChainHealth(metrics, {
                maxTickAgeSeconds: config.chain.healthMaxTickAgeSeconds,
                maxQueuedAgeSeconds: config.chain.healthMaxQueuedAgeSeconds,
                maxLagBlocks: config.chain.healthMaxLagBlocks,
                minRelayerBalanceWei: config.chain.minRelayerBalanceWei,
                failureStreak: config.chain.alertFailureStreak,
            });
            print({ ...health, metrics });
        } else if (command === 'stuck') {
            print(await listStuckItems(db));
        } else if (command === 'requeue-outbox') {
            if (!flag('--all-blocked') && ids.length === 0) usage();
            const rows = await requeueOutbox(db, { ids, allBlocked: flag('--all-blocked'), includeFailed: flag('--include-failed') });
            print({ requeued: rows });
        } else if (command === 'requeue-op') {
            if (ids.length === 0) usage();
            print({ requeued: await requeueDeviceOps(db, { ids, includeFailed: flag('--include-failed') }) });
        } else if (command === 'alerts') {
            print(await listAlerts(db, { includeAcknowledged: flag('--all') }));
        } else if (command === 'ack-alert') {
            if (!flag('--all') && ids.length === 0) usage();
            print({ acknowledged: await acknowledgeAlerts(db, { ids, all: flag('--all') }) });
        } else {
            usage();
        }
    } finally {
        await pool.end();
    }
}

run().catch((err) => {
    console.error(`chain-ops failed: ${err.message}`);
    process.exit(1);
});
