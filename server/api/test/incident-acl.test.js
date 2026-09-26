import test from 'node:test';
import assert from 'node:assert/strict';

import { SUBSCRIPTIONS } from '../src/plugins/mqtt.js';
import { bridgeRules, deviceRules, syncDeviceRules } from '../src/services/emqx.js';
import { incidentAckTopic } from '../src/services/incident-intake.js';
import { projectNotificationEvent } from '../src/services/notification-events.js';

const DEVICE_ID = 'aa:bb:cc:dd:ee:ff';

function hasRule(rules, topic, action) {
    return rules.some((rule) => rule.topic === topic && rule.action === action && rule.permission === 'allow');
}

test('bridge subscribes to device/+/incident and every subscription is allowed by its ACL', () => {
    assert.ok(SUBSCRIPTIONS.includes('device/+/incident'));
    const rules = bridgeRules();
    for (const topic of SUBSCRIPTIONS) {
        assert.ok(hasRule(rules, topic, 'subscribe'), `bridge ACL missing subscribe ${topic}`);
    }
    assert.ok(hasRule(rules, 'device/+/incident/ack', 'publish'));
});

test('device ACL allows publishing incidents and subscribing to its own ACK topic only', () => {
    const rules = deviceRules(DEVICE_ID);
    assert.ok(hasRule(rules, `device/${DEVICE_ID}/incident`, 'publish'));
    assert.ok(hasRule(rules, incidentAckTopic(DEVICE_ID), 'subscribe'));
    assert.equal(incidentAckTopic(DEVICE_ID), `device/${DEVICE_ID}/incident/ack`);
    assert.ok(rules.every((rule) => rule.topic.startsWith(`device/${DEVICE_ID}/`)));
    assert.ok(!hasRule(rules, `device/${DEVICE_ID}/incident/ack`, 'publish'), 'device must not forge ACKs');
});

test('syncDeviceRules rewrites an existing device ACL with the incident topics', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
        if (options.method === 'POST') return { ok: false, status: 409, async text() { return ''; } };
        return { ok: true, status: 204, async text() { return ''; } };
    };
    try {
        await syncDeviceRules(DEVICE_ID);
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(calls.length, 2, 'POST conflict falls back to PUT for an existing rule set');
    const put = calls[1];
    assert.equal(put.method, 'PUT');
    assert.ok(put.url.endsWith(`/rules/users/${encodeURIComponent(DEVICE_ID)}`));
    assert.ok(hasRule(put.body.rules, `device/${DEVICE_ID}/incident`, 'publish'));
    assert.ok(hasRule(put.body.rules, `device/${DEVICE_ID}/incident/ack`, 'subscribe'));
});

test('incident.created projects warning/danger notifications naming the alarming gas', async () => {
    const inserted = [];
    const db = {
        async query(sql, params) {
            if (sql.includes('FROM devices')) return { rows: [{ name: 'Kitchen' }] };
            inserted.push(params);
            return { rows: [] };
        },
    };
    const base = { device_id: DEVICE_ID, occurred_at: new Date().toISOString() };

    await projectNotificationEvent(db, { ...base, id: '1', type: 'incident.created', payload: { severity: 'warning', co_level: 0, no2_level: 1 } });
    await projectNotificationEvent(db, { ...base, id: '2', type: 'incident.created', payload: { severity: 'danger', co_level: 2, no2_level: 2 } });
    await projectNotificationEvent(db, { ...base, id: '3', type: 'incident.created', payload: { severity: 'critical' } });

    assert.equal(inserted.length, 2, 'unknown severities are not projected');
    assert.deepEqual(inserted[0].slice(1, 7), [
        'incident.warning', DEVICE_ID, 'Kitchen', 'Gas early warning', 'NO2 entered early warning.', 'warning',
    ]);
    assert.deepEqual(inserted[1].slice(1, 7), [
        'incident.danger', DEVICE_ID, 'Kitchen', 'Gas threshold exceeded', 'CO and NO2 exceeded the QCVN 03:2019/BYT limit.', 'danger',
    ]);
});
