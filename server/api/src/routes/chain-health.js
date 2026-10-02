// Chain worker health and metrics (Task 4, docs/ops/CHAIN_WORKER_RUNBOOK.md).
//   GET /api/health/chain    200 ok / 503 degraded with reasons; full metrics only for
//                            operators (OPS_METRICS_TOKEN).
//   GET /api/metrics/chain   Prometheus text; operators only.
// Kept apart from /health/ready on purpose: a stuck chain must not take the API out of
// rotation, since MQTT intake, ACKs and the app keep working without the chain.
import { timingSafeEqual } from 'node:crypto';

import { config } from '../config.js';
import { collectChainMetrics, evaluateChainHealth, renderPrometheus } from '../services/chain-metrics.js';

function tokenMatches(header, token) {
    const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
    if (!match) return false;
    const given = Buffer.from(match[1].trim());
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
}

export default async function chainHealthRoutes(fastify, options = {}) {
    const settings = {
        metricsToken: options.metricsToken ?? config.ops.metricsToken,
        isProduction: options.isProduction ?? config.isProduction,
        thresholds: options.thresholds ?? {
            maxTickAgeSeconds: config.chain.healthMaxTickAgeSeconds,
            maxQueuedAgeSeconds: config.chain.healthMaxQueuedAgeSeconds,
            maxLagBlocks: config.chain.healthMaxLagBlocks,
            minRelayerBalanceWei: config.chain.minRelayerBalanceWei,
            failureStreak: config.chain.alertFailureStreak,
        },
    };

    // No token configured: open for local/dev use, closed in production.
    function isOperator(request) {
        if (settings.metricsToken) return tokenMatches(request.headers.authorization, settings.metricsToken);
        return !settings.isProduction;
    }

    async function snapshot() {
        const metrics = await collectChainMetrics(fastify.db);
        return { metrics, health: evaluateChainHealth(metrics, settings.thresholds) };
    }

    fastify.get('/health/chain', async (request, reply) => {
        const { metrics, health } = await snapshot();
        return reply.code(health.status === 'ok' ? 200 : 503).send({
            status: health.status,
            reasons: health.reasons,
            checked_at: metrics.checked_at,
            ...(isOperator(request) ? { metrics } : {}),
        });
    });

    fastify.get('/metrics/chain', async (request, reply) => {
        if (!isOperator(request)) {
            return reply.code(settings.metricsToken ? 401 : 404).send({ error: settings.metricsToken ? 'Unauthorized' : 'Not Found' });
        }
        const { metrics, health } = await snapshot();
        return reply.type('text/plain; version=0.0.4').send(renderPrometheus(metrics, health));
    });
}
