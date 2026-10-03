import { parseTelemetryPoint, tryParseTelemetryPoint } from './telemetry';

describe('parseTelemetryPoint', () => {
  it('parses a full payload', () => {
    const point = parseTelemetryPoint({
      ts: '2024-01-01T00:00:00Z',
      temperature: 25.5,
      humidity: 60,
      co_ppm: 1.2,
      no2_ppm: 0.3,
      mode: 'auto',
    });

    expect(point).toEqual({
      ts: new Date('2024-01-01T00:00:00Z'),
      temperature: 25.5,
      humidity: 60,
      coPpm: 1.2,
      no2Ppm: 0.3,
      mode: 'auto',
    });
  });

  it('throws when ts is missing', () => {
    expect(() => parseTelemetryPoint({ temperature: 25 })).toThrow();
  });
});

describe('tryParseTelemetryPoint', () => {
  it('returns null when ts is missing', () => {
    expect(tryParseTelemetryPoint({ temperature: 25 })).toBeNull();
  });

  it('returns null when ts is unparseable', () => {
    expect(tryParseTelemetryPoint({ ts: 'not-a-date' })).toBeNull();
  });

  it('still throws when a non-ts field is malformed', () => {
    expect(() =>
      tryParseTelemetryPoint({ ts: '2024-01-01T00:00:00Z', temperature: 'hot' }),
    ).toThrow();
  });

  it('parses successfully when ts is valid', () => {
    const point = tryParseTelemetryPoint({ ts: '2024-01-01T00:00:00Z', humidity: 55 });
    expect(point).toEqual({
      ts: new Date('2024-01-01T00:00:00Z'),
      temperature: null,
      humidity: 55,
      coPpm: null,
      no2Ppm: null,
      mode: null,
    });
  });
});
