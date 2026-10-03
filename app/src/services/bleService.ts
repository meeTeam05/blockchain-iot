import { Linking, PermissionsAndroid, Platform } from 'react-native';
import { BleManager, Device, ScanMode, State, Subscription } from 'react-native-ble-plx';
import * as base64 from 'base-64';
import { BleConfig, matchesProvisioningName } from '../config/bleConfig';
import { BleDeviceInfo, BleException, BlePreflightStatus, BleProvisioningResult } from './bleModels';

function utf8ToBase64(value: string): string {
  return base64.encode(unescape(encodeURIComponent(value)));
}

function base64ToUtf8(value: string): string {
  return decodeURIComponent(escape(base64.decode(value)));
}

export interface ScanHandlers {
  onDevice: (device: BleDeviceInfo) => void;
  onError?: (error: Error) => void;
}

/**
 * Owns the BLE lifecycle for Smart Air provisioning.
 *
 * Usage:
 * ```ts
 * const service = new BleService();
 * const preflight = await service.checkPreflight();
 * const stopScan = service.scan({ onDevice: ... });
 * await service.connect(mac);
 * const result = await service.sendCredentials(ssid, password);
 * await service.disconnect();
 * ```
 *
 * NOT ported (dead code in the Dart source — unreferenced by any route):
 * `connectAndRead`/`SensorSnapshot` (test-mode sensor read used only by
 * screens/ble_scan_screen.dart, which no route ever pushes).
 */
export class BleService {
  private readonly manager = new BleManager();
  private connectedDeviceId: string | null = null;

  // Permissions

  private androidSdkInt(): number {
    return Platform.OS === 'android' && typeof Platform.Version === 'number' ? Platform.Version : 0;
  }

  /** Returns the first blocker that must be fixed before BLE scanning. */
  async checkPreflight(): Promise<BlePreflightStatus> {
    const state = await this.manager.state();
    if (state === State.Unsupported) return 'unsupported';

    if (Platform.OS === 'android') {
      const sdkInt = this.androidSdkInt();
      const permissions =
        sdkInt < 31
          ? [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]
          : [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT];
      const statuses = await PermissionsAndroid.requestMultiple(permissions);
      const values = Object.values(statuses);
      if (values.some((s) => s === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN)) {
        return 'permissionPermanentlyDenied';
      }
      if (values.some((s) => s !== PermissionsAndroid.RESULTS.GRANTED)) {
        return 'permissionDenied';
      }
      // NOT ported: Dart also checks whether the Android <31 system Location
      // toggle is ON (Permission.locationWhenInUse.serviceStatus). RN/Expo
      // has no public API for that without a native module or expo-location
      // — scanning will just silently return nothing on affected devices
      // instead of surfacing a clear "turn on Location" message.
    } else if (state === State.Unauthorized) {
      return 'permissionPermanentlyDenied';
    }

    const adapterState = await this.manager.state();
    if (adapterState !== State.PoweredOn) return 'bluetoothOff';

    return 'ready';
  }

  async ensurePermissions(): Promise<boolean> {
    return (await this.checkPreflight()) === 'ready';
  }

  async openPermissionSettings(): Promise<void> {
    await Linking.openSettings();
  }

  async openBluetoothSettings(): Promise<void> {
    if (Platform.OS === 'android') {
      await Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS');
    } else {
      await Linking.openSettings();
    }
  }

  async openLocationSettings(): Promise<void> {
    if (Platform.OS === 'android') {
      await Linking.sendIntent('android.settings.LOCATION_SOURCE_SETTINGS');
    } else {
      await Linking.openSettings();
    }
  }

  // Scan

  /**
   * Scans for nearby Smart Air BLE devices matching the provisioning name
   * prefix. Stops automatically after `timeoutMs` (default 12s) or when the
   * returned stop function is called.
   */
  scan(handlers: ScanHandlers, timeoutMs = 12_000): () => void {
    this.manager.startDeviceScan(null, { scanMode: ScanMode.LowLatency }, (error, device) => {
      if (error) {
        handlers.onError?.(new Error(error.message));
        return;
      }
      if (!device) return;
      const name = (device.name ?? '').trim();
      if (!matchesProvisioningName(name)) return;
      handlers.onDevice({ remoteId: device.id, name, rssi: device.rssi ?? 0 });
    });

    const timer = setTimeout(() => {
      this.manager.stopDeviceScan();
    }, timeoutMs);

    return () => {
      clearTimeout(timer);
      this.manager.stopDeviceScan();
    };
  }

  async stopScan(): Promise<void> {
    await this.manager.stopDeviceScan();
  }

  // Provisioning

  /** Connect to a device by remote ID for provisioning. */
  async connect(remoteId: string): Promise<void> {
    await this.disconnect();
    let device: Device;
    try {
      device = await this.manager.connectToDevice(remoteId, { timeout: 10_000 });
      await device.discoverAllServicesAndCharacteristics();
      // Request a larger MTU so notify payloads (JSON ~70 bytes) arrive in
      // one packet — default BLE MTU payload is 20 bytes. Best-effort: some
      // Android versions/peripherals don't support MTU renegotiation.
      await this.manager.requestMTUForDevice(device.id, 256).catch(() => undefined);
    } catch (err) {
      throw new BleException(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.connectedDeviceId = device.id;
  }

  /**
   * Write SSID and password to the provisioning characteristics, wait for
   * the device to connect to WiFi, then return its reported device id and
   * local IP. Throws BleException on failure or timeout.
   */
  async sendCredentials(
    ssid: string,
    password: string,
    timeoutMs = 30_000,
  ): Promise<BleProvisioningResult> {
    const initialDeviceId = this.connectedDeviceId;
    if (!initialDeviceId) throw new BleException('Not connected');

    // Link may have dropped while the user was typing WiFi creds; reconnect once instead of failing the write.
    const stillConnected = await this.manager.isDeviceConnected(initialDeviceId).catch(() => false);
    if (!stillConnected) {
      await this.connect(initialDeviceId);
    }
    const deviceId = this.connectedDeviceId;
    if (!deviceId) throw new BleException('Not connected');

    let notifyBuffer = '';
    let subscription: Subscription | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notifyPromise = new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => {
        subscription?.remove();
        reject(
          new BleException(`Timed out waiting for device response (${Math.round(timeoutMs / 1000)}s)`),
        );
      }, timeoutMs);

      // Subscribe before writing credentials so we don't miss the response.
      subscription = this.manager.monitorCharacteristicForDevice(
        deviceId,
        BleConfig.provisioningServiceUuid,
        BleConfig.provisioningNotifyCharacteristicUuid,
        (error, characteristic) => {
          if (error || !characteristic?.value) return;
          notifyBuffer += base64ToUtf8(characteristic.value);
          if (notifyBuffer.includes('{') && notifyBuffer.includes('}')) {
            clearTimeout(timer);
            subscription?.remove();
            resolve(notifyBuffer);
          }
        },
      );
    });

    try {
      // monitorCharacteristicForDevice enables notify async with no promise to await; give it a moment to land first.
      await new Promise((resolve) => setTimeout(resolve, 200));

      await this.manager.writeCharacteristicWithResponseForDevice(
        deviceId,
        BleConfig.provisioningServiceUuid,
        BleConfig.provisioningSsidCharacteristicUuid,
        utf8ToBase64(ssid),
      );
      await this.manager.writeCharacteristicWithResponseForDevice(
        deviceId,
        BleConfig.provisioningServiceUuid,
        BleConfig.provisioningPasswordCharacteristicUuid,
        utf8ToBase64(password),
      );
    } catch (err) {
      clearTimeout(timer);
      subscription?.remove();
      throw new BleException(
        `Failed to write credentials: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const jsonStr = await notifyPromise;

    let result: Record<string, unknown>;
    try {
      result = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
      throw new BleException(`Invalid response from device: ${jsonStr}`);
    }

    if (result.status !== 'ok') {
      throw new BleException('Device failed to connect to WiFi; check password');
    }

    const resultDeviceId = typeof result.device_id === 'string' ? result.device_id : '';
    if (!resultDeviceId) throw new BleException('Device did not report its ID');

    const ip = typeof result.ip === 'string' ? result.ip.trim() : '';
    if (!ip) throw new BleException('Device did not report its local IP');

    return { deviceId: resultDeviceId.trim().toLowerCase(), ip };
  }

  // Disconnect

  async disconnect(): Promise<void> {
    const deviceId = this.connectedDeviceId;
    this.connectedDeviceId = null;
    if (!deviceId) return;
    try {
      await this.manager.cancelDeviceConnection(deviceId);
    } catch {
      // Ignore; the device may already be gone.
    }
  }

  async dispose(): Promise<void> {
    await this.stopScan();
    await this.disconnect();
    this.manager.destroy();
  }
}

export const bleService = new BleService();
