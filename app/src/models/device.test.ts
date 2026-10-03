import { parseDevice } from './device';

describe('parseDevice', () => {
  it('parses a full device payload and maps snake_case to camelCase', () => {
    const device = parseDevice({
      id: 'd1',
      name: 'Living room sensor',
      home_id: 'h1',
      room_id: 'r1',
      online: true,
      last_seen: '2024-01-01T00:00:00Z',
      firmware_ver: '1.2.3',
      mode: 'auto',
      relay_1: true,
      relay_2: false,
      relay_3: null,
      created_at: '2023-12-01T00:00:00Z',
    });

    expect(device).toEqual({
      id: 'd1',
      name: 'Living room sensor',
      homeId: 'h1',
      roomId: 'r1',
      online: true,
      lastSeen: new Date('2024-01-01T00:00:00Z'),
      firmwareVer: '1.2.3',
      mode: 'auto',
      relay1: true,
      relay2: false,
      relay3: null,
      createdAt: new Date('2023-12-01T00:00:00Z'),
    });
  });

  it('defaults optional/nullable fields when absent', () => {
    const device = parseDevice({ id: 'd1', name: 'Sensor', home_id: 'h1' });

    expect(device.roomId).toBeNull();
    expect(device.online).toBe(false);
    expect(device.lastSeen).toBeNull();
    expect(device.createdAt).toBeNull();
  });

  it('throws on missing required fields', () => {
    expect(() => parseDevice({ name: 'Sensor', home_id: 'h1' })).toThrow();
  });

  it('throws on malformed datetime', () => {
    expect(() =>
      parseDevice({ id: 'd1', name: 'Sensor', home_id: 'h1', last_seen: 'not-a-date' }),
    ).toThrow();
  });
});
