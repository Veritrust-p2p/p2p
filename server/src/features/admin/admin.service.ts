import { prisma } from "../../shared/lib/prisma";
import { ApiError } from "../../shared/lib/errors";
import { invalidateUser } from "../../shared/lib/auth-cache";
import { env } from "../../shared/config/env";
import type {
  AccountStatus,
  DisputeOutcome,
  EscrowStatus,
  KycStatus,
  PaystackEnvironment,
  Prisma,
  UserRole,
  WithdrawalStatus,
} from "../../generated/prisma/client";
import type { ListingRemovalReason } from "../../generated/prisma/client";
import { transition } from "../escrows/escrows.service";
import { breakdown } from "../escrows/money";
import { listDealTranscript, postDealMessage } from "../messages/messages.service";
import { notify, notifyMany } from "../notifications/notifications.service";
import * as walletService from "../wallet/wallet.service";
import { mailer } from "../../shared/mail/mail.service";
import { removalReasonText } from "../listings/removal-reasons";

// ---------- KYC review queue ----------

const kycWithUser = {
  user: { select: { id: true, username: true, email: true, avatarUrl: true, createdAt: true } },
} satisfies Prisma.KycProfileInclude;

type KycWithUser = Prisma.KycProfileGetPayload<{ include: typeof kycWithUser }>;

export async function listKyc(status: KycStatus) {
  const rows = await prisma.kycProfile.findMany({
    where: { status },
    orderBy: { createdAt: "asc" }, // oldest submissions first
    include: kycWithUser,
  });
  return rows.map(toAdminKyc);
}

export async function getKyc(id: string) {
  const kyc = await prisma.kycProfile.findUnique({ where: { id }, include: kycWithUser });
  if (!kyc) throw ApiError.notFound("KYC submission not found");
  return toAdminKyc(kyc);
}

export async function approveKyc(adminId: string, id: string) {
  await assertPending(id);
  const kyc = await prisma.kycProfile.update({
    where: { id },
    data: { status: "verified", rejectionReason: null, reviewedById: adminId, reviewedAt: new Date() },
    include: kycWithUser,
  });
  // `requireSeller` reads this off the cached auth row — without dropping it,
  // a freshly approved seller would still be refused until the entry aged out.
  invalidateUser(kyc.userId);
  void notify({
    userId: kyc.userId,
    category: "kyc",
    title: "You're verified",
    body: "Your identity check passed. You can now list items and sell on the marketplace.",
    link: "/dashboard",
  });
  return toAdminKyc(kyc);
}

export async function rejectKyc(adminId: string, id: string, reason: string) {
  await assertPending(id);
  const kyc = await prisma.kycProfile.update({
    where: { id },
    data: { status: "rejected", rejectionReason: reason, reviewedById: adminId, reviewedAt: new Date() },
    include: kycWithUser,
  });
  invalidateUser(kyc.userId);
  void notify({
    userId: kyc.userId,
    category: "kyc",
    title: "Identity check not approved",
    body: `${reason} You can correct your details and submit again.`,
    link: "/vendor/kyc",
  });
  return toAdminKyc(kyc);
}

async function assertPending(id: string) {
  const kyc = await prisma.kycProfile.findUnique({ where: { id } });
  if (!kyc) throw ApiError.notFound("KYC submission not found");
  if (kyc.status !== "pending") {
    throw ApiError.conflict(`This submission was already ${kyc.status} — only pending submissions can be reviewed`);
  }
}

function toAdminKyc(kyc: KycWithUser) {
  return {
    id: kyc.id,
    status: kyc.status,
    legalName: kyc.legalName,
    storeName: kyc.storeName,
    taxId: kyc.taxId,
    country: kyc.country,
    address: kyc.address,
    idType: kyc.idType,
    idNumber: kyc.idNumber,
    momoNumber: kyc.momoNumber,
    trxAddress: kyc.trxAddress,
    rejectionReason: kyc.rejectionReason,
    submittedAt: kyc.createdAt.toISOString(),
    reviewedAt: kyc.reviewedAt?.toISOString() ?? null,
    user: {
      id: kyc.user.id,
      username: kyc.user.username,
      email: kyc.user.email,
      avatarUrl: kyc.user.avatarUrl,
      joinedAt: kyc.user.createdAt.toISOString(),
    },
  };
}

// ---------- Disputes review & resolution ----------

export async function listDisputes(status: "open" | "resolved" | "all") {
  const where = status === "all" ? {} : { status };
  const rows = await prisma.dispute.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      escrow: {
        select: {
          id: true,
          code: true,
          title: true,
          amount: true,
          currency: true,
          status: true,
          buyer: { select: { id: true, username: true, avatarUrl: true } },
          seller: { select: { id: true, username: true, avatarUrl: true } },
          _count: { select: { messages: true } },
        },
      },
      openedBy: { select: { id: true, username: true } },
      resolvedBy: { select: { id: true, username: true } },
    },
  });

  return rows.map((d) => ({
    id: d.id,
    escrowId: d.escrowId,
    status: d.status,
    reason: d.reason,
    description: d.description,
    outcome: d.outcome,
    ruledAmountBuyer: d.ruledAmountBuyer ? Number(d.ruledAmountBuyer) : null,
    ruledAmountSeller: d.ruledAmountSeller ? Number(d.ruledAmountSeller) : null,
    rulingNote: d.rulingNote,
    createdAt: d.createdAt.toISOString(),
    resolvedAt: d.resolvedAt?.toISOString() ?? null,
    escrow: {
      id: d.escrow.id,
      code: d.escrow.code,
      title: d.escrow.title,
      amount: Number(d.escrow.amount),
      currency: d.escrow.currency,
      status: d.escrow.status,
      buyer: d.escrow.buyer,
      seller: d.escrow.seller,
      // Deal-linked system notices only — the parties' chat isn't stamped with
      // escrowId, so this is a lifecycle count, not a conversation length.
      noticeCount: d.escrow._count.messages,
    },
    openedBy: d.openedBy,
    resolvedBy: d.resolvedBy,
  }));
}

export async function getDispute(id: string) {
  const d = await prisma.dispute.findUnique({
    where: { id },
    include: {
      escrow: {
        include: {
          buyer: { select: { id: true, username: true, avatarUrl: true, email: true } },
          seller: { select: { id: true, username: true, avatarUrl: true, email: true } },
          events: { orderBy: { createdAt: "asc" } },
        },
      },
      openedBy: { select: { id: true, username: true, avatarUrl: true } },
      resolvedBy: { select: { id: true, username: true } },
    },
  });

  if (!d) throw ApiError.notFound("Dispute not found");

  // Evidence = what the parties actually said about this deal. Starts at the
  // deal's first system notice; runs to the ruling, or to now while still open
  // (post-dispute messages are where the parties argue their case).
  const transcript =
    d.escrow.buyerId && d.escrow.sellerId
      ? await listDealTranscript(d.escrowId, d.escrow.buyerId, d.escrow.sellerId, {
          fallbackFrom: d.escrow.createdAt,
          until: d.resolvedAt,
        })
      : [];

  return {
    id: d.id,
    escrowId: d.escrowId,
    status: d.status,
    reason: d.reason,
    description: d.description,
    outcome: d.outcome,
    ruledAmountBuyer: d.ruledAmountBuyer ? Number(d.ruledAmountBuyer) : null,
    ruledAmountSeller: d.ruledAmountSeller ? Number(d.ruledAmountSeller) : null,
    rulingNote: d.rulingNote,
    createdAt: d.createdAt.toISOString(),
    resolvedAt: d.resolvedAt?.toISOString() ?? null,
    escrow: {
      id: d.escrow.id,
      code: d.escrow.code,
      title: d.escrow.title,
      amount: Number(d.escrow.amount),
      feeAmount: Number(d.escrow.feeAmount),
      currency: d.escrow.currency,
      status: d.escrow.status,
      // The arbitrator is deciding where money goes, so send the same breakdown
      // the parties agreed to — who carries the fee changes what each side nets.
      feeSplit: d.escrow.feeSplit,
      ...breakdown(Number(d.escrow.amount), Number(d.escrow.feeAmount), d.escrow.feeSplit),
      buyer: d.escrow.buyer,
      seller: d.escrow.seller,
      disputedAt: d.escrow.disputedAt?.toISOString() ?? null,
      messages: transcript,
      events: d.escrow.events,
    },
    openedBy: d.openedBy,
    resolvedBy: d.resolvedBy,
  };
}

/**
 * An arbitrator's question to both parties, dropped into their deal thread as a
 * `system` line so it reads as coming from the platform rather than from either
 * side. No socket needed here — postDealMessage persists and emits, so the
 * parties get it live over the sockets they already hold.
 *
 * Note `senderId` ends up being the buyer: Message requires a sender and the
 * admin isn't in the pair's conversation. `type: "system"` is what disambiguates
 * it — both clients render those centred, never as the buyer's bubble. Same
 * approach the ruling verdict has always used.
 */
export async function postDisputeNote(adminId: string, id: string, body: string) {
  const d = await prisma.dispute.findUnique({
    where: { id },
    include: { escrow: { select: { id: true, buyerId: true, sellerId: true } } },
  });
  if (!d) throw ApiError.notFound("Dispute not found");
  if (d.status !== "open") throw ApiError.conflict("This dispute is already resolved");
  if (!d.escrow.buyerId || !d.escrow.sellerId) {
    throw ApiError.badRequest("This deal is missing a party to message");
  }

  const admin = await prisma.user.findUnique({ where: { id: adminId }, select: { username: true } });

  await postDealMessage(
    d.escrow.buyerId,
    d.escrow.sellerId,
    `⚖️ Admin${admin ? ` @${admin.username}` : ""} asks: ${body}`,
    d.escrowId,
  );

  return getDispute(id);
}

export async function resolveDispute(
  adminId: string,
  id: string,
  input: { outcome: "release" | "refund" | "split"; buyerRefund?: number; rulingNote: string },
) {
  const d = await prisma.dispute.findUnique({ where: { id }, include: { escrow: true } });
  if (!d) throw ApiError.notFound("Dispute not found");
  if (d.status !== "open") throw ApiError.conflict("This dispute is already resolved");

  const totalAmount = Number(d.escrow.amount);
  let ruledBuyer = 0;
  let ruledSeller = 0;

  if (input.outcome === "release") {
    ruledSeller = totalAmount;
    await transition(d.escrowId, "RESOLVE_RELEASE", "system");
  } else if (input.outcome === "refund") {
    ruledBuyer = totalAmount;
    await transition(d.escrowId, "RESOLVE_REFUND", "system");
  } else if (input.outcome === "split") {
    ruledBuyer = input.buyerRefund ?? 0;
    ruledSeller = Math.max(0, totalAmount - ruledBuyer);
    await transition(d.escrowId, "RESOLVE_PARTIAL", "system", { buyerRefund: ruledBuyer });
  }

  const updated = await prisma.dispute.update({
    where: { id },
    data: {
      status: "resolved",
      outcome: input.outcome as DisputeOutcome,
      ruledAmountBuyer: ruledBuyer,
      ruledAmountSeller: ruledSeller,
      rulingNote: input.rulingNote,
      resolvedById: adminId,
      resolvedAt: new Date(),
    },
  });

  // Post resolution announcement in deal chat
  if (d.escrow.buyerId && d.escrow.sellerId) {
    const verdictText =
      input.outcome === "refund"
        ? "Full refund granted to buyer."
        : input.outcome === "release"
        ? "Payout released to seller."
        : `Split ruling: GH₵ ${ruledBuyer.toFixed(2)} to buyer / GH₵ ${ruledSeller.toFixed(2)} to seller.`;

    await postDealMessage(
      d.escrow.buyerId,
      d.escrow.sellerId,
      `⚖️ Official Admin Ruling Verdict: ${verdictText}\nNote: "${input.rulingNote}"`,
      d.escrowId,
    ).catch(() => undefined);
  }

  return getDispute(updated.id);
}

// ---------- User management ----------

const userRowSelect = {
  id: true,
  username: true,
  email: true,
  fullName: true,
  avatarUrl: true,
  role: true,
  status: true,
  emailVerifiedAt: true,
  createdAt: true,
  kyc: { select: { status: true } },
  _count: { select: { escrowsAsBuyer: true, escrowsAsSeller: true, listings: true } },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof userRowSelect }>;

function toAdminUserRow(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    fullName: u.fullName,
    avatarUrl: u.avatarUrl,
    role: u.role,
    status: u.status,
    kycStatus: u.kyc?.status ?? "unverified",
    emailVerified: Boolean(u.emailVerifiedAt),
    dealsAsBuyer: u._count.escrowsAsBuyer,
    dealsAsSeller: u._count.escrowsAsSeller,
    listingsCount: u._count.listings,
    joinedAt: u.createdAt.toISOString(),
  };
}

export async function listUsers(params: {
  search?: string;
  role?: UserRole;
  status?: AccountStatus;
  page: number;
  limit: number;
}) {
  const { search, role, status, page, limit } = params;
  const where: Prisma.UserWhereInput = {
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
    ...(search
      ? {
          OR: [
            { username: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
            { fullName: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  // Concurrent, not transactional — see the note in listings.service list().
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: userRowSelect,
    }),
    prisma.user.count({ where }),
  ]);

  return {
    users: rows.map(toAdminUserRow),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

export async function getUser(id: string) {
  const u = await prisma.user.findUnique({
    where: { id },
    select: { ...userRowSelect, phone: true, wallets: { select: { currency: true, balance: true } } },
  });
  if (!u) throw ApiError.notFound("User not found");
  return {
    ...toAdminUserRow(u),
    phone: u.phone,
    wallets: u.wallets.map((w) => ({ currency: w.currency, balance: Number(w.balance) })),
  };
}

export async function setUserStatus(adminId: string, id: string, status: AccountStatus) {
  if (id === adminId) throw ApiError.badRequest("You cannot change your own account status");
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!target) throw ApiError.notFound("User not found");
  const updated = await prisma.user.update({ where: { id }, data: { status }, select: userRowSelect });
  // `auth` serves a cached copy of this row; without this a suspension would
  // not bite until the entry aged out, and the account would keep working.
  invalidateUser(id);
  return toAdminUserRow(updated);
}

// ---------- Escrow deals oversight (read-only) ----------

const dealPartySelect = { id: true, username: true, avatarUrl: true } satisfies Prisma.UserSelect;

export async function listEscrows(params: {
  status?: EscrowStatus;
  search?: string;
  page: number;
  limit: number;
}) {
  const { status, search, page, limit } = params;
  const where: Prisma.EscrowWhereInput = {
    ...(status ? { status } : {}),
    ...(search
      ? {
          OR: [
            { code: { contains: search, mode: "insensitive" } },
            { title: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  // Concurrent, not transactional — see the note in listings.service list().
  const [rows, total] = await Promise.all([
    prisma.escrow.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        code: true,
        title: true,
        amount: true,
        feeAmount: true,
        currency: true,
        rail: true,
        status: true,
        createdAt: true,
        buyer: { select: dealPartySelect },
        seller: { select: dealPartySelect },
        dispute: { select: { id: true, status: true } },
      },
    }),
    prisma.escrow.count({ where }),
  ]);

  return {
    deals: rows.map((d) => ({
      id: d.id,
      code: d.code,
      title: d.title,
      amount: Number(d.amount),
      feeAmount: Number(d.feeAmount),
      currency: d.currency,
      rail: d.rail,
      status: d.status,
      createdAt: d.createdAt.toISOString(),
      buyer: d.buyer,
      seller: d.seller,
      hasOpenDispute: d.dispute?.status === "open",
      disputeId: d.dispute?.id ?? null,
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

// ---------- Platform stats (admin dashboard) ----------

export async function getStats() {
  const [users, suspendedUsers, activeListings, kycPending, openDisputes, openReports, dealGroups, volume] =
    await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { status: "suspended" } }),
      prisma.listing.count({ where: { status: "active" } }),
      prisma.kycProfile.count({ where: { status: "pending" } }),
      prisma.dispute.count({ where: { status: "open" } }),
      prisma.listingReport.count({ where: { status: "open" } }),
      prisma.escrow.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.escrow.aggregate({ _sum: { amount: true }, where: { status: "disbursed" } }),
    ]);

  const dealsByStatus: Record<EscrowStatus, number> = {
    created: 0,
    funded: 0,
    delivered: 0,
    disbursed: 0,
    disputed: 0,
    cancelled: 0,
  };
  for (const g of dealGroups) dealsByStatus[g.status] = g._count._all;
  const totalDeals = Object.values(dealsByStatus).reduce((a, b) => a + b, 0);

  return {
    users,
    suspendedUsers,
    activeListings,
    kycPending,
    openDisputes,
    openReports,
    totalDeals,
    dealsByStatus,
    // Completed (disbursed) GHS volume — the only "settled" money in the simulated fiat rail.
    ghsVolume: Number(volume._sum.amount ?? 0),
  };
}

// ---------- Listings moderation ----------

const listingRowSelect = {
  id: true,
  title: true,
  price: true,
  currency: true,
  category: true,
  quantity: true,
  images: true,
  status: true,
  createdAt: true,
  removalReason: true,
  removalNote: true,
  removedAt: true,
  disputeAllowed: true,
  seller: { select: { id: true, username: true, avatarUrl: true } },
  removedBy: { select: { username: true } },
  disputes: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true } },
  // Buyer reports awaiting a verdict — the flag on the moderation row that says
  // "someone has already told us about this one".
  _count: { select: { reports: { where: { status: "open" } } } },
} satisfies Prisma.ListingSelect;

type ListingRow = Prisma.ListingGetPayload<{ select: typeof listingRowSelect }>;

function toAdminListing(l: ListingRow) {
  return {
    id: l.id,
    title: l.title,
    price: Number(l.price),
    currency: l.currency,
    category: l.category,
    quantity: l.quantity,
    image: l.images[0] ?? null,
    status: l.status,
    createdAt: l.createdAt.toISOString(),
    seller: { username: l.seller.username, avatarUrl: l.seller.avatarUrl },
    openReportCount: l._count.reports,
    removal: l.removedAt
      ? {
          reason: l.removalReason,
          reasonText: l.removalReason ? removalReasonText(l.removalReason, l.removalNote) : null,
          removedAt: l.removedAt.toISOString(),
          removedBy: l.removedBy?.username ?? null,
          disputeAllowed: l.disputeAllowed,
          disputeStatus: l.disputes[0]?.status ?? null,
        }
      : null,
  };
}

/** Moderation browse — every listing, drafts and removed ones included. */
export async function listListings(params: {
  search?: string;
  status?: "draft" | "active" | "out_of_stock" | "removed";
  page: number;
  limit: number;
}) {
  const { search, status, page, limit } = params;
  const where: Prisma.ListingWhereInput = {
    ...(status ? { status } : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: "insensitive" } },
            { category: { contains: search, mode: "insensitive" } },
            { seller: { username: { contains: search.replace(/^@/, ""), mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  // Concurrent, not transactional — see the note in listings.service list().
  const [rows, total] = await Promise.all([
    prisma.listing.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: listingRowSelect,
    }),
    prisma.listing.count({ where }),
  ]);

  return {
    listings: rows.map(toAdminListing),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

/**
 * Take a listing down. Soft state (status → `removed`) rather than a delete, so
 * listings attached to escrow deals keep their history. The seller is told in
 * their message thread and by email, both carrying the reason.
 *
 * This is also how a buyer report is resolved in the affirmative: any open
 * reports on the listing are marked `actioned` in the same transaction, so a
 * takedown that fails can't leave the queue claiming it succeeded.
 */
export async function removeListing(
  adminId: string,
  listingId: string,
  input: { reason: ListingRemovalReason; note?: string; disputeAllowed?: boolean },
) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: {
      id: true,
      title: true,
      status: true,
      sellerId: true,
      description: true,
      price: true,
      category: true,
      condition: true,
      quantity: true,
      images: true,
      location: true,
    },
  });
  if (!listing) throw ApiError.notFound("Listing not found");
  if (listing.status === "removed") throw ApiError.conflict("This listing has already been removed");
  if (input.reason === "other" && !input.note?.trim()) {
    throw ApiError.badRequest("Describe the reason when choosing Other");
  }

  const note = input.note?.trim() || null;
  const now = new Date();

  const { updated, reporterIds } = await prisma.$transaction(async (tx) => {
    // Read the reporters before the updateMany rewrites their status.
    const open = await tx.listingReport.findMany({
      where: { listingId, status: "open" },
      select: { reporterId: true },
    });
    await tx.listingReport.updateMany({
      where: { listingId, status: "open" },
      data: { status: "actioned", reviewedById: adminId, reviewedAt: now },
    });
    const row = await tx.listing.update({
      where: { id: listingId },
      data: {
        status: "removed",
        removalReason: input.reason,
        removalNote: note,
        removedAt: now,
        removedById: adminId,
        disputeAllowed: input.disputeAllowed ?? false,
      },
      select: listingRowSelect,
    });
    return { updated: row, reporterIds: open.map((o) => o.reporterId) };
  });

  const reasonText = removalReasonText(input.reason, note);
  const canDispute = input.disputeAllowed ?? false;

  // Tell the seller — notification first, then email. Best-effort: a delivery
  // problem must not roll back a completed moderation action.
  //
  // A notification rather than a chat message on purpose: moderation shouldn't
  // arrive from the acting admin's personal account, and it shouldn't land in
  // the pair Conversation that listDealTranscript later reads as evidence. The
  // seller's reply path is the appeal, not a chat bubble.
  void notify({
    userId: listing.sellerId,
    category: "listing",
    title: "Your listing was removed",
    body:
      `"${listing.title}" was removed by an administrator. Reason: ${reasonText}` +
      (canDispute ? " You can submit a dispute for review." : " This removal can't be disputed."),
    link: `/listings/${listingId}`,
  });

  prisma.user
    .findUnique({ where: { id: listing.sellerId }, select: { email: true, fullName: true } })
    .then(
      (seller) =>
        seller &&
        mailer.listingRemoved(seller.email, seller.fullName, listing.title, reasonText, canDispute),
    )
    .catch(() => undefined);

  // Close the loop with whoever flagged it. Links to the marketplace, not the
  // listing — that page 404s for everyone but the seller now.
  if (reporterIds.length > 0) {
    void notifyMany(reporterIds, {
      category: "listing",
      title: "Thanks — that listing is gone",
      body: `"${listing.title}" was removed after review. Thanks for reporting it.`,
      link: "/marketplace",
    });
  }

  return toAdminListing(updated);
}

// ---------- Buyer reports (the moderation queue) ----------

const reportInclude = {
  reporter: { select: { username: true, avatarUrl: true } },
  reviewedBy: { select: { username: true } },
  listing: {
    select: {
      id: true,
      title: true,
      images: true,
      price: true,
      currency: true,
      category: true,
      status: true,
      seller: { select: { username: true, avatarUrl: true } },
    },
  },
} satisfies Prisma.ListingReportInclude;

type ReportRow = Prisma.ListingReportGetPayload<{ include: typeof reportInclude }>;

/**
 * The queue, one card per reported listing.
 *
 * Grouping happens in memory: the rows come off the report table but the unit
 * of review is the listing, and no single Prisma query returns "listings with
 * their reports" from this side. Same fetch-then-shape approach the rating sort
 * in listings.service takes — fine at marketplace scale, and the alternative is
 * a query per listing.
 */
export async function listReports(params: {
  status: "open" | "actioned" | "dismissed" | "all";
  page: number;
  limit: number;
}) {
  const { status, page, limit } = params;
  const where: Prisma.ListingReportWhereInput = status === "all" ? {} : { status };

  const rows = await prisma.listingReport.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: reportInclude,
  });

  const groups = groupByListing(rows);
  const start = (page - 1) * limit;

  return {
    groups: groups.slice(start, start + limit),
    total: groups.length,
    page,
    pages: Math.max(1, Math.ceil(groups.length / limit)),
  };
}

/**
 * Rows arrive newest-first, so first-seen wins throughout: Map insertion order
 * already ranks the groups by their most recent report, and a strict `>` on the
 * reason tally breaks ties toward the more recently reported reason.
 */
function groupByListing(rows: ReportRow[]) {
  const groups = new Map<
    string,
    { listing: ReportRow["listing"]; tally: Map<ListingRemovalReason, number>; reports: ReportRow[] }
  >();

  for (const r of rows) {
    let group = groups.get(r.listingId);
    if (!group) {
      group = { listing: r.listing, tally: new Map(), reports: [] };
      groups.set(r.listingId, group);
    }
    group.tally.set(r.reason, (group.tally.get(r.reason) ?? 0) + 1);
    group.reports.push(r);
  }

  return [...groups.values()].map(({ listing, tally, reports }) => {
    const reasonCounts = [...tally.entries()]
      .map(([reason, count]) => ({ reason, reasonText: removalReasonText(reason), count }))
      .sort((a, b) => b.count - a.count);

    return {
      listing: {
        id: listing.id,
        title: listing.title,
        image: listing.images[0] ?? null,
        price: Number(listing.price),
        currency: listing.currency,
        category: listing.category,
        status: listing.status,
        seller: listing.seller,
      },
      reportCount: reports.length,
      reasonCounts,
      // Pre-selects the takedown dialog: what most reporters said it was.
      topReason: reasonCounts[0]!.reason,
      openCount: reports.filter((r) => r.status === "open").length,
      firstReportedAt: reports[reports.length - 1]!.createdAt.toISOString(),
      lastReportedAt: reports[0]!.createdAt.toISOString(),
      reports: reports.map((r) => ({
        id: r.id,
        reason: r.reason,
        // `other` says nothing on its own, so the reporter's note stands in for it.
        reasonText: removalReasonText(r.reason, r.note),
        note: r.note,
        status: r.status,
        reviewNote: r.reviewNote,
        reviewedBy: r.reviewedBy?.username ?? null,
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
        reporter: r.reporter,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });
}

/**
 * The negative verdict: the listing stays up. Clears every open report on it in
 * one go — they're all answered by the same finding, and leaving stragglers
 * would put the listing straight back in the queue.
 */
export async function dismissListingReports(adminId: string, listingId: string, note?: string | null) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: { id: true, title: true },
  });
  if (!listing) throw ApiError.notFound("Listing not found");

  const open = await prisma.listingReport.findMany({
    where: { listingId, status: "open" },
    select: { reporterId: true },
  });
  if (open.length === 0) throw ApiError.conflict("There are no open reports on this listing");

  const reviewNote = note?.trim() || null;
  const { count } = await prisma.listingReport.updateMany({
    where: { listingId, status: "open" },
    data: { status: "dismissed", reviewNote, reviewedById: adminId, reviewedAt: new Date() },
  });

  void notifyMany(
    open.map((o) => o.reporterId),
    {
      category: "listing",
      title: "We reviewed your report",
      body:
        `We looked at "${listing.title}" and found nothing that breaks the rules, so it stays up.` +
        (reviewNote ? ` Note: ${reviewNote}` : ""),
      link: `/marketplace/${listingId}`,
    },
  );

  return { dismissed: count };
}

// ---------- Listing disputes (seller appeals against a takedown) ----------

const disputeInclude = {
  listing: {
    select: {
      id: true,
      title: true,
      description: true,
      price: true,
      category: true,
      condition: true,
      quantity: true,
      images: true,
      location: true,
      status: true,
      removalReason: true,
      removalNote: true,
    },
  },
  seller: { select: { username: true, avatarUrl: true } },
  reviewedBy: { select: { username: true } },
} satisfies Prisma.ListingDisputeInclude;

type DisputeWithListing = Prisma.ListingDisputeGetPayload<{ include: typeof disputeInclude }>;

// No snapshot/diff: the listing is frozen at removal, so what the reviewer sees
// is by definition what was taken down.
function toAdminDispute(d: DisputeWithListing) {
  return {
    id: d.id,
    status: d.status,
    explanation: d.explanation,
    reviewNote: d.reviewNote,
    reviewedBy: d.reviewedBy?.username ?? null,
    reviewedAt: d.reviewedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    seller: { username: d.seller.username, avatarUrl: d.seller.avatarUrl },
    listing: {
      id: d.listing.id,
      status: d.listing.status,
      image: d.listing.images[0] ?? null,
      removalReasonText: d.listing.removalReason
        ? removalReasonText(d.listing.removalReason, d.listing.removalNote)
        : null,
      title: d.listing.title,
      description: d.listing.description,
      price: Number(d.listing.price),
      category: d.listing.category,
      condition: d.listing.condition,
      quantity: d.listing.quantity,
      images: d.listing.images,
      location: d.listing.location,
    },
  };
}

export async function listListingDisputes(status: "open" | "resolved" | "all") {
  const where: Prisma.ListingDisputeWhereInput =
    status === "all" ? {} : status === "open" ? { status: "open" } : { status: { in: ["approved", "rejected"] } };

  const rows = await prisma.listingDispute.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: disputeInclude,
  });
  return { disputes: rows.map(toAdminDispute), total: rows.length };
}

/**
 * Rule on an appeal. Approving reinstates the listing (clearing the takedown
 * trail); rejecting leaves it removed and closes the appeal.
 */
export async function resolveListingDispute(
  adminId: string,
  id: string,
  input: { decision: "approve" | "reject"; note?: string },
) {
  const dispute = await prisma.listingDispute.findUnique({
    where: { id },
    select: { id: true, status: true, listingId: true, sellerId: true, listing: { select: { title: true } } },
  });
  if (!dispute) throw ApiError.notFound("Dispute not found");
  if (dispute.status !== "open") throw ApiError.conflict("This dispute has already been reviewed");

  const approved = input.decision === "approve";
  const note = input.note?.trim() || null;

  const updated = await prisma.$transaction(async (tx) => {
    if (approved) {
      // Reinstate first, so the dispute we return below carries the fresh
      // listing state rather than a pre-update snapshot.
      await tx.listing.update({
        where: { id: dispute.listingId },
        data: {
          status: "active",
          removalReason: null,
          removalNote: null,
          removedAt: null,
          removedById: null,
          disputeAllowed: false,
        },
      });
    } else {
      // A rejection is the end of the road: clearing the flag stops further
      // edits (update() gates on it) and stops a second dispute being filed,
      // which submitDispute would otherwise allow once this one is closed.
      await tx.listing.update({
        where: { id: dispute.listingId },
        data: { disputeAllowed: false },
      });
    }

    return tx.listingDispute.update({
      where: { id },
      data: {
        status: approved ? "approved" : "rejected",
        reviewNote: note,
        reviewedById: adminId,
        reviewedAt: new Date(),
      },
      include: disputeInclude,
    });
  });

  const title = dispute.listing.title;
  void notify({
    userId: dispute.sellerId,
    category: "listing",
    title: approved ? "Your dispute was approved" : "Your dispute was rejected",
    body: approved
      ? `"${title}" is live again.${note ? ` Note: ${note}` : ""}`
      : `"${title}" stays removed.${note ? ` Note: ${note}` : ""}`,
    link: `/listings/${dispute.listingId}`,
  });

  prisma.user
    .findUnique({ where: { id: dispute.sellerId }, select: { email: true, fullName: true } })
    .then(
      (seller) =>
        seller &&
        (approved
          ? mailer.listingDisputeApproved(seller.email, seller.fullName, title, note)
          : mailer.listingDisputeRejected(seller.email, seller.fullName, title, note)),
    )
    .catch(() => undefined);

  return toAdminDispute(updated);
}

// ---------- Single listing: the admin review page ----------

/**
 * Everything an admin needs to judge a listing without leaving the page — the
 * full description and image set (the list view truncates both), the seller's
 * standing, and the takedown trail if there is one.
 */
export async function getListing(id: string) {
  const l = await prisma.listing.findUnique({
    where: { id },
    include: {
      seller: {
        select: {
          id: true,
          username: true,
          avatarUrl: true,
          email: true,
          createdAt: true,
          status: true,
          kyc: { select: { status: true, storeName: true } },
          _count: { select: { listings: true } },
        },
      },
      removedBy: { select: { username: true } },
      disputes: { orderBy: { createdAt: "desc" }, take: 1 },
      reviews: { select: { rating: true } },
      _count: { select: { escrows: true } },
    },
  });
  if (!l) throw ApiError.notFound("Listing not found");

  const ratings = l.reviews.map((r) => r.rating);
  const dispute = l.disputes[0];

  return {
    id: l.id,
    title: l.title,
    description: l.description,
    price: Number(l.price),
    currency: l.currency,
    category: l.category,
    condition: l.condition,
    quantity: l.quantity,
    images: l.images,
    location: l.location,
    status: l.status,
    views: l.views,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
    rating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
    reviewCount: ratings.length,
    /** Deals referencing this listing — why a takedown is a soft delete. */
    dealCount: l._count.escrows,
    seller: {
      id: l.seller.id,
      username: l.seller.username,
      avatarUrl: l.seller.avatarUrl,
      email: l.seller.email,
      storeName: l.seller.kyc?.storeName ?? null,
      kycStatus: l.seller.kyc?.status ?? "unverified",
      accountStatus: l.seller.status,
      listingsCount: l.seller._count.listings,
      joinedAt: l.seller.createdAt.toISOString(),
    },
    removal: l.removedAt && l.removalReason
      ? {
          reason: l.removalReason,
          reasonText: removalReasonText(l.removalReason, l.removalNote),
          note: l.removalNote,
          removedAt: l.removedAt.toISOString(),
          removedBy: l.removedBy?.username ?? null,
          disputeAllowed: l.disputeAllowed,
        }
      : null,
    dispute: dispute
      ? {
          id: dispute.id,
          status: dispute.status,
          explanation: dispute.explanation,
          reviewNote: dispute.reviewNote,
          createdAt: dispute.createdAt.toISOString(),
        }
      : null,
  };
}

/**
 * Put a removed listing back on the marketplace, clearing the takedown trail.
 *
 * Separate from approving an appeal: this is an admin changing their own mind,
 * so there's no dispute to rule on. Any open appeal is closed as approved —
 * the seller got what they asked for.
 */
export async function reinstateListing(adminId: string, listingId: string) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: { id: true, title: true, status: true, sellerId: true, quantity: true },
  });
  if (!listing) throw ApiError.notFound("Listing not found");
  if (listing.status !== "removed") throw ApiError.conflict("This listing isn't removed");

  const updated = await prisma.$transaction(async (tx) => {
    await tx.listingDispute.updateMany({
      where: { listingId, status: "open" },
      data: {
        status: "approved",
        reviewNote: "Listing reinstated by an administrator.",
        reviewedById: adminId,
        reviewedAt: new Date(),
      },
    });
    return tx.listing.update({
      where: { id: listingId },
      data: {
        // Out of stock stays out of stock — reinstating shouldn't resurrect
        // a listing with nothing left to sell.
        status: listing.quantity > 0 ? "active" : "out_of_stock",
        removalReason: null,
        removalNote: null,
        removedAt: null,
        removedById: null,
        disputeAllowed: false,
      },
      select: listingRowSelect,
    });
  });

  void notify({
    userId: listing.sellerId,
    category: "listing",
    title: "Your listing is back online",
    body: `"${listing.title}" has been reinstated by an administrator and is visible to buyers again.`,
    link: `/listings/${listingId}`,
  });

  prisma.user
    .findUnique({ where: { id: listing.sellerId }, select: { email: true, fullName: true } })
    .then((seller) => seller && mailer.listingDisputeApproved(seller.email, seller.fullName, listing.title, null))
    .catch(() => undefined);

  return toAdminListing(updated);
}

// ---------- Withdrawals (payout moderation) ----------

/**
 * The payout queue. Money is already out of the user's balance by the time a
 * row appears here — `wallet.service.withdraw` debits on request — so what an
 * admin decides is whether it actually leaves the platform, or comes back.
 */
export async function listWithdrawals(
  status: WithdrawalStatus | "all",
  page: number,
  limit: number,
) {
  const where: Prisma.WithdrawalWhereInput = status === "all" ? {} : { status };
  const [total, rows] = await Promise.all([
    prisma.withdrawal.count({ where }),
    prisma.withdrawal.findMany({
      where,
      // Oldest pending first: a payout queue is worked front to back, unlike
      // the other admin lists where newest-first is what you want.
      orderBy: { createdAt: status === "pending" ? "asc" : "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        user: { select: { id: true, username: true, email: true, fullName: true } },
        reviewedBy: { select: { username: true } },
      },
    }),
  ]);

  return {
    withdrawals: rows.map((w) => ({
      ...walletService.serializeWithdrawal(w),
      user: {
        id: w.user.id,
        username: w.user.username,
        email: w.user.email,
        fullName: w.user.fullName,
      },
      reviewedBy: w.reviewedBy?.username ?? null,
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

/**
 * Guarded claim of a pending row, so two admins can't both rule on one payout.
 *
 * Takes the client to run on rather than reaching for `prisma` itself, so the
 * claim can be enrolled in a caller's transaction. That matters for rejection,
 * where the claim and the refund have to succeed or fail together — see
 * `rejectWithdrawal`.
 */
async function claimWithdrawal(
  db: Prisma.TransactionClient,
  id: string,
  adminId: string,
  status: WithdrawalStatus,
  reviewNote?: string,
) {
  const claimed = await db.withdrawal.updateMany({
    where: { id, status: "pending" },
    data: { status, reviewNote: reviewNote ?? null, reviewedById: adminId, reviewedAt: new Date() },
  });
  if (claimed.count === 0) {
    const existing = await db.withdrawal.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Withdrawal not found");
    throw ApiError.conflict(`This payout was already ${existing.status}`);
  }
  return db.withdrawal.findUniqueOrThrow({ where: { id } });
}

/**
 * Mark a payout as actually sent. No money moves — it left on request.
 *
 * No transaction needed, and none used: the guarded claim is a single statement
 * and there is nothing for it to be atomic *with*.
 */
export async function completeWithdrawal(adminId: string, id: string) {
  const withdrawal = await claimWithdrawal(prisma, id, adminId, "completed");

  void notify({
    userId: withdrawal.userId,
    category: "wallet",
    title: "Withdrawal sent",
    body: `${walletService.formatAmount(Number(withdrawal.amount), withdrawal.currency)} is on its way to ${withdrawal.destination}.`,
    link: "/wallet",
  });

  return walletService.serializeWithdrawal(withdrawal);
}

/**
 * Refuse a payout and give the money back.
 *
 * The credit is the whole point: the balance was debited when the request was
 * made, so rejecting without crediting would simply destroy it.
 *
 * Claim and credit run in **one** transaction, and that is the whole reason
 * this function has one. They used to be separate statements: the row was
 * marked `rejected` first, then the refund went out on its own. A process that
 * died in between left a payout reading "rejected — returned to your balance"
 * over money that was never returned, and nothing could ever find it again,
 * because the row itself claimed the refund had happened. Together, either both
 * land or neither does, and a failed reject leaves the payout pending for
 * someone to rule on again.
 *
 * The guarded claim inside still does its other job — stopping two admins from
 * both refunding one payout — since only one of them can move it off `pending`.
 */
export async function rejectWithdrawal(adminId: string, id: string, reason: string) {
  const withdrawal = await prisma.$transaction(async (tx) => {
    const claimed = await claimWithdrawal(tx, id, adminId, "rejected", reason);
    await walletService.credit(
      tx,
      claimed.userId,
      claimed.currency,
      Number(claimed.amount),
      "withdrawal",
      `Withdrawal ${claimed.reference} rejected — returned to balance`,
    );
    return claimed;
  });

  void notify({
    userId: withdrawal.userId,
    category: "wallet",
    title: "Withdrawal rejected",
    body: `${walletService.formatAmount(Number(withdrawal.amount), withdrawal.currency)} has been returned to your balance. ${reason}`,
    link: "/wallet",
  });

  return walletService.serializeWithdrawal(withdrawal);
}

// ---------- Platform settings ----------

/**
 * The Paystack test/live switch, held in the `paystack_mode` singleton so it can
 * be flipped from the console instead of by editing `.env` and redeploying.
 *
 * `upsert` rather than `findUnique`/`update` throughout: the row is seeded by
 * migration, but a database restored without it must still answer here rather
 * than 500 the settings page. The create falls back to the column default,
 * which is `test`.
 */
export async function getPaystackMode() {
  const row = await prisma.paystackMode.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
  return {
    mode: row.mode,
    updatedAt: row.updatedAt,
    // The console needs to know which secrets actually exist on the server, so
    // it can explain a mode it cannot offer instead of failing on submit.
    testKeyConfigured: Boolean(env.PAYSTACK_SECRET_KEY),
    liveKeyConfigured: Boolean(env.PAYSTACK_SECRET_KEY_LIVE),
  };
}

export async function setPaystackMode(adminId: string, mode: PaystackEnvironment) {
  // Refuse a mode whose key is missing rather than accepting the flip and
  // failing every deposit afterwards with a 501 the admin never sees.
  const key = mode === "live" ? env.PAYSTACK_SECRET_KEY_LIVE : env.PAYSTACK_SECRET_KEY;
  if (!key) {
    throw ApiError.badRequest(
      `Cannot switch to ${mode} mode: no ${mode} secret key is configured on the server`,
    );
  }

  const row = await prisma.paystackMode.upsert({
    where: { id: "singleton" },
    update: { mode },
    create: { id: "singleton", mode },
  });

  // Deliberately noisy. Going live means real cards get charged, and this line
  // is the only record of who made that happen.
  console.warn(`[admin] Paystack mode switched to ${row.mode} by admin ${adminId}`);

  return {
    mode: row.mode,
    updatedAt: row.updatedAt,
    testKeyConfigured: Boolean(env.PAYSTACK_SECRET_KEY),
    liveKeyConfigured: Boolean(env.PAYSTACK_SECRET_KEY_LIVE),
  };
}
