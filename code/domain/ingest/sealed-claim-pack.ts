/**
 * T-60-01 / T004 — SealedClaimPack domain shape (content-addressed snapshot).
 *
 * HONESTY: evidence refs on sealed claims are INHERITED from durable claim
 * records. The seal proves snapshot fidelity of selected claim versions — it
 * does NOT re-verify that those refs were packet-mapped at write time (T004).
 *
 * T004: applicationRefs are a FIELD on the pack and in the seal hash so
 * selection is auditable (re-derive accept−reject) as well as reproducible.
 * Application refs prove selection matches RECORDED decisions; they do NOT
 * prove those decisions were correct.
 */
import { z } from "zod";

import {
  ClaimIdSchema,
  ClaimSchema,
  type Claim,
} from "./claim.js";
import {
  ClaimReviewDecisionSchema,
  ClaimReviewIdSchema,
} from "./claim-review.js";
import { QuestionIdSchema } from "./id-schemas.js";
import type { ClaimId, GraphRevision, Sha256 } from "./types.js";

const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .transform((v) => v as Sha256);

export const QualifierEdgeSchema = z
  .object({
    from: ClaimIdSchema,
    to: ClaimIdSchema,
  })
  .strict();

export type QualifierEdge = {
  readonly from: ClaimId;
  readonly to: ClaimId;
};

export const PackCitationSchema = z
  .object({
    claimId: ClaimIdSchema,
    unitId: z.string().min(1),
    unitSha256: Sha256Schema,
    fileSha256: Sha256Schema,
    snapshotId: z.string().min(1),
  })
  .strict();

export type PackCitation = z.infer<typeof PackCitationSchema>;

/**
 * T004 / B009 — durable review application witness on the pack (audit material).
 *
 * Design B: one ref per (applicationId, claimId) pair. Multi-id applications
 * expand to multiple refs so deriveClaimIdsFromApplicationRefs matches
 * listAcceptedClaimIds array semantics. Single-id accept/reject apps still
 * emit exactly one ref (seal hash stable for existing v2 fixtures).
 *
 * Dual-gate membership remains authority; refs are an independent witness.
 */
export const PackApplicationRefSchema = z
  .object({
    applicationId: z.string().min(1).max(128),
    reviewId: ClaimReviewIdSchema,
    claimId: ClaimIdSchema,
    decision: ClaimReviewDecisionSchema,
  })
  .strict();

export type PackApplicationRef = z.infer<typeof PackApplicationRefSchema>;

export const SealedClaimPackSchema = z
  .object({
    schemaVersion: z.literal(2),
    hash: Sha256Schema,
    questionId: QuestionIdSchema,
    graphRevision: z.number().int().nonnegative(),
    claimIds: z.array(ClaimIdSchema).max(10_000),
    claims: z.array(ClaimSchema).max(10_000),
    qualifierEdges: z.array(QualifierEdgeSchema).max(50_000),
    citations: z.array(PackCitationSchema).max(50_000),
    gaps: z.array(z.string().min(1).max(512)).max(1_024),
    applicationRefs: z.array(PackApplicationRefSchema).max(50_000),
  })
  .strict();

export type SealedClaimPack = {
  readonly schemaVersion: 2;
  readonly hash: Sha256;
  readonly questionId: string;
  readonly graphRevision: GraphRevision;
  readonly claimIds: readonly ClaimId[];
  readonly claims: readonly Claim[];
  readonly qualifierEdges: readonly QualifierEdge[];
  readonly citations: readonly PackCitation[];
  readonly gaps: readonly string[];
  readonly applicationRefs: readonly PackApplicationRef[];
};
