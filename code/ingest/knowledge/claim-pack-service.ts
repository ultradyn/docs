/**
 * T-60-01 — Sealed claim-pack builder (on-demand, no durable pack store).
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
 *   write time (T004). A sealed pack is the most authoritative-looking artifact
 *   in the system; it must not imply more than snapshot fidelity.
 * - Application refs NOT in v1 seal (P2.M3.E4.T004 follow-up).
 * - Required unaccepted qualifier → MISSING_QUALIFIER (not pull-in).
 * - Reject-then-qualify cannot launder into pack (qualify never writes
 *   acceptedClaimIds; store accepted−rejected excludes).
 * - Pure build: no Date.now / random / pid in hash material.
 * - Empty accepted set → empty pack ok:true (valid).
 */
import { createHash } from "node:crypto";

import type { Claim } from "../../domain/ingest/claim.js";
import type {
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

function sha256Hex(material: string): Sha256 {
  return createHash("sha256").update(material).digest("hex") as Sha256;
}

/**
 * Canonical JSON for hashing — key order fixed by construction (arrays only +
 * explicit field order in objects). No Date/random/pid.
 */
function canonicalPackBody(input: {
  questionId: string;
  graphRevision: number;
  claims: readonly Claim[];
  qualifierEdges: readonly QualifierEdge[];
  citations: readonly PackCitation[];
  gaps: readonly string[];
}): string {
  const claims = [...input.claims]
    .sort((a, b) => cmpId(a.id, b.id))
    .map((c) => ({
      id: c.id,
      version: c.version,
      statement: c.statement,
      claimType: c.claimType,
      scope: c.scope,
      authority: c.authority,
      lifecycle: c.lifecycle,
      state: c.state,
      evidenceRefs: [...c.evidenceRefs]
        .sort((a, b) => cmpId(a.unitId, b.unitId))
        .map((r) => ({
          snapshotId: r.snapshotId,
          fileId: r.fileId,
          unitId: r.unitId,
          fileSha256: r.fileSha256,
          unitSha256: r.unitSha256,
          ...(r.verified !== undefined ? { verified: r.verified } : {}),
        })),
      relationships: {
        qualifierClaimIds: [...c.relationships.qualifierClaimIds].sort(cmpId),
        contradictsClaimIds: [...c.relationships.contradictsClaimIds].sort(
          cmpId,
        ),
        supersedesClaimIds: [...c.relationships.supersedesClaimIds].sort(cmpId),
      },
      createdFrom: c.createdFrom,
    }));
  const claimIds = claims.map((c) => c.id);
  const qualifierEdges = [...input.qualifierEdges].sort((a, b) => {
    const f = cmpId(a.from, b.from);
    return f !== 0 ? f : cmpId(a.to, b.to);
  });
  const citations = [...input.citations].sort((a, b) => {
    const c = cmpId(a.claimId, b.claimId);
    return c !== 0 ? c : cmpId(a.unitId, b.unitId);
  });
  const gaps = [...input.gaps].sort(cmpId);
  // Explicit field order — application refs intentionally omitted (v1).
  return JSON.stringify({
    schemaVersion: 1,
    questionId: input.questionId,
    graphRevision: input.graphRevision,
    claimIds,
    claims,
    qualifierEdges,
    citations,
    gaps,
  });
}

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
      const body = canonicalPackBody({
        questionId,
        graphRevision: expectedRevision,
        claims: selected,
        qualifierEdges,
        citations,
        gaps,
      });
      const hash = sha256Hex(body);

      const pack: SealedClaimPack = deepFreeze({
        schemaVersion: 1 as const,
        hash,
        questionId,
        graphRevision: expectedRevision as GraphRevision,
        claimIds: Object.freeze(selected.map((c) => c.id)),
        claims: Object.freeze([...selected]),
        qualifierEdges: Object.freeze(qualifierEdges),
        citations: Object.freeze(citations),
        gaps: Object.freeze(gaps),
      });
      return ok(pack);
    },
  };
}
