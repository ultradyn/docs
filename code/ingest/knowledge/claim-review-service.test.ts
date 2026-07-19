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
  createInMemoryClaimReviewApplicationStore,
  isEligibleForAcceptedPack,
  listAcceptedClaimIds,
  normaliseRunIdentity,
  type ClaimReviewApplication,
  type ClaimReviewApplicationStore,
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
    applicationStore?: ClaimReviewApplicationStore;
    hooks?: {
      afterSplitPartCreate?: (
        index: number,
        claimId: string,
      ) => void | Promise<void>;
    };
  } = {},
) {
  const store = overrides.store ?? createInMemoryClaimStore();
  const applicationStore =
    overrides.applicationStore ?? createInMemoryClaimReviewApplicationStore();
  const service = createClaimReviewService({
    store,
    evidence: verifierOk(),
    packetIdentity: overrides.identity ?? packetIdentity(),
    applicationStore,
    ...(overrides.hooks ? { hooks: overrides.hooks } : {}),
  });
  return { service, store, repo: service.repository, applicationStore };
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
// Idempotency (AC2) — including DURABLE path across service instances
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

  it("DURABLE path: new service instance replays APPLICATION via store (no re-apply)", async () => {
    const store = createInMemoryClaimStore();
    const applicationStore = createInMemoryClaimReviewApplicationStore();
    const identity = packetIdentity();
    const s1 = createClaimReviewService({
      store,
      evidence: verifierOk(),
      packetIdentity: identity,
      applicationStore,
    });
    const claim = await seedProposed(s1);
    const draft = reviewDraft(claim.id);
    const first = await s1.apply(draft, "idem-durable-1");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const versionAfterFirst = (await s1.repository.get(claim.id)).ok
      ? ((await s1.repository.get(claim.id)) as { ok: true; value: Claim })
          .value.version
      : -1;

    // Fresh process-equivalent service: empty process maps, same durable stores
    const s2 = createClaimReviewService({
      store,
      evidence: verifierOk(),
      packetIdentity: identity,
      applicationStore,
    });
    const second = await s2.apply(draft, "idem-durable-1");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.applicationId).toBe(first.value.applicationId);
    expect(second.value.acceptedClaimIds).toEqual(first.value.acceptedClaimIds);
    expect(second.value.reviewApplicationRef).toBe(
      first.value.reviewApplicationRef,
    );
    // No new claim version — authority decision not double-applied
    const latest = await s2.repository.get(claim.id);
    expect(latest.ok && latest.value.version).toBe(versionAfterFirst);
  });

  it("DURABLE path: same key different payload is IDEMPOTENCY_CONFLICT across instances", async () => {
    const store = createInMemoryClaimStore();
    const applicationStore = createInMemoryClaimReviewApplicationStore();
    const identity = packetIdentity();
    const s1 = createClaimReviewService({
      store,
      evidence: verifierOk(),
      packetIdentity: identity,
      applicationStore,
    });
    const claim = await seedProposed(s1);
    expect(
      (await s1.apply(reviewDraft(claim.id), "idem-durable-conflict")).ok,
    ).toBe(true);
    const s2 = createClaimReviewService({
      store,
      evidence: verifierOk(),
      packetIdentity: identity,
      applicationStore,
    });
    const conflict = await s2.apply(
      reviewDraft(claim.id, { reason: "Other reason for conflict." }),
      "idem-durable-conflict",
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
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

  it("mid-split crash leaves no durable application; recovery can complete", async () => {
    const store = createInMemoryClaimStore();
    const applicationStore = createInMemoryClaimReviewApplicationStore();
    const identity = packetIdentity();
    let crashAfter = 0;
    const crashing = createClaimReviewService({
      store,
      evidence: verifierOk(),
      packetIdentity: identity,
      applicationStore,
      hooks: {
        afterSplitPartCreate: async (index) => {
          if (index === 0 && crashAfter === 0) {
            crashAfter = 1;
            throw new Error("injected-crash afterSplitPartCreate");
          }
        },
      },
    });
    const claim = await seedProposed(crashing);
    const draft = reviewDraft(claim.id, {
      decision: "split",
      splits: [
        {
          statement: "Split part one for crash test.",
          claimType: "behavior",
          scope: { component: "delivery-worker" },
        },
        {
          statement: "Split part two for crash test.",
          claimType: "behavior",
          scope: { component: "delivery-worker" },
        },
      ],
    });
    await expect(crashing.apply(draft, "idem-split-crash")).rejects.toThrow(
      /injected-crash/,
    );
    // No durable application after crash
    const orphan = await applicationStore.lookup(
      "claim-review:idem-split-crash",
    );
    expect(orphan).toBeUndefined();
    expect(crashing.listApplications()).toHaveLength(0);

    // Recovery: fresh service, same stores, no crash hook — completes once
    const recovered = createClaimReviewService({
      store,
      evidence: verifierOk(),
      packetIdentity: identity,
      applicationStore,
    });
    const result = await recovered.apply(draft, "idem-split-crash");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.splitClaimIds.length).toBe(2);
    // Replay does not create more
    const replay = await recovered.apply(draft, "idem-split-crash");
    expect(replay.ok && replay.value.applicationId).toBe(
      result.value.applicationId,
    );
    expect(replay.ok && replay.value.splitClaimIds).toEqual(
      result.value.splitClaimIds,
    );
  });
});

// ---------------------------------------------------------------------------
// Qualify fail-closed (never silent no-op)
// ---------------------------------------------------------------------------
describe("qualify decision", () => {
  it("qualify is refused with QUALIFY_UNSUPPORTED (not accepted-and-ignored)", async () => {
    const { service, repo } = makeService();
    const claim = await seedProposed(service);
    const result = await service.apply(
      reviewDraft(claim.id, { decision: "qualify" }),
      "idem-qualify-1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("QUALIFY_UNSUPPORTED");
    const latest = await repo.get(claim.id);
    expect(latest.ok && latest.value.state).toBe("proposed");
    expect(service.listApplications()).toHaveLength(0);
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
    // In-memory application store stays off the barrel (T-22-01 discipline).
    expect(
      (barrel as { createInMemoryClaimReviewApplicationStore?: unknown })
        .createInMemoryClaimReviewApplicationStore,
    ).toBeUndefined();
  });

  it("listAcceptedClaimIds is pure over its argument (partial set weakens exclusion)", () => {
    const acceptedOnly = {
      schemaVersion: 1 as const,
      applicationId: "cra-partial-a",
      reviewApplicationRef: "cra-partial-a",
      reviewId: "crv-01ARZ3NDEKTSV4RRFFQ69G5FAV" as ClaimReview["id"],
      claimId: "clm-01ARZ3NDEKTSV4RRFFQ69G5FAV" as ClaimId,
      decision: "accept" as const,
      acceptedClaimIds: ["clm-01ARZ3NDEKTSV4RRFFQ69G5FAV" as ClaimId],
      rejectedClaimIds: [] as ClaimId[],
      splitClaimIds: [] as ClaimId[],
      provenanceLinks: [],
      reviewerRunId: REVIEWER_RUN,
      idempotencyKey: "partial-a",
    };
    const rejectSame = {
      ...acceptedOnly,
      applicationId: "cra-partial-b",
      reviewApplicationRef: "cra-partial-b",
      decision: "reject" as const,
      acceptedClaimIds: [] as ClaimId[],
      rejectedClaimIds: ["clm-01ARZ3NDEKTSV4RRFFQ69G5FAV" as ClaimId],
      idempotencyKey: "partial-b",
    };
    // Complete set: rejection wins
    expect(listAcceptedClaimIds([acceptedOnly, rejectSame])).not.toContain(
      "clm-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    // Partial set (missing rejection): claim appears accepted — documents precondition
    expect(listAcceptedClaimIds([acceptedOnly])).toContain(
      "clm-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
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

// ---------------------------------------------------------------------------
// T-22-05 — Rejected-claim exclusion at the durable application store boundary
// ---------------------------------------------------------------------------
describe("T-22-05 store-level rejected-claim exclusion", () => {
  it("SIMULATED restart: fresh service over shared application store still excludes rejected ids", async () => {
    // Process-local applicationIndex alone loses durable applications after a
    // "restart". Shared application store + fresh service is the structural path.
    // Order: reject first (claim stays proposed), then accept — both durable.
    // Complete set: id is in acceptedClaimIds AND rejectedClaimIds → excluded.
    const applicationStore = createInMemoryClaimReviewApplicationStore();
    const claimStore = createInMemoryClaimStore();
    const s1 = createClaimReviewService({
      store: claimStore,
      evidence: verifierOk(),
      packetIdentity: packetIdentity(),
      applicationStore,
    });
    const claim = await seedProposed(s1);
    const rejected = await s1.apply(
      reviewDraft(claim.id, { decision: "reject", reason: "Not entailed." }),
      "t2205-reject",
    );
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    const accepted = await s1.apply(reviewDraft(claim.id), "t2205-accept");
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    // Fresh service instance over the SAME durable application store.
    const s2 = createClaimReviewService({
      store: claimStore,
      evidence: verifierOk(),
      packetIdentity: packetIdentity(),
      applicationStore,
    });
    // Complete exclusion must not require process-local memory.
    const packIds = await s2.listAcceptedClaimIds();
    expect(packIds).not.toContain(claim.id);
    // Store path is the supported selection path.
    expect(typeof applicationStore.listAcceptedClaimIds).toBe("function");
    expect(await applicationStore.listAcceptedClaimIds()).not.toContain(
      claim.id,
    );
  });

  it("POSITIVE CONTROL: accepted id is selected when never rejected (store path)", async () => {
    const applicationStore = createInMemoryClaimReviewApplicationStore();
    const { service } = makeService({ applicationStore });
    const claim = await seedProposed(service, {
      statement: "Positive-control claim for pack selection after T-22-05.",
    });
    const accepted = await service.apply(
      reviewDraft(claim.id),
      "t2205-pos-accept",
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    // Anti-vacuity for the exclusion tests: same store path WOULD include this id.
    expect(await service.listAcceptedClaimIds()).toContain(claim.id);
    expect(await applicationStore.listAcceptedClaimIds()).toContain(claim.id);
    expect(await applicationStore.isEligibleForAcceptedPack(claim.id)).toBe(
      true,
    );
  });

  it("adversarial: rejected id cannot enter pack via store query even if pure helper is given a partial set", async () => {
    const applicationStore = createInMemoryClaimReviewApplicationStore();
    const { service } = makeService({ applicationStore });
    const claim = await seedProposed(service, {
      statement: "Adversarial partial-set claim for T-22-05 exclusion.",
    });
    // reject then accept so both application rows exist durably
    const rejected = await service.apply(
      reviewDraft(claim.id, { decision: "reject", reason: "Rejected." }),
      "t2205-adv-reject",
    );
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    const accepted = await service.apply(
      reviewDraft(claim.id),
      "t2205-adv-accept",
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    // Pure helper with PARTIAL set (accept only) still weakens — documents helper residual.
    expect(
      listAcceptedClaimIds([accepted.value]).includes(claim.id as ClaimId),
    ).toBe(true);
    // Store / service path MUST NOT weaken — complete durable set.
    expect(await applicationStore.listAcceptedClaimIds()).not.toContain(
      claim.id,
    );
    expect(await service.listAcceptedClaimIds()).not.toContain(claim.id);
    expect(await applicationStore.isEligibleForAcceptedPack(claim.id)).toBe(
      false,
    );
  });
});
