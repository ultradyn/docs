/**
 * T-22-03 — ClaimReview application (Tier A authority boundary).
 *
 * Invariants:
 * 1) Separation of duties — creating run from AUTHORITATIVE packet provenance.
 * 2) Idempotency — same key → one logical application.
 * 3) Split preserves all evidence/provenance; append-only.
 * 4) Accepted transitions only via this service's authority path.
 * 5) Rejected claims cannot enter accepted packs (safe default accessor).
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ClaimReviewSchema,
  type ClaimReview,
  type ClaimReviewDecision,
} from "../../domain/ingest/claim-review.js";
import type { Claim } from "../../domain/ingest/claim.js";
import type { ClaimId, Sha256 } from "../../domain/ingest/types.js";

import {
  createClaimReviewService,
  isEligibleForAcceptedPack,
  listAcceptedClaimIds,
  normaliseRunIdentity,
  type ClaimReviewApplication,
  type ClaimReviewService,
  type ClaimReviewServiceError,
  type PacketCreationIdentityReader,
} from "./claim-review-service.js";
import {
  createClaimRepository,
  createInMemoryClaimStore,
  type ClaimAcceptanceAuthority,
  type EvidenceVerificationReader,
} from "./claim-repository.js";

const SNAP = `snap-${"b".repeat(64)}`;
const FILE = `file-${"a".repeat(64)}`;
const UNIT = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const QUESTION = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PACKET = "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EXTRACTOR_RUN = "run-extractor-01ARZ3NDEKTSV4RRFFQ69G5F";
const REVIEWER_RUN = "run-reviewer-01ARZ3NDEKTSV4RRFFQ69G5F";

function sha(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}

function evidence(verified = true) {
  return {
    snapshotId: SNAP,
    fileId: FILE,
    unitId: UNIT,
    fileSha256: sha("file"),
    unitSha256: sha("unit"),
    verified,
  };
}

function verifierOk(): EvidenceVerificationReader {
  return { isVerified: async () => true };
}

function authorityDeny(): ClaimAcceptanceAuthority {
  return {
    authorizeAcceptance: async () => ({
      ok: false as const,
      code: "ACCEPTANCE_FORBIDDEN" as const,
      message: "No independent review application.",
    }),
  };
}

/** Authoritative packet→run map (simulates packet store provenance). */
function packetIdentity(
  map: ReadonlyMap<string, string> = new Map([[PACKET, EXTRACTOR_RUN]]),
): PacketCreationIdentityReader {
  return {
    getRunIdForPacket: async (packetId) => map.get(packetId),
  };
}

function makeService(
  overrides: {
    store?: ReturnType<typeof createInMemoryClaimStore>;
    identity?: PacketCreationIdentityReader;
  } = {},
) {
  const store = overrides.store ?? createInMemoryClaimStore();
  const service = createClaimReviewService({
    store,
    evidence: verifierOk(),
    packetIdentity: overrides.identity ?? packetIdentity(),
  });
  return { service, store, repo: service.repository };
}

async function seedProposed(
  service: ClaimReviewService,
  overrides: Record<string, unknown> = {},
): Promise<Claim> {
  const created = await service.repository.create({
    statement: "Workers retry failed endpoints with exponential backoff.",
    claimType: "behavior",
    scope: { component: "delivery-worker" },
    authority: "official",
    lifecycle: "current",
    evidenceRefs: [evidence(true)],
    relationships: {
      qualifierClaimIds: [],
      contradictsClaimIds: [],
      supersedesClaimIds: [],
    },
    createdFrom: { questionId: QUESTION, packetId: PACKET },
    ...overrides,
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("seed failed");
  return created.value;
}

function reviewDraft(
  claimId: ClaimId,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "crv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    claimId,
    expectedVersion: 1,
    decision: "accept" as ClaimReviewDecision,
    reviewerRunId: REVIEWER_RUN,
    extractorRunId: EXTRACTOR_RUN,
    reason: "Entailed by verified evidence.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Domain schema surface
// ---------------------------------------------------------------------------
describe("ClaimReview domain schema", () => {
  it("exports ClaimReviewSchema with closed decision set", () => {
    expect(typeof ClaimReviewSchema?.safeParse).toBe("function");
    const base = {
      schemaVersion: 1,
      id: "crv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      claimId: "clm-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      expectedVersion: 1,
      decision: "accept",
      reviewerRunId: REVIEWER_RUN,
      extractorRunId: EXTRACTOR_RUN,
    };
    expect(ClaimReviewSchema.safeParse(base).success).toBe(true);
    for (const decision of ["accept", "reject", "qualify", "split"] as const) {
      expect(
        ClaimReviewSchema.safeParse({
          ...base,
          decision,
          ...(decision === "split"
            ? {
                splits: [
                  {
                    statement: "Part A.",
                    claimType: "behavior",
                    scope: { a: 1 },
                  },
                ],
              }
            : {}),
        }).success,
      ).toBe(true);
    }
    expect(
      ClaimReviewSchema.safeParse({ ...base, decision: "approve" }).success,
    ).toBe(false);
  });

  it("rejects unknown keys and missing reviewerRunId", () => {
    const base = reviewDraft("clm-01ARZ3NDEKTSV4RRFFQ69G5FAV" as ClaimId);
    expect(ClaimReviewSchema.safeParse({ ...base, evil: true }).success).toBe(
      false,
    );
    const noReviewer = { ...base };
    delete noReviewer.reviewerRunId;
    expect(ClaimReviewSchema.safeParse(noReviewer).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Separation of duties (AC1) — authoritative packet provenance
// ---------------------------------------------------------------------------
describe("separation of duties", () => {
  it("extractor run cannot accept its own claim (self-acceptance refused)", async () => {
    const { service, repo } = makeService();
    const claim = await seedProposed(service);
    const result = await service.apply(
      reviewDraft(claim.id, {
        reviewerRunId: EXTRACTOR_RUN, // equals packet-bound creating run
        extractorRunId: EXTRACTOR_RUN,
      }),
      "idem-sod-1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SEPARATION_OF_DUTIES");
      expect(result.message).not.toContain(EXTRACTOR_RUN);
    }
    const latest = await repo.get(claim.id);
    expect(latest.ok && latest.value.state).toBe("proposed");
  });

  it("caller-asserted extractorRunId cannot bypass SoD when packet identity differs", async () => {
    // Packet store says EXTRACTOR_RUN created the packet. Reviewer claims to be
    // REVIEWER but sets extractorRunId to a decoy — SoD still uses packet store.
    const { service } = makeService();
    const claim = await seedProposed(service);
    const result = await service.apply(
      reviewDraft(claim.id, {
        reviewerRunId: EXTRACTOR_RUN, // still the real creator
        extractorRunId: "run-decoy-not-used-for-sod",
      }),
      "idem-sod-bypass",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SEPARATION_OF_DUTIES");
  });

  it("near-miss identities including zero-width chars still fail after normalise", async () => {
    expect(normaliseRunIdentity(`\u200B${EXTRACTOR_RUN} `)).toBe(EXTRACTOR_RUN);
    const { service } = makeService();
    const claim = await seedProposed(service);
    const result = await service.apply(
      reviewDraft(claim.id, {
        reviewerRunId: `\u200B${EXTRACTOR_RUN}\u200B`,
        extractorRunId: EXTRACTOR_RUN,
      }),
      "idem-sod-near",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SEPARATION_OF_DUTIES");
  });

  it("absent reviewerRunId is refused", async () => {
    const { service } = makeService();
    const claim = await seedProposed(service);
    const draft = reviewDraft(claim.id);
    delete draft.reviewerRunId;
    const result = await service.apply(draft, "idem-sod-absent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["INVALID_INPUT", "REVIEW_REQUIRED"]).toContain(result.code);
    }
  });

  it("unresolved packet identity fails closed (IDENTITY_UNAVAILABLE)", async () => {
    const { service } = makeService({
      identity: { getRunIdForPacket: async () => undefined },
    });
    const claim = await seedProposed(service);
    const result = await service.apply(reviewDraft(claim.id), "idem-sod-none");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("IDENTITY_UNAVAILABLE");
  });

  it("distinct reviewerRunId may accept when authority path is this service", async () => {
    const { service, repo } = makeService();
    const claim = await seedProposed(service);
    const result = await service.apply(
      reviewDraft(claim.id, {
        reviewerRunId: REVIEWER_RUN,
        extractorRunId: EXTRACTOR_RUN,
      }),
      "idem-accept-ok",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.acceptedClaimIds).toContain(claim.id);
    expect(result.value.rejectedClaimIds).toHaveLength(0);
    const latest = await repo.get(claim.id);
    expect(latest.ok && latest.value.state).toBe("accepted");
  });
});

// ---------------------------------------------------------------------------
// Idempotency (AC2)
// ---------------------------------------------------------------------------
describe("idempotency", () => {
  it("retry with same key produces one logical application (replay)", async () => {
    const { service, repo } = makeService();
    const claim = await seedProposed(service);
    const draft = reviewDraft(claim.id);
    const first = await service.apply(draft, "idem-replay-1");
    const second = await service.apply(draft, "idem-replay-1");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.applicationId).toBe(first.value.applicationId);
    expect(second.value.acceptedClaimIds).toEqual(first.value.acceptedClaimIds);
    const latest = await repo.get(claim.id);
    expect(latest.ok && latest.value.version).toBe(2);
  });

  it("same key with different payload is IDEMPOTENCY_CONFLICT", async () => {
    const { service } = makeService();
    const claim = await seedProposed(service);
    const first = await service.apply(reviewDraft(claim.id), "idem-conflict-1");
    expect(first.ok).toBe(true);
    const second = await service.apply(
      reviewDraft(claim.id, { reason: "Different payload reason text." }),
      "idem-conflict-1",
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// Split provenance (AC3)
// ---------------------------------------------------------------------------
describe("split preserves provenance", () => {
  it("split creates NEW claims linked to original with full evidence copy", async () => {
    const { service, repo } = makeService();
    const claim = await seedProposed(service);
    const result = await service.apply(
      reviewDraft(claim.id, {
        decision: "split",
        splits: [
          {
            statement: "Workers retry failed endpoints.",
            claimType: "behavior",
            scope: claim.scope,
          },
          {
            statement: "Retries use exponential backoff.",
            claimType: "behavior",
            scope: claim.scope,
          },
        ],
      }),
      "idem-split-1",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.splitClaimIds.length).toBe(2);
    expect(result.value.splitClaimIds).not.toContain(claim.id);
    const original = await repo.get(claim.id);
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    for (const splitId of result.value.splitClaimIds) {
      const split = await repo.get(splitId);
      expect(split.ok).toBe(true);
      if (!split.ok) continue;
      expect(split.value.evidenceRefs).toEqual(claim.evidenceRefs);
      expect(split.value.createdFrom).toEqual(claim.createdFrom);
      expect(
        result.value.provenanceLinks.some(
          (l) => l.fromClaimId === claim.id && l.toClaimId === splitId,
        ),
      ).toBe(true);
    }
  });

  it("split never erases the original claim record", async () => {
    const { service, repo } = makeService();
    const claim = await seedProposed(service);
    await service.apply(
      reviewDraft(claim.id, {
        decision: "split",
        splits: [
          {
            statement: "Part A of the claim.",
            claimType: "behavior",
            scope: { component: "delivery-worker" },
          },
        ],
      }),
      "idem-split-keep",
    );
    const still = await repo.get(claim.id);
    expect(still.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rejection is not ClaimState; pack exclusion (AC5)
// ---------------------------------------------------------------------------
describe("rejection outcome and pack exclusion", () => {
  it("reject leaves claim state proposed (not a ClaimState='rejected')", async () => {
    const { service, repo } = makeService();
    const claim = await seedProposed(service);
    const result = await service.apply(
      reviewDraft(claim.id, { decision: "reject", reason: "Not entailed." }),
      "idem-reject-1",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rejectedClaimIds).toContain(claim.id);
    expect(result.value.acceptedClaimIds).toHaveLength(0);
    const latest = await repo.get(claim.id);
    expect(latest.ok && latest.value.state).toBe("proposed");
    expect(latest.ok && (latest.value.state as string)).not.toBe("rejected");
  });

  it("rejected claims cannot enter accepted packs (safe default accessor)", async () => {
    const { service } = makeService();
    const claim = await seedProposed(service);
    const applied = await service.apply(
      reviewDraft(claim.id, { decision: "reject" }),
      "idem-pack-1",
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(isEligibleForAcceptedPack(claim.id, [applied.value])).toBe(false);
    // Service accessor is the safe default path
    expect(service.listAcceptedClaimIds()).not.toContain(claim.id);

    const { service: s2 } = makeService();
    const c2 = await seedProposed(s2, {
      statement: "A different claim statement for pack eligibility.",
    });
    const accepted = await s2.apply(reviewDraft(c2.id), "idem-pack-2");
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(isEligibleForAcceptedPack(c2.id, [accepted.value])).toBe(true);
    expect(listAcceptedClaimIds([accepted.value])).toContain(c2.id);
    expect(s2.listAcceptedClaimIds()).toContain(c2.id);
  });
});

// ---------------------------------------------------------------------------
// Accepted only through this service (AC4)
// ---------------------------------------------------------------------------
describe("accepted-state transition only through review service", () => {
  it("repository deny-by-default still blocks accept without this service", async () => {
    const store = createInMemoryClaimStore();
    const repo = createClaimRepository({
      store,
      evidence: verifierOk(),
      acceptance: authorityDeny(),
    });
    const created = await repo.create({
      statement: "Workers retry failed endpoints with exponential backoff.",
      claimType: "behavior",
      scope: { component: "delivery-worker" },
      authority: "official",
      lifecycle: "current",
      evidenceRefs: [evidence(true)],
      relationships: {
        qualifierClaimIds: [],
        contradictsClaimIds: [],
        supersedesClaimIds: [],
      },
      createdFrom: { questionId: QUESTION, packetId: PACKET },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const direct = await repo.transition({
      claimId: created.value.id,
      expectedVersion: 1,
      to: "accepted",
      reviewerRunId: REVIEWER_RUN,
    });
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.code).toBe("ACCEPTANCE_FORBIDDEN");
  });

  it("service accept path grants via ClaimAcceptanceAuthority seam", async () => {
    const { service } = makeService();
    const claim = await seedProposed(service);
    const granted = await service.apply(reviewDraft(claim.id), "idem-auth-1");
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    expect(granted.value.reviewApplicationRef).toMatch(/^cra-/);
  });
});

// ---------------------------------------------------------------------------
// Hygiene / barrel
// ---------------------------------------------------------------------------
describe("hygiene", () => {
  it("deep-freezes applications; hostile review accessors rejected", async () => {
    const { service } = makeService();
    const claim = await seedProposed(service);
    const ok = await service.apply(reviewDraft(claim.id), "idem-freeze-1");
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(Object.isFrozen(ok.value)).toBe(true);
    }

    const hostile: Record<string, unknown> = {
      schemaVersion: 1,
      id: "crv-01ARZ3NDEKTSV4RRFFQ69G5FB0",
      claimId: claim.id,
      expectedVersion: 1,
      decision: "accept",
      extractorRunId: EXTRACTOR_RUN,
    };
    Object.defineProperty(hostile, "reviewerRunId", {
      enumerable: true,
      get() {
        throw new Error("hostile");
      },
    });
    const bad = await service.apply(hostile, "idem-hostile");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("INVALID_INPUT");
  });

  it("public knowledge barrel exports createClaimReviewService", async () => {
    const barrel = await import("./index.js");
    expect(typeof barrel.createClaimReviewService).toBe("function");
    expect(typeof barrel.isEligibleForAcceptedPack).toBe("function");
    expect(typeof barrel.listAcceptedClaimIds).toBe("function");
  });
});

describe("type surface", () => {
  it("ClaimReviewApplication exposes accepted/rejected/split ids", () => {
    expect(typeof createClaimReviewService).toBe("function");
    expect(typeof isEligibleForAcceptedPack).toBe("function");
    expect(typeof ClaimReviewSchema?.safeParse).toBe("function");
    const _pin: ClaimReviewApplication | undefined = undefined;
    const _svc: ClaimReviewService | undefined = undefined;
    const _err: ClaimReviewServiceError | undefined = undefined;
    const _rev: ClaimReview | undefined = undefined;
    void _pin;
    void _svc;
    void _err;
    void _rev;
  });
});
