// Token incentives API (Task5_8_plan.md, Task 7, step 7.5). Read-only; the chain worker
// writes everything these routes return. The incident detail route adds `incentive`.
import { normalizeDeviceId } from '../utils/device-id.js';
import { checkDeviceAccess } from '../utils/check-access.js';
import { parsePositiveInt } from '../utils/parse.js';
import { getDeviceIncentives, getIncentiveParams, getLeaderboard, listOverdue } from '../services/incentives.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const OVERDUE_DEFAULT_LIMIT = 100;
const OVERDUE_MAX_LIMIT = 500;
const LEADERBOARD_DEFAULT_LIMIT = 10;
const LEADERBOARD_MAX_LIMIT = 100;

// Public routes are unauthenticated; keep them cheap to serve.
const publicRateLimit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
const NOT_AVAILABLE = { error: 'Incentives are not available' };

function parseLimit(value, fallback, max) {
    const limit = parsePositiveInt(value, fallback, max);
    return limit === null || limit <= 0 ? null : limit;
}

export default async function incentivesRoutes(fastify) {
    fastify.get('/devices/:id/incentives', { preHandler: fastify.authenticate }, async (request, reply) => {
        const deviceId = normalizeDeviceId(request.params.id);
        if (!deviceId) return reply.code(400).send({ error: 'Invalid device ID' });
        if (!(await checkDeviceAccess(fastify, deviceId, request.user.sub))) {
            return reply.code(403).send({ error: 'Forbidden' });
        }
        const limit = parseLimit(request.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
        if (limit === null) return reply.code(400).send({ error: 'limit must be a positive integer' });
        const beforeId = request.query.before_id ?? null;
        if (beforeId !== null && !/^[1-9][0-9]{0,18}$/.test(String(beforeId))) {
            return reply.code(400).send({ error: 'before_id must be a positive integer' });
        }
        return getDeviceIncentives(fastify, deviceId, { limit, beforeId });
    });

    fastify.get('/incentives/overdue', publicRateLimit, async (request, reply) => {
        const limit = parseLimit(request.query.limit, OVERDUE_DEFAULT_LIMIT, OVERDUE_MAX_LIMIT);
        if (limit === null) return reply.code(400).send({ error: 'limit must be a positive integer' });
        const result = await listOverdue(fastify, { limit });
        return result ?? reply.code(404).send(NOT_AVAILABLE);
    });

    fastify.get('/incentives/params', publicRateLimit, async (request, reply) => {
        const result = await getIncentiveParams(fastify);
        return result ?? reply.code(404).send(NOT_AVAILABLE);
    });

    fastify.get('/incentives/leaderboard', publicRateLimit, async (request, reply) => {
        const limit = parseLimit(request.query.limit, LEADERBOARD_DEFAULT_LIMIT, LEADERBOARD_MAX_LIMIT);
        if (limit === null) return reply.code(400).send({ error: 'limit must be a positive integer' });
        const result = await getLeaderboard(fastify, { limit });
        return result ?? reply.code(404).send(NOT_AVAILABLE);
    });
}
