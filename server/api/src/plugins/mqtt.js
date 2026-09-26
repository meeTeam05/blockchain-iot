import fp from 'fastify-plugin';
import mqtt from 'mqtt';
import {
    handleStatus,
    handleTelemetry,
    handleResponse,
    handleShadowReport,
    handleShadowGet,
    handleOtaProgress,
} from '../services/mqtt-handlers.js';
import { handleIncident, publishIncidentAck } from '../services/incident-intake.js';
import { normalizeDeviceId } from '../utils/device-id.js';
import { ensureBridgeUser } from '../services/emqx.js';
import { config } from '../config.js';

export const SUBSCRIPTIONS = Object.freeze([
    'device/+/status',
    'device/+/telemetry',
    'device/+/response',
    'device/+/shadow/report',
    'device/+/shadow/get',
    'device/+/ota/progress',
    'device/+/incident',
]);

export function waitForMqttClientEnd(client) {
    return new Promise((resolve, reject) => {
        try {
            client.end(false, {}, resolve);
        } catch (err) {
            reject(err);
        }
    });
}

async function mqttPlugin(fastify) {
    const client = mqtt.connect(config.emqx.mqttUrl, {
        username: config.emqx.mqttUser,
        password: config.emqx.mqttPassword,
        clientId: config.emqx.mqttClientId,
        clean: false,
        manualAcks: true,
        manualConnect: true,
        reconnectPeriod: config.mqtt.reconnectPeriodMs,
        connectTimeout: config.mqtt.connectTimeoutMs,
    });
    let closed = false;
    let connectingStarted = false;
    let subscriptionGeneration = 0;

    fastify.decorate('mqttReadyAt', null);
    fastify.decorate('mqttIsReady', () => client.connected && fastify.mqttReadyAt !== null);
    fastify.decorate('mqttPublish', (topic, payload, options = {}) => {
        const publishOptions = { qos: 1, ...options };
        if (!client.connected || fastify.mqttReadyAt === null) {
            return Promise.reject(new Error('MQTT bridge is not ready'));
        }

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error(`MQTT publish timed out after ${config.mqtt.publishTimeoutMs}ms`));
            }, config.mqtt.publishTimeoutMs);

            client.publish(topic, payload, publishOptions, (err) => {
                clearTimeout(timeoutId);
                if (err) {
                    reject(err);
                    return;
                }

                resolve();
            });
        });
    });

    const setNotReady = () => {
        fastify.mqttReadyAt = null;
    };

    const subscribeWithCheck = (topic) => {
        return new Promise((resolve, reject) => {
            client.subscribe(topic, { qos: 1 }, (err, granted = []) => {
                const denied = granted.some((g) => g?.qos === 128);
                if (err || denied) {
                    reject(Object.assign(err || new Error('MQTT subscription denied'), { topic, granted }));
                    return;
                }
                resolve(granted);
            });
        });
    };

    const provisionAndConnect = async () => {
        while (!closed) {
            try {
                await ensureBridgeUser();
                if (!closed && !connectingStarted) {
                    connectingStarted = true;
                    client.connect();
                }
                return;
            } catch (err) {
                fastify.log.error({ err, retryMs: config.mqtt.provisionRetryMs }, 'MQTT bridge provisioning failed; retrying');
                await new Promise((resolve) => {
                    setTimeout(resolve, config.mqtt.provisionRetryMs);
                });
            }
        }
    };

    client.on('connect', async () => {
        setNotReady();
        const generation = subscriptionGeneration + 1;
        subscriptionGeneration = generation;

        try {
            await Promise.all(SUBSCRIPTIONS.map((topic) => subscribeWithCheck(topic)));
            if (generation === subscriptionGeneration && client.connected) {
                fastify.mqttReadyAt = Date.now();
                fastify.log.info(
                    { mqttReadyAt: fastify.mqttReadyAt, subscriptions: SUBSCRIPTIONS },
                    'MQTT bridge connected and subscribed'
                );
            }
        } catch (err) {
            setNotReady();
            fastify.log.error({ err }, 'MQTT bridge subscription setup failed');
        }
    });

    client.on('close', setNotReady);
    client.on('offline', setNotReady);
    client.on('end', setNotReady);
    client.on('disconnect', setNotReady);
    client.on('error', (err) => fastify.log.error({ err }, 'MQTT bridge error'));

    // Returns work to run after the inbound packet is acked (e.g. publishes that wait for PUBACK).
    async function handleInboundMessage(topic, buf, packet = null) {
        const afterAck = [];
        const parts = topic.split('/');
        const deviceId = normalizeDeviceId(parts[1]);
        if (!deviceId) {
            return afterAck;
        }

        let payload;
        try {
            payload = JSON.parse(buf.toString());
        } catch {
            fastify.log.warn({ topic }, 'MQTT payload is not valid JSON');
            return afterAck;
        }

        let handled = true;
        const payloadByteLength = buf.length;
        if (parts[2] === 'status') {
            await handleStatus(fastify, deviceId, payload);
        } else if (parts[2] === 'telemetry') {
            await handleTelemetry(fastify, deviceId, payload, packet, payloadByteLength);
        } else if (parts[2] === 'response') {
            await handleResponse(fastify, deviceId, payload);
        } else if (parts[2] === 'shadow' && parts[3] === 'report') {
            await handleShadowReport(fastify, deviceId, payload, payloadByteLength);
        } else if (parts[2] === 'shadow' && parts[3] === 'get') {
            await handleShadowGet(fastify, deviceId, payload);
        } else if (parts[2] === 'ota' && parts[3] === 'progress') {
            await handleOtaProgress(fastify, deviceId, payload);
        } else if (parts[2] === 'incident' && parts.length === 3) {
            const result = await handleIncident(fastify, deviceId, payload, buf);
            if (result.ack) {
                afterAck.push(() => publishIncidentAck(fastify, deviceId, result.ack));
            }
        } else {
            handled = false;
        }

        if (!handled) {
            fastify.log.warn({ topic }, 'MQTT message topic not handled');
        }
        return afterAck;
    }

    client.handleMessage = async (packet, callback) => {
        const topic = packet.topic;
        let afterAck;
        try {
            afterAck = await handleInboundMessage(topic, packet.payload, packet);
            callback();
        } catch (err) {
            fastify.log.error({ err, topic }, 'MQTT message handler error; message left unacked for redelivery');
            // With manualAcks=true, not calling callback keeps the QoS1 message unacked.
            return;
        }
        for (const task of afterAck) {
            task().catch((err) => fastify.log.warn({ err, topic }, 'post-ack MQTT publish failed'));
        }
    };

    fastify.addHook('onClose', async () => {
        closed = true;
        setNotReady();
        await waitForMqttClientEnd(client);
    });

    provisionAndConnect();
}

export default fp(mqttPlugin);
