import * as SecureStore from 'expo-secure-store';
import type { User } from '@/constants/appTypes';

/**
 * Auth token and session profile storage — the native implementation, backed by
 * the OS keychain (Keychain on iOS, EncryptedSharedPreferences on Android).
 *
 * `tokenStore.web.ts` sits beside this file for the web target, because
 * expo-secure-store has no browser implementation. Metro picks the right one.
 */

const ACCESS_KEY = 'p2p_access_token';
const REFRESH_KEY = 'p2p_refresh_token';
const USER_KEY = 'p2p_auth_user';

export const tokenStore = {
  async getAccess(): Promise<string | null> {
    return SecureStore.getItemAsync(ACCESS_KEY).catch(() => null);
  },
  async getRefresh(): Promise<string | null> {
    return SecureStore.getItemAsync(REFRESH_KEY).catch(() => null);
  },
  async getUser(): Promise<User | null> {
    try {
      const raw = await SecureStore.getItemAsync(USER_KEY);
      return raw ? (JSON.parse(raw) as User) : null;
    } catch {
      return null;
    }
  },
  async set(access: string, refresh: string) {
    await SecureStore.setItemAsync(ACCESS_KEY, access);
    await SecureStore.setItemAsync(REFRESH_KEY, refresh);
  },
  async setUser(user: User) {
    await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user)).catch(() => undefined);
  },
  async clear() {
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_KEY).catch(() => undefined),
      SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => undefined),
      SecureStore.deleteItemAsync(USER_KEY).catch(() => undefined),
    ]);
  },
};

