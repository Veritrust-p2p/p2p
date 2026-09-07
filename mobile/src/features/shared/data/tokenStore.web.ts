import type { User } from '@/constants/appTypes';

/**
 * Web counterpart of `tokenStore.ts` — expo-secure-store is native-only, so the
 * browser build falls back to localStorage. Same shape, so callers never care
 * which target they're on.
 */

const ACCESS_KEY = 'p2p_access_token';
const REFRESH_KEY = 'p2p_refresh_token';
const USER_KEY = 'p2p_auth_user';

const read = (key: string) => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null; // storage disabled (private mode / blocked cookies)
  }
};

export const tokenStore = {
  async getAccess(): Promise<string | null> {
    return read(ACCESS_KEY);
  },
  async getRefresh(): Promise<string | null> {
    return read(REFRESH_KEY);
  },
  async getUser(): Promise<User | null> {
    const raw = read(USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as User;
    } catch {
      return null;
    }
  },
  async set(access: string, refresh: string) {
    try {
      localStorage.setItem(ACCESS_KEY, access);
      localStorage.setItem(REFRESH_KEY, refresh);
    } catch {
      /* non-fatal: the session just won't survive a reload */
    }
  },
  async setUser(user: User) {
    try {
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch {
      /* non-fatal */
    }
  },
  async clear() {
    try {
      localStorage.removeItem(ACCESS_KEY);
      localStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(USER_KEY);
    } catch {
      /* ignore */
    }
  },
};

