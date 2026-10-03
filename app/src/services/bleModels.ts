export type RssiLevel = 'strong' | 'medium' | 'weak';

export interface BleDeviceInfo {
  /** Platform device ID: MAC address on Android, UUID on iOS. */
  remoteId: string;
  name: string;
  rssi: number;
}

export function rssiLevel(rssi: number): RssiLevel {
  if (rssi >= -60) return 'strong';
  if (rssi >= -80) return 'medium';
  return 'weak';
}

export interface BleProvisioningResult {
  deviceId: string;
  ip: string;
}

export type BlePreflightStatus =
  | 'ready'
  | 'unsupported'
  | 'bluetoothOff'
  | 'permissionDenied'
  | 'permissionPermanentlyDenied'
  | 'locationOff';

export class BleException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BleException';
  }
}
