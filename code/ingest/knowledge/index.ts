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
export * from "./evidence-service.js";
// Explicit re-exports: avoid validateIdempotencyOperation name clash with evidence-service.
// Module paths still export validateIdempotencyOperation for custody tests.
// createInMemoryQuestionFacetReader is testing-only — import from module path, not barrel.
export {
  createEvidenceVerdictService,
  createInMemoryEvidenceVerdictStore,
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
export {
  createClaimReviewService,
  isEligibleForAcceptedPack,
  listAcceptedClaimIds,
  normaliseRunIdentity,
  type ClaimReviewService,
  type ClaimReviewServiceError,
  type CreateClaimReviewServiceOptions,
  type PacketCreationIdentityReader,
} from "./claim-review-service.js";
export * from "./obligation-service.js";
export * from "./question-admissibility.js";
export * from "./question-link-service.js";
