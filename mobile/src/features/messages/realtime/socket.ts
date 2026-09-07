import { io, type Socket } from 'socket.io-client';
import { API_URL } from '@/features/shared/data/config';
import { refreshTokens } from '@/features/shared/data/api';
import { tokenStore } from '@/features/shared/data/tokenStore';
import { registerTeardown } from '@/features/shared/data/teardown';

/**
 * The app's single WebSocket connection — the mobile twin of
 * `web/src/features/messages/realtime/socket.ts`.
 *
 * A module-level singleton rather than per-screen state, for the same reason
 * the web keeps one: the server joins every socket to a `user:<id>` room on
 * connect, and that room is how a new message reaches you when you aren't
 * looking at the thread it belongs to.
 *
 * Mobile needs it for one thing REST can't do. `POST /api/messages/:username`
 * validates **`body` only** — there is no field on it for a file. Attachments
 * exist solely on the socket's `message:send`, so an image sent over REST can
 * only ever be a text message that happens to contain a URL. Evidence in a
 * dispute needs to be a real `file` message carrying name, mime and size, and
 * this is the only transport that produces one.
 */

/** Server ack envelope — mirrors the REST error shape (see messages.gateway.ts). */
export type Ack<T> =
  | { ok: true; data: T }
  | { ok: false; error: { status: number; message: string; details?: unknown } };

/** All four fields are required by the server's Joi schema. Max size is 10MB. */
export interface Attachment {
  url: string;
  name: string;
  mime: string;
  size: number;
}

let socket: Socket | null = null;
let refreshing = false;

export function getSocket(): Socket {
  if (socket) return socket;

  socket = io(API_URL, {
    /**
     * A function, not a static object, and asynchronous — which is the one real
     * difference from the web. There the token sits in `localStorage` and can be
     * read synchronously; here it lives in the OS keychain behind
     * `expo-secure-store`, so the callback resolves a promise before handing the
     * token over. socket.io waits for `cb` either way, and because it re-runs
     * this on every reconnect, a socket that reconnects after a token refresh
     * automatically carries the new one.
     */
    auth: (cb) => {
      void tokenStore.getAccess().then((token) => cb({ token: token ?? '' }));
    },
    /**
     * React Native has no long-polling fallback worth using, and the default
     * upgrade dance costs an extra round trip on a link where round trips are
     * already seconds. Go straight to the WebSocket.
     */
    transports: ['websocket'],

    /**
     * Bounded reconnection — the important part now that this socket is opened
     * on every signed-in screen rather than only inside a chat.
     *
     * socket.io retries forever by default. On a phone that can't reach the dev
     * machine that meant an endless connect → fail → log cycle running behind
     * whatever screen you were on, competing with rendering and filling the dev
     * error log. Six attempts over roughly half a minute is enough to ride out a
     * flaky moment; past that the host is genuinely unreachable and retrying is
     * just noise. `reconnectSocket()` below is how it comes back.
     */
    reconnectionAttempts: 6,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 8_000,
    timeout: 10_000,
  });

  /**
   * Handled, and deliberately quiet.
   *
   * A connect error is expected — the phone drops off Wi-Fi, the dev server
   * restarts. Chat is not essential to any other screen, so a failure here must
   * stay silent rather than surface as an error on top of whatever the user is
   * actually looking at. The one case worth acting on is a rejected handshake,
   * which is the socket's 401.
   */
  socket.on('connect_error', async (err: Error) => {
    if (err.message !== 'Invalid or expired token' || refreshing) return;
    refreshing = true;
    try {
      const refreshed = await refreshTokens();
      // The refresh token is spent too, so the session is genuinely gone. Stop
      // retrying rather than hammering a server that will keep saying no.
      if (!refreshed) disconnectSocket();
    } catch {
      // Network failure while refreshing tokens — keep socket quiet until network recovers
    } finally {
      refreshing = false;
    }
  });

  // Logout closes it. Registered here rather than imported by AuthContext, so
  // this module — and socket.io-client with it — stays out of the startup
  // bundle until a chat is actually opened.
  registerTeardown(disconnectSocket);

  return socket;
}

/** Tear down on logout — a signed-out app must stop receiving notifications. */
export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

/**
 * Emit and await the server's ack, rejecting on `{ ok: false }`.
 *
 * Without this every caller would have to unpack the envelope by hand, and a
 * refusal would look like success. The timeout matters more here than on the
 * web: if the socket is mid-reconnect the ack simply never arrives, and the
 * send would otherwise hang with a spinner and no way out.
 */
export function emitWithAck<T>(event: string, payload: unknown, timeoutMs = 20_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Couldn't reach the chat server. Check your connection and try again."));
    }, timeoutMs);

    getSocket().emit(event, payload, (res: Ack<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (res?.ok) resolve(res.data);
      else reject(new Error(res?.error?.message ?? 'Something went wrong'));
    });
  });
}
