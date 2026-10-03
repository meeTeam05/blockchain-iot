import { AxiosInstance, create, isAxiosError } from 'axios';
import { apiClient } from '../api/client';
import { ApiConfig } from '../config/env';
import { ApiException, AppException, NetworkException } from '../api/appException';
import { Device, DeviceShadow, parseDevice, parseDeviceShadow } from '../models/device';
import { Command, parseCommand } from '../models/command';
import { DeviceOtaCatalog, OtaVersionInfo } from '../models/ota';
import { TelemetryPoint, tryParseTelemetryPoint } from '../models/telemetry';

function normalizeDeviceId(value: string): string {
  return value.trim().toLowerCase();
}

function bodyAsMap(data: unknown): Record<string, unknown> {
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  throw new ApiException(0, 'Unexpected server response');
}

function bodyAsMapList(data: unknown): Record<string, unknown>[] {
  if (!Array.isArray(data)) {
    throw new ApiException(0, 'Unexpected server response');
  }
  return data.map((item) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      return item as Record<string, unknown>;
    }
    throw new ApiException(0, 'Unexpected server response');
  });
}

function commandIdFromBody(data: unknown): string {
  const body = bodyAsMap(data);
  const commandId = typeof body.command_id === 'string' ? body.command_id : null;
  if (!commandId) throw new ApiException(0, 'Unexpected server response');
  return commandId;
}

function requiredStringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value === 'string' && value.length > 0) return value;
  throw new ApiException(0, 'Unexpected server response');
}

function requiredBoolField(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value === 'boolean') return value;
  throw new ApiException(0, 'Unexpected server response');
}

function stringError(body: Record<string, unknown> | null, fallback: string): string {
  return typeof body?.error === 'string' ? body.error : fallback;
}

function mapError(err: unknown): AppException {
  if (err instanceof AppException) return err;
  if (isAxiosError(err)) {
    const status = err.response?.status;
    const body = err.response?.data;
    const msg =
      body !== null && typeof body === 'object' && typeof (body as Record<string, unknown>).error === 'string'
        ? ((body as Record<string, unknown>).error as string)
        : null;
    return new ApiException(status ?? 0, msg ?? 'Unknown error');
  }
  return new ApiException(0, 'Unknown error');
}

function normalizeProvisioningHost(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith(`${ApiConfig.localProvisioningScheme}://`) || trimmed.startsWith('https://')) {
    return new URL(trimmed).host;
  }
  return trimmed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ProvisionedDevice {
  device: Device;
  secretKey: string;
}

export class DeviceService {
  constructor(private readonly client: AxiosInstance) {}

  async provisionDevice(options: {
    deviceId: string;
    name: string;
    homeId: string;
    roomId?: string;
  }): Promise<ProvisionedDevice> {
    try {
      const normalizedDeviceId = normalizeDeviceId(options.deviceId);
      const res = await this.client.post('/devices', {
        device_id: normalizedDeviceId,
        name: options.name,
        home_id: options.homeId,
        ...(options.roomId !== undefined ? { room_id: options.roomId } : {}),
      });
      const data = bodyAsMap(res.data);
      const secretKey = typeof data.secret_key === 'string' ? data.secret_key : null;
      if (!secretKey) {
        throw new ApiException(0, 'Provisioning response missing secret_key');
      }
      return { device: parseDevice(data), secretKey };
    } catch (err) {
      throw mapError(err);
    }
  }

  async registerDevice(options: {
    deviceId: string;
    name: string;
    homeId: string;
    roomId?: string;
  }): Promise<Device> {
    const result = await this.provisionDevice(options);
    return result.device;
  }

  private async waitForProvisioningApiReady(
    localClient: AxiosInstance,
    expectedDeviceId: string,
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    let lastError: unknown = null;

    while (Date.now() < deadline) {
      try {
        const res = await localClient.get(ApiConfig.localInfoPath);
        const data = res.data;
        if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
          const actualDeviceId = normalizeDeviceId(
            typeof (data as Record<string, unknown>).device_id === 'string'
              ? ((data as Record<string, unknown>).device_id as string)
              : '',
          );
          if (actualDeviceId === expectedDeviceId) return;
          if (actualDeviceId.length > 0) {
            throw new ApiException(0, 'Provisioning endpoint responded with a different device ID');
          }
        }
      } catch (err) {
        lastError = err;
      }
      await sleep(250);
    }

    if (lastError instanceof AppException) throw lastError;
    throw new NetworkException('Device provisioning API did not become ready in time');
  }

  async configureProvisionedDevice(options: {
    host: string;
    deviceId: string;
    secretKey: string;
    brokerUri?: string;
  }): Promise<void> {
    const normalizedDeviceId = normalizeDeviceId(options.deviceId);
    const normalizedHost = normalizeProvisioningHost(options.host);
    const localClient = create({
      baseURL: `${ApiConfig.localProvisioningScheme}://${normalizedHost}`,
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });

    await this.waitForProvisioningApiReady(localClient, normalizedDeviceId);

    try {
      await localClient.post(ApiConfig.localConfigPath, {
        device_id: normalizedDeviceId,
        secret_key: options.secretKey,
        ...(options.brokerUri && options.brokerUri.trim()
          ? { broker_uri: options.brokerUri.trim() }
          : {}),
      });
    } catch (err) {
      if (isAxiosError(err)) {
        const body =
          err.response?.data !== null && typeof err.response?.data === 'object'
            ? (err.response?.data as Record<string, unknown>)
            : null;
        throw new ApiException(
          err.response?.status ?? 0,
          stringError(body, 'Failed to send MQTT credentials to device'),
        );
      }
      throw mapError(err);
    }
  }

  /** Returns true when the device has announced itself online via MQTT.
   * Poll this after BLE credential write to confirm WiFi connect succeeded. */
  async checkAnnounce(mac: string): Promise<boolean> {
    try {
      const normalizedDeviceId = normalizeDeviceId(mac);
      const res = await this.client.get(`/devices/announce/${normalizedDeviceId}`);
      return bodyAsMap(res.data).announced === true;
    } catch (err) {
      throw mapError(err);
    }
  }

  async getDevices(): Promise<Device[]> {
    try {
      const res = await this.client.get('/devices');
      return bodyAsMapList(res.data).map(parseDevice);
    } catch (err) {
      throw mapError(err);
    }
  }

  async updateDevice(id: string, options: { name?: string; roomId?: string | null } = {}): Promise<Device> {
    try {
      const normalizedDeviceId = normalizeDeviceId(id);
      const res = await this.client.put(`/devices/${normalizedDeviceId}`, {
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.roomId !== undefined ? { room_id: options.roomId } : {}),
      });
      return parseDevice(bodyAsMap(res.data));
    } catch (err) {
      throw mapError(err);
    }
  }

  async deleteDevice(id: string): Promise<void> {
    try {
      const normalizedDeviceId = normalizeDeviceId(id);
      await this.client.delete(`/devices/${normalizedDeviceId}`);
    } catch (err) {
      throw mapError(err);
    }
  }

  async getShadow(deviceId: string): Promise<DeviceShadow> {
    try {
      const normalizedDeviceId = normalizeDeviceId(deviceId);
      const res = await this.client.get(`/devices/${normalizedDeviceId}/shadow`);
      return parseDeviceShadow(bodyAsMap(res.data));
    } catch (err) {
      throw mapError(err);
    }
  }

  async getOtaCatalog(deviceId: string): Promise<DeviceOtaCatalog> {
    try {
      const normalizedDeviceId = normalizeDeviceId(deviceId);
      const res = await this.client.get(`/devices/${normalizedDeviceId}/ota/versions`);
      const body = bodyAsMap(res.data);
      const versions = body.versions;
      if (!Array.isArray(versions)) {
        throw new ApiException(0, 'Unexpected server response');
      }

      const parsedVersions: OtaVersionInfo[] = versions.map((item) => {
        const versionBody = bodyAsMap(item);
        return {
          version: requiredStringField(versionBody, 'version'),
          filename: requiredStringField(versionBody, 'filename'),
          url: requiredStringField(versionBody, 'url'),
        };
      });

      const currentVersion = body.current_version;
      if (currentVersion !== null && currentVersion !== undefined && typeof currentVersion !== 'string') {
        throw new ApiException(0, 'Unexpected server response');
      }

      return {
        deviceId: requiredStringField(body, 'device_id'),
        currentVersion: (currentVersion as string | null) ?? null,
        deviceOnline: requiredBoolField(body, 'device_online'),
        versions: parsedVersions,
      };
    } catch (err) {
      throw mapError(err);
    }
  }

  async startOtaUpdate(deviceId: string, version: string): Promise<void> {
    try {
      const normalizedDeviceId = normalizeDeviceId(deviceId);
      await this.client.post(`/devices/${normalizedDeviceId}/ota`, { version });
    } catch (err) {
      throw mapError(err);
    }
  }

  /**
   * Updates the desired state of the device shadow.
   *
   * IMPORTANT: only for the declarative shadow keys the firmware supports
   * (`mode`, `relay_1`, `relay_2`, `relay_3`). Do NOT use this for
   * relay/mode toggles — use `setRelay`/`setMode` for real-time control.
   */
  async setDesired(deviceId: string, desired: Record<string, unknown>): Promise<void> {
    try {
      const normalizedDeviceId = normalizeDeviceId(deviceId);
      await this.client.put(`/devices/${normalizedDeviceId}/shadow/desired`, desired);
    } catch (err) {
      throw mapError(err);
    }
  }

  async sendCommand(deviceId: string, payload: Record<string, unknown>): Promise<string> {
    try {
      const normalizedDeviceId = normalizeDeviceId(deviceId);
      const res = await this.client.post(`/devices/${normalizedDeviceId}/command`, { payload });
      return commandIdFromBody(res.data);
    } catch (err) {
      throw mapError(err);
    }
  }

  /** Sends a typed relay command for channel 1..3 and returns the command id. */
  async setRelay(deviceId: string, channel: number, state: boolean): Promise<string> {
    if (channel < 1 || channel > 3) {
      throw new RangeError(`channel must be between 1 and 3, got ${channel}`);
    }
    try {
      const normalizedDeviceId = normalizeDeviceId(deviceId);
      const res = await this.client.post(`/devices/${normalizedDeviceId}/relay/${channel}`, { state });
      return commandIdFromBody(res.data);
    } catch (err) {
      throw mapError(err);
    }
  }

  /** Sends a typed device mode command ('on' or 'off') and returns the command id. */
  async setMode(deviceId: string, mode: 'on' | 'off'): Promise<string> {
    try {
      const normalizedDeviceId = normalizeDeviceId(deviceId);
      const res = await this.client.post(`/devices/${normalizedDeviceId}/mode`, { mode });
      return commandIdFromBody(res.data);
    } catch (err) {
      throw mapError(err);
    }
  }

  /** Sends a typed AI toggle command (runtime only, not persisted) and returns the command id. */
  async setAi(deviceId: string, state: boolean): Promise<string> {
    try {
      const normalizedDeviceId = normalizeDeviceId(deviceId);
      const res = await this.client.post(`/devices/${normalizedDeviceId}/ai`, { state });
      return commandIdFromBody(res.data);
    } catch (err) {
      throw mapError(err);
    }
  }

  async getCommands(deviceId: string, options: { limit?: number; offset?: number } = {}): Promise<Command[]> {
    try {
      const normalizedDeviceId = normalizeDeviceId(deviceId);
      const res = await this.client.get(`/devices/${normalizedDeviceId}/commands`, {
        params: { limit: options.limit ?? 50, offset: options.offset ?? 0 },
      });
      return bodyAsMapList(res.data).map(parseCommand);
    } catch (err) {
      throw mapError(err);
    }
  }

  async waitForCommandCompletion(
    deviceId: string,
    commandId: string,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<Command> {
    const timeoutMs = options.timeoutMs ?? 3 * 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const commands = await this.getCommands(deviceId, { limit: 100 });
      const command = commands.find((c) => c.id === commandId);
      if (command && (command.status === 'done' || command.status === 'error' || command.status === 'timeout')) {
        return command;
      }
      await sleep(pollIntervalMs);
    }
    throw new Error(`Command did not finish within ${Math.round(timeoutMs / 60_000)} minute(s)`);
  }

  async getTelemetry(
    deviceId: string,
    options: { from?: Date; to?: Date; agg?: string; limit?: number } = {},
  ): Promise<TelemetryPoint[]> {
    try {
      const now = new Date();
      const normalizedDeviceId = normalizeDeviceId(deviceId);
      const from = options.from ?? new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const to = options.to ?? now;
      const res = await this.client.get(`/devices/${normalizedDeviceId}/telemetry`, {
        params: {
          from: from.toISOString(),
          to: to.toISOString(),
          ...(options.agg ? { agg: options.agg } : {}),
          limit: options.limit ?? 1000,
        },
      });
      if (!Array.isArray(res.data)) return [];
      const points: TelemetryPoint[] = [];
      for (const item of res.data) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
        const point = tryParseTelemetryPoint(item);
        if (point) points.push(point);
      }
      return points;
    } catch (err) {
      throw mapError(err);
    }
  }
}

export const deviceService = new DeviceService(apiClient);
