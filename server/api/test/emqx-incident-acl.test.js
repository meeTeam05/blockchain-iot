import test from 'node:test';
import assert from 'node:assert/strict';

const DEVICE_ID = 'dc:b4:d9:13:ed:8c';

function response(status) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() { return ''; },
    };
}

test('new device gets exact incident publish and ACK subscribe permissions', async () => {
    const originalFetch = globalThis.fetch;
    let rulesPayload = null;

    globalThis.fetch = async (url, options) => {
        if (url.includes('/authentication/password_based:built_in_database/users') && options.method === 'POST') {
            return response(201);
        }
        if (url.includes('/authorization/sources/built_in_database/rules/users') && options.method === 'POST') {
            rulesPayload = JSON.parse(options.body);
            return response(201);
        }
        throw new Error(`Unexpected fetch ${options.method} ${url}`);
    };

    try {
        const { createDeviceUser } = await import(`../src/services/emqx.js?device-incident=${Date.now()}`);
        await createDeviceUser(DEVICE_ID, 'secret-key');

        const rules = rulesPayload[0]?.rules ?? [];
        assert.deepEqual(
            rules.map(({ topic, action }) => [topic, action]),
            [
                [`device/${DEVICE_ID}/status`, 'publish'],
                [`device/${DEVICE_ID}/telemetry`, 'publish'],
                [`device/${DEVICE_ID}/response`, 'publish'],
                [`device/${DEVICE_ID}/shadow/report`, 'publish'],
                [`device/${DEVICE_ID}/shadow/get`, 'publish'],
                [`device/${DEVICE_ID}/ota/progress`, 'publish'],
                [`device/${DEVICE_ID}/ai/state`, 'publish'],
                [`device/${DEVICE_ID}/incident`, 'publish'],
                [`device/${DEVICE_ID}/command`, 'subscribe'],
                [`device/${DEVICE_ID}/shadow/get_response`, 'subscribe'],
                [`device/${DEVICE_ID}/ota/update`, 'subscribe'],
                [`device/${DEVICE_ID}/incident/ack`, 'subscribe'],
            ]
        );
        assert.deepEqual(
            rules.find((rule) => rule.topic === `device/${DEVICE_ID}/incident`),
            { topic: `device/${DEVICE_ID}/incident`, action: 'publish', permission: 'allow' }
        );
        assert.deepEqual(
            rules.find((rule) => rule.topic === `device/${DEVICE_ID}/incident/ack`),
            { topic: `device/${DEVICE_ID}/incident/ack`, action: 'subscribe', permission: 'allow' }
        );
        assert.equal(rules.some((rule) => rule.topic === '#' || rule.topic === 'device/#'), false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('startup refresh loads all provisioned device IDs from the database', async () => {
    const originalFetch = globalThis.fetch;
    const secondDeviceId = 'aa:bb:cc:dd:ee:ff';
    const calls = [];

    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith('/authorization/sources/built_in_database/rules/users') && options.method === 'POST') {
            return response(409);
        }
        if (url.includes('/authorization/sources/built_in_database/rules/users/') && options.method === 'PUT') {
            return response(204);
        }
        if (url.endsWith('/authorization/cache') && options.method === 'DELETE') {
            return response(204);
        }
        throw new Error(`Unexpected fetch ${options.method} ${url}`);
    };

    const queries = [];
    const logs = [];
    const fastify = {
        db: {
            async query(sql) {
                queries.push(sql);
                return { rows: [{ id: DEVICE_ID }, { id: secondDeviceId }] };
            },
        },
        log: {
            info(context, message) {
                logs.push({ context, message });
            },
        },
    };

    try {
        const { refreshProvisionedDeviceAuthorizations } = await import('../src/plugins/mqtt.js');
        await refreshProvisionedDeviceAuthorizations(fastify);

        assert.deepEqual(queries, ['SELECT id FROM devices ORDER BY id']);
        assert.equal(calls.filter(({ options }) => options.method === 'PUT').length, 2);
        assert.equal(calls.filter(({ options }) => options.method === 'DELETE').length, 1);
        assert.deepEqual(logs, [{
            context: { deviceCount: 2 },
            message: 'EMQX authorization refreshed for provisioned devices',
        }]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('existing provisioned device authorization is replaced and cache is cleared', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];

    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith('/authorization/sources/built_in_database/rules/users') && options.method === 'POST') {
            return response(409);
        }
        if (url.includes(`/rules/users/${encodeURIComponent(DEVICE_ID)}`) && options.method === 'PUT') {
            return response(204);
        }
        if (url.endsWith('/authorization/cache') && options.method === 'DELETE') {
            return response(204);
        }
        throw new Error(`Unexpected fetch ${options.method} ${url}`);
    };

    try {
        const { refreshDeviceAuthorizations } = await import(`../src/services/emqx.js?refresh-incident=${Date.now()}`);
        await refreshDeviceAuthorizations([DEVICE_ID]);

        assert.equal(calls.length, 3);
        const put = calls.find(({ options }) => options.method === 'PUT');
        const rules = JSON.parse(put.options.body).rules;
        assert.deepEqual(
            rules.find((rule) => rule.topic === `device/${DEVICE_ID}/incident/ack`),
            { topic: `device/${DEVICE_ID}/incident/ack`, action: 'subscribe', permission: 'allow' }
        );
        assert.equal(calls.at(-1).options.method, 'DELETE');
        assert.equal(calls.at(-1).url.endsWith('/authorization/cache'), true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
