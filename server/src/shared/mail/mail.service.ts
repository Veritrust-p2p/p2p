import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import { env } from "../config/env";

/**
 * Mail rendering + delivery. Templates live in /server/templates (outside src,
 * as the team agreed) and survive the tsc build because we resolve them from the
 * repo — not from dist. Delivery is SIMULATED by default: every send logs
 *   [mail:simulated] To <email>: <subject>
 * matching the existing verify/reset console pattern. Set MAIL_DRIVER=smtp
 * (and SMTP_*) plus `npm i nodemailer` to send for real — no other code changes.
 */

// src/shared/mail -> ../../../templates == server/templates (dist mirrors this depth)
const TEMPLATES_DIR = path.resolve(__dirname, "../../../templates");
const fileCache = new Map<string, string>();

function readTemplate(name: string): string {
  const cached = fileCache.get(name);
  if (cached !== undefined) return cached;
  const html = fs.readFileSync(path.join(TEMPLATES_DIR, `${name}.html`), "utf8");
  if (env.NODE_ENV === "production") fileCache.set(name, html);
  return html;
}

type Vars = Record<string, string | number>;

function interpolate(template: string, vars: Vars): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) =>
    key in vars ? String(vars[key]) : "",
  );
}

/** Render a named template inside layout.html. */
export function renderTemplate(name: string, vars: Vars): string {
  const base: Vars = {
    appName: "VeriTrust",
    webOrigin: env.WEB_ORIGIN,
    year: new Date().getFullYear(),
    ...vars,
  };
  const body = interpolate(readTemplate(name), base);
  const layout = readTemplate("layout");
  // Function replacer: inserts `body` literally so any `$`-patterns in user data
  // (e.g. a deal title) aren't treated as replacement specials ($&, $1, …).
  return interpolate(layout.replace("{{content}}", () => body), base);
}

/** Deliver (or simulate) one message. Never throws — mail is best-effort. */
export async function sendMail(to: string, subject: string, template: string, vars: Vars): Promise<void> {
  try {
    const html = renderTemplate(template, vars);
    if (env.MAIL_DRIVER === "smtp") {
      await sendSmtp(to, subject, html);
      console.log(`[mail:sent] To ${to}: ${subject}`);
    } else {
      console.log(`[mail:simulated] To ${to}: ${subject}`);
    }
  } catch (err) {
    console.error(`[mail:error] To ${to}: ${subject} —`, (err as Error).message);
  }
}

async function sendSmtp(to: string, subject: string, html: string): Promise<void> {
  // Optional dependency: resolved only when MAIL_DRIVER=smtp so the default
  // build needs no nodemailer. The variable specifier keeps tsc from requiring
  // its types when the package isn't installed.
  const moduleName = "nodemailer";
  const mod: any = await import(moduleName);
  const nodemailer = mod.default ?? mod; // CJS/ESM interop
  // Resolve the host to an IPv4 literal ourselves.
  //
  // Sends were dying with
  //   connect ENETUNREACH 2a00:1450:4001:c21::6d:587
  // on a host with no outbound IPv6. The obvious `family: 4` does nothing:
  // smtp-connection never reads that option. Nodemailer resolves the hostname
  // itself, concatenates the A and AAAA records, and then — in
  // `lib/shared/index.js`, formatDNSValue — picks one of them **at random**:
  //   addresses[Math.floor(Math.random() * addresses.length)]
  // So every send was a coin flip between Gmail's IPv4 and an IPv6 address
  // nothing here can route to, which is why the failures alternated between
  // ENETUNREACH and a connect timeout.
  //
  // `resolveHostname` short-circuits on `net.isIP(host)` — "nothing to do
  // here" — so handing it an address instead of a name skips that lottery
  // entirely. `tls.servername` keeps certificate validation (and SNI) pointed
  // at the real hostname, which an IP literal would otherwise break.
  const { address } = await dns.lookup(env.SMTP_HOST, { family: 4 });

  const transport = nodemailer.createTransport({
    host: address,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    tls: { servername: env.SMTP_HOST },
    // Fail fast instead of hanging the default two minutes: a blocked port
    // should show up in the log as an error, not as a request that never ends.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  await transport.sendMail({ from: env.MAIL_FROM, to, subject, html });
}

/**
 * Typed helpers — one per lifecycle event. Centralizes copy so call sites stay
 * one line and subjects/templates never drift. All fire-and-forget.
 */
export const mailer = {
  verifyAccount: (to: string, name: string, link: string) =>
    sendMail(to, "Verify your VeriTrust account", "verify-account", { name, link }),

  forgotPassword: (to: string, name: string, link: string) =>
    sendMail(to, "Reset your VeriTrust password", "forgot-password", { name, link }),

  loginAlert: (to: string, name: string, when: string, ip: string) =>
    sendMail(to, "New sign-in to your account", "login", { name, when, ip }),

  newOrder: (to: string, sellerName: string, title: string, amount: string, code: string) =>
    sendMail(to, `New order: ${title}`, "new-order", { name: sellerName, title, amount, code }),

  /** Standalone deals only — marketplace checkout is already covered by newOrder. */
  dealFunded: (to: string, sellerName: string, title: string, amount: string, code: string) =>
    sendMail(to, `Deal funded: ${title}`, "deal-funded", { name: sellerName, title, amount, code }),

  orderDelivered: (to: string, buyerName: string, title: string, tracking: string, code: string) =>
    sendMail(to, `Marked delivered: ${title}`, "order-delivered", { name: buyerName, title, tracking, code }),

  fundsRelease: (to: string, sellerName: string, title: string, payout: string, code: string) =>
    sendMail(to, `Payout released: ${title}`, "funds-release", { name: sellerName, title, payout, code }),

  /** Buyer-side counterpart to fundsRelease, for the timer-driven release only. */
  autoRelease: (to: string, buyerName: string, title: string, payout: string, code: string) =>
    sendMail(to, `Escrow auto-released: ${title}`, "auto-release", { name: buyerName, title, payout, code }),

  orderCancelled: (to: string, buyerName: string, title: string, refund: string, code: string) =>
    sendMail(to, `Order cancelled: ${title}`, "order-cancelled", { name: buyerName, title, refund, code }),

  disputeCreated: (to: string, name: string, title: string, code: string) =>
    sendMail(to, `Dispute opened: ${title}`, "dispute-created", { name, title, code }),

  disputeResolved: (to: string, name: string, title: string, outcome: string, code: string) =>
    sendMail(to, `Dispute resolved: ${title}`, "dispute-resolved", { name, title, outcome, code }),

  withdrawal: (to: string, name: string, amount: string, destination: string) =>
    sendMail(to, "Withdrawal processed", "withdrawal", { name, amount, destination }),

  listingRemoved: (to: string, name: string, title: string, reason: string, disputeAllowed = false) =>
    sendMail(to, `Listing removed: ${title}`, "listing-removed", {
      name,
      title,
      reason,
      disputeNote: disputeAllowed
        ? "You can correct the listing and submit a dispute for review."
        : "This removal cannot be disputed.",
    }),

  listingDisputeSubmitted: (to: string, name: string, title: string, seller: string, explanation: string) =>
    sendMail(to, `Listing dispute: ${title}`, "listing-dispute-submitted", { name, title, seller, explanation }),

  listingDisputeApproved: (to: string, name: string, title: string, note: string | null) =>
    sendMail(to, `Listing reinstated: ${title}`, "listing-dispute-approved", {
      name,
      title,
      note: note || "No additional notes.",
    }),

  listingDisputeRejected: (to: string, name: string, title: string, note: string | null) =>
    sendMail(to, `Dispute not upheld: ${title}`, "listing-dispute-rejected", {
      name,
      title,
      note: note || "No additional notes.",
    }),
};
