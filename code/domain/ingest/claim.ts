import { z } from "zod";

import {
  QuestionIdSchema,
  SnapshotIdSchema,
  SourceFileIdSchema,
  SourceUnitIdSchema,
  ULID_PATTERN,
} from "./id-schemas.js";
import type { ClaimId, Sha256 } from "./types.js";

const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "must be 64 lowercase hex characters")
  .transform((value) => value as Sha256);

/** Claim id brand: clm- + Crockford ULID body. */
export const ClaimIdSchema = z
  .string()
  .regex(new RegExp(`^clm-${ULID_PATTERN}$`))
  .transform((value) => value as ClaimId);

/** Plan five-set only — `rejected` is T-22-03 review outcome, not a store state. */
export const ClaimStateSchema = z.enum([
  "proposed",
  "accepted",
  "disputed",
  "stale",
  "superseded",
]);

export type ClaimState = z.infer<typeof ClaimStateSchema>;

export const ClaimTypeSchema = z.enum([
  "definition",
  "purpose",
  "behavior",
  "requirement",
  "constraint",
  "interface_contract",
  "procedure_step",
  "failure_mode",
  "rationale_documented",
  "example",
  "metric",
  "historical_fact",
  "unknown_boundary",
]);

export type ClaimType = z.infer<typeof ClaimTypeSchema>;

export const ClaimEvidenceRefSchema = z
  .object({
    snapshotId: SnapshotIdSchema,
    fileId: SourceFileIdSchema,
    unitId: SourceUnitIdSchema,
    fileSha256: Sha256Schema,
    unitSha256: Sha256Schema,
    verified: z.boolean().optional(),
  })
  .strict();

export type ClaimEvidenceRef = {
  readonly snapshotId: string;
  readonly fileId: string;
  readonly unitId: string;
  readonly fileSha256: Sha256;
  readonly unitSha256: Sha256;
  readonly verified?: boolean;
};

export const ClaimRelationshipsSchema = z
  .object({
    qualifierClaimIds: z.array(ClaimIdSchema).max(256),
    contradictsClaimIds: z.array(ClaimIdSchema).max(256),
    supersedesClaimIds: z.array(ClaimIdSchema).max(256),
  })
  .strict();

export type ClaimRelationships = {
  readonly qualifierClaimIds: readonly ClaimId[];
  readonly contradictsClaimIds: readonly ClaimId[];
  readonly supersedesClaimIds: readonly ClaimId[];
};

export const ClaimSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: ClaimIdSchema,
    version: z.number().int().positive().max(1_000_000),
    statement: z.string().min(1).max(8_000),
    claimType: ClaimTypeSchema,
    scope: z.record(z.string(), z.unknown()),
    authority: z.string().min(1).max(128),
    lifecycle: z.string().min(1).max(128),
    state: ClaimStateSchema,
    evidenceRefs: z.array(ClaimEvidenceRefSchema).min(1).max(256),
    relationships: ClaimRelationshipsSchema,
    createdFrom: z
      .object({
        questionId: QuestionIdSchema,
        packetId: z.string().regex(new RegExp(`^pkt-${ULID_PATTERN}$`)),
      })
      .strict(),
    reviewerRunId: z.string().min(1).max(128).optional(),
    supersederId: ClaimIdSchema.optional(),
    reason: z.string().min(1).max(2_000).optional(),
  })
  .strict();

export type Claim = {
  readonly schemaVersion: 1;
  readonly id: ClaimId;
  readonly version: number;
  readonly statement: string;
  readonly claimType: ClaimType;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly authority: string;
  readonly lifecycle: string;
  readonly state: ClaimState;
  readonly evidenceRefs: readonly ClaimEvidenceRef[];
  readonly relationships: ClaimRelationships;
  readonly createdFrom: {
    readonly questionId: string;
    readonly packetId: string;
  };
  readonly reviewerRunId?: string;
  readonly supersederId?: ClaimId;
  readonly reason?: string;
};
