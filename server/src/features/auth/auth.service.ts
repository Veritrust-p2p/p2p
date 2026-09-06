import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { prisma } from "../../shared/lib/prisma";
import { ApiError } from "../../shared/lib/errors";
import { env } from "../../shared/config/env";
import type { User } from "../../generated/prisma/client";
import { mailer } from "../../shared/mail/mail.service";
import { notify } from "../notifications/notifications.service";
import * as tokenService from "./token.service";
import type {
  AuthResult,
  AuthTokens,
  ChangePasswordInput,
  LoginInput,
  PublicUser,
  RequestContext,
  SignupInput,
} from "./auth.model";

// Same argon2id parameters as the TaaS API.
const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
} as const;

// Simulated email delivery (proposal scope): links are printed to the server
// console instead of being emailed. The tokens themselves are stateless JWTs so
// they survive dev-server restarts (an in-memory map would be wiped by tsx watch).
// They are signed with JWT_REFRESH_SECRET (not the access secret) so an email
// token can never pass the auth middleware as an access token.
interface EmailTokenPayload {
  sub?: string;
  purpose?: string;
}

// ---------- Signup & email verification ----------

export async function signup(input: SignupInput): Promise<{ user: PublicUser }> {
  const [usernameTaken, emailTaken] = await Promise.all([
    prisma.user.findUnique({ where: { username: input.username } }),
    prisma.user.findUnique({ where: { email: input.email } }),
  ]);
  if (usernameTaken) throw ApiError.conflict("Username is taken");
  if (emailTaken) throw ApiError.conflict("An account with this email already exists");

  const passwordHash = await argon2.hash(input.password, ARGON2_OPTS);

  const user = await prisma.user
    .create({
      data: {
        username: input.username,
        email: input.email,
        passwordHash,
        fullName: input.fullName,
        wallets: { create: { currency: "GHS" } }
      },
    })
    .catch((err: unknown) => {
      // Race on the unique indexes between the checks above and the insert.
      if (err && typeof err === "object" && (err as { code?: string }).code === "P2002") {
        throw ApiError.conflict("Username or email already taken");
      }
      throw err;
    });

  sendVerificationEmail(user);
  // No auto-login — the user must verify their email, then sign in.
  return { user: publicUser(user) };
}

function sendVerificationEmail(user: User): void {
  const token = jwt.sign({ sub: user.id, purpose: "verify_email" }, env.JWT_REFRESH_SECRET, {
    expiresIn: "24h",
  });
  const link = `${env.WEB_ORIGIN}/verify-email?token=${token}`;
  // Console link is kept for dev (the launcher surfaces it); the templated email
  // is the real channel once MAIL_DRIVER=smtp.
  console.log(`[verify-link] ${user.email}: ${link}`);
  void mailer.verifyAccount(user.email, user.fullName, link);
}

/** Idempotent — clicking an already-used (but unexpired) link still succeeds. */
export async function verifyEmail(token: string): Promise<void> {
  const invalid = () => ApiError.badRequest("This verification link is invalid or has expired");
  let payload: EmailTokenPayload;
  try {
    payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as EmailTokenPayload;
  } catch {
    throw invalid();
  }
  if (payload.purpose !== "verify_email" || !payload.sub) throw invalid();

  await prisma.user
    .update({ where: { id: payload.sub }, data: { emailVerifiedAt: new Date() } })
    .catch(() => {
      throw invalid();
    });
}

export async function resendVerification(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (user && !user.emailVerifiedAt) sendVerificationEmail(user);
}

// ---------- Login ----------

export async function login(input: LoginInput, ctx: RequestContext): Promise<AuthResult> {
  const isEmail = input.identifier.includes("@");
  const user = isEmail
    ? await prisma.user.findUnique({ where: { email: input.identifier } })
    : await prisma.user.findUnique({ where: { username: input.identifier } });

  if (!user) {
    // Equalize timing with the argon2.verify below (both lookup paths).
    await argon2.hash("dummy-to-equalize-timing").catch(() => undefined);
    throw ApiError.unauthorized("Invalid credentials");
  }
  if (user.status === "suspended") throw ApiError.forbidden("This account is suspended");

  const ok = await argon2.verify(user.passwordHash, input.password);
  if (!ok) throw ApiError.unauthorized("Invalid credentials");

  // Email must be verified before login. Checked AFTER the password so we never
  // reveal an account's verification state to anyone who doesn't own it. On an
  // unverified attempt we re-send a fresh link and tag the error so the client
  // can route the user to the verification screen.
  if (!user.emailVerifiedAt) {
    sendVerificationEmail(user);
    throw new ApiError(403, "Please verify your email — we've re-sent the verification link to your inbox.", {
      code: "email_unverified",
      email: user.email,
    });
  }

  /*
    Return the same shape `/api/auth/me` does, not the thinner `publicUser`.

    Both clients used to sign in and then immediately ask `/me`, because login
    withheld the one field that decides what the app looks like — `kycStatus`,
    which is what makes someone a seller. That second request is a whole extra
    HTTP round trip on the critical path, and until it landed the web header had
    no user and rendered Sign up / Log in to someone who had just signed in.

    Gathered concurrently with the session write: `me` is four parallel reads
    and `startSession` is a write, so neither waits on the other and login costs
    what it did before.
  */
  const [tokens, profile] = await Promise.all([startSession(user, ctx), me(user.id)]);
  void mailer.loginAlert(user.email, user.fullName, new Date().toUTCString(), ctx.ip ?? "unknown");
  return { user: profile, tokens };
}

// ---------- Sessions & token rotation ----------

async function startSession(user: User, ctx: RequestContext): Promise<AuthTokens> {
  const { token: refreshToken, hash } = tokenService.generateRefreshToken();
  await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: hash,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      expiresAt: new Date(Date.now() + tokenService.refreshTtlMs()),
    },
  });
  const accessToken = tokenService.signAccessToken({
    sub: user.id,
    username: user.username,
    role: user.role,
  });
  return { accessToken, refreshToken };
}

/** Rotates a refresh token. Reuse of an already-rotated token means theft:
 *  every session of that user is revoked. */
export async function refresh(refreshToken: string, ctx: RequestContext): Promise<AuthTokens> {
  const hash = tokenService.hashRefreshToken(refreshToken);
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hash },
    include: { user: true },
  });
  if (!session) throw ApiError.unauthorized("Invalid session");

  if (session.revokedAt) {
    await prisma.session.updateMany({
      where: { userId: session.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw ApiError.unauthorized("Session reuse detected. Please log in again.");
  }
  if (session.expiresAt < new Date()) throw ApiError.unauthorized("Session expired");
  if (session.user.status !== "active") throw ApiError.unauthorized("Account is not active");

  // Rotate: revoke the old session, mint a new one.
  await prisma.session.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  });
  return startSession(session.user, ctx);
}

export async function logout(refreshToken: string): Promise<void> {
  await prisma.session.updateMany({
    where: { refreshTokenHash: tokenService.hashRefreshToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// ---------- Password reset & change ----------

export async function forgotPassword(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return; // Never reveal whether the email exists.
  // Signed with secret + current password hash → the moment the password
  // changes, the token stops verifying. Stateless single-use.
  const token = jwt.sign({ sub: user.id, purpose: "reset_password" }, env.JWT_REFRESH_SECRET + user.passwordHash, {
    expiresIn: "30m",
  });
  const link = `${env.WEB_ORIGIN}/reset-password?token=${token}`;
  console.log(`[reset-link] ${email}: ${link}`);
  void mailer.forgotPassword(user.email, user.fullName, link);
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const invalid = () => ApiError.badRequest("This reset link is invalid or has expired");

  const decoded = jwt.decode(token) as EmailTokenPayload | null;
  if (!decoded?.sub || decoded.purpose !== "reset_password") throw invalid();
  const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
  if (!user) throw invalid();
  try {
    jwt.verify(token, env.JWT_REFRESH_SECRET + user.passwordHash);
  } catch {
    throw invalid();
  }

  const passwordHash = await argon2.hash(newPassword, ARGON2_OPTS);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
  // Reset invalidates all sessions.
  await prisma.session.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  void notify({
    userId: user.id,
    category: "system",
    title: "Your password was reset",
    body: "Your password changed and every device was signed out. If this wasn't you, reset it again immediately.",
    link: "/settings",
  });
}

/** Changes the password, revokes every session, and returns a fresh pair so
 *  the current client stays logged in. */
export async function changePassword(
  userId: string,
  input: ChangePasswordInput,
  ctx: RequestContext,
): Promise<AuthTokens> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const ok = await argon2.verify(user.passwordHash, input.currentPassword);
  if (!ok) throw ApiError.badRequest("Current password is incorrect");

  const passwordHash = await argon2.hash(input.newPassword, ARGON2_OPTS);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  // A durable in-app record survives an attacker who controls the mailbox —
  // which is the point of flagging a password change at all.
  void notify({
    userId,
    category: "system",
    title: "Your password was changed",
    body: "Your password changed and your other devices were signed out. If this wasn't you, reset it immediately.",
    link: "/settings",
  });

  return startSession(user, ctx);
}

// ---------- Username availability & profile ----------

export async function isUsernameAvailable(username: string): Promise<boolean> {
  const existing = await prisma.user.findUnique({ where: { username } });
  return !existing;
}

/** GET /me — profile + KYC status + wallets + the dashboard counts the client shows. */
/**
 * All four queries in one batch, not the user row and then the three stats.
 *
 * They were sequential, but only by habit — the stats key off `userId`, which
 * the caller already has from the verified token, so none of them ever needed
 * the user row. Against a database ~450ms away that ordering was costing a
 * whole extra round trip on the request every signed-in screen makes first.
 */
export async function me(userId: string) {
  const [user, activeOrdersCount, spent, savedItemsCount] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      include: { kyc: { select: { status: true } }, wallets: true },
    }),
    prisma.escrow.count({
      where: { buyerId: userId, status: { in: ["created", "funded", "delivered"] } },
    }),
    prisma.escrow.aggregate({
      _sum: { amount: true },
      where: { buyerId: userId, status: "disbursed" },
    }),
    prisma.savedListing.count({ where: { userId } }),
  ]);

  if (!user) throw ApiError.notFound("User not found");

  return {
    ...publicUser(user),
    kycStatus: user.kyc?.status ?? "unverified",
    prefs: {
      emailShipmentUpdates: user.emailShipmentUpdates,
      smsReleaseAlerts: user.smsReleaseAlerts,
    },
    wallets: user.wallets.map((w) => ({ currency: w.currency, balance: Number(w.balance) })),
    stats: {
      activeOrdersCount,
      totalSpent: Number(spent._sum.amount ?? 0),
      savedItemsCount,
    },
  };
}

// ---------- helpers ----------

export function publicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    fullName: user.fullName,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    role: user.role,
    emailVerified: Boolean(user.emailVerifiedAt),
    phoneVerified: Boolean(user.phoneVerifiedAt),
    createdAt: user.createdAt.toISOString(),
  };
}
