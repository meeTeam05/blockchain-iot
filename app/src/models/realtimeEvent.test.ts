import { parseRealtimeEvent } from './realtimeEvent';

describe('parseRealtimeEvent', () => {
  it('parses a full payload', () => {
    const event = parseRealtimeEvent({
      id: 'e1',
      type: 'telemetry',
      device_id: 'd1',
      occurred_at: '2024-01-01T00:00:00Z',
      payload: { temperature: 25 },
    });

    expect(event).toEqual({
      id: 'e1',
      type: 'telemetry',
      deviceId: 'd1',
      occurredAt: new Date('2024-01-01T00:00:00Z'),
      payload: { temperature: 25 },
    });
  });

  it('never throws: falls back to defaults for missing fields', () => {
    const event = parseRealtimeEvent({});
    expect(event.id).toBe('null');
    expect(event.type).toBe('');
    expect(event.deviceId).toBe('');
    expect(event.occurredAt).toEqual(new Date(0));
    expect(event.payload).toEqual({});
  });
});
