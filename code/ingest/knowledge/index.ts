// Composer is the sole public routing seam. Pure evaluateEvidenceLoop remains
// available via direct `./evidence-loop-policy.js` import for unit/internal tests.
export {
  DEFAULT_EVIDENCE_LOOP_BUDGET,
  canonicalNoveltyKey,
  composeAndEvaluateEvidenceLoop,
  type EvidenceLoopRoute,
  type EvidenceLoopServiceError,
  type EvidenceLoopBudget,
  type EvidenceLoopStep,
  type EvidenceLoopHistory,
  type EvidenceLoopHistoryReceipt,
  type EvidenceLoopDecision,
  type EvidenceHistoryPacketStore,
  type EvidenceHistoryVerdictStore,
} from "./evidence-loop-policy.js";
// Explicit re-exports (was `export *`), so a testing-only store cannot reach the
// public barrel by accident. createInMemoryEvidencePacketStore is testing-only —
// import from the module path (same discipline as createInMemoryClaimStore).
export {
  createEvidenceService,
  createFileEvidencePacketStore,
  deriveEvidencePacketId,
  receiptDigestOf,
  validateIdempotencyOperation,
  type EvidenceServiceError,
  type SourceHashContext,
  type QuestionLinkReader,
  type ReceiptReader,
  type EvidencePacketStore,
  type EvidenceService,
} from "./evidence-service.js";
// Explicit re-exports: avoid validateIdempotencyOperation name clash with evidence-service.
// Module paths still export validateIdempotencyOperation for custody tests.
// createInMemoryQuestionFacetReader is testing-only — import from module path, not barrel.
// createInMemoryEvidenceVerdictStore is testing-only — import from the module
// path, not this barrel (same discipline as createInMemoryClaimStore).
export {
  createEvidenceVerdictService,
  createFileEvidenceVerdictStore,
  deriveEvidenceVerdictId,
  type EvidenceVerdictServiceError,
  type EvidenceVerdictTransition,
  type EvidenceVerdictApplyResult,
  type EvidencePacketReader,
  type ReceiptFailureReader,
  type PacketVerifier,
  type EvidenceVerdictStore,
  type EvidenceVerdictService,
  type QuestionFacetReader,
} from "./evidence-verdict-service.js";
// Claim repository: production surface only — in-memory store is module/testing-only.
export {
  createClaimRepository,
  createFileClaimStore,
  deriveClaimId,
  type ClaimServiceError,
  type EvidenceVerificationReader,
  type ClaimAcceptanceAuthority,
  type ClaimStore,
  type ClaimRepository,
} from "./claim-repository.js";
// T004 — apply validated Claim Extractor proposals (create only; proposed).
export {
  applyClaimProposals,
  type ApplyClaimProposalsError,
  type ApplyClaimProposalsInput,
  type ApplyClaimProposalsSuccess,
} from "./apply-claim-proposals.js";
// Claim candidates: pure-read relationship candidates (no merge decision).
export {
  CLAIM_CANDIDATE_LIMITS,
  CLAIM_CANDIDATE_RECALL_FLOOR,
  MATCHER_VERSION,
  createClaimCandidateFinder,
  type ClaimCandidate,
  type ClaimCandidateCorpusReader,
  type ClaimCandidateError,
  type ClaimCandidateFindResult,
  type ClaimCandidateFinder,
  type ClaimCandidateReceipt,
  type ClaimCandidateRelation,
  type ClaimCandidateSignals,
  type ScopeSignal,
  type TypeSignal,
} from "./claim-candidates.js";
// Claim review application (T-22-03 authority boundary).
// createInMemoryClaimReviewApplicationStore is testing-only — import from the
// module path, not this barrel (same discipline as createInMemoryClaimStore).
export {
  createClaimReviewService,
  isEligibleForAcceptedPack,
  listAcceptedClaimIds,
  normaliseRunIdentity,
  type ClaimReviewApplicationStore,
  type ClaimReviewService,
  type ClaimReviewServiceError,
  type ClaimReviewServiceHooks,
  type CreateClaimReviewServiceOptions,
  type PacketCreationIdentityReader,
} from "./claim-review-service.js";
// T-60-01 — sealed claim pack (on-demand build; pack-safe membership).
export {
  createClaimPackService,
  type ClaimPackError,
  type ClaimPackService,
  type CreateClaimPackServiceOptions,
} from "./claim-pack-service.js";
export * from "./obligation-service.js";
export * from "./question-admissibility.js";
// Explicit re-exports (was `export *`) so a testing helper added to this module
// in future cannot reach the barrel automatically. createInMemoryQuestionLinkStore
// IS deliberately public here — pinned by question-link-service.test.ts "public
// seams" — and is retained unchanged; this closes the recurrence vector without
// reversing that decision.
export {
  createInMemoryQuestionLinkStore,
  createQuestionLinkService,
  type QuestionLinkError,
  type QuestionReader,
  type QuestionLinkService,
} from "./question-link-service.js";
