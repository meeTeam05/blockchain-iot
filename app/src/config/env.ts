const DEFAULT_API_BASE_URL = 'https://minhnhat05.xyz/api';
const DEFAULT_MQTT_BROKER_URI = 'wss://minhnhat05.xyz/mqtt';

export const ApiConfig = {
  defaultApiBaseUrl: DEFAULT_API_BASE_URL,
  defaultMqttBrokerUri: DEFAULT_MQTT_BROKER_URI,
  localProvisioningScheme: 'http',
  localInfoPath: '/api/info',
  localConfigPath: '/api/config',
} as const;

function validateAbsoluteUri(
  value: string,
  settingName: string,
  allowedSchemes: readonly string[],
): URL {
  let uri: URL;
  try {
    uri = new URL(value.trim());
  } catch {
    throw new Error(`${settingName} must be an absolute URI with a host`);
  }
  if (!uri.hostname) {
    throw new Error(`${settingName} must be an absolute URI with a host`);
  }

  const scheme = uri.protocol.replace(':', '');
  if (!allowedSchemes.includes(scheme)) {
    const allowed = [...allowedSchemes].sort().join(' or ');
    throw new Error(`${settingName} must use ${allowed}`);
  }

  return uri;
}

export function validateApiBaseUrl(value: string): URL {
  return validateAbsoluteUri(value, 'API_BASE_URL', ['http', 'https']);
}

export function validateMqttBrokerUri(value: string): URL {
  return validateAbsoluteUri(value, 'MQTT_BROKER_URI', ['ws', 'wss']);
}

export const Env = {
  apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? ApiConfig.defaultApiBaseUrl,
  mqttBrokerUri: process.env.EXPO_PUBLIC_MQTT_BROKER_URI ?? ApiConfig.defaultMqttBrokerUri,

  get apiBaseUri(): URL {
    return validateApiBaseUrl(Env.apiBaseUrl);
  },

  get mqttBrokerWsUri(): URL {
    return validateMqttBrokerUri(Env.mqttBrokerUri);
  },

  validate(): void {
    void Env.apiBaseUri;
    void Env.mqttBrokerWsUri;
  },
};
