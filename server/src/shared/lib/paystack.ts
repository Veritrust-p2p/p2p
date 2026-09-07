import crypto from "node:crypto";
import { env } from "../config/env";
import { prisma } from "./prisma";
import type { PaystackEnvironment } from "../../generated/prisma/client";
import { ApiError } from "./errors";

/**
 * Thin Paystack client, test or live per the `paystack_mode` row. GHS amounts
 * cross the wire in pesewas (Paystack's minor unit), matching money.ts. Only
 * the pieces the deposit flow needs: initialize a charge, verify one by
 * reference, and authenticate webhooks.
 */

const BASE = "https://api.paystack.co";

/**
 * The live/test switch, read from the `paystack_mode` singleton.
 *
 * Deliberately uncached. A deposit issues at most two of these, so the query is
 * negligible next to the round trip to Paystack itself, and a TTL cache would
 * mean a flipped toggle keeps charging the old environment until it expires —
 * the one kind of staleness this particular setting cannot afford.
 *
 * A missing row resolves to `test`, matching the column default. Every failure
 * path here has to land on test; none may fall through to live.
 */
export async function currentMode(): Promise<PaystackEnvironment> {
  const row = await prisma.paystackMode.findUnique({ where: { id: "singleton" } });
  return row?.mode ?? "test";
}

/** The secret for one mode, or a 501 naming the key that is actually missing. */
function secretFor(mode: PaystackEnvironment): string {
  const key = mode === "live" ? env.PAYSTACK_SECRET_KEY_LIVE : env.PAYSTACK_SECRET_KEY;
  if (!key) {
    throw ApiError.notImplemented(`Paystack is in ${mode} mode but no ${mode} secret key is configured`);
  }
  return key;
}

async function authHeaders() {
  return {
    Authorization: `Bearer ${secretFor(await currentMode())}`,
    "Content-Type": "application/json",
  };
}

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const headers = await authHeaders(); // throws 501 if unconfigured — must not be masked as 502
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch {
    throw ApiError.badGateway("Could not reach Paystack");
  }
  const body = (await res.json().catch(() => null)) as PaystackEnvelope<T> | null;
  if (!res.ok || !body?.status) {
    throw ApiError.badRequest(body?.message || `Paystack error (${res.status})`);
  }
  return body.data;
}

/** Paystack channel ids. The client picks "momo" or "card"; we map to these. */
export type PaymentChannel = "mobile_money" | "card" | "bank" | "bank_transfer" | "ussd";

/**
 * Tag the configured return page with the client that started the charge.
 *
 * Returns the URL byte-for-byte unchanged for anything other than "mobile" —
 * including when it is unset, which is how every existing caller behaves. The
 * web flow therefore sees exactly the URL it always has.
 *
 * A malformed or empty setting is passed through as-is rather than thrown on:
 * this is a redirect convenience, and failing the charge over it would be worse
 * than landing on a page that cannot bounce.
 */
export function buildCallbackUrl(configured: string, client?: "web" | "mobile"): string | undefined {
  if (!configured) return undefined;
  if (client !== "mobile") return configured;
  try {
    const url = new URL(configured);
    url.searchParams.set("client", "mobile");
    return url.toString();
  } catch {
    return configured;
  }
}

export interface InitResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

/** Start a charge. `amountPesewas` is an integer (GH₵1 = 100). */
export async function initTransaction(params: {
  email: string;
  amountPesewas: number;
  reference: string;
  metadata?: Record<string, unknown>;
  /** Restrict the hosted page to one method so the buyer's choice carries over. */
  channels?: PaymentChannel[];
  /**
   * Which client started this charge. Only "mobile" changes anything: it tags
   * the return page so it knows to hand control back to the app.
   *
   * The callback stays the configured https URL either way. Paystack requires
   * an http(s) callback — a `veritrust://` value here is rejected — and the
   * setting is one global shared by both clients, so pointing it at the app
   * would break the web. The tag is a query parameter on the same page instead.
   */
  client?: "web" | "mobile";
}): Promise<InitResult> {
  const callbackUrl = buildCallbackUrl(env.PAYSTACK_CALLBACK_URL, params.client);

  const data = await call<{ authorization_url: string; access_code: string; reference: string }>(
    "/transaction/initialize",
    {
      method: "POST",
      body: JSON.stringify({
        email: params.email,
        amount: params.amountPesewas,
        currency: "GHS",
        reference: params.reference,
        metadata: params.metadata ?? {},
        channels: params.channels?.length ? params.channels : undefined,
        callback_url: callbackUrl,
      }),
    },
  );
  return {
    authorizationUrl: data.authorization_url,
    accessCode: data.access_code,
    reference: data.reference,
  };
}

export interface VerifyResult {
  status: string; // "success" | "failed" | "abandoned" | ...
  reference: string;
  amountPesewas: number;
  currency: string;
}

/** Ask Paystack the authoritative outcome of a reference (webhook fallback / poll). */
export async function verifyTransaction(reference: string): Promise<VerifyResult> {
  const data = await call<{ status: string; reference: string; amount: number; currency: string }>(
    `/transaction/verify/${encodeURIComponent(reference)}`,
    { method: "GET" },
  );
  return {
    status: data.status,
    reference: data.reference,
    amountPesewas: data.amount,
    currency: data.currency,
  };
}

/**
 * Verify an incoming webhook. Paystack signs the raw request body with
 * HMAC-SHA512 keyed by the secret; the digest arrives in `x-paystack-signature`.
 * Compare in constant time against the untouched raw bytes.
 */
export function verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined): boolean {
  if (!signature || !env.PAYSTACK_SECRET_KEY) return false;
  const expected = crypto.createHmac("sha512", env.PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A unique, human-legible deposit reference. */
export function newReference(): string {
  return `p2p_dep_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}
