import * as SecureStore from 'expo-secure-store';
import { SecureStorage } from './secureStorage';

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

describe('SecureStorage.getUserJson', () => {
  beforeEach(() => {
    (SecureStore as unknown as { __store: Map<string, string> }).__store.clear();
  });

  it('returns null and clears malformed JSON', async () => {
    await SecureStore.setItemAsync('user_json', '{broken-json');

    const storage = new SecureStorage();
    const userJson = await storage.getUserJson();

    expect(userJson).toBeNull();
    expect(await SecureStore.getItemAsync('user_json')).toBeNull();
  });

  it('returns null and clears non-object JSON', async () => {
    await SecureStore.setItemAsync('user_json', '["not","object"]');

    const storage = new SecureStorage();
    const userJson = await storage.getUserJson();

    expect(userJson).toBeNull();
    expect(await SecureStore.getItemAsync('user_json')).toBeNull();
  });
});
