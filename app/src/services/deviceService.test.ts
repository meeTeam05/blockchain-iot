import { create } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { DeviceService } from './deviceService';

function makeService() {
  const client = create({ baseURL: 'http://example.com' });
  const mock = new MockAdapter(client);
  return { service: new DeviceService(client), mock };
}

test('getDevices throws ApiException for malformed list payload', async () => {
  const { service, mock } = makeService();
  mock.onGet('/devices').reply(200, { not: 'a-list' });

  await expect(service.getDevices()).rejects.toMatchObject({
    message: 'Unexpected server response',
  });
});

test('getShadow throws ApiException for malformed object payload', async () => {
  const { service, mock } = makeService();
  mock.onGet('/devices/aa:bb:cc:dd:ee:ff/shadow').reply(200, ['bad']);

  await expect(service.getShadow('AA:BB:CC:DD:EE:FF')).rejects.toMatchObject({
    message: 'Unexpected server response',
  });
});

test('sendCommand throws ApiException for malformed command response', async () => {
  const { service, mock } = makeService();
  mock.onPost('/devices/aa:bb:cc:dd:ee:ff/command').reply(200, ['bad']);

  await expect(service.sendCommand('AA:BB:CC:DD:EE:FF', { type: 'noop' })).rejects.toMatchObject({
    message: 'Unexpected server response',
  });
});

test('string error response does not crash exception mapping', async () => {
  const { service, mock } = makeService();
  mock.onGet('/devices').reply(500, 'server exploded');

  await expect(service.getDevices()).rejects.toMatchObject({ message: 'Unknown error' });
});

test('setRelay rejects channel outside 1..3', async () => {
  const { service } = makeService();
  await expect(service.setRelay('aa:bb:cc:dd:ee:ff', 4, true)).rejects.toThrow(RangeError);
});

test('getTelemetry silently drops points with an unparseable ts', async () => {
  const { service, mock } = makeService();
  mock.onGet('/devices/aa:bb:cc:dd:ee:ff/telemetry').reply(200, [
    { ts: '2024-01-01T00:00:00Z', temperature: 25 },
    { ts: 'not-a-date', temperature: 30 },
  ]);

  const points = await service.getTelemetry('AA:BB:CC:DD:EE:FF');
  expect(points).toHaveLength(1);
  expect(points[0].temperature).toBe(25);
});

test('waitForCommandCompletion resolves once the command reaches a terminal status', async () => {
  const { service, mock } = makeService();
  let call = 0;
  mock.onGet('/devices/aa:bb:cc:dd:ee:ff/commands').reply(() => {
    call += 1;
    const status = call < 2 ? 'pending' : 'done';
    return [
      200,
      [{ id: 'cmd-1', payload: {}, status, created_at: '2024-01-01T00:00:00Z' }],
    ];
  });

  const command = await service.waitForCommandCompletion('AA:BB:CC:DD:EE:FF', 'cmd-1', {
    timeoutMs: 5000,
    pollIntervalMs: 1,
  });
  expect(command.status).toBe('done');
  expect(call).toBeGreaterThanOrEqual(2);
});

test('waitForCommandCompletion throws once the timeout elapses', async () => {
  const { service, mock } = makeService();
  mock.onGet('/devices/aa:bb:cc:dd:ee:ff/commands').reply(200, [
    { id: 'cmd-1', payload: {}, status: 'pending', created_at: '2024-01-01T00:00:00Z' },
  ]);

  await expect(
    service.waitForCommandCompletion('AA:BB:CC:DD:EE:FF', 'cmd-1', {
      timeoutMs: 5,
      pollIntervalMs: 2,
    }),
  ).rejects.toThrow(/did not finish/);
});

test('setAi posts the typed AI command and returns the command id', async () => {
  const { service, mock } = makeService();
  mock.onPost('/devices/aa:bb:cc:dd:ee:ff/ai', { state: true }).reply(201, { command_id: 'cmd-ai' });

  await expect(service.setAi('AA:BB:CC:DD:EE:FF', true)).resolves.toBe('cmd-ai');
});

test('setAi surfaces the server error message', async () => {
  const { service, mock } = makeService();
  mock.onPost('/devices/aa:bb:cc:dd:ee:ff/ai').reply(403, { error: 'Forbidden' });

  await expect(service.setAi('aa:bb:cc:dd:ee:ff', false)).rejects.toMatchObject({ message: 'Forbidden' });
});
