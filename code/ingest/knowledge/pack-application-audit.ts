/**
 * T004 / B009 — Auditable selection: re-derive accept−reject from pack.applicationRefs.
 *
 * HONESTY (NAIL 4):
 * This verifier proves the pack SELECTION matches the RECORDED claim-review
 * decisions embedded as application refs. It does NOT prove the decisions
 * were correct.
 *
 * Dual-gate membership at build time remains the production selection authority;
 * applicationRefs are an independent witness from the decision store.
 *
 * B009 design B: each PackApplicationRef is one (applicationId, claimId) pair.
 * Multi-id applications expand to multiple refs so this witness matches
 * listAcceptedClaimIds array semantics (acceptedClaimIds − rejectedClaimIds).
 */
import { createHash } from "node:crypto";

import type {
  ClaimReviewDecision,
  ClaimReviewId,
} from "../../domain/ingest/claim-review.js";
import type {
  PackApplicationRef,
  SealedClaimPack,
} from "../../domain/ingest/sealed-claim-pack.js";
import type { ClaimId, Sha256 } from "../../domain/ingest/types.js";

export type { PackApplicationRef };

export const PACK_SELECTION_HONESTY =
  "This verifier proves the pack SELECTION matches the recorded decisions " +
  "embedded as application refs. It does NOT prove the decisions were correct.";

export type PackSelectionVerifyResult =
  | { ok: true }
  | {
      ok: false;
      code: "SELECTION_MISMATCH" | "INVALID_PACK";
      message: string;
    };

function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256Hex(material: string): Sha256 {
  return createHash("sha256").update(material).digest("hex") as Sha256;
}

/**
 * Expand a store application into one PackApplicationRef per claimId in the
 * decision-scoped arrays (B009 design B). Single-id accept/reject apps yield
 * exactly one ref — same shape as pre-B009, preserving seal hashes.
 */
export function expandApplicationToPackRefs(app: {
  readonly applicationId: string;
  readonly reviewId: ClaimReviewId | string;
  readonly decision: ClaimReviewDecision | string;
  readonly acceptedClaimIds: readonly ClaimId[];
  readonly rejectedClaimIds: readonly ClaimId[];
}): PackApplicationRef[] {
  const base = {
    applicationId: app.applicationId,
    reviewId: app.reviewId as ClaimReviewId,
  };
  if (app.decision === "accept") {
    return [...app.acceptedClaimIds]
      .map((id) => id as string)
      .sort(cmpId)
      .map(
        (claimId) =>
          ({
            ...base,
            claimId: claimId as ClaimId,
            decision: "accept" as const,
          }) satisfies PackApplicationRef,
      );
  }
  if (app.decision === "reject") {
    return [...app.rejectedClaimIds]
      .map((id) => id as string)
      .sort(cmpId)
      .map(
        (claimId) =>
          ({
            ...base,
            claimId: claimId as ClaimId,
            decision: "reject" as const,
          }) satisfies PackApplicationRef,
      );
  }
  // split / qualify intentionally omitted from pack refs (builder filters too).
  return [];
}

/** Accepts minus rejects across expanded refs; sorted claim ids. */
export function deriveClaimIdsFromApplicationRefs(
  refs: readonly PackApplicationRef[],
): ClaimId[] {
  const accepted = new Set<string>();
  const rejected = new Set<string>();
  for (const r of refs) {
    if (r.decision === "accept") accepted.add(r.claimId as string);
    if (r.decision === "reject") rejected.add(r.claimId as string);
  }
  for (const id of rejected) accepted.delete(id);
  return [...accepted].sort(cmpId) as ClaimId[];
}

/**
 * Recompute seal hash from pack fields alone (including applicationRefs).
 * Must match production claim-pack-service canonical body.
 */
export function recomputeSealedPackHash(pack: SealedClaimPack): Sha256 {
  const claims = [...pack.claims]
    .sort((a, b) => cmpId(a.id as string, b.id as string))
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
  const qualifierEdges = [...pack.qualifierEdges].sort((a, b) => {
    const f = cmpId(a.from as string, b.from as string);
    return f !== 0 ? f : cmpId(a.to as string, b.to as string);
  });
  const citations = [...pack.citations].sort((a, b) => {
    const c = cmpId(a.claimId as string, b.claimId as string);
    return c !== 0 ? c : cmpId(a.unitId, b.unitId);
  });
  const gaps = [...pack.gaps].sort(cmpId);
  // B009: multi-ref per applicationId → sort by applicationId then claimId.
  const applicationRefs = [...pack.applicationRefs]
    .map((r) => ({
      applicationId: r.applicationId,
      reviewId: r.reviewId,
      claimId: r.claimId,
      decision: r.decision,
    }))
    .sort((a, b) => {
      const byApp = cmpId(a.applicationId, b.applicationId);
      return byApp !== 0 ? byApp : cmpId(a.claimId as string, b.claimId as string);
    });

  const body = JSON.stringify({
    schemaVersion: pack.schemaVersion,
    questionId: pack.questionId,
    graphRevision: pack.graphRevision,
    claimIds,
    claims,
    qualifierEdges,
    citations,
    gaps,
    applicationRefs,
  });
  return sha256Hex(body);
}

export function verifyPackSelection(
  pack: SealedClaimPack,
): PackSelectionVerifyResult {
  if (pack.applicationRefs == null) {
    return {
      ok: false,
      code: "INVALID_PACK",
      message: "Pack missing applicationRefs field.",
    };
  }
  if (pack.applicationRefs.length < 1 && pack.claimIds.length > 0) {
    return {
      ok: false,
      code: "SELECTION_MISMATCH",
      message:
        "Pack has claimIds but no application refs to audit selection. " +
        PACK_SELECTION_HONESTY,
    };
  }
  const derived = deriveClaimIdsFromApplicationRefs(pack.applicationRefs);
  const actual = [...pack.claimIds].map((id) => id as string).sort(cmpId);
  const expected = derived.map((id) => id as string);
  if (
    actual.length !== expected.length ||
    actual.some((id, i) => id !== expected[i])
  ) {
    return {
      ok: false,
      code: "SELECTION_MISMATCH",
      message:
        "Pack claimIds do not match accept−reject set derived from application refs. " +
        PACK_SELECTION_HONESTY,
    };
  }
  return { ok: true };
}
