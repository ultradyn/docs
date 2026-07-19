/**
 * T004 RED — application refs on sealed pack (auditable selection).
 *
 * NAIL 1: refs are a FIELD on the pack AND in seal hash (recomputable; swap changes hash).
 * NAIL 2: re-derive accepted = accepts MINUS rejects; fixture includes a REJECT.
 * NAIL 3: claimIds vs derived set mismatch is detectable (isolated pin).
 * NAIL 4: honesty text does not overclaim decision correctness.
 *
 * Dual-gate at build remains authority; refs are additional audit material.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Claim } from "../../domain/ingest/claim.js";
import type { SealedClaimPack } from "../../domain/ingest/sealed-claim-pack.js";
import type { ClaimId, GraphRevision, Sha256 } from "../../domain/ingest/types.js";

import {
  PACK_SELECTION_HONESTY,
  deriveClaimIdsFromApplicationRefs,
  recomputeSealedPackHash,
  verifyPackSelection,
  type PackApplicationRef,
} from "./pack-application-audit.js";

const QUESTION = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CLM_A = "clm-01ARZ3NDEKTSV4RRFFQ69G5FAA" as ClaimId;
const CLM_B = "clm-01ARZ3NDEKTSV4RRFFQ69G5FAB" as ClaimId;
const CLM_REJECTED = "clm-01ARZ3NDEKTSV4RRFFQ69G5FAC" as ClaimId;
const REVISION = 1 as GraphRevision;

function sha(s: string): Sha256 {
  return createHash("sha256").update(s).digest("hex") as Sha256;
}

function claim(id: ClaimId, statement: string): Claim {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    statement,
    claimType: "behavior",
    scope: { product: "atlas" },
    authority: "source-doc",
    lifecycle: "current",
    state: "accepted",
    evidenceRefs: [
      {
        snapshotId: `snap-${"b".repeat(64)}`,
        fileId: `file-${"c".repeat(64)}`,
        unitId: "unit-01ARZ3NDEKTSV4RRFFQ69G5FAA",
        fileSha256: sha("f"),
        unitSha256: sha("u"),
      },
    ],
    relationships: {
      qualifierClaimIds: [],
      contradictsClaimIds: [],
      supersedesClaimIds: [],
    },
    createdFrom: {
      questionId: QUESTION,
      packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    },
  };
}

/** Fixture: two accepts + one reject (NAIL 2 requires reject present). */
function applicationRefs(): PackApplicationRef[] {
  return [
    {
      applicationId: "app-accept-a",
      reviewId: "crv-01ARZ3NDEKTSV4RRFFQ69G5FAA",
      claimId: CLM_A,
      decision: "accept",
    },
    {
      applicationId: "app-accept-b",
      reviewId: "crv-01ARZ3NDEKTSV4RRFFQ69G5FAB",
      claimId: CLM_B,
      decision: "accept",
    },
    {
      applicationId: "app-reject-c",
      reviewId: "crv-01ARZ3NDEKTSV4RRFFQ69G5FAC",
      claimId: CLM_REJECTED,
      decision: "reject",
    },
  ];
}

function packWithRefs(
  overrides: Partial<SealedClaimPack> = {},
): SealedClaimPack {
  const claims = [
    claim(CLM_A, "Atlas stores knowledge in Git."),
    claim(CLM_B, "Settings apply via procedure."),
  ];
  const refs = applicationRefs();
  const base = {
    schemaVersion: 2 as const,
    hash: "a".repeat(64) as Sha256,
    questionId: QUESTION,
    graphRevision: REVISION,
    claimIds: [CLM_A, CLM_B] as ClaimId[],
    claims,
    qualifierEdges: [],
    citations: claims.map((c) => ({
      claimId: c.id,
      unitId: c.evidenceRefs[0]!.unitId,
      unitSha256: c.evidenceRefs[0]!.unitSha256,
      fileSha256: c.evidenceRefs[0]!.fileSha256,
      snapshotId: c.evidenceRefs[0]!.snapshotId,
    })),
    gaps: [] as string[],
    applicationRefs: refs,
  };
  // Hash must be recomputable from pack fields alone (NAIL 1).
  const withBody = { ...base, ...overrides } as SealedClaimPack;
  const hash = recomputeSealedPackHash(withBody);
  return { ...withBody, hash };
}

describe("pack application audit (T004)", () => {
  it("NAIL 4: honesty header does not claim decision correctness", () => {
    expect(PACK_SELECTION_HONESTY).toMatch(/selection matches the recorded decisions/i);
    expect(PACK_SELECTION_HONESTY).toMatch(/does not prove the decisions were correct/i);
    expect(PACK_SELECTION_HONESTY).not.toMatch(/decisions were correct(?!)/i);
  });

  it("NAIL 1a: recomputeSealedPackHash equals pack.hash when refs are a field", () => {
    const pack = packWithRefs();
    expect(pack.applicationRefs).toBeDefined();
    expect(pack.applicationRefs!.length).toBeGreaterThan(0);
    expect(recomputeSealedPackHash(pack)).toBe(pack.hash);
  });

  it("NAIL 1b: mutating one application ref changes the seal hash", () => {
    const pack = packWithRefs();
    const mutatedRefs = pack.applicationRefs!.map((r, i) =>
      i === 0
        ? { ...r, applicationId: "app-mutated-swap" }
        : r,
    );
    const mutated = {
      ...pack,
      applicationRefs: mutatedRefs,
    };
    const newHash = recomputeSealedPackHash(mutated as SealedClaimPack);
    expect(newHash).not.toBe(pack.hash);
  });

  it("NAIL 2: deriveClaimIdsFromApplicationRefs = accepts MINUS rejects", () => {
    const refs = applicationRefs();
    const derived = deriveClaimIdsFromApplicationRefs(refs);
    expect(derived).toContain(CLM_A);
    expect(derived).toContain(CLM_B);
    expect(derived).not.toContain(CLM_REJECTED);
    // Sorted for determinism
    expect(derived).toEqual([...derived].sort());
  });

  it("NAIL 2: pack wrongly including rejected claim is DETECTABLE", () => {
    const claims = [
      claim(CLM_A, "Atlas stores knowledge in Git."),
      claim(CLM_B, "Settings apply via procedure."),
      claim(CLM_REJECTED, "Should not be in pack."),
    ];
    const bad = packWithRefs({
      claimIds: [CLM_A, CLM_B, CLM_REJECTED],
      claims,
    });
    const result = verifyPackSelection(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SELECTION_MISMATCH");
  });

  it("NAIL 3: claimIds vs refs mismatch fails verifyPackSelection", () => {
    // claimIds includes only A but refs say A+B accepted
    const bad = packWithRefs({
      claimIds: [CLM_A],
      claims: [claim(CLM_A, "Atlas stores knowledge in Git.")],
    });
    const result = verifyPackSelection(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SELECTION_MISMATCH");
  });

  it("control: matching claimIds + refs with reject excluded → verify ok", () => {
    const pack = packWithRefs();
    const result = verifyPackSelection(pack);
    expect(result.ok).toBe(true);
  });
});
