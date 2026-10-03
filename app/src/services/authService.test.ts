import { create } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { AuthService } from './authService';
import { ApiException } from '../api/appException';

function makeService() {
  const client = create({ baseURL: 'http://example.com' });
  const mock = new MockAdapter(client);
  return { service: new AuthService(client), mock };
}

test('login throws ApiException for malformed success payload', async () => {
  const { service, mock } = makeService();
  mock.onPost('/auth/login').reply(200, 'not-an-object');

  await expect(service.login('a@example.com', 'pw')).rejects.toMatchObject({
    message: 'Unexpected server response',
  });
  await expect(service.login('a@example.com', 'pw')).rejects.toBeInstanceOf(ApiException);
});

test('register throws ApiException for malformed success payload', async () => {
  const { service, mock } = makeService();
  mock.onPost('/auth/register').reply(200, ['not', 'object']);

  await expect(service.register('a@example.com', 'pw', 'Nhat')).rejects.toMatchObject({
    message: 'Unexpected server response',
  });
});

test('refresh ignores invalid optional refreshToken field type', async () => {
  const { service, mock } = makeService();
  mock.onPost('/auth/refresh').reply(200, { accessToken: 'fresh-token', refreshToken: 42 });

  const result = await service.refresh('refresh-1');

  expect(result.accessToken).toBe('fresh-token');
  expect(result.refreshToken).toBeNull();
});

test('string error response does not crash exception mapping', async () => {
  const { service, mock } = makeService();
  mock.onPost('/auth/login').reply(500, 'server exploded');

  await expect(service.login('a@example.com', 'pw')).rejects.toMatchObject({
    message: 'Unknown error',
  });
});
