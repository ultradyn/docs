/**
 * T-60-01 — SealedClaimPack domain shape (content-addressed snapshot).
 *
 * HONESTY: evidence refs on sealed claims are INHERITED from durable claim
 * records. The seal proves snapshot fidelity of selected claim versions — it
 * does NOT re-verify that those refs were packet-mapped at write time (T004).
 * Application refs are NOT in v1 (follow-up P2.M3.E4.T004).
 */
import { z } from "zod";

import {
  ClaimIdSchema,
  ClaimSchema,
  type Claim,
  type ClaimId,
} from "./claim.js";
import { QuestionIdSchema } from "./id-schemas.js";
import type { GraphRevision, Sha256 } from "./types.js";

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

export const SealedClaimPackSchema = z
  .object({
    schemaVersion: z.literal(1),
    hash: Sha256Schema,
    questionId: QuestionIdSchema,
    graphRevision: z.number().int().nonnegative(),
    claimIds: z.array(ClaimIdSchema).max(10_000),
    claims: z.array(ClaimSchema).max(10_000),
    qualifierEdges: z.array(QualifierEdgeSchema).max(50_000),
    citations: z.array(PackCitationSchema).max(50_000),
    gaps: z.array(z.string().min(1).max(512)).max(1_024),
  })
  .strict();

export type SealedClaimPack = {
  readonly schemaVersion: 1;
  readonly hash: Sha256;
  readonly questionId: string;
  readonly graphRevision: GraphRevision;
  readonly claimIds: readonly ClaimId[];
  readonly claims: readonly Claim[];
  readonly qualifierEdges: readonly QualifierEdge[];
  readonly citations: readonly PackCitation[];
  readonly gaps: readonly string[];
};
