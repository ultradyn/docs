import { z } from "zod";

import {
  SourceFileIdSchema,
  SourceRepresentationIdSchema,
  SourceUnitIdSchema,
  ULID_PATTERN,
} from "./id-schemas.js";
import type { SourceUnit } from "./source-unit.js";
import type { SourceUnitId } from "./types.js";

const prefixedId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}-${ULID_PATTERN}$`));
const NonblankSchema = z.string().trim().min(1);
const ActorSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9:._-]*$/u);
const RevisionSchema = z.number().safe().int().positive();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const REPAIR_TERMINAL_STATES = Object.freeze([
  "approved",
  "rejected",
] as const);

export const CorrectionArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: prefixedId("cor"),
    sourceFileId: SourceFileIdSchema,
    supersedesRepresentationId: SourceRepresentationIdSchema,
    sha256: Sha256Schema,
    size: z.number().safe().int().nonnegative(),
  })
  .strict();

export const RepresentationRepairSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: prefixedId("rpr"),
    sourceFileId: SourceFileIdSchema,
    representationId: SourceRepresentationIdSchema,
    correctionArtifactId: prefixedId("cor"),
    candidateRepresentationId: SourceRepresentationIdSchema,
    proposedBy: ActorSchema,
    reason: NonblankSchema,
    expectedRevision: RevisionSchema,
    idempotencyKey: NonblankSchema,
    state: z.enum(["proposed", "approved", "rejected"]),
  })
  .strict();

export const RepresentationRepairApprovalSchema = z
  .object({
    schemaVersion: z.literal(1),
    repairId: prefixedId("rpr"),
    approvedBy: ActorSchema,
    reason: NonblankSchema,
    approvedRevision: RevisionSchema,
  })
  .strict();

export const RepresentationRepairRejectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    repairId: prefixedId("rpr"),
    rejectedBy: ActorSchema,
    reason: NonblankSchema,
  })
  .strict();

export const InvalidationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: prefixedId("inv"),
    repairId: prefixedId("rpr"),
    sourceFileId: SourceFileIdSchema,
    unitIds: z.array(SourceUnitIdSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const canonical = [...new Set(value.unitIds)].sort();
    if (
      canonical.length !== value.unitIds.length ||
      canonical.some((id, index) => id !== value.unitIds[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["unitIds"],
        message: "must be sorted and unique",
      });
    }
  });

export type RepresentationRepair = z.infer<typeof RepresentationRepairSchema>;
export type RepresentationRepairApproval = z.infer<
  typeof RepresentationRepairApprovalSchema
>;
export type RepresentationRepairRejection = z.infer<
  typeof RepresentationRepairRejectionSchema
>;
export type CorrectionArtifact = z.infer<typeof CorrectionArtifactSchema>;
export type InvalidationRequest = z.infer<typeof InvalidationRequestSchema>;

export function canonicalUnitRecord(unit: SourceUnit): string {
  const fields = [
    unit.schemaVersion,
    unit.id,
    unit.snapshotId,
    unit.sourceFileId,
    unit.representationId,
    unit.kind,
    unit.parentId ?? null,
    unit.headingPath,
    [
      unit.normalizedLocator.utf16Start,
      unit.normalizedLocator.utf16End,
      unit.normalizedLocator.lineStart,
      unit.normalizedLocator.columnStart,
      unit.normalizedLocator.lineEnd,
      unit.normalizedLocator.columnEnd,
    ],
    [
      unit.originalLocator.byteStart,
      unit.originalLocator.byteEnd,
      unit.originalLocator.lineStart,
      unit.originalLocator.columnStart,
      unit.originalLocator.lineEnd,
      unit.originalLocator.columnEnd,
    ],
    unit.textSha256,
  ] as const;
  return JSON.stringify(fields);
}

export function computeInvalidation(
  before: readonly SourceUnit[],
  after: readonly SourceUnit[],
): readonly SourceUnitId[] {
  const afterById = new Map(after.map((unit) => [unit.id, unit]));
  const invalid = new Set<SourceUnitId>();
  for (const unit of before) {
    const replacement = afterById.get(unit.id);
    if (
      replacement === undefined ||
      canonicalUnitRecord(unit) !== canonicalUnitRecord(replacement)
    ) {
      invalid.add(unit.id);
    }
  }
  return Object.freeze([...invalid].sort());
}
