import * as SecureStore from 'expo-secure-store';

const REFRESH_TOKEN_KEY = 'refresh_token';
const USER_KEY = 'user_json';

// expo-secure-store has no deleteAll()/enumerate-keys API (unlike Dart's
// flutter_secure_storage) — every key this module ever writes must be
// listed here so clear() stays exhaustive as keys are added.
const ALL_KEYS = [REFRESH_TOKEN_KEY, USER_KEY] as const;

export class SecureStorage {
  saveRefreshToken(token: string): Promise<void> {
    return SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
  }

  getRefreshToken(): Promise<string | null> {
    return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  }

  saveUserJson(user: Record<string, unknown>): Promise<void> {
    return SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
  }

  async getUserJson(): Promise<Record<string, unknown> | null> {
    const raw = await SecureStore.getItemAsync(USER_KEY);
    if (raw === null) return null;

    try {
      const decoded: unknown = JSON.parse(raw);
      if (decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)) {
        return decoded as Record<string, unknown>;
      }
    } catch {
      // Fall through and clear the corrupt session blob below.
    }
    await SecureStore.deleteItemAsync(USER_KEY);
    return null;
  }

  async clear(): Promise<void> {
    await Promise.all(ALL_KEYS.map((key) => SecureStore.deleteItemAsync(key)));
  }
}
