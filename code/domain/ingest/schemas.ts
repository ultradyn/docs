import { z } from "zod";
export { CoverageObligationRecordSchema as CoverageObligationSchema } from "./coverage-obligation.js";
export { PolicyProfileSchema } from "./policy-profile.js";
export { IngestionQuestionLinkSchema } from "./question-link.js";

const IdSchema = z.string().min(1);
const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "must be 64 lowercase hex characters");
const SnapshotIdSchema = z
  .string()
  .regex(
    /^snap-[a-f0-9]{64}$/,
    "must be snap- followed by 64 lowercase hex characters",
  );
const SourceFileIdSchema = z
  .string()
  .regex(
    /^file-[a-f0-9]{64}$/,
    "must be file- followed by 64 lowercase hex characters",
  );

export const SourceFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SourceFileIdSchema,
    snapshotId: SnapshotIdSchema,
    logicalPath: z.string().min(1),
    mediaType: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: Sha256Schema,
  })
  .strict();

export const SourceExclusionSchema = z
  .object({
    logicalPath: z.string().min(1),
    mediaType: z.string().min(1),
    size: z.number().int().nonnegative(),
    reason: z.string().min(1),
  })
  .strict();

export const SourceSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SnapshotIdSchema,
    packageSha256: Sha256Schema,
    contentSha256: Sha256Schema,
    policyId: IdSchema,
    files: z.array(SourceFileSchema),
    exclusions: z.array(SourceExclusionSchema),
    qualified: z.literal(true),
  })
  .strict();

export const SourceUnitSchema = z
  .object({ schemaVersion: z.literal(1), id: IdSchema })
  .strict();
export const SearchReceiptSchema = z
  .object({ schemaVersion: z.literal(1), id: IdSchema })
  .strict();
export const EvidencePacketSchema = z
  .object({ schemaVersion: z.literal(1), id: IdSchema })
  .strict();
export const EvidenceVerdictSchema = z
  .object({ schemaVersion: z.literal(1), id: IdSchema })
  .strict();
export const ClaimSchema = z
  .object({ schemaVersion: z.literal(1), id: IdSchema })
  .strict();
export const ClaimReviewSchema = z
  .object({ schemaVersion: z.literal(1), id: IdSchema })
  .strict();
export const GraphEventSchema = z
  .object({ schemaVersion: z.literal(1), id: IdSchema })
  .strict();
export const SealedClaimPackSchema = z
  .object({ schemaVersion: z.literal(1), id: IdSchema })
  .strict();
export const AnswerCompositionSchema = z
  .object({ schemaVersion: z.literal(1), id: IdSchema })
  .strict();
