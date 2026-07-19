import { z } from "zod";

import {
  SourceRepresentationIdSchema,
  ULID_PATTERN,
} from "../domain/ingest/id-schemas.js";

const prefixedId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}-${ULID_PATTERN}$`));
const NonblankSchema = z.string().trim().min(1);
const ActorSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9:._-]*$/u);
const RevisionSchema = z.number().safe().int().positive();

export const RepairProposalRequestSchema = z
  .object({
    representationId: SourceRepresentationIdSchema,
    correctedArtifactId: prefixedId("cor"),
    proposedBy: ActorSchema,
    reason: NonblankSchema,
    expectedRevision: RevisionSchema,
    idempotencyKey: NonblankSchema,
  })
  .strict();

export const RepairApprovalRequestSchema = z
  .object({
    repairId: prefixedId("rpr"),
    approvedBy: ActorSchema,
    reason: NonblankSchema,
    expectedRevision: RevisionSchema,
  })
  .strict();

export const RepairRejectionRequestSchema = z
  .object({
    repairId: prefixedId("rpr"),
    rejectedBy: ActorSchema,
    reason: NonblankSchema,
  })
  .strict();

export const RepairReviewResponseSchema = z
  .object({
    repairId: prefixedId("rpr"),
    state: z.enum(["proposed", "approved", "rejected"]),
    representationId: SourceRepresentationIdSchema,
    correctionArtifactId: prefixedId("cor"),
    proposedBy: ActorSchema,
    reason: NonblankSchema,
    revision: RevisionSchema,
    invalidatedUnitCount: z.number().safe().int().nonnegative(),
  })
  .strict();

export const REPAIR_HTTP_STATUS_BY_FAILURE = Object.freeze({
  REPAIR_NOT_FOUND: 404,
  REPRESENTATION_NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  ALREADY_TERMINAL: 409,
  INVALID_CORRECTION: 422,
  AUDIT_REJECTED: 422,
  UNITIZATION_REJECTED: 422,
  APPROVER_NOT_AUTHORIZED: 403,
  CUSTODY_FAILURE: 500,
} as const);

export type RepairFailureCode = keyof typeof REPAIR_HTTP_STATUS_BY_FAILURE;

export function repairFailureResponse(code: RepairFailureCode, detail: string) {
  void detail;
  return {
    status: REPAIR_HTTP_STATUS_BY_FAILURE[code],
    body: {
      code,
      message: "Representation repair request failed.",
    },
  } as const;
}
