import { Router } from "express";
import { auth, requireAdmin } from "../../shared/middleware/auth.middleware";
import { validate } from "../../shared/middleware/validate.middleware";
import * as adminController from "./admin.controller";
import * as adminValidation from "./admin.validation";

export const adminRouter = Router();

// Every admin route: signed in + admin role.
adminRouter.use(auth, requireAdmin);

adminRouter.get("/kyc", validate(adminValidation.kycList), adminController.listKyc);
adminRouter.get("/kyc/:id", validate(adminValidation.kycParam), adminController.getKyc);
adminRouter.post("/kyc/:id/approve", validate(adminValidation.kycParam), adminController.approveKyc);
adminRouter.post("/kyc/:id/reject", validate(adminValidation.kycReject), adminController.rejectKyc);

adminRouter.get("/disputes", validate(adminValidation.disputeList), adminController.listDisputes);
adminRouter.get("/disputes/:id", validate(adminValidation.disputeParam), adminController.getDispute);
adminRouter.post("/disputes/:id/note", validate(adminValidation.disputeNote), adminController.postDisputeNote);
adminRouter.post("/disputes/:id/resolve", validate(adminValidation.disputeResolve), adminController.resolveDispute);

adminRouter.get("/users", validate(adminValidation.userList), adminController.listUsers);
adminRouter.get("/users/:id", validate(adminValidation.userParam), adminController.getUser);
adminRouter.patch("/users/:id/status", validate(adminValidation.userStatus), adminController.setUserStatus);

adminRouter.get("/listings", validate(adminValidation.listingList), adminController.listListings);
adminRouter.get("/listings/:id", validate(adminValidation.listingParam), adminController.getListing);
adminRouter.post("/listings/:id/remove", validate(adminValidation.listingRemove), adminController.removeListing);
adminRouter.post(
  "/listings/:id/reinstate",
  validate(adminValidation.listingParam),
  adminController.reinstateListing,
);

// Buyer reports. Dismissal hangs off the listing, not a report id — it's a
// verdict on the listing, and it clears every open report at once. The other
// verdict needs no endpoint: /listings/:id/remove actions them.
adminRouter.get("/reports", validate(adminValidation.reportList), adminController.listReports);
adminRouter.post(
  "/listings/:id/reports/dismiss",
  validate(adminValidation.reportsDismiss),
  adminController.dismissListingReports,
);

// Seller appeals against a takedown ("/listing-disputes" kept distinct from escrow "/disputes")
adminRouter.get("/listing-disputes", validate(adminValidation.listingDisputeList), adminController.listListingDisputes);
adminRouter.post(
  "/listing-disputes/:id/resolve",
  validate(adminValidation.listingDisputeResolve),
  adminController.resolveListingDispute,
);

adminRouter.get("/escrows", validate(adminValidation.escrowList), adminController.listEscrows);

// Payout moderation. The money has already left the user's balance by the time
// it appears here — completing confirms it was sent, rejecting returns it.
adminRouter.get("/withdrawals", validate(adminValidation.withdrawalList), adminController.listWithdrawals);
adminRouter.post(
  "/withdrawals/:id/complete",
  validate(adminValidation.withdrawalParam),
  adminController.completeWithdrawal,
);
adminRouter.post(
  "/withdrawals/:id/reject",
  validate(adminValidation.withdrawalReject),
  adminController.rejectWithdrawal,
);

adminRouter.get("/stats", adminController.getStats);

// Payment environment. Test/live lives in the database rather than the
// environment so it can be switched from the console without a redeploy.
adminRouter.get("/settings/paystack-mode", adminController.getPaystackMode);
adminRouter.patch(
  "/settings/paystack-mode",
  validate(adminValidation.paystackMode),
  adminController.setPaystackMode,
);
