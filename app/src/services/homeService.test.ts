import { create } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { HomeService } from './homeService';

function makeService() {
  const client = create({ baseURL: 'http://example.com' });
  const mock = new MockAdapter(client);
  return { service: new HomeService(client), mock };
}

test('getHomes throws ApiException for malformed list payload', async () => {
  const { service, mock } = makeService();
  mock.onGet('/homes').reply(200, 'not-a-list');

  await expect(service.getHomes()).rejects.toMatchObject({
    message: 'Unexpected server response',
  });
});

test('createHome throws ApiException for malformed object payload', async () => {
  const { service, mock } = makeService();
  mock.onPost('/homes').reply(200, ['not', 'object']);

  await expect(service.createHome('My Home')).rejects.toMatchObject({
    message: 'Unexpected server response',
  });
});

test('getRooms throws ApiException for malformed room list payload', async () => {
  const { service, mock } = makeService();
  mock.onGet('/homes/home-1/rooms').reply(200, { not: 'a-list' });

  await expect(service.getRooms('home-1')).rejects.toMatchObject({
    message: 'Unexpected server response',
  });
});

test('string error response does not crash exception mapping', async () => {
  const { service, mock } = makeService();
  mock.onGet('/homes').reply(500, 'server exploded');

  await expect(service.getHomes()).rejects.toMatchObject({
    message: 'Unknown error',
  });
});
