import { useAuthStore, onSessionInvalidated } from './authStore';
import { useForceLogoutSignal } from '../api/forceLogoutSignal';
import { getAccessToken, setAccessToken } from '../api/authInterceptor';
import { authService } from '../services/authService';
import { SecureStorage } from '../storage/secureStorage';
import * as SecureStore from 'expo-secure-store';

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

jest.mock('../services/authService', () => ({
  authService: {
    login: jest.fn(),
    register: jest.fn(),
    logout: jest.fn(),
    refresh: jest.fn(),
  },
}));

const secureStoreMock = SecureStore as unknown as { __store: Map<string, string> };

beforeEach(() => {
  secureStoreMock.__store.clear();
  useAuthStore.setState({ status: 'loading', user: null, error: null });
  useForceLogoutSignal.setState({ count: 0 });
  setAccessToken(null);
  jest.clearAllMocks();
});

test('restore: unauthenticated when no refresh token stored', async () => {
  await useAuthStore.getState().restore();

  expect(useAuthStore.getState().status).toBe('unauthenticated');
  expect(useAuthStore.getState().user).toBeNull();
});

test('restore: authenticated when refresh token + cached user exist', async () => {
  const storage = new SecureStorage();
  await storage.saveRefreshToken('rt-1');
  await storage.saveUserJson({ id: 'u1', email: 'a@b.com', full_name: 'A' });

  await useAuthStore.getState().restore();

  expect(useAuthStore.getState().status).toBe('authenticated');
  expect(useAuthStore.getState().user).toEqual({ id: 'u1', email: 'a@b.com', fullName: 'A' });
});

test('login: sets access token, persists session, updates state', async () => {
  (authService.login as jest.Mock).mockResolvedValue({
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    user: { id: 'u1', email: 'a@b.com', fullName: null },
  });

  await useAuthStore.getState().login('a@b.com', 'pw');

  expect(useAuthStore.getState().status).toBe('authenticated');
  expect(getAccessToken()).toBe('at-1');
  const storage = new SecureStorage();
  expect(await storage.getRefreshToken()).toBe('rt-1');
});

test('login: failure sets error status without throwing', async () => {
  (authService.login as jest.Mock).mockRejectedValue(new Error('bad creds'));

  await useAuthStore.getState().login('a@b.com', 'wrong');

  expect(useAuthStore.getState().status).toBe('error');
  expect(useAuthStore.getState().error).toBeInstanceOf(Error);
});

test('logout: clears state and fires session-invalidation hooks', async () => {
  (authService.logout as jest.Mock).mockResolvedValue(undefined);
  const hook = jest.fn();
  onSessionInvalidated(hook);

  await useAuthStore.getState().logout();

  expect(useAuthStore.getState().status).toBe('unauthenticated');
  expect(getAccessToken()).toBeNull();
  expect(hook).toHaveBeenCalled();
});

test('forced logout signal clears session state', () => {
  useAuthStore.setState({
    status: 'authenticated',
    user: { id: 'u1', email: 'a@b.com', fullName: null },
    error: null,
  });

  useForceLogoutSignal.getState().bump();

  expect(useAuthStore.getState().status).toBe('unauthenticated');
  expect(useAuthStore.getState().user).toBeNull();
});
