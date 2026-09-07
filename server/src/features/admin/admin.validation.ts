import Joi from "joi";
import type { RequestSchema } from "../../shared/middleware/validate.middleware";

export const kycList: RequestSchema = {
  query: Joi.object({
    status: Joi.string().valid("pending", "verified", "rejected").default("pending"),
  }),
};

export const kycParam: RequestSchema = {
  params: Joi.object({
    id: Joi.string().guid().required(),
  }),
};

export const kycReject: RequestSchema = {
  params: Joi.object({
    id: Joi.string().guid().required(),
  }),
  body: Joi.object({
    reason: Joi.string().trim().min(5).max(500).required().messages({
      "string.min": "Give the applicant a clear rejection reason (min 5 chars)",
    }),
  }),
};

export const disputeList: RequestSchema = {
  query: Joi.object({
    status: Joi.string().valid("open", "resolved", "all").default("open"),
  }),
};

export const disputeParam: RequestSchema = {
  params: Joi.object({
    id: Joi.string().guid().required(),
  }),
};

export const disputeNote: RequestSchema = {
  params: Joi.object({
    id: Joi.string().guid().required(),
  }),
  body: Joi.object({
    body: Joi.string().trim().min(3).max(1000).required().messages({
      "string.empty": "Write something to send to the parties",
    }),
  }),
};

export const disputeResolve: RequestSchema = {
  params: Joi.object({
    id: Joi.string().guid().required(),
  }),
  body: Joi.object({
    outcome: Joi.string().valid("release", "refund", "split").required(),
    buyerRefund: Joi.number().min(0).optional(),
    rulingNote: Joi.string().trim().min(5).max(1000).required().messages({
      "string.min": "Provide a clear ruling explanation note (min 5 chars)",
    }),
  }),
};

export const userList: RequestSchema = {
  query: Joi.object({
    search: Joi.string().trim().allow("").optional(),
    role: Joi.string().valid("user", "admin").optional(),
    status: Joi.string().valid("active", "suspended").optional(),
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
  }),
};

export const userParam: RequestSchema = {
  params: Joi.object({
    id: Joi.string().guid().required(),
  }),
};

export const userStatus: RequestSchema = {
  params: Joi.object({
    id: Joi.string().guid().required(),
  }),
  body: Joi.object({
    status: Joi.string().valid("active", "suspended").required(),
  }),
};

export const escrowList: RequestSchema = {
  query: Joi.object({
    status: Joi.string().valid("created", "funded", "delivered", "disbursed", "disputed", "cancelled").optional(),
    search: Joi.string().trim().allow("").optional(),
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
  }),
};

export const listingList: RequestSchema = {
  query: Joi.object({
    search: Joi.string().trim().allow("").optional(),
    status: Joi.string().valid("draft", "active", "out_of_stock", "removed").optional(),
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
  }),
};

export const listingRemove: RequestSchema = {
  params: Joi.object({
    id: Joi.string().guid().required(),
  }),
  body: Joi.object({
    reason: Joi.string()
      .valid("prohibited_item", "duplicate", "misleading", "spam", "guidelines", "fraud", "other")
      .required(),
    // Whether the seller may appeal this takedown.
    disputeAllowed: Joi.boolean().default(false),
    // Required only for `other`, where the label alone says nothing.
    note: Joi.string().trim().max(500).allow("", null).when("reason", {
      is: "other",
      then: Joi.string().trim().min(3).max(500).required().messages({
        "any.required": "Describe the reason when choosing Other",
        "string.empty": "Describe the reason when choosing Other",
        "string.min": "Give a little more detail (at least 3 characters)",
      }),
    }),
  }),
};

export const listingDisputeList: RequestSchema = {
  query: Joi.object({
    status: Joi.string().valid("open", "resolved", "all").default("open"),
  }),
};

export const listingDisputeResolve: RequestSchema = {
  params: Joi.object({
    id: Joi.string().guid().required(),
  }),
  body: Joi.object({
    decision: Joi.string().valid("approve", "reject").required(),
    note: Joi.string().trim().max(1000).allow("", null),
  }),
};

export const listingParam: RequestSchema = {
  params: Joi.object({
    id: Joi.string().guid().required(),
  }),
};

// Buyer reports. Paginated over *listings* rather than rows — the queue groups
// every report for one listing into a single card.
export const reportList: RequestSchema = {
  query: Joi.object({
    status: Joi.string().valid("open", "actioned", "dismissed", "all").default("open"),
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
  }),
};

export const reportsDismiss: RequestSchema = {
  params: Joi.object({
    id: Joi.string().guid().required(),
  }),
  body: Joi.object({
    note: Joi.string().trim().max(500).allow("", null),
  }),
};

export const withdrawalList: RequestSchema = {
  query: Joi.object({
    status: Joi.string().valid("pending", "completed", "rejected", "all").default("pending"),
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
  }),
};

export const withdrawalParam: RequestSchema = {
  params: Joi.object({
    id: Joi.string().guid().required(),
  }),
};

export const withdrawalReject: RequestSchema = {
  params: Joi.object({
    id: Joi.string().guid().required(),
  }),
  body: Joi.object({
    // Required, not optional: the money goes back to the user and they are told
    // why, so "rejected" with no reason is not a usable outcome for them.
    reason: Joi.string().trim().min(3).max(500).required(),
  }),
};

/** Test first, live second — the order the console offers them in. */
export const paystackMode: RequestSchema = {
  body: Joi.object({
    mode: Joi.string().valid("test", "live").required(),
  }),
};
