import { validateApiBaseUrl, validateMqttBrokerUri } from './env';

describe('validateApiBaseUrl', () => {
  it('accepts absolute http urls', () => {
    const uri = validateApiBaseUrl('https://example.com/api');
    expect(uri.toString()).toBe('https://example.com/api');
  });

  it('rejects malformed urls', () => {
    expect(() => validateApiBaseUrl('not a url')).toThrow(
      'API_BASE_URL must be an absolute URI with a host',
    );
  });
});

describe('validateMqttBrokerUri', () => {
  it('rejects non-websocket schemes', () => {
    expect(() => validateMqttBrokerUri('https://example.com/mqtt')).toThrow(
      'MQTT_BROKER_URI must use ws or wss',
    );
  });
});
