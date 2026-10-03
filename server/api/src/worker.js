// Chain worker process: relayer (Task 4) + signer lifecycle ops + indexer, and with
// INCENTIVES_ENABLED the SafetyIncentives indexer + keeper (Task 7).
//
//   node src/worker.js        (docker compose service "chain-worker")
//
// Exactly one instance may run per database (and therefore per relayer wallet): a
// session-level advisory lock is held for the lifetime of the process.
import pg from 'pg';

import { config } from './config.js';
import { resolveIncidentDomains } from './services/incident-domains.js';
import { assertDomainMatchesChain, assertRoles, ChainFatalError, chainErrorText, createChainContext, createProvider } from './chain/air-safety-log.js';
import {
    assertIncentivesContract,
    assertKeeperWallet,
    createIncentivesContext,
    keeperWalletClashes,
    resolveIncentivesDeployment,
} from './chain/incentives.js';
import { INCENTIVES_DEPLOYMENTS } from './generated/incentives-deployments.js';
import { createIncentivesIndexer } from './chain/incentives-indexer.js';
import { createKeeper } from './chain/keeper.js';
import { createIndexer } from './chain/indexer.js';
import { createAlertDelivery } from './chain/ops-alerts.js';
import { createRelayer } from './chain/relayer.js';
import { createWorkerStatus } from './chain/worker-status.js';

const WORKER_LOCK_ID = 7_300_419;

function makeLogger() {
    const write = (level) => (obj, msg) => {
        const entry = typeof obj === 'string' ? { msg: obj } : { ...obj, msg };
        console[level === 'info' ? 'log' : level](JSON.stringify({ level, time: new Date().toISOString(), ...entry }));
    };
    return { info: write('info'), warn: write('warn'), error: write('error') };
}

export function poolAdapter(pool) {
    return {
        query: (sql, params) => pool.query(sql, params),
        async withTransaction(fn) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const result = await fn(client);
                await client.query('COMMIT');
                return result;
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {});
                throw err;
            } finally {
                client.release();
            }
        },
    };
}

// Startup checks of Task 7: the incentives deployment must read this AirSafetyLog, and
// the keeper wallet must be dedicated (not relayer, manager or operator) and hold ETH.
// Any failure is a ChainFatalError (exit code 2). Returns null when incentives are off.
export async function setupIncentives({
    provider,
    chain,
    db,
    chainConfig,
    log,
    incentivesConfig = config.incentives,
    keeperPrivateKey = config.chain.keeperPrivateKey,
    deployments = INCENTIVES_DEPLOYMENTS,
}) {
    if (!incentivesConfig.enabled) {
        if (incentivesConfig.keeperEnabled) log.warn({}, 'KEEPER_ENABLED ignored: INCENTIVES_ENABLED is not true');
        return null;
    }
    const deployment = resolveIncentivesDeployment(incentivesConfig.deployment, chain.address, deployments);
    const ctx = createIncentivesContext({
        provider,
        address: deployment.incentives.address,
        tokenAddress: deployment.token.address,
        keeperPrivateKey,
    });
    await assertIncentivesContract(ctx, chain.address);

    const wallets = { relayer: chain.relayerWallet?.address, manager: chain.managerWallet?.address };
    let keeper = null;
    if (incentivesConfig.keeperEnabled) {
        const wallet = await assertKeeperWallet(ctx, wallets);
        if (wallet.lowBalance) log.warn({ keeper: wallet.address, balanceWei: String(wallet.balance) }, 'keeper wallet is low on ETH');
        keeper = createKeeper({
            db,
            chain: ctx,
            config: { batchSize: incentivesConfig.keeperBatchSize, confirmations: chainConfig.confirmations, maxAttempts: chainConfig.maxAttempts },
            log,
        });
    } else if (ctx.keeperWallet) {
        const clashes = keeperWalletClashes(ctx.keeperWallet.address, { ...wallets, operator: await ctx.read.operator() });
        if (clashes.length) throw new ChainFatalError(`KEEPER_PRIVATE_KEY is also the ${clashes.join(' and ')} wallet`);
    }

    const startBlock = Number.isInteger(incentivesConfig.startBlock) ? incentivesConfig.startBlock : deployment.incentives.blockNumber;
    const indexer = createIncentivesIndexer({
        db,
        chain: ctx,
        config: { ...chainConfig, stateRefreshMs: incentivesConfig.stateRefreshMs },
        startBlock,
        deploymentBlock: deployment.incentives.blockNumber,
        log,
    });
    log.info({
        incentives: ctx.address,
        token: ctx.tokenAddress,
        keeper: keeper ? ctx.keeperWallet.address : null,
        keeperBatchSize: incentivesConfig.keeperBatchSize,
        startBlock,
    }, 'incentives enabled');
    return { ctx, indexer, keeper };
}

async function main() {
    const log = makeLogger();
    const domains = resolveIncidentDomains(config.incident);
    const chainConfig = {
        confirmations: config.chain.confirmations,
        batchSize: config.chain.batchSize,
        maxAttempts: config.chain.maxAttempts,
        maxRetryAgeHours: config.chain.maxRetryAgeHours,
        logBatchBlocks: config.chain.logBatchBlocks,
    };
    if (!config.chain.relayerPrivateKey) throw new ChainFatalError('RELAYER_PRIVATE_KEY is required');

    const provider = createProvider(config.chain.rpcUrl);
    await assertDomainMatchesChain(provider, domains.current);
    const chain = createChainContext({
        provider,
        address: domains.current.verifyingContract,
        relayerPrivateKey: config.chain.relayerPrivateKey,
        deviceManagerPrivateKey: config.chain.deviceManagerPrivateKey,
    });
    await assertRoles(chain);

    const pool = new pg.Pool({
        host: config.db.host,
        port: config.db.port,
        database: config.db.database,
        user: config.db.user,
        password: config.db.password,
        max: 4,
    });
    const lockClient = await pool.connect();
    const { rows } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [WORKER_LOCK_ID]);
    if (!rows[0].locked) throw new ChainFatalError('another chain worker already holds the worker lock');

    const db = poolAdapter(pool);
    const startBlock = Number.isInteger(config.chain.startBlock) ? config.chain.startBlock : (domains.deployment?.blockNumber ?? 0);
    const relayer = createRelayer({ db, chain, config: chainConfig, log });
    const indexer = createIndexer({ db, chain, config: chainConfig, startBlock, log });
    const incentives = await setupIncentives({ provider, chain, db, chainConfig, log });
    const status = createWorkerStatus({
        db,
        chain,
        config: {
            alertFailureStreak: config.chain.alertFailureStreak,
            balanceCheckIntervalMs: config.chain.balanceCheckIntervalMs,
            minRelayerBalanceWei: config.chain.minRelayerBalanceWei,
        },
        log,
    });
    const alerts = createAlertDelivery({ db, webhookUrl: config.ops.alertWebhookUrl, log });
    await status.start();
    log.info({
        contract: chain.address,
        relayer: chain.relayerWallet.address,
        deviceManager: chain.managerWallet?.address ?? null,
        legacyDomains: domains.legacy.map((d) => d.verifyingContract),
        confirmations: chainConfig.confirmations,
        startBlock,
    }, 'chain worker started');

    let stopping = false;
    const stop = () => { stopping = true; };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);

    while (!stopping) {
        try {
            await indexer.catchUp();
            await relayer.tick();
            await status.success();
        } catch (err) {
            if (err instanceof ChainFatalError) {
                await status.stopped(err);
                await alerts.deliverPending().catch(() => {});
                throw err;
            }
            log.error({ err: chainErrorText(err) }, 'chain worker iteration failed');
            await status.failure(err).catch((statusErr) => log.error({ err: String(statusErr?.message ?? statusErr) }, 'heartbeat write failed'));
        }
        // Incentives are independent: failures here do not interrupt Task 4 relaying.
        if (incentives) {
            try {
                await incentives.indexer.catchUp();
                if (incentives.keeper) await incentives.keeper.tick();
            } catch (err) {
                if (err instanceof ChainFatalError) {
                    await status.stopped(err);
                    await alerts.deliverPending().catch(() => {});
                    throw err;
                }
                log.error({ err: chainErrorText(err) }, 'incentives iteration failed');
            }
        }
        await alerts.deliverPending().catch((err) => log.error({ err: String(err?.message ?? err) }, 'ops alert delivery failed'));
        await new Promise((resolve) => setTimeout(resolve, config.chain.pollIntervalMs));
    }
    lockClient.release();
    await pool.end();
    log.info({}, 'chain worker stopped');
}

if (process.argv[1]?.endsWith('worker.js')) {
    main().catch((err) => {
        console.error(JSON.stringify({
            level: 'fatal',
            time: new Date().toISOString(),
            msg: 'chain worker stopped on fatal error',
            err: String(err?.message ?? err),
        }));
        process.exit(err instanceof ChainFatalError ? 2 : 1);
    });
}
