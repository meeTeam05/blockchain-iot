import test from 'node:test';
import assert from 'node:assert/strict';

import Fastify from 'fastify';

import devicesRoutes from '../src/routes/devices.js';

test('GET /devices orders by created_at and id for stable pagination', async () => {
    const app = Fastify({ logger: false });
    let seenQuery = null;
    let seenParams = null;

    app.decorate('authenticate', async (request) => {
        request.user = { sub: 'user-1' };
    });
    app.decorate('db', {
        async query(sql, params = []) {
            seenQuery = sql;
            seenParams = params;
            return { rows: [], rowCount: 0 };
        },
    });

    await app.register(devicesRoutes);

    const res = await app.inject({
        method: 'GET',
        url: '/devices?limit=10&offset=5',
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
    assert.match(seenQuery, /ORDER BY d\.created_at,\s*d\.id LIMIT \$2 OFFSET \$3/);
    assert.deepEqual(seenParams, ['user-1', 10, 5]);

    await app.close();
});

test('GET /devices safely normalizes relay shadow fields without ::bool casts', async () => {
    const app = Fastify({ logger: false });
    let seenQuery = null;

    app.decorate('authenticate', async (request) => {
        request.user = { sub: 'user-1' };
    });
    app.decorate('db', {
        async query(sql) {
            seenQuery = sql;
            return {
                rows: [{
                    id: 'aa:bb:cc:dd:ee:ff',
                    name: 'Device 1',
                    relay_1: null,
                    relay_2: true,
                    relay_3: false,
                }],
                rowCount: 1,
            };
        },
    });

    await app.register(devicesRoutes);

    const res = await app.inject({
        method: 'GET',
        url: '/devices',
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json()[0].relay_1, null);
    assert.equal(res.json()[0].relay_2, true);
    assert.equal(res.json()[0].relay_3, false);
    assert.doesNotMatch(seenQuery, /::bool/);
    assert.match(seenQuery, /CASE[\s\S]*relay_1/);

    await app.close();
});

test('GET /devices includes open_incident_count as a correlated subquery scoped to the device', async () => {
    const app = Fastify({ logger: false });
    let seenQuery = null;

    app.decorate('authenticate', async (request) => {
        request.user = { sub: 'user-1' };
    });
    app.decorate('db', {
        async query(sql) {
            seenQuery = sql;
            return { rows: [{ id: 'aa:bb:cc:dd:ee:ff', name: 'Device 1', open_incident_count: 2 }], rowCount: 1 };
        },
    });

    await app.register(devicesRoutes);

    const res = await app.inject({ method: 'GET', url: '/devices' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json()[0].open_incident_count, 2);
    assert.match(seenQuery, /FROM incidents i\s*\n\s*WHERE i\.device_id = d\.id AND i\.owner_status = 'open'/);

    await app.close();
});
