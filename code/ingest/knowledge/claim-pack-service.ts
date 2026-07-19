/**
 * T-60-01 — Sealed claim-pack builder (on-demand, no durable pack store).
 *
 * RED STUB — implementation after Claude releases RED checkpoint.
 *
 * HONESTY (binding):
 * - Membership ONLY via ClaimReviewApplicationStore.listAcceptedClaimIds()
 *   over the complete durable application set. Never ClaimStore.list for
 *   membership; never a caller-supplied applications array.
 * - DUAL GATE: id ∈ listAcceptedClaimIds AND current claim.state === "accepted"
 *   (closes B001 markStale race).
 * - Question-scoped: createdFrom.questionId must match pack questionId.
 * - Evidence refs COPIED from durable claims (inherited). Seal proves snapshot
 *   fidelity of selected claim versions — NOT that refs were packet-mapped.
 * - Application refs NOT in v1 seal (P2.M3.E4.T004 follow-up).
 * - Required unaccepted qualifier → MISSING_QUALIFIER (not pull-in).
 * - Reject-then-qualify cannot launder into pack (qualify never writes
 *   acceptedClaimIds; store accepted−rejected excludes).
 * - Pure build: no Date.now / random / pid in hash material.
 */
import type { SealedClaimPack } from "../../domain/ingest/sealed-claim-pack.js";
import type { GraphRevision, IngestResult } from "../../domain/ingest/types.js";
import type { ClaimRepository } from "./claim-repository.js";
import type { ClaimReviewApplicationStore } from "./claim-review-service.js";

export type ClaimPackError =
  | "INVALID_INPUT"
  | "UNACCEPTED_CLAIM"
  | "STALE_CLAIM"
  | "MISSING_QUALIFIER"
  | "REVISION_MISMATCH"
  | "COMMIT_FAILED";

export type ClaimPackService = {
  build(
    questionId: string,
    expectedRevision: GraphRevision,
  ): Promise<IngestResult<SealedClaimPack, ClaimPackError>>;
};

export type CreateClaimPackServiceOptions = {
  readonly applicationStore: ClaimReviewApplicationStore;
  readonly claims: ClaimRepository;
  readonly graph?: {
    currentRevision(): Promise<GraphRevision>;
  };
};

export function createClaimPackService(
  options: CreateClaimPackServiceOptions,
): ClaimPackService {
  if (!options?.applicationStore) {
    throw new Error("createClaimPackService requires applicationStore.");
  }
  if (!options?.claims) {
    throw new Error("createClaimPackService requires claims repository.");
  }
  return {
    async build() {
      return Object.freeze({
        ok: false as const,
        code: "COMMIT_FAILED" as const,
        message: "claim pack builder not implemented (RED stub).",
      });
    },
  };
}
