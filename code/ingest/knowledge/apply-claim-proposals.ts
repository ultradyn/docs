/**
 * T004 — Apply validated Claim Extractor proposals via ClaimRepository.create.
 *
 * RED STUB — implementation after GREEN GO.
 *
 * HONESTY (binding):
 * - ID minting: REUSE deriveClaimId(questionId, packetId, statement) only —
 *   pure over content; no wall-clock, no random. Statement-only identity is
 *   ClaimRepository behaviour; apply inherits deliberately (widening the hash
 *   is a repository change, not this task).
 * - Intra-batch id collision (same statement text → same id): whole-batch
 *   refuse BEFORE any write (ID_COLLISION) — never silently collapse two
 *   proposals into one durable claim.
 * - Evidence: unitIds only, mapped from authoritative packet references.
 *   Never accept agent full evidenceRef shapes.
 * - candidateRelationships: free strings at proposal time; apply re-resolves
 *   against list() ∪ batch-derived ids, DROPS unknown targets, and REPORTS
 *   them on the success result (not silent).
 * - State stays proposed; only ClaimRepository.create; no accept/transition.
 * - Whole-batch fail-closed on unsupported evidence; assert store absence.
 */
import type { Claim, ClaimId } from "../../domain/ingest/claim.js";
import type { IngestResult } from "../../domain/ingest/types.js";
import type { ClaimRepository } from "./claim-repository.js";

export type ApplyClaimProposalsError =
  | "INVALID_INPUT"
  | "VERDICT_NOT_ACCEPTED"
  | "INVALID_PROPOSAL"
  | "UNSUPPORTED_EVIDENCE"
  | "ID_COLLISION"
  | "IDEMPOTENCY_CONFLICT"
  | "COMMIT_FAILED";

export type ApplyClaimProposalsSuccess = {
  readonly claimIds: readonly ClaimId[];
  readonly claims: readonly Claim[];
  /** Relationship target ids that were candidates but not authoritative. */
  readonly droppedRelationshipTargets: readonly string[];
};

export type ApplyClaimProposalsInput = {
  readonly questionId: string;
  readonly packet: unknown;
  readonly verdictAccepted: boolean;
  readonly proposals: unknown;
  readonly repository: ClaimRepository;
};

export async function applyClaimProposals(
  _input: ApplyClaimProposalsInput,
): Promise<
  IngestResult<ApplyClaimProposalsSuccess, ApplyClaimProposalsError>
> {
  // RED: not implemented — tests must fail until GREEN.
  return Object.freeze({
    ok: false as const,
    code: "COMMIT_FAILED" as const,
    message: "applyClaimProposals not implemented (RED stub).",
  });
}
