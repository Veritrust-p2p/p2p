import path from "node:path";
import dotenv from "dotenv";
import { resolveLanIp } from "../lib/net";

dotenv.config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

const WEB_PORT = process.env.WEB_PORT ?? "5173";
// When WEB_ORIGIN isn't set, point email links at the machine's current LAN IP
// so they're clickable from a phone on the same WiFi — re-detected each startup,
// so it follows the network automatically (no hardcoded IP to go stale).
const detectedWebOrigin = `http://${resolveLanIp() ?? "localhost"}:${WEB_PORT}`;

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: Number(process.env.PORT ?? 4000),
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  // Primary web origin — used to build links in emails. Auto-detected if unset.
  WEB_ORIGIN: process.env.WEB_ORIGIN ?? detectedWebOrigin,
  // Explicit allow-list for CORS (comma-separated). In development, localhost and
  // private-LAN origins are always allowed on top of this (see app.ts), so this
  // usually only matters in production.
  CORS_ORIGINS: (process.env.CORS_ORIGINS ?? process.env.WEB_ORIGIN ?? detectedWebOrigin)
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET ?? "",
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET ?? "",
  JWT_ACCESS_TTL: process.env.JWT_ACCESS_TTL ?? "15m",
  JWT_REFRESH_TTL: process.env.JWT_REFRESH_TTL ?? "30d",
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME ?? "",
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY ?? "",
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET ?? "",
  CLOUDINARY_URL: process.env.CLOUDINARY_URL ?? "",

  // Paystack (test mode). Deposits are real charges against test cards/momo;
  // the webhook (HMAC-SHA512 verified) or the /verify poll credits the wallet.
  // Leave the secret blank to fall back to the instant simulated deposit.
  PAYSTACK_SECRET_KEY: process.env.PAYSTACK_SECRET_KEY ?? "",
  PAYSTACK_PUBLIC_KEY: process.env.PAYSTACK_PUBLIC_KEY ?? "",
  // Where Paystack returns the buyer after payment (frontend route).
  PAYSTACK_CALLBACK_URL: (() => {
    const url = process.env.PAYSTACK_CALLBACK_URL ?? "";
    const isDev = (process.env.NODE_ENV ?? "development") !== "production";
    if (isDev && url.includes("localhost:")) {
      const origin = process.env.WEB_ORIGIN ?? detectedWebOrigin;
      return url.replace(/https?:\/\/localhost:\d+/, origin);
    }
    return url;
  })(),

  // NOWPayments (sandbox). Funds the crypto rail: the buyer pays TRX on the
  // provider's hosted invoice, the IPN (HMAC-SHA512 verified) — or the
  // /crypto/check poll, for a laptop a webhook can't reach — moves the deal to
  // `funded`. Leave the API key blank and crypto funding reports 501.
  NOWPAYMENTS_API_KEY: process.env.NOWPAYMENTS_API_KEY ?? "",
  NOWPAYMENTS_IPN_SECRET: process.env.NOWPAYMENTS_IPN_SECRET ?? "",
  NOWPAYMENTS_BASE_URL: process.env.NOWPAYMENTS_BASE_URL ?? "https://api-sandbox.nowpayments.io/v1",
  // Both default to TRX so the deal is priced in the coin it is paid in — no FX
  // drift between invoice creation and payment. They are separately settable
  // because the sandbox does not carry every coin the live API does: if TRX is
  // missing there, point these at a coin it does have rather than editing code.
  NOWPAYMENTS_PRICE_CURRENCY: process.env.NOWPAYMENTS_PRICE_CURRENCY ?? "trx",
  NOWPAYMENTS_PAY_CURRENCY: process.env.NOWPAYMENTS_PAY_CURRENCY ?? "trx",
  // Public origin of THIS API — where NOWPayments posts its IPN. On localhost
  // it is unreachable by design; that is what the poll fallback is for. Point
  // it at a tunnel (ngrok/cloudflared) to exercise the webhook path for real.
  SERVER_ORIGIN: process.env.SERVER_ORIGIN ?? `http://localhost:${Number(process.env.PORT ?? 4000)}`,

  /**
   * How often to send a trivial query so the database doesn't fall asleep.
   *
   * Neon scales the compute to zero after a few minutes with no queries (five,
   * on the plans where it isn't configurable). Waking it costs seconds and
   * kills every pooled connection, so the next few requests pay TLS handshakes
   * on top — which is what "the app is fine, then suddenly takes 30 seconds"
   * actually is.
   *
   * Four minutes leaves a margin under that threshold. Set `DB_KEEPALIVE_MS=0`
   * to switch it off, which is the right setting against a database that
   * doesn't suspend — there is no point holding one awake that was never going
   * to sleep.
   */
  DB_KEEPALIVE_MS: Number(process.env.DB_KEEPALIVE_MS ?? 4 * 60_000),

  // Mail. "simulated" logs `[mail:simulated] To <email>: <subject>` (default).
  //
  // "smtp" sends through SMTP_* — fine locally, but many hosts (Render among
  // them) block outbound SMTP to stop spam, and a blocked port looks exactly
  // like a hang: the connection times out with no bounce, because nothing ever
  // reached a mail server that could generate one.
  //
  // "brevo" and "resend" use HTTPS APIs on :443, which work on deployments
  // where outbound SMTP is blocked.
  MAIL_DRIVER: (process.env.MAIL_DRIVER ?? "simulated") as "simulated" | "smtp" | "resend" | "brevo",
  MAIL_FROM: process.env.MAIL_FROM ?? "VeriTrust <no-reply@veritrust.app>",
  SMTP_HOST: process.env.SMTP_HOST ?? "",
  SMTP_PORT: Number(process.env.SMTP_PORT ?? 587),
  SMTP_USER: process.env.SMTP_USER ?? "",
  SMTP_PASS: process.env.SMTP_PASS ?? "",
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? "",
  BREVO_API_KEY: process.env.BREVO_API_KEY ?? "",
};

// Fail fast on boot instead of running on empty defaults. An unset JWT secret
// is the dangerous one: jsonwebtoken happily signs and verifies with "", so the
// app would look healthy while every token was trivially forgeable. DATABASE_URL
// is here too — the Prisma adapter is built from it at import time.
const REQUIRED = ["DATABASE_URL", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"] as const;
const missing = REQUIRED.filter((key) => !env[key]);
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(", ")}. ` +
      `Set them in server/.env before starting the API.`,
  );
}

/** True once a Paystack TEST secret is configured. Restricted to test keys on
 *  purpose — the platform is test-mode only, so a mis-pasted live key must not
 *  silently process real charges. */
export const paystackEnabled = () => env.PAYSTACK_SECRET_KEY.startsWith("sk_test_");

/** True once a NOWPayments API key is configured — see shared/lib/nowpayments.ts. */
export const nowpaymentsEnabled = () => env.NOWPAYMENTS_API_KEY.length > 0;

/**
 * Fund a crypto deal on the provider's *status* alone, ignoring the amount it
 * says was received.
 *
 * Only ever for the sandbox. NOWPayments' sandbox marks a payment `finished`
 * while still reporting `actually_paid: 0`, so the underpayment guard in
 * crypto.service — correctly — refuses to fund and the deal sits at
 * `partially_paid` forever. That makes the rail impossible to demonstrate end
 * to end without weakening the guard against real money, which is not a trade
 * worth making.
 *
 * So it is gated twice, and both gates must be open:
 *
 *  1. `NOWPAYMENTS_TRUST_STATUS=true` — off unless someone deliberately sets it
 *  2. the base URL is a sandbox one — so copying a production `.env` that still
 *     carries the flag cannot switch it on
 *
 * The second gate is the one that matters. A flag alone would be one careless
 * `.env` copy away from funding real deals on unpaid invoices.
 */
export const nowpaymentsTrustStatus = () =>
  (process.env.NOWPAYMENTS_TRUST_STATUS ?? "").toLowerCase() === "true" &&
  /sandbox/i.test(env.NOWPAYMENTS_BASE_URL);
