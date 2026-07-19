/**
 * T-22-03 — ClaimReview domain model.
 *
 * ClaimReview is a fresh-context verdict applied by ClaimReviewService.
 * Rejection is a *review outcome*, not a ClaimState (T-22-01 froze the
 * five-set proposed|accepted|disputed|stale|superseded without "rejected").
 *
 * Plan: r0-r1-implementation-plan.md L965–987.
 */
import { z } from "zod";

import { ClaimIdSchema, ClaimTypeSchema } from "./claim.js";
import { ULID_PATTERN } from "./id-schemas.js";
import type { ClaimId } from "./types.js";

/** Application / review id brand: crv- + Crockford ULID body. */
export const ClaimReviewIdSchema = z
  .string()
  .regex(new RegExp(`^crv-${ULID_PATTERN}$`))
  .transform((value) => value as ClaimReviewId);

export type ClaimReviewId = string & { readonly __brand: "ClaimReviewId" };

export const ClaimReviewDecisionSchema = z.enum([
  "accept",
  "reject",
  "qualify",
  "split",
]);

export type ClaimReviewDecision = z.infer<typeof ClaimReviewDecisionSchema>;

export const ClaimSplitSpecSchema = z
  .object({
    statement: z.string().min(1).max(8_000),
    claimType: ClaimTypeSchema,
    scope: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ClaimSplitSpec = {
  readonly statement: string;
  readonly claimType: z.infer<typeof ClaimTypeSchema>;
  readonly scope: Readonly<Record<string, unknown>>;
};

/**
 * ClaimReview — independent reviewer verdict.
 * extractorRunId is declared on the review for audit; SoD enforcement uses
 * AUTHORITATIVE packet→run resolution, not this field alone (see service).
 */
export const ClaimReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: ClaimReviewIdSchema,
    claimId: ClaimIdSchema,
    expectedVersion: z.number().int().positive().max(1_000_000),
    decision: ClaimReviewDecisionSchema,
    reviewerRunId: z.string().min(1).max(128),
    /** Audit declaration of the subject extractor run (not the SoD trust root). */
    extractorRunId: z.string().min(1).max(128),
    reason: z.string().min(1).max(2_000).optional(),
    splits: z.array(ClaimSplitSpecSchema).min(1).max(32).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === "split") {
      if (!value.splits || value.splits.length < 1) {
        ctx.addIssue({
          code: "custom",
          path: ["splits"],
          message: "split decision requires splits",
        });
      }
    } else if (value.splits !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["splits"],
        message: "splits only allowed for split decision",
      });
    }
  });

export type ClaimReview = {
  readonly schemaVersion: 1;
  readonly id: ClaimReviewId;
  readonly claimId: ClaimId;
  readonly expectedVersion: number;
  readonly decision: ClaimReviewDecision;
  readonly reviewerRunId: string;
  readonly extractorRunId: string;
  readonly reason?: string;
  readonly splits?: readonly ClaimSplitSpec[];
};

export const ClaimReviewProvenanceLinkSchema = z
  .object({
    fromClaimId: ClaimIdSchema,
    toClaimId: ClaimIdSchema,
    relation: z.enum(["split_from", "qualified_by", "supersedes"]),
  })
  .strict();

export type ClaimReviewProvenanceLink = {
  readonly fromClaimId: ClaimId;
  readonly toClaimId: ClaimId;
  readonly relation: "split_from" | "qualified_by" | "supersedes";
};

export const ClaimReviewApplicationSchema = z
  .object({
    schemaVersion: z.literal(1),
    applicationId: z.string().min(1).max(128),
    reviewApplicationRef: z.string().min(1).max(128),
    reviewId: ClaimReviewIdSchema,
    claimId: ClaimIdSchema,
    decision: ClaimReviewDecisionSchema,
    acceptedClaimIds: z.array(ClaimIdSchema).max(256),
    rejectedClaimIds: z.array(ClaimIdSchema).max(256),
    splitClaimIds: z.array(ClaimIdSchema).max(256),
    provenanceLinks: z.array(ClaimReviewProvenanceLinkSchema).max(512),
    reviewerRunId: z.string().min(1).max(128),
    idempotencyKey: z.string().min(1).max(256),
  })
  .strict();

export type ClaimReviewApplication = {
  readonly schemaVersion: 1;
  readonly applicationId: string;
  readonly reviewApplicationRef: string;
  readonly reviewId: ClaimReviewId;
  readonly claimId: ClaimId;
  readonly decision: ClaimReviewDecision;
  readonly acceptedClaimIds: readonly ClaimId[];
  readonly rejectedClaimIds: readonly ClaimId[];
  readonly splitClaimIds: readonly ClaimId[];
  readonly provenanceLinks: readonly ClaimReviewProvenanceLink[];
  readonly reviewerRunId: string;
  readonly idempotencyKey: string;
};
