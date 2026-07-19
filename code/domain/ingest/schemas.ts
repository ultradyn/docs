import { z } from "zod";
export { CoverageObligationRecordSchema as CoverageObligationSchema } from "./coverage-obligation.js";
export { PolicyProfileSchema } from "./policy-profile.js";
export { IngestionQuestionLinkSchema } from "./question-link.js";
import {
  SnapshotIdSchema,
  SourceFileIdSchema,
  SourceRepresentationIdSchema,
} from "./id-schemas.js";

const IdSchema = z.string().min(1);
const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "must be 64 lowercase hex characters");
export const SourceFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SourceFileIdSchema,
    snapshotId: SnapshotIdSchema,
    logicalPath: z.string().min(1),
    mediaType: z.string().min(1),
    size: z.number().safe().int().nonnegative(),
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

const OriginalLocationSchema = z
  .object({
    byteStart: z.number().int().nonnegative(),
    byteEnd: z.number().int().nonnegative(),
    lineStart: z.number().int().positive(),
    columnStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    columnEnd: z.number().int().positive(),
  })
  .strict();

const LocatorSpanSchema = z
  .object({
    kind: z.enum(["line", "cell", "span"]),
    normalized: z
      .object({
        utf16Start: z.number().int().nonnegative(),
        utf16End: z.number().int().nonnegative(),
        lineStart: z.number().int().positive(),
        columnStart: z.number().int().positive(),
        lineEnd: z.number().int().positive(),
        columnEnd: z.number().int().positive(),
      })
      .strict(),
    original: OriginalLocationSchema,
    cell: z
      .object({
        row: z.number().int().positive(),
        column: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const SourceRepresentationSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SourceRepresentationIdSchema,
    sourceFileId: SourceFileIdSchema,
    version: z.number().safe().int().positive(),
    kind: z.enum(["markdown", "text", "code", "json", "yaml", "csv"]),
    normalizedText: z.string(),
    locatorMap: z.array(LocatorSpanSchema),
    warnings: z.array(
      z
        .object({
          code: z.string().min(1),
          message: z.string().min(1),
          location: OriginalLocationSchema,
        })
        .strict(),
    ),
  })
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
