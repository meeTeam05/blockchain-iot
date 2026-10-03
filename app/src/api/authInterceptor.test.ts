import { create } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { attachAuthInterceptor, getAccessToken, setAccessToken } from './authInterceptor';
import { useForceLogoutSignal } from './forceLogoutSignal';
import { AuthException } from './appException';
import { SecureStorage } from '../storage/secureStorage';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    setItemAsync: jest.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    deleteItemAsync: jest.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    __store: store,
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const secureStoreMock = require('expo-secure-store') as { __store: Map<string, string> };

beforeEach(() => {
  secureStoreMock.__store.clear();
  setAccessToken('expired-token');
  useForceLogoutSignal.setState({ count: 0 });
});

afterEach(() => {
  setAccessToken(null);
});

test('malformed refresh payload forces logout instead of crashing', async () => {
  const storage = new SecureStorage();
  await storage.saveRefreshToken('refresh-1');

  const client = create({ baseURL: 'http://example.com' });
  attachAuthInterceptor(client, storage);
  const mock = new MockAdapter(client);

  mock.onPost('/auth/refresh').reply(200, 'not-an-object');
  mock.onGet('/protected').reply(401, { error: 'expired' });

  await expect(client.get('/protected')).rejects.toBeInstanceOf(AuthException);

  expect(getAccessToken()).toBeNull();
  expect(await storage.getRefreshToken()).toBeNull();
  expect(useForceLogoutSignal.getState().count).toBe(1);
});

test('invalid refreshToken field type is ignored during successful refresh', async () => {
  const storage = new SecureStorage();
  await storage.saveRefreshToken('refresh-1');

  const client = create({ baseURL: 'http://example.com' });
  attachAuthInterceptor(client, storage);
  const mock = new MockAdapter(client);

  let authorized = false;
  mock.onPost('/auth/refresh').reply(() => {
    authorized = true;
    return [200, { accessToken: 'fresh-token', refreshToken: 42 }];
  });
  mock.onGet('/protected').reply(() => (authorized ? [200, { ok: true }] : [401, { error: 'expired' }]));

  const response = await client.get('/protected');

  expect(response.data).toEqual({ ok: true });
  expect(getAccessToken()).toBe('fresh-token');
  expect(await storage.getRefreshToken()).toBe('refresh-1');
  expect(useForceLogoutSignal.getState().count).toBe(0);
});
