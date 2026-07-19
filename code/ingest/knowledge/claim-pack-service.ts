/**
 * T-60-01 / T004 — Sealed claim-pack builder (on-demand, no durable pack store).
 *
 * HONESTY (binding):
 * - Membership ONLY via ClaimReviewApplicationStore.listAcceptedClaimIds()
 *   over the complete durable application set. Never ClaimStore.list /
 *   repository.list for membership; never a caller-supplied applications array.
 * - DUAL GATE: id ∈ listAcceptedClaimIds AND current claim.state === "accepted"
 *   (closes B001 markStale race). A claim can sit in acceptedClaimIds while its
 *   current record is stale — both gates required.
 * - Question-scoped: createdFrom.questionId must match pack questionId.
 * - Evidence refs COPIED from durable claims (inherited). Seal proves snapshot
 *   fidelity of selected claim versions — NOT that refs were packet-mapped at
 *   write time.
 * - T004: applicationRefs are populated INDEPENDENTLY from
 *   ClaimReviewApplicationStore.listApplications() (accept AND reject
 *   decisions for the question). They are NOT synthesized from claimIds —
 *   that would make the selection audit circular/hollow.
 * - Application refs prove selection matches RECORDED decisions; they do NOT
 *   prove those decisions were correct.
 * - Required unaccepted qualifier → MISSING_QUALIFIER (not pull-in).
 * - Reject-then-qualify cannot launder into pack (qualify never writes
 *   acceptedClaimIds; store accepted−rejected excludes).
 * - Pure build: no Date.now / random / pid in hash material.
 * - Empty accepted set → empty pack ok:true (valid).
 */
import type { Claim } from "../../domain/ingest/claim.js";
import type {
  PackApplicationRef,
  PackCitation,
  QualifierEdge,
  SealedClaimPack,
} from "../../domain/ingest/sealed-claim-pack.js";
import type {
  ClaimId,
  GraphRevision,
  IngestResult,
  Sha256,
} from "../../domain/ingest/types.js";
import type { ClaimRepository } from "./claim-repository.js";
import type { ClaimReviewApplicationStore } from "./claim-review-service.js";
import { recomputeSealedPackHash } from "./pack-application-audit.js";

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

const FIXED: Record<ClaimPackError, string> = {
  INVALID_INPUT: "Claim pack build input is invalid.",
  UNACCEPTED_CLAIM: "A selected claim is not accepted for packing.",
  STALE_CLAIM:
    "A claim is in the accepted application set but current state is not accepted.",
  MISSING_QUALIFIER:
    "An accepted claim requires a qualifier that is not pack-accepted.",
  REVISION_MISMATCH: "Graph revision does not match the expected revision.",
  COMMIT_FAILED: "Claim pack build failed.",
};

function fail(
  code: ClaimPackError,
): IngestResult<never, ClaimPackError> {
  return Object.freeze({ ok: false as const, code, message: FIXED[code] });
}

function ok(value: SealedClaimPack): IngestResult<SealedClaimPack, ClaimPackError> {
  return Object.freeze({ ok: true as const, value });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) for (const item of value) deepFreeze(item);
    else for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Hash material is owned by recomputeSealedPackHash (pack-application-audit)
// so builder and auditor cannot diverge.

export function createClaimPackService(
  options: CreateClaimPackServiceOptions,
): ClaimPackService {
  if (!options?.applicationStore) {
    throw new Error("createClaimPackService requires applicationStore.");
  }
  if (!options?.claims) {
    throw new Error("createClaimPackService requires claims repository.");
  }
  const { applicationStore, claims: claimRepo, graph } = options;

  return {
    async build(questionId, expectedRevision) {
      if (
        typeof questionId !== "string" ||
        questionId.length < 1 ||
        typeof expectedRevision !== "number" ||
        !Number.isInteger(expectedRevision) ||
        expectedRevision < 0
      ) {
        return fail("INVALID_INPUT");
      }

      if (graph) {
        const current = await graph.currentRevision();
        if (current !== expectedRevision) {
          return fail("REVISION_MISMATCH");
        }
      }

      // Authority: complete durable application set only.
      const acceptedIds = await applicationStore.listAcceptedClaimIds();

      const selected: Claim[] = [];
      for (const id of acceptedIds) {
        const got = await claimRepo.get(id);
        if (!got.ok) {
          // Application references a claim that cannot be loaded.
          return fail("UNACCEPTED_CLAIM");
        }
        const claim = got.value;
        // Question scope
        if (claim.createdFrom.questionId !== questionId) {
          continue;
        }
        // Dual gate half 2: current state must be accepted (B001).
        if (claim.state !== "accepted") {
          return fail("STALE_CLAIM");
        }
        selected.push(claim);
      }

      selected.sort((a, b) => cmpId(a.id, b.id));
      const packIdSet = new Set(selected.map((c) => c.id as string));

      // Qualifier closure: every qualifier target of a pack member must be pack-accepted.
      const qualifierEdges: QualifierEdge[] = [];
      for (const claim of selected) {
        for (const qid of claim.relationships.qualifierClaimIds) {
          if (!packIdSet.has(qid as string)) {
            return fail("MISSING_QUALIFIER");
          }
          qualifierEdges.push({ from: claim.id, to: qid as ClaimId });
        }
      }
      qualifierEdges.sort((a, b) => {
        const f = cmpId(a.from, b.from);
        return f !== 0 ? f : cmpId(a.to, b.to);
      });

      const citations: PackCitation[] = [];
      for (const claim of selected) {
        for (const ref of claim.evidenceRefs) {
          citations.push({
            claimId: claim.id,
            unitId: ref.unitId,
            unitSha256: ref.unitSha256,
            fileSha256: ref.fileSha256,
            snapshotId: ref.snapshotId,
          });
        }
      }
      citations.sort((a, b) => {
        const c = cmpId(a.claimId, b.claimId);
        return c !== 0 ? c : cmpId(a.unitId, b.unitId);
      });

      const gaps: string[] = [];

      // T004 Condition B: applicationRefs from store applications INDEPENDENTLY
      // of claimIds (accept + reject for this question). Never synthesize from
      // selected claim ids — that would make the audit circular.
      const allApps = await applicationStore.listApplications();
      const appRefById = new Map<string, PackApplicationRef>();
      for (const app of allApps) {
        const got = await claimRepo.get(app.claimId);
        if (!got.ok) continue;
        if (got.value.createdFrom.questionId !== questionId) continue;
        if (app.decision !== "accept" && app.decision !== "reject") continue;
        appRefById.set(app.applicationId, {
          applicationId: app.applicationId,
          reviewId: app.reviewId,
          claimId: app.claimId,
          decision: app.decision,
        });
      }
      const applicationRefs = [...appRefById.values()].sort((a, b) =>
        cmpId(a.applicationId, b.applicationId),
      );

      const packDraft: SealedClaimPack = {
        schemaVersion: 2 as const,
        hash: "0".repeat(64) as Sha256, // placeholder; overwritten from body
        questionId,
        graphRevision: expectedRevision as GraphRevision,
        claimIds: Object.freeze(selected.map((c) => c.id)),
        claims: Object.freeze([...selected]),
        qualifierEdges: Object.freeze(qualifierEdges),
        citations: Object.freeze(citations),
        gaps: Object.freeze(gaps),
        applicationRefs: Object.freeze(applicationRefs),
      };
      const hash = recomputeSealedPackHash(packDraft);
      const pack: SealedClaimPack = deepFreeze({
        ...packDraft,
        hash,
      });
      return ok(pack);
    },
  };
}
