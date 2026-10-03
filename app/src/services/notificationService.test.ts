import { create } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { NotificationService } from './notificationService';
import { ApiException, NetworkException } from '../api/appException';

function makeService() {
  const client = create({ baseURL: 'http://example.com' });
  const mock = new MockAdapter(client);
  return { service: new NotificationService(client), mock };
}

test('listNotifications throws ApiException for malformed list payload', async () => {
  const { service, mock } = makeService();
  mock.onGet('/notifications').reply(200, { not: 'a-list' });

  await expect(service.listNotifications()).rejects.toBeInstanceOf(ApiException);
});

test('listNotifications parses a well-formed list', async () => {
  const { service, mock } = makeService();
  mock.onGet('/notifications').reply(200, [
    {
      id: 'n1',
      type: 'device.offline',
      device_id: 'd1',
      device_name: 'Sensor',
      title: 'Device went offline',
      body: 'Device is no longer reporting.',
      severity: 'warning',
      occurred_at: '2024-01-01T00:00:00Z',
      payload: {},
    },
  ]);

  const items = await service.listNotifications();
  expect(items).toHaveLength(1);
  expect(items[0].title).toBe('Device went offline');
});

test('network error maps to NetworkException', async () => {
  const { service, mock } = makeService();
  mock.onGet('/notifications').networkError();

  await expect(service.listNotifications()).rejects.toBeInstanceOf(NetworkException);
});
