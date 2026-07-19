import { describe, expect, it } from "vitest";

import {
  ClaimSchema,
  ClaimIdSchema,
  ClaimStateSchema,
  ClaimTypeSchema,
  ClaimEvidenceRefSchema,
  ClaimRelationshipsSchema,
} from "./claim.js";

const CLM = "clm-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UNIT = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SNAP = `snap-${"b".repeat(64)}`;
const FILE = `file-${"a".repeat(64)}`;
const DIGEST = "a".repeat(64);

function baseClaim(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    id: CLM,
    version: 1,
    statement: "Workers retry failed endpoints with exponential backoff.",
    claimType: "behavior",
    scope: { component: "delivery-worker", version: "3.x" },
    authority: "official",
    lifecycle: "current",
    state: "proposed",
    evidenceRefs: [
      {
        snapshotId: SNAP,
        fileId: FILE,
        unitId: UNIT,
        fileSha256: DIGEST,
        unitSha256: DIGEST,
        verified: false,
      },
    ],
    relationships: {
      qualifierClaimIds: [] as string[],
      contradictsClaimIds: [] as string[],
      supersedesClaimIds: [] as string[],
    },
    createdFrom: {
      questionId: "q-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    },
    ...overrides,
  };
}

describe("Claim domain exports", () => {
  it("exports ClaimSchema", () => {
    expect(typeof ClaimSchema?.safeParse).toBe("function");
  });

  it("ClaimIdSchema accepts clm- brand only", () => {
    expect(ClaimIdSchema.safeParse(CLM).success).toBe(true);
    expect(
      ClaimIdSchema.safeParse("pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV").success,
    ).toBe(false);
    expect(
      ClaimIdSchema.safeParse("claim-01ARZ3NDEKTSV4RRFFQ69G5FAV").success,
    ).toBe(false);
  });

  it("ClaimStateSchema is closed plan set (no plan-rejected drift without T-22-03)", () => {
    for (const state of [
      "proposed",
      "accepted",
      "disputed",
      "stale",
      "superseded",
    ] as const) {
      expect(ClaimStateSchema.safeParse(state).success).toBe(true);
    }
    // rejected is review-owned later; not a free repository invent token here
    // if present must be explicit — RED pins plan five-state set
    expect(ClaimStateSchema.safeParse("draft").success).toBe(false);
  });

  it("ClaimTypeSchema is closed protocol set", () => {
    expect(ClaimTypeSchema.safeParse("behavior").success).toBe(true);
    expect(ClaimTypeSchema.safeParse("definition").success).toBe(true);
    expect(ClaimTypeSchema.safeParse("not-a-type").success).toBe(false);
  });

  it("accepts a complete proposed claim", () => {
    expect(ClaimSchema.safeParse(baseClaim()).success).toBe(true);
  });

  it("rejects legacy placeholder {schemaVersion,id} alone", () => {
    expect(
      ClaimSchema.safeParse({ schemaVersion: 1, id: CLM }).success,
    ).toBe(false);
  });

  it("requires statement, claimType, scope, authority, lifecycle, state, evidenceRefs", () => {
    for (const key of [
      "statement",
      "claimType",
      "scope",
      "authority",
      "lifecycle",
      "state",
      "evidenceRefs",
    ] as const) {
      const copy = baseClaim();
      delete (copy as Record<string, unknown>)[key];
      expect(ClaimSchema.safeParse(copy).success).toBe(false);
    }
  });

  it("rejects unknown keys and child-question smuggling", () => {
    expect(
      ClaimSchema.safeParse(baseClaim({ childQuestions: [] })).success,
    ).toBe(false);
    expect(ClaimSchema.safeParse(baseClaim({ evil: true })).success).toBe(
      false,
    );
  });

  it("ClaimEvidenceRefSchema requires hashes and unit binding", () => {
    expect(
      ClaimEvidenceRefSchema.safeParse({
        snapshotId: SNAP,
        fileId: FILE,
        unitId: UNIT,
        fileSha256: DIGEST,
        unitSha256: DIGEST,
        verified: true,
      }).success,
    ).toBe(true);
    expect(
      ClaimEvidenceRefSchema.safeParse({
        unitId: UNIT,
        verified: true,
      }).success,
    ).toBe(false);
  });

  it("relationships only allow claim id brands", () => {
    expect(
      ClaimRelationshipsSchema.safeParse({
        qualifierClaimIds: [CLM],
        contradictsClaimIds: [],
        supersedesClaimIds: [],
      }).success,
    ).toBe(true);
    expect(
      ClaimRelationshipsSchema.safeParse({
        qualifierClaimIds: ["not-a-claim"],
        contradictsClaimIds: [],
        supersedesClaimIds: [],
      }).success,
    ).toBe(false);
  });
});
