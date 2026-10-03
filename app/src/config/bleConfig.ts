export const BleConfig = {
  provisioningServiceUuid: '0000fffe-0000-1000-8000-00805f9b34fb',
  tempCharacteristicUuid: '0000ffe1-0000-1000-8000-00805f9b34fb',
  humidityCharacteristicUuid: '0000ffe2-0000-1000-8000-00805f9b34fb',
  provisioningSsidCharacteristicUuid: '0000ff01-0000-1000-8000-00805f9b34fb',
  provisioningPasswordCharacteristicUuid: '0000ff02-0000-1000-8000-00805f9b34fb',
  provisioningNotifyCharacteristicUuid: '0000ff03-0000-1000-8000-00805f9b34fb',
  provisioningDeviceNamePrefix: 'SMART_AIR_',
  legacyDeviceNamePrefix: 'SmartAir-',
} as const;

export function matchesProvisioningName(name: string): boolean {
  const normalized = name.trim();
  return (
    normalized.startsWith(BleConfig.provisioningDeviceNamePrefix) ||
    normalized.startsWith(BleConfig.legacyDeviceNamePrefix)
  );
}
