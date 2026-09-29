// Chain worker process: relayer (Task 4) + signer lifecycle ops + indexer.
//
//   node src/worker.js        (docker compose service "chain-worker")
//
// Exactly one instance may run per database (and therefore per relayer wallet): a
// session-level advisory lock is held for the lifetime of the process.
import pg from 'pg';

import { config } from './config.js';
import { resolveIncidentDomains } from './services/incident-domains.js';
import { assertDomainMatchesChain, assertRoles, ChainFatalError, createChainContext, createProvider } from './chain/air-safety-log.js';
import { createIndexer } from './chain/indexer.js';
import { createRelayer } from './chain/relayer.js';

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
        } catch (err) {
            if (err instanceof ChainFatalError) throw err;
            log.error({ err: String(err?.shortMessage ?? err?.message ?? err) }, 'chain worker iteration failed');
        }
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
