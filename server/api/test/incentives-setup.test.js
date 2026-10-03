// Worker startup checks for incentives (Task5_8_plan.md, Task 7, step 7.1): the keeper
// wallet must be dedicated and funded, the deployment must read the worker's AirSafetyLog,
// and with INCENTIVES_ENABLED off nothing incentive-related runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';

import { ChainFatalError } from '../src/chain/air-safety-log.js';
import { assertKeeperWallet, keeperWalletClashes, resolveIncentivesDeployment } from '../src/chain/incentives.js';
import { INCENTIVES_DEPLOYMENTS } from '../src/generated/incentives-deployments.js';
import { config } from '../src/config.js';
import { setupIncentives } from '../src/worker.js';

const RELAYER = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const MANAGER = new Wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const KEEPER = new Wallet('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a');
const OTHER = new Wallet('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');

function fakeCtx(keeper, { operator = OTHER.address, balance = 10n ** 18n } = {}) {
    return {
        keeperWallet: keeper ? { address: keeper.address } : null,
        read: { operator: async () => operator },
        provider: { getBalance: async () => balance },
    };
}

test('keeperWalletClashes compares checksum-insensitively against relayer, manager and operator', () => {
    assert.deepEqual(keeperWalletClashes(KEEPER.address, { relayer: RELAYER.address, manager: MANAGER.address, operator: OTHER.address }), []);
    assert.deepEqual(keeperWalletClashes(RELAYER.address, { relayer: RELAYER.address.toLowerCase() }), ['relayer']);
    assert.deepEqual(keeperWalletClashes(MANAGER.address, { relayer: RELAYER.address, manager: MANAGER.address }), ['device manager']);
    assert.deepEqual(keeperWalletClashes(RELAYER.address, { relayer: RELAYER.address, operator: RELAYER.address }), ['relayer', 'incentives operator']);
});

test('assertKeeperWallet: dedicated wallet with ETH passes; shared or empty wallets are fatal', async () => {
    const wallets = { relayer: RELAYER.address, manager: MANAGER.address };
    const ok = await assertKeeperWallet(fakeCtx(KEEPER), wallets);
    assert.equal(ok.address, KEEPER.address);
    assert.equal(ok.lowBalance, false);
    assert.equal((await assertKeeperWallet(fakeCtx(KEEPER, { balance: 10n ** 15n }), wallets)).lowBalance, true);

    await assert.rejects(assertKeeperWallet(fakeCtx(null), wallets), (err) => err instanceof ChainFatalError && /KEEPER_PRIVATE_KEY is required/.test(err.message));
    await assert.rejects(assertKeeperWallet(fakeCtx(RELAYER), wallets), (err) => err instanceof ChainFatalError && /also the relayer/.test(err.message));
    await assert.rejects(assertKeeperWallet(fakeCtx(MANAGER), wallets), (err) => err instanceof ChainFatalError && /device manager/.test(err.message));
    await assert.rejects(
        assertKeeperWallet(fakeCtx(KEEPER, { operator: KEEPER.address }), wallets),
        (err) => err instanceof ChainFatalError && /incentives operator/.test(err.message)
    );
    await assert.rejects(assertKeeperWallet(fakeCtx(KEEPER, { balance: 0n }), wallets), (err) => err instanceof ChainFatalError && /no ETH/.test(err.message));
});

test('resolveIncentivesDeployment requires a deployment that reads the same AirSafetyLog', () => {
    const local = INCENTIVES_DEPLOYMENTS.localhost;
    assert.equal(resolveIncentivesDeployment('localhost', local.airSafetyLog.toLowerCase()), local);
    assert.throws(() => resolveIncentivesDeployment('', local.airSafetyLog), (err) => err instanceof ChainFatalError && /INCENTIVES_DEPLOYMENT/.test(err.message));
    assert.throws(() => resolveIncentivesDeployment('mainnet', local.airSafetyLog), (err) => err instanceof ChainFatalError && /mainnet\.incentives\.json/.test(err.message));
    assert.throws(
        () => resolveIncentivesDeployment('localhost', '0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A'),
        (err) => err instanceof ChainFatalError && /but the worker uses/.test(err.message)
    );
});

test('INCENTIVES_ENABLED off: no incentives indexer or keeper, no RPC calls, KEEPER_ENABLED alone is ignored', async () => {
    const warnings = [];
    const log = { info() {}, error() {}, warn: (o, m) => warnings.push(m) };
    const provider = new Proxy({}, { get() { throw new Error('no RPC expected'); } });
    const result = await setupIncentives({
        provider,
        chain: { address: INCENTIVES_DEPLOYMENTS.localhost.airSafetyLog },
        db: null,
        chainConfig: {},
        log,
        incentivesConfig: { enabled: false, keeperEnabled: true },
        keeperPrivateKey: RELAYER.privateKey,
    });
    assert.equal(result, null);
    assert.deepEqual(warnings, ['KEEPER_ENABLED ignored: INCENTIVES_ENABLED is not true']);
});

test('config: incentives are off by default and read their env vars', () => {
    const names = ['INCENTIVES_ENABLED', 'KEEPER_ENABLED', 'KEEPER_PRIVATE_KEY', 'KEEPER_BATCH_SIZE', 'INCENTIVES_DEPLOYMENT', 'INCIDENT_DEPLOYMENT'];
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    try {
        for (const n of names) delete process.env[n];
        assert.equal(config.incentives.enabled, false);
        assert.equal(config.incentives.keeperEnabled, false);
        assert.equal(config.incentives.keeperBatchSize, 20);
        assert.equal(config.chain.keeperPrivateKey, '');

        process.env.INCENTIVES_ENABLED = 'true';
        process.env.KEEPER_ENABLED = 'true';
        process.env.KEEPER_PRIVATE_KEY = KEEPER.privateKey;
        process.env.KEEPER_BATCH_SIZE = '5';
        process.env.INCIDENT_DEPLOYMENT = 'sepolia';
        assert.equal(config.incentives.enabled, true);
        assert.equal(config.incentives.keeperEnabled, true);
        assert.equal(config.chain.keeperPrivateKey, KEEPER.privateKey);
        assert.equal(config.incentives.keeperBatchSize, 5);
        assert.equal(config.incentives.deployment, 'sepolia', 'defaults to INCIDENT_DEPLOYMENT');
        process.env.INCENTIVES_DEPLOYMENT = 'localhost';
        assert.equal(config.incentives.deployment, 'localhost');
    } finally {
        for (const n of names) {
            if (saved[n] === undefined) delete process.env[n];
            else process.env[n] = saved[n];
        }
    }
});
