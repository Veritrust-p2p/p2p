/**
 * Auth context for the P2P mobile app.
 *
 * Sessions are real: `login` goes to `/api/auth/login`, which returns the token
 * pair and the full profile together, and stores the tokens in the device
 * keychain. A rejected login throws so the screen can say why.
 *
 * There used to be a mock fallback here — a failed sign-in quietly became a
 * fake `mockCurrentUser` session. It made every authenticated request 401 while
 * the app looked signed in, which reads as broken screens rather than a bad
 * password.
 */

import React, { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { User } from '@/constants/appTypes';
import { tokenStore } from '@/features/shared/data/tokenStore';
import { api, ApiError, setSessionExpiredHandler } from '@/features/shared/data/api';
import { dashboardKeys, type DashboardResponse } from '@/features/dashboard/data/dashboardApi';
import { runTeardown } from '@/features/shared/data/teardown';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /**
   * Kept for screens that gate on a server-backed session (AdminDashboard).
   * Every session is server-backed now, so this tracks `isAuthenticated`.
   */
  isRealSession: boolean;
  /**
   * True from launch until the stored session has been checked. Distinct from
   * `isLoading`, which covers a sign-in the user is watching.
   *
   * Nothing may branch on `isAuthenticated` while this is true: it is `false`
   * during the check, and a router that acts on it sends the user to the login
   * screen a moment before the restore signs them back in. Hold the splash
   * instead — see `RootNavigator`.
   */
  isBooting: boolean;
}

interface AuthContextValue extends AuthState {
  /** Throws on failure — the screen renders the message. */
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => void;
}

/**
 * How long the splash may cover the session check before we give up and show
 * the app. Generous, because a warm DB-backed request already costs 1–4.5s —
 * but bounded, because a sleeping server would otherwise hold the splash for
 * the best part of a minute, which reads as a failed launch.
 */
const RESTORE_TIMEOUT_MS = 10_000;

/** Shape of `/api/auth/me` — the fields the app actually consumes. */
interface ServerMe {
  id: string;
  username: string;
  email: string;
  fullName: string;
  phone?: string | null;
  avatarUrl?: string | null;
  role: 'user' | 'admin';
  kycStatus: 'unverified' | 'pending' | 'verified' | 'rejected';
  createdAt: string;
}

/**
 * The server tracks `user | admin`; the app's screens branch on
 * `buyer | seller | admin`. A verified KYC profile is what makes someone a
 * seller — the same rule the web uses.
 *
 * `kycStatus` is the field that decides this, and login withholding it is why
 * signing in used to cost two sequential calls. It comes back on the login
 * response now, so this maps whichever of the two carried it.
 */
function toAppUser(me: ServerMe): User {
  return {
    id: me.id,
    username: me.username,
    fullName: me.fullName,
    email: me.email,
    phone: me.phone ?? undefined,
    avatarUrl: me.avatarUrl ?? undefined,
    role: me.role === 'admin' ? 'admin' : me.kycStatus === 'verified' ? 'seller' : 'buyer',
    kycStatus: me.kycStatus,
    createdAt: me.createdAt,
  };
}

/**
 * Warm every tab NOW, rather than letting each screen start its own fetch when
 * you first tap it.
 *
 * A single DB-backed request against this database costs 1–4.5 seconds measured
 * *on the server*, before the phone's network is involved at all. Fetched lazily
 * that is a multi-second stall the first time you open each tab, which is
 * exactly what "the tabs take time to show up" is. Started here they overlap
 * with each other and with the rest of sign-in, so by the time a tab is tapped
 * its data is usually already in cache and the screen paints immediately.
 *
 * Deliberately NOT awaited: reaching the app must not block on any of them, and
 * a failure is harmless — each screen's own query retries it. They are also
 * fired together rather than in sequence, since the cost here is latency, not
 * bandwidth.
 *
 * Called from both ways into a session — signing in, and restoring one on
 * launch — because the cold cache is identical in both cases.
 */
function prefetchTabs(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.prefetchQuery({
    queryKey: dashboardKeys.data,
    queryFn: () => api<DashboardResponse>('/api/users/me/dashboard'),
  });
  // My Deals
  void queryClient.prefetchQuery({
    queryKey: ['deals', 'list', 'all'],
    queryFn: () => api('/api/escrows?limit=48'),
  });
  // My Listings
  void queryClient.prefetchQuery({
    queryKey: ['listings', 'mine'],
    queryFn: () => api('/api/listings/mine?limit=48'),
  });
  // Marketplace — the unfiltered first page, which is what it opens on.
  void queryClient.prefetchQuery({
    queryKey: ['listings', 'browse', '', ''],
    queryFn: () => api('/api/listings?limit=48'),
  });
}

const AuthContext = createContext<AuthContextValue | null>(null);


export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({
    user: null,
    isAuthenticated: false,
    isLoading: false,
    isRealSession: false,
    isBooting: true,
  });

  /**
   * Restore the session from the keychain on cold start, so a launch lands on
   * the app rather than the login screen.
   *
   * This deliberately reverses the previous behaviour, which cleared the tokens
   * here and required credentials every launch. The reason it was written that
   * way is real and worth keeping in mind: restoring naively makes the login
   * screen appear and then sign itself in a second later, with nobody typing —
   * which looks broken. But the flash was the complaint, not persistence, and
   * the flash is a rendering problem, not a reason to throw the session away.
   *
   * It is fixed by holding the native splash over this check: `isBooting` stays
   * true until we know the answer, `RootNavigator` renders nothing while it is,
   * and the splash hides on the far side. The user sees the splash, then the
   * app — never a login screen they were about to skip past.
   *
   * `api()` transparently refreshes an expired access token, so this survives a
   * device sitting unused for longer than an access token lives. A rejection —
   * spent refresh token, revoked session, deleted account — clears the tokens
   * and lands signed out, which is the same place the old code always started.
   * A timeout is treated differently; see the catch.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [access, refresh, cachedUser] = await Promise.all([
        tokenStore.getAccess().catch(() => null),
        tokenStore.getRefresh().catch(() => null),
        tokenStore.getUser().catch(() => null),
      ]);

      if (!access && !refresh) {
        // Never signed in on this device, or signed out last time.
        if (!cancelled) setState((s) => ({ ...s, isBooting: false }));
        return;
      }

      // If we have a cached user profile and credentials, immediately hydrate
      // the session so cold starts don't block on network round-trips.
      if (cachedUser && !cancelled) {
        prefetchTabs(queryClient);
        setState({
          user: cachedUser,
          isAuthenticated: true,
          isLoading: false,
          isRealSession: true,
          isBooting: false,
        });
      }

      try {
        const me = await Promise.race([
          api<ServerMe>('/api/auth/me'),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('restore-timeout')), RESTORE_TIMEOUT_MS),
          ),
        ]);
        if (cancelled) return;
        const freshUser = toAppUser(me);
        await tokenStore.setUser(freshUser);
        prefetchTabs(queryClient);
        setState({
          user: freshUser,
          isAuthenticated: true,
          isLoading: false,
          isRealSession: true,
          isBooting: false,
        });
      } catch (err) {
        /*
          Only an explicit 401 or 403 (invalid / expired token that could not be
          refreshed) means the session is dead.
          Timeouts, network errors (status 0), and sleeping servers are NOT
          grounds for wiping tokens or signing the user out.
        */
        const isAuthRejection = err instanceof ApiError && (err.status === 401 || err.status === 403);
        if (isAuthRejection) {
          await tokenStore.clear();
          if (cancelled) return;
          setState({
            user: null,
            isAuthenticated: false,
            isLoading: false,
            isRealSession: false,
            isBooting: false,
          });
        } else {
          // If we had no cached user profile to restore earlier, mark booting complete
          // so the app can finish loading without clearing stored credentials.
          if (!cancelled && !cachedUser) {
            setState((s) => ({ ...s, isBooting: false }));
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  const login = useCallback(async (identifier: string, password: string) => {
    setState((s) => ({ ...s, isLoading: true }));
    try {
      const { user, tokens } = await api<{
        user: ServerMe;
        tokens: { accessToken: string; refreshToken: string };
      }>('/api/auth/login', { method: 'POST', body: { identifier, password } });
      await tokenStore.set(tokens.accessToken, tokens.refreshToken);
      const appUser = toAppUser(user);
      await tokenStore.setUser(appUser);

      prefetchTabs(queryClient);

      /*
        No second `/me` call. Login used to withhold `kycStatus` — the field
        that decides the persona — so signing in cost two sequential round
        trips before the app knew which face to show. It returns the full
        profile now, so this is the same information one request earlier.
      */
      setState({
        user: appUser,
        isAuthenticated: true,
        isLoading: false,
        isRealSession: true,
        isBooting: false,
      });
    } catch (err) {
      // Leave no half-session behind before handing the error to the screen.
      await tokenStore.clear();
      setState({ user: null, isAuthenticated: false, isLoading: false, isRealSession: false, isBooting: false });
      throw err;
    }
  }, [queryClient]);

  const logout = useCallback(() => {
    queryClient.clear(); // never show one account's data to the next
    // Closes the chat socket if one was ever opened. It authenticates once at
    // handshake and stays open, so clearing the tokens isn't enough — left
    // connected it would keep delivering the previous account's messages to
    // whoever signs in next.
    runTeardown();
    setState({ user: null, isAuthenticated: false, isLoading: false, isRealSession: false, isBooting: false });

    /*
      Revoke the session server-side, then drop the tokens locally.

      Clearing the store alone only forgets the refresh token — it stays valid
      in the `Session` table until it expires, so a copy lifted off the device
      could still mint access tokens for an account that had signed out. The web
      has always posted this; mobile never did.

      Deliberately not awaited and deliberately swallowing errors: signing out
      must not fail or hang because the network is down. The local half below
      runs regardless, so the worst case is a server session that outlives the
      sign-out — exactly today's behaviour — rather than a user stuck signed in.
    */
    void (async () => {
      const refreshToken = await tokenStore.getRefresh().catch(() => null);
      if (refreshToken) {
        await api('/api/auth/logout', {
          method: 'POST',
          body: { refreshToken },
        }).catch(() => undefined);
      }
      await tokenStore.clear();
    })();
  }, [queryClient]);

  // A spent refresh token signs the user out rather than leaving screens
  // retrying against a dead session.
  useEffect(() => {
    setSessionExpiredHandler(() => logout());
    return () => setSessionExpiredHandler(null);
  }, [logout]);

  const value = useMemo(() => ({ ...state, login, logout }), [state, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
