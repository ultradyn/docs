import { createHash } from "node:crypto";

import { ulid } from "ulid";

import {
  CorrectionArtifactSchema,
  InvalidationRequestSchema,
  RepresentationRepairApprovalSchema,
  RepresentationRepairRejectionSchema,
  RepresentationRepairSchema,
  SourceRepresentationSchema,
  computeInvalidation,
  type CorrectionArtifact,
  type IngestResult,
  type InvalidationRequest,
  type LocatorSpan,
  type RepresentationRepair,
  type RepresentationRepairApproval,
  type RepresentationRepairRejection,
  type Sha256,
  type SourceFile,
  type SourceRepresentation,
} from "../../domain/ingest/index.js";
import { auditRepresentation } from "./representation-auditor.js";
import { unitizeRepresentation } from "./unitizer.js";

export interface RepresentationRepairApprovalPolicy {
  isAuthorisedHuman(actor: string): boolean;
}

export interface RepresentationRepairInvalidationSink {
  deliver(request: InvalidationRequest): Promise<void>;
}

export interface RepresentationRepairLedger {
  append(record: {
    readonly kind: string;
    readonly [key: string]: unknown;
  }): Promise<void>;
}

export interface RepresentationRepairServiceOptions {
  readonly sourceFile: SourceFile;
  readonly representation: SourceRepresentation;
  readonly approvalPolicy: RepresentationRepairApprovalPolicy;
  readonly invalidationSink: RepresentationRepairInvalidationSink;
  readonly ledger: RepresentationRepairLedger;
}

export interface ProposeRepresentationRepairInput {
  readonly representationId: SourceRepresentation["id"];
  readonly correctedText: string;
  readonly correctedLocators: readonly LocatorSpan[];
  readonly proposedBy: string;
  readonly reason: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

export interface ApproveRepresentationRepairInput {
  readonly repairId: string;
  readonly approvedBy: string;
  readonly reason: string;
  readonly expectedRevision: number;
}

export interface RejectRepresentationRepairInput {
  readonly repairId: string;
  readonly rejectedBy: string;
  readonly reason: string;
}

export interface RepresentationRepairReview {
  readonly faultyRepresentation: SourceRepresentation;
  readonly proposal: RepresentationRepair;
  readonly correctionArtifact: CorrectionArtifact;
  readonly candidateRepresentation: SourceRepresentation;
  readonly approval?: RepresentationRepairApproval;
  readonly rejection?: RepresentationRepairRejection;
}

export interface RepresentationRepairApprovalResult {
  readonly representation: SourceRepresentation;
  readonly invalidation: InvalidationRequest;
}

type RepairFailureCode =
  | "IDEMPOTENCY_CONFLICT"
  | "REVISION_CONFLICT"
  | "INVALID_CORRECTION"
  | "APPROVER_NOT_AUTHORIZED"
  | "AUDIT_REJECTED"
  | "ALREADY_TERMINAL"
  | "NOT_FOUND"
  | "COMMIT_FAILED";

type RepairResult<T> = IngestResult<T, RepairFailureCode>;

export interface RepresentationRepairService {
  propose(
    input: ProposeRepresentationRepairInput,
  ): Promise<RepairResult<RepresentationRepair>>;
  approve(
    input: ApproveRepresentationRepairInput,
  ): Promise<RepairResult<RepresentationRepairApprovalResult>>;
  reject(
    input: RejectRepresentationRepairInput,
  ): Promise<RepairResult<RepresentationRepairRejection>>;
  getReview(
    repairId: string,
  ): Promise<RepairResult<RepresentationRepairReview>>;
  recoverInvalidations(): Promise<RepairResult<readonly string[]>>;
}

interface StoredRepair {
  proposal: RepresentationRepair;
  readonly correctionArtifact: CorrectionArtifact;
  readonly candidateRepresentation: SourceRepresentation;
  approval?: RepresentationRepairApproval;
  rejection?: RepresentationRepairRejection;
}

function digest(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}

function failure<T>(code: RepairFailureCode, message: string): RepairResult<T> {
  return { ok: false, code, message };
}

function payloadKey(input: ProposeRepresentationRepairInput): string {
  return JSON.stringify([
    input.representationId,
    input.correctedText,
    input.correctedLocators,
    input.proposedBy,
    input.reason,
    input.expectedRevision,
  ]);
}

function immutable<T extends object>(value: T): T {
  return Object.freeze(value);
}

export function createRepresentationRepairService(
  options: RepresentationRepairServiceOptions,
): RepresentationRepairService {
  const repairs = new Map<string, StoredRepair>();
  const idempotency = new Map<
    string,
    { readonly payload: string; readonly repairId: string }
  >();
  const pendingInvalidations = new Map<string, InvalidationRequest>();

  return {
    async propose(input) {
      const existing = idempotency.get(input.idempotencyKey);
      const payload = payloadKey(input);
      if (existing !== undefined) {
        if (existing.payload !== payload) {
          return failure(
            "IDEMPOTENCY_CONFLICT",
            "The idempotency key was already used for another correction.",
          );
        }
        return { ok: true, value: repairs.get(existing.repairId)!.proposal };
      }
      if (
        input.representationId !== options.representation.id ||
        input.expectedRevision !== options.representation.version
      ) {
        return failure(
          "REVISION_CONFLICT",
          "The representation revision is stale.",
        );
      }
      if (input.reason.trim() === "" || input.idempotencyKey.trim() === "") {
        return failure(
          "INVALID_CORRECTION",
          "A correction rationale and idempotency key are required.",
        );
      }

      const candidateRepresentation = SourceRepresentationSchema.safeParse({
        ...options.representation,
        id: `repr-${ulid()}`,
        supersedesId: options.representation.id,
        version: options.representation.version + 1,
        normalizedText: input.correctedText,
        locatorMap: input.correctedLocators,
      });
      if (!candidateRepresentation.success) {
        return failure(
          "INVALID_CORRECTION",
          "The proposed correction is not a valid representation.",
        );
      }
      const correctionArtifact = CorrectionArtifactSchema.parse({
        schemaVersion: 1,
        id: `cor-${ulid()}`,
        sourceFileId: options.sourceFile.id,
        supersedesRepresentationId: options.representation.id,
        sha256: digest(input.correctedText),
        size: Buffer.byteLength(input.correctedText),
      }) as CorrectionArtifact;
      const proposal = RepresentationRepairSchema.safeParse({
        schemaVersion: 1,
        id: `rpr-${ulid()}`,
        sourceFileId: options.sourceFile.id,
        representationId: input.representationId,
        correctionArtifactId: correctionArtifact.id,
        candidateRepresentationId: candidateRepresentation.data.id,
        proposedBy: input.proposedBy,
        reason: input.reason,
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
        state: "proposed",
      });
      if (!proposal.success) {
        return failure(
          "INVALID_CORRECTION",
          "The proposed correction metadata is invalid.",
        );
      }

      try {
        await options.ledger.append({
          kind: "proposal",
          proposal: proposal.data,
          correctionArtifact,
          candidateRepresentation: candidateRepresentation.data,
        });
      } catch {
        return failure(
          "COMMIT_FAILED",
          "The correction proposal could not be committed.",
        );
      }
      const stored: StoredRepair = {
        proposal: immutable(proposal.data as RepresentationRepair),
        correctionArtifact: immutable(correctionArtifact),
        candidateRepresentation: immutable(
          candidateRepresentation.data as SourceRepresentation,
        ),
      };
      repairs.set(stored.proposal.id, stored);
      idempotency.set(input.idempotencyKey, {
        payload,
        repairId: stored.proposal.id,
      });
      return { ok: true, value: stored.proposal };
    },

    async approve(input) {
      const stored = repairs.get(input.repairId);
      if (stored === undefined)
        return failure("NOT_FOUND", "The repair does not exist.");
      if (stored.proposal.state !== "proposed") {
        return failure("ALREADY_TERMINAL", "The repair is already terminal.");
      }
      if (
        input.approvedBy.startsWith("agent:") ||
        !options.approvalPolicy.isAuthorisedHuman(input.approvedBy)
      ) {
        return failure(
          "APPROVER_NOT_AUTHORIZED",
          "Only an authorised human may approve a repair.",
        );
      }
      if (input.reason.trim() === "") {
        return failure(
          "INVALID_CORRECTION",
          "An approval rationale is required.",
        );
      }
      if (input.expectedRevision !== stored.proposal.expectedRevision) {
        return failure("REVISION_CONFLICT", "The repair revision is stale.");
      }

      const freshAudit = auditRepresentation(stored.candidateRepresentation);
      if (!freshAudit.ok || !freshAudit.value.claimEligible) {
        return failure(
          "AUDIT_REJECTED",
          "The corrected representation failed its fresh audit.",
        );
      }
      const oldAudit = auditRepresentation(options.representation);
      if (!oldAudit.ok) {
        return failure(
          "AUDIT_REJECTED",
          "The superseded representation could not be audited.",
        );
      }
      const before = unitizeRepresentation({
        sourceFile: options.sourceFile,
        representation: options.representation,
        audit: oldAudit.value,
      });
      const correctedSourceFile: SourceFile = {
        ...options.sourceFile,
        size: Buffer.byteLength(stored.candidateRepresentation.normalizedText),
        sha256: digest(stored.candidateRepresentation.normalizedText),
      };
      const after = unitizeRepresentation({
        sourceFile: correctedSourceFile,
        representation: stored.candidateRepresentation,
        audit: freshAudit.value,
      });
      if (!before.ok || !after.ok) {
        return failure(
          "AUDIT_REJECTED",
          "The corrected representation could not be unitized.",
        );
      }

      const approval = RepresentationRepairApprovalSchema.parse({
        schemaVersion: 1,
        repairId: stored.proposal.id,
        approvedBy: input.approvedBy,
        reason: input.reason,
        approvedRevision: input.expectedRevision,
      }) as RepresentationRepairApproval;
      const invalidation = InvalidationRequestSchema.parse({
        schemaVersion: 1,
        id: `inv-${ulid()}`,
        repairId: stored.proposal.id,
        sourceFileId: options.sourceFile.id,
        unitIds: computeInvalidation(before.value, after.value),
      }) as InvalidationRequest;

      try {
        await options.ledger.append({
          kind: "approval",
          audit: freshAudit.value,
          approval,
          representation: stored.candidateRepresentation,
          invalidation,
        });
      } catch {
        return failure(
          "COMMIT_FAILED",
          "The repair approval could not be committed.",
        );
      }

      stored.approval = immutable(approval);
      stored.proposal = immutable({ ...stored.proposal, state: "approved" });
      pendingInvalidations.set(invalidation.id, immutable(invalidation));
      try {
        await options.invalidationSink.deliver(invalidation);
        pendingInvalidations.delete(invalidation.id);
      } catch {
        // The committed outbox entry remains pending for explicit recovery.
      }
      return {
        ok: true,
        value: immutable({
          representation: stored.candidateRepresentation,
          invalidation,
        }),
      };
    },

    async reject(input) {
      const stored = repairs.get(input.repairId);
      if (stored === undefined)
        return failure("NOT_FOUND", "The repair does not exist.");
      if (stored.proposal.state !== "proposed") {
        return failure("ALREADY_TERMINAL", "The repair is already terminal.");
      }
      const rejection = RepresentationRepairRejectionSchema.safeParse({
        schemaVersion: 1,
        repairId: stored.proposal.id,
        rejectedBy: input.rejectedBy,
        reason: input.reason,
      });
      if (!rejection.success) {
        return failure(
          "INVALID_CORRECTION",
          "A valid rejection rationale is required.",
        );
      }
      try {
        await options.ledger.append({
          kind: "rejection",
          rejection: rejection.data,
        });
      } catch {
        return failure(
          "COMMIT_FAILED",
          "The repair rejection could not be committed.",
        );
      }
      stored.rejection = immutable(
        rejection.data as RepresentationRepairRejection,
      );
      stored.proposal = immutable({ ...stored.proposal, state: "rejected" });
      return { ok: true, value: stored.rejection };
    },

    async getReview(repairId) {
      const stored = repairs.get(repairId);
      if (stored === undefined)
        return failure("NOT_FOUND", "The repair does not exist.");
      return {
        ok: true,
        value: immutable({
          faultyRepresentation: options.representation,
          proposal: stored.proposal,
          correctionArtifact: stored.correctionArtifact,
          candidateRepresentation: stored.candidateRepresentation,
          ...(stored.approval === undefined
            ? {}
            : { approval: stored.approval }),
          ...(stored.rejection === undefined
            ? {}
            : { rejection: stored.rejection }),
        }),
      };
    },

    async recoverInvalidations() {
      const delivered: string[] = [];
      for (const [id, request] of pendingInvalidations) {
        try {
          await options.invalidationSink.deliver(request);
          pendingInvalidations.delete(id);
          delivered.push(id);
        } catch {
          // Keep the durable request pending for another recovery attempt.
        }
      }
      return { ok: true, value: Object.freeze(delivered) };
    },
  };
}
