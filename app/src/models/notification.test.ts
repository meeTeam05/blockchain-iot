import { parseNotificationItem } from './notification';

describe('parseNotificationItem', () => {
  it('parses a full payload', () => {
    const item = parseNotificationItem({
      id: 'n1',
      type: 'alert',
      device_id: 'd1',
      device_name: 'Sensor',
      title: 'High CO',
      body: 'CO level above threshold',
      severity: 'critical',
      occurred_at: '2024-01-01T00:00:00Z',
      payload: { co_ppm: 40 },
    });

    expect(item).toEqual({
      id: 'n1',
      type: 'alert',
      deviceId: 'd1',
      deviceName: 'Sensor',
      title: 'High CO',
      body: 'CO level above threshold',
      severity: 'critical',
      occurredAt: new Date('2024-01-01T00:00:00Z'),
      payload: { co_ppm: 40 },
    });
  });

  it('never throws: falls back to defaults for missing/malformed fields', () => {
    const item = parseNotificationItem({ id: 42 });

    expect(item.id).toBe('42');
    expect(item.type).toBe('');
    expect(item.deviceId).toBe('');
    expect(item.severity).toBe('info');
    expect(item.payload).toEqual({});
    expect(item.occurredAt).toEqual(new Date(0));
  });

  it('falls back to epoch for an unparseable occurred_at', () => {
    const item = parseNotificationItem({ id: 'n1', occurred_at: 'not-a-date' });
    expect(item.occurredAt).toEqual(new Date(0));
  });
});
