/**
 * T-32-02 — Claim Reviewer (proposal agent only) — RED stub.
 *
 * HONESTY (binding — filled on GREEN):
 * - PROPOSES ONLY. Never calls ClaimReviewService.apply; never grants
 *   ClaimAcceptanceAuthority; never transitions ClaimState.
 * - Agent-layer SoD (reviewerRunId ≠ extractorRunId after normaliseRunIdentity)
 *   is CALLER-TRUSTED: both ids arrive in the input. A dishonest caller that
 *   lies about either passes the pin. Authoritative SoD is packet→run
 *   provenance on ClaimReviewService.apply (T-22-03).
 * - authorityEligible is an AGENT ASSERTION (LLM boolean), never a permission
 *   grant. Only ClaimAcceptanceAuthority on apply grants acceptance.
 * - Free-text reason → UntrustedProse after validate (B003).
 * - Fresh context is STRUCTURAL: ProposeContext has no extractorMessages /
 *   chat / transcript slot.
 *
 * RED: exports present so tests import; validation not implemented.
 */
import type { IngestResult } from "../../domain/ingest/types.js";

export const CLAIM_REVIEWER_LIMITS = Object.freeze({
  maxReviews: 64,
  maxReasonChars: 2_000,
  maxSplits: 32,
  maxQualifierIds: 32,
  maxEvidenceUnitIds: 32,
});

export type ClaimReviewerError =
  | "INVALID_INPUT"
  | "INVALID_PROPOSAL"
  | "UNEVALUATED_CLAIM"
  | "UNSUPPORTED_EVIDENCE"
  | "SEPARATION_OF_DUTIES"
  | "PROPOSER_FAILED"
  | "SCHEMA_LOAD_FAILED";

export type ClaimReviewerProposal = {
  readonly schemaVersion: 1;
  readonly packetId: string;
  readonly reviewerRunId: string;
  readonly extractorRunId: string;
  readonly reviews: readonly unknown[];
};

export type ClaimReviewerProposeContext = {
  readonly packet: unknown;
  readonly claims: readonly unknown[];
  readonly reviewerRunId: string;
  readonly extractorRunId: string;
};

export type ClaimReviewerPropose = (
  context: ClaimReviewerProposeContext,
) => Promise<unknown>;

export interface ClaimReviewerAgent {
  runClaimReviewer(
    input: ClaimReviewerProposeContext,
  ): Promise<IngestResult<ClaimReviewerProposal, ClaimReviewerError>>;
}

export type CreateClaimReviewerAgentOptions = {
  readonly propose: ClaimReviewerPropose;
};

/** RED stub — not implemented. */
export function validateClaimReviewerProposal(
  _input: unknown,
  _options: {
    readonly packet: unknown;
    readonly claims: readonly unknown[];
    readonly reviewerRunId: string;
    readonly extractorRunId: string;
  },
): IngestResult<ClaimReviewerProposal, ClaimReviewerError> {
  return Object.freeze({
    ok: false as const,
    code: "INVALID_PROPOSAL" as const,
    message: "Claim reviewer proposal validation not implemented (RED).",
  });
}

export function createClaimReviewerAgent(
  _options: CreateClaimReviewerAgentOptions,
): ClaimReviewerAgent {
  return {
    async runClaimReviewer() {
      return Object.freeze({
        ok: false as const,
        code: "PROPOSER_FAILED" as const,
        message: "Claim reviewer agent not implemented (RED).",
      });
    },
  };
}

export async function loadClaimReviewerOutputSchema(
  _scaffoldDirectory: string,
): Promise<Record<string, unknown>> {
  throw new Error("Claim reviewer scaffold not implemented (RED).");
}
