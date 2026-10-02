import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REQUIRED_RUNTIME_ENV_VARS = [
    'JWT_SECRET',
    'POSTGRES_PASSWORD',
    'REDIS_PASSWORD',
    'EMQX_API_KEY',
    'EMQX_API_SECRET',
    'EMQX_MQTT_PASSWORD',
];

function env(name, fallback = '') {
    const value = process.env[name];
    return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

// Distinguishes "unset" from "explicitly empty" (e.g. clearing legacy domains).
function envList(name) {
    const value = process.env[name];
    if (typeof value !== 'string') return null;
    return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function intEnv(name, fallback) {
    const value = Number.parseInt(process.env[name] || '', 10);
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

function parseAllowedOrigins() {
    const origins = env('CORS_ORIGINS', 'https://minhnhat05.xyz')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

    if (process.env.NODE_ENV === 'production') {
        const hasInvalidOrigin = origins.length === 0
            || origins.some((origin) => origin === '*' || !origin.startsWith('https://'));
        if (hasInvalidOrigin) {
            throw new Error('CORS_ORIGINS must contain explicit HTTPS origins in production');
        }
    }

    return origins;
}

export function getMissingRequiredEnvVars(requiredVars = REQUIRED_RUNTIME_ENV_VARS) {
    return requiredVars.filter((name) => {
        const value = process.env[name];
        return typeof value !== 'string' || value.trim() === '';
    });
}

export const config = Object.freeze({
    get nodeEnv() { return env('NODE_ENV'); },
    get isProduction() { return process.env.NODE_ENV === 'production'; },
    get isDevelopment() { return process.env.NODE_ENV === 'development'; },
    get port() { return intEnv('PORT', 3000); },
    get logLevel() { return env('LOG_LEVEL', 'info'); },
    get bodyLimitBytes() { return intEnv('BODY_LIMIT_BYTES', 65_536); },
    get corsOrigins() { return parseAllowedOrigins(); },
    db: Object.freeze({
        get host() { return env('POSTGRES_HOST', 'postgres'); },
        get port() { return intEnv('POSTGRES_PORT', 5432); },
        get database() { return env('POSTGRES_DB', 'smartair'); },
        get user() { return env('POSTGRES_USER', 'smartair'); },
        get password() { return process.env.POSTGRES_PASSWORD; },
        get poolMax() { return intEnv('PG_POOL_MAX', 20); },
        get idleTimeoutMs() { return intEnv('PG_IDLE_TIMEOUT_MS', 30_000); },
        get connectionTimeoutMs() { return intEnv('PG_CONNECTION_TIMEOUT_MS', 5_000); },
        get statementTimeoutMs() { return intEnv('PG_STATEMENT_TIMEOUT_MS', 10_000); },
    }),
    redis: Object.freeze({
        get host() { return env('REDIS_HOST', 'redis'); },
        get port() { return intEnv('REDIS_PORT', 6379); },
        get password() { return process.env.REDIS_PASSWORD; },
    }),
    jwt: Object.freeze({
        get secret() { return process.env.JWT_SECRET; },
        get expiresIn() { return env('JWT_EXPIRES_IN', '15m'); },
    }),
    refreshTokens: Object.freeze({
        get expiresDays() { return intEnv('REFRESH_TOKEN_EXPIRES_DAYS', 30); },
        get reuseMarkerSweepIntervalMs() { return intEnv('REFRESH_REUSE_MARKER_SWEEP_INTERVAL_MS', 3_600_000); },
    }),
    emqx: Object.freeze({
        get apiUrl() { return env('EMQX_API_URL', 'http://emqx:18083'); },
        get apiTimeoutMs() { return intEnv('EMQX_API_TIMEOUT_MS', 5_000); },
        get apiKey() { return env('EMQX_API_KEY'); },
        get apiSecret() { return env('EMQX_API_SECRET'); },
        get mqttUrl() { return env('EMQX_MQTT_URL', 'mqtt://emqx:1883'); },
        get mqttUser() { return env('EMQX_MQTT_USER', 'sa-server'); },
        get mqttPassword() { return env('EMQX_MQTT_PASSWORD'); },
        get mqttClientId() { return env('EMQX_MQTT_CLIENT_ID', 'sa-api-bridge'); },
        get cleanupRetryIntervalMs() { return 300_000; },
        get cleanupRetryLimit() { return 100; },
    }),
    mqtt: Object.freeze({
        get publishTimeoutMs() { return intEnv('MQTT_PUBLISH_TIMEOUT_MS', 5_000); },
        get provisionRetryMs() { return intEnv('MQTT_PROVISION_RETRY_MS', 5_000); },
        get reconnectPeriodMs() { return 2_000; },
        get connectTimeoutMs() { return 30_000; },
    }),
    ota: Object.freeze({
        get filesDir() { return env('OTA_FILES_DIR', path.resolve(__dirname, '../../ota-files')); },
        get publicBaseUrl() { return env('OTA_PUBLIC_BASE_URL', 'https://minhnhat05.xyz').replace(/\/+$/, ''); },
    }),
    commands: Object.freeze({
        get sentTimeoutSeconds() { return intEnv('COMMAND_SENT_TIMEOUT_SECONDS', 420); },
        get pendingTimeoutSeconds() { return intEnv('COMMAND_PENDING_TIMEOUT_SECONDS', 1_800); },
        get timeoutSweepIntervalMs() { return intEnv('COMMAND_TIMEOUT_SWEEP_INTERVAL_MS', 30_000); },
    }),
    realtime: Object.freeze({
        get replayLimit() { return intEnv('REALTIME_REPLAY_LIMIT', 1_000); },
        get heartbeatMs() { return intEnv('REALTIME_HEARTBEAT_MS', 25_000); },
        get maxClients() { return intEnv('REALTIME_MAX_CLIENTS', 1_000); },
        get maxClientsPerIp() { return intEnv('REALTIME_MAX_CLIENTS_PER_IP', 10); },
        get reconnectInitialDelayMs() { return 1_000; },
        get reconnectMaxDelayMs() { return 30_000; },
        get eventRetentionHours() { return intEnv('REALTIME_EVENT_RETENTION_HOURS', 24); },
        get eventRetentionSweepIntervalMs() { return intEnv('REALTIME_EVENT_RETENTION_SWEEP_INTERVAL_MS', 3_600_000); },
    }),
    incident: Object.freeze({
        // EIP-712 domain is provisioned config only; it is never accepted over MQTT.
        // INCIDENT_DEPLOYMENT selects spec/incident/deployments/<name>.json (via the
        // generated module); AIR_SAFETY_LOG_ADDRESS, when also set, must match it.
        get deployment() { return env('INCIDENT_DEPLOYMENT'); },
        get domainName() { return env('INCIDENT_DOMAIN_NAME', 'AirSafetyLog'); },
        get domainVersion() { return env('INCIDENT_DOMAIN_VERSION', '1'); },
        get chainId() { return env('INCIDENT_CHAIN_ID'); },
        get verifyingContract() { return env('AIR_SAFETY_LOG_ADDRESS'); },
        // Old domains accepted off-chain only (outbox legacy_domain). null = use the
        // deployment's legacyAddresses; an explicitly empty value disables them.
        get legacyVerifyingContracts() { return envList('AIR_SAFETY_LOG_LEGACY_ADDRESSES'); },
        get maxPayloadBytes() { return intEnv('INCIDENT_MAX_PAYLOAD_BYTES', 4_096); },
        get clockSkewSeconds() { return intEnv('INCIDENT_CLOCK_SKEW_SECONDS', 600); },
    }),
    // Chain worker (relayer + signer lifecycle + indexer) and the API startup domain check.
    chain: Object.freeze({
        get rpcUrl() { return env('CHAIN_RPC_URL'); },
        get relayerPrivateKey() { return env('RELAYER_PRIVATE_KEY'); },
        get deviceManagerPrivateKey() { return env('DEVICE_MANAGER_PRIVATE_KEY'); },
        get confirmations() { return intEnv('CHAIN_CONFIRMATIONS', 3); },
        get pollIntervalMs() { return intEnv('CHAIN_POLL_INTERVAL_MS', 5_000); },
        get startBlock() { return Number.parseInt(env('CHAIN_START_BLOCK', ''), 10); },
        get logBatchBlocks() { return intEnv('CHAIN_LOG_BATCH_BLOCKS', 2_000); },
        get maxAttempts() { return intEnv('CHAIN_MAX_ATTEMPTS', 10); },
        get maxRetryAgeHours() { return intEnv('CHAIN_MAX_RETRY_AGE_HOURS', 24); },
        get batchSize() { return intEnv('CHAIN_BATCH_SIZE', 20); },
        // Refuse to start when the configured domain does not match the chain.
        get requireDomainCheck() { return env('CHAIN_DOMAIN_CHECK', 'true') !== 'false'; },
        // Keeper wallet (Task 7): no role, must differ from the relayer and manager wallets.
        get keeperPrivateKey() { return env('KEEPER_PRIVATE_KEY'); },
    }),
    // Token incentives (Task 7). Off by default so the incident pipeline runs unchanged.
    incentives: Object.freeze({
        get enabled() { return env('INCENTIVES_ENABLED', 'false') === 'true'; },
        // Selects blockchain/deployments/<name>.incentives.json via the generated module.
        get deployment() { return env('INCENTIVES_DEPLOYMENT', env('INCIDENT_DEPLOYMENT')); },
        // Defaults to the SafetyIncentives deployment block.
        get startBlock() { return Number.parseInt(env('INCENTIVES_START_BLOCK', ''), 10); },
        // Send recordTimelyAck/recordTimelyResolve/slashMissedAck from KEEPER_PRIVATE_KEY.
        get keeperEnabled() { return env('KEEPER_ENABLED', 'false') === 'true'; },
        get keeperBatchSize() { return intEnv('KEEPER_BATCH_SIZE', 20); },
        get stateRefreshMs() { return intEnv('INCENTIVES_STATE_REFRESH_MS', 60_000); },
    }),
    dataRetention: Object.freeze({
        get commandRetentionDays() { return intEnv('COMMAND_RETENTION_DAYS', 30); },
        get refreshTokenRetentionDays() { return 30; },
        get sweepIntervalMs() { return intEnv('DATA_RETENTION_SWEEP_INTERVAL_MS', 3_600_000); },
    }),
});
