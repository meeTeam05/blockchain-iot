import { normalizeDeviceId } from '../utils/device-id.js';
import { checkDeviceAccess } from '../utils/check-access.js';
import { parsePositiveInt } from '../utils/parse.js';
import { isBytes32, isUint64String } from '../services/incident-verify.js';
import {
    formatIncidentDetail,
    getIncidentRow,
    listIncidents,
    verifyStoredIncident,
} from '../services/incidents.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export default async function incidentsRoutes(fastify) {
    const auth = { preHandler: fastify.authenticate };

    async function authorizeDevice(request, reply) {
        const deviceId = normalizeDeviceId(request.params.id);
        if (!deviceId) {
            reply.code(400).send({ error: 'Invalid device ID' });
            return null;
        }
        const allowed = await checkDeviceAccess(fastify, deviceId, request.user.sub);
        if (!allowed) {
            reply.code(403).send({ error: 'Forbidden' });
            return null;
        }
        return deviceId;
    }

    async function loadIncident(request, reply) {
        const deviceId = await authorizeDevice(request, reply);
        if (!deviceId) return null;

        const incidentId = typeof request.params.incidentId === 'string'
            ? request.params.incidentId.toLowerCase()
            : null;
        if (!isBytes32(incidentId)) {
            reply.code(400).send({ error: 'Invalid incident ID' });
            return null;
        }
        const row = await getIncidentRow(fastify, deviceId, incidentId);
        if (!row) {
            reply.code(404).send({ error: 'Incident not found' });
            return null;
        }
        return row;
    }

    fastify.get('/devices/:id/incidents', auth, async (request, reply) => {
        const deviceId = await authorizeDevice(request, reply);
        if (!deviceId) return reply;

        const limit = parsePositiveInt(request.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
        if (limit === null || limit <= 0) {
            return reply.code(400).send({ error: 'limit must be a positive integer' });
        }
        const beforeSequence = request.query.before_sequence ?? null;
        if (beforeSequence !== null && !isUint64String(beforeSequence)) {
            return reply.code(400).send({ error: 'before_sequence must be a uint64 decimal string' });
        }

        return listIncidents(fastify, deviceId, { beforeSequence, limit });
    });

    fastify.get('/devices/:id/incidents/:incidentId', auth, async (request, reply) => {
        const row = await loadIncident(request, reply);
        if (!row) return reply;
        return formatIncidentDetail(row);
    });

    fastify.get('/devices/:id/incidents/:incidentId/verify', auth, async (request, reply) => {
        const row = await loadIncident(request, reply);
        if (!row) return reply;
        return verifyStoredIncident(fastify, row);
    });
}
