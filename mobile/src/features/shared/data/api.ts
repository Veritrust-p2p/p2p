import { API_URL } from './config';
import { tokenStore } from './tokenStore';

/**
 * API client — the mobile twin of `web/src/features/shared/libs/api.ts`.
 *
 * Same contract: attach the access token, transparently refresh once on a 401
 * and retry, and normalise failures into ApiError so screens can render
 * `apiErrorMessage(err)` without unwrapping anything.
 *
 * Every screen goes through here now — admin was simply the first to.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Best-effort human message from anything thrown by the client. */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong. Please try again.';
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
}

/** Session-expiry hook — AuthContext registers a callback to sign the user out. */
let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(fn: (() => void) | null) {
  onSessionExpired = fn;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>(path, options, true);
}

/**
 * Multipart upload — the same contract as `api()`, but for a file body.
 *
 * Separate from `request` for one reason: **Content-Type must not be set**.
 * `fetch` generates a `multipart/form-data` header including the boundary it
 * chose, and setting the header by hand overwrites that boundary, leaving the
 * server unable to split the parts. That failure looks like "no file uploaded"
 * rather than a header problem, so it's worth being explicit about.
 */
export async function apiUpload<T>(path: string, formData: FormData): Promise<T> {
  return uploadRequest<T>(path, formData, true);
}

async function uploadRequest<T>(
  path: string,
  formData: FormData,
  allowRefresh: boolean,
): Promise<T> {
  const headers: Record<string, string> = {};
  const access = await tokenStore.getAccess();
  if (access) headers.Authorization = `Bearer ${access}`;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { method: 'POST', headers, body: formData });
  } catch {
    throw new ApiError(0, `Can't reach the server at ${API_URL}. Check you're on the same network.`);
  }

  // An upload can easily outlive a short-lived access token, so it gets the
  // same refresh-and-retry treatment as every other call.
  if (res.status === 401 && allowRefresh && access) {
    try {
      const refreshed = await refreshTokens();
      if (refreshed) return uploadRequest<T>(path, formData, false);
      await tokenStore.clear();
      onSessionExpired?.();
    } catch (err) {
      // Network failure while attempting refresh — keep tokens and propagate error.
      throw err;
    }
  }

  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data as { error?: string } | null)?.error ?? res.statusText ?? 'Upload failed',
      (data as { details?: unknown } | null)?.details,
    );
  }
  return data as T;
}

async function request<T>(path: string, options: RequestOptions, allowRefresh: boolean): Promise<T> {
  const { method = 'GET', body } = options;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const access = await tokenStore.getAccess();
  if (access) headers.Authorization = `Bearer ${access}`;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // No response at all — almost always the phone can't see the dev machine.
    throw new ApiError(0, `Can't reach the server at ${API_URL}. Check you're on the same network.`);
  }

  if (res.status === 401 && allowRefresh && access) {
    try {
      const refreshed = await refreshTokens();
      if (refreshed) return request<T>(path, options, false);
      await tokenStore.clear();
      onSessionExpired?.();
    } catch (err) {
      // Network failure while attempting refresh — keep tokens and propagate error.
      throw err;
    }
  }

  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data as { error?: string } | null)?.error ?? res.statusText ?? 'Request failed',
      (data as { details?: unknown } | null)?.details,
    );
  }
  return data as T;
}

/**
 * Rotate the token pair. Returns false when the refresh token is spent.
 *
 * Exported because the chat socket needs it too: a rejected handshake is the
 * socket's version of a 401, and it recovers the same way this client does.
 */
let refreshPromise: Promise<boolean> | null = null;

export function refreshTokens(): Promise<boolean> {
  /*
    Exactly one refresh in flight at a time — concurrent 401s share it. The web
    client has always done this (`web/src/features/shared/libs/api.ts`); mobile
    never did, and the difference signed people out.

    The server rotates on refresh and treats a *second* presentation of an
    already-rotated token as theft: `auth.service.ts` revokes every session the
    user has and answers "Session reuse detected". That is the right thing to do
    about a stolen token, but two of our own requests racing look identical to
    it from the server's side.

    Which is what happens on resume. Several queries refetch at once when the
    app comes back to the foreground; if the access token expired while it was
    away they all 401 together, all read the same refresh token, and all post
    it. The first rotates. The rest present a token the server has just revoked,
    so it revokes everything — including the pair the first call had only
    just been issued — and the app drops to the login screen with a session
    that was perfectly valid a moment earlier.

    Sharing one promise means the losers of that race never post at all: they
    wait for the winner and read the rotated pair out of the store.
  */
  refreshPromise ??= doRefresh().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function doRefresh(): Promise<boolean> {
  const refreshToken = await tokenStore.getRefresh();
  if (!refreshToken) return false;
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    throw new ApiError(0, `Can't reach the server at ${API_URL}. Check you're on the same network.`);
  }
  if (!res.ok) return false;
  // The endpoint wraps the pair: { tokens: { accessToken, refreshToken } }
  const body = (await res.json()) as { tokens?: { accessToken?: string; refreshToken?: string } };
  const tokens = body.tokens;
  if (!tokens?.accessToken || !tokens?.refreshToken) return false;
  await tokenStore.set(tokens.accessToken, tokens.refreshToken);
  return true;
}

