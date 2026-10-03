import { parseDeviceOtaCatalog } from './ota';

describe('parseDeviceOtaCatalog', () => {
  it('parses a full payload', () => {
    const catalog = parseDeviceOtaCatalog({
      device_id: 'd1',
      current_version: '1.0.0',
      device_online: true,
      versions: [{ version: '1.1.0', filename: 'fw.bin', url: 'https://example.com/fw.bin' }],
    });

    expect(catalog).toEqual({
      deviceId: 'd1',
      currentVersion: '1.0.0',
      deviceOnline: true,
      versions: [{ version: '1.1.0', filename: 'fw.bin', url: 'https://example.com/fw.bin' }],
    });
  });

  it('throws on malformed payload', () => {
    expect(() => parseDeviceOtaCatalog({ not: 'a-catalog' })).toThrow();
  });
});
