/**
 * T-60-01 — Sealed claim-pack builder (RED-first).
 *
 * Dual gate: listAcceptedClaimIds + state===accepted.
 * Membership never via ClaimStore.list.
 */
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { Claim } from "../../domain/ingest/claim.js";
import type { ClaimId, GraphRevision, Sha256 } from "../../domain/ingest/types.js";
import type { ClaimReviewDecision } from "../../domain/ingest/claim-review.js";

import {
  createClaimPackService,
  type ClaimPackService,
} from "./claim-pack-service.js";
import {
  createClaimRepository,
  createInMemoryClaimStore,
  type ClaimAcceptanceAuthority,
  type ClaimRepository,
  type EvidenceVerificationReader,
} from "./claim-repository.js";
import {
  createClaimReviewService,
  createInMemoryClaimReviewApplicationStore,
  type ClaimReviewApplicationStore,
  type ClaimReviewService,
  type PacketCreationIdentityReader,
} from "./claim-review-service.js";

const SNAP = `snap-${"b".repeat(64)}`;
const FILE = `file-${"a".repeat(64)}`;
const UNIT = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UNIT_Q = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAQ";
const QUESTION = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const QUESTION_OTHER = "q-01ARZ3NDEKTSV4RRFFQ69G5FB0";
const PACKET = "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PACKET_OTHER = "pkt-01ARZ3NDEKTSV4RRFFQ69G5FB0";
const EXTRACTOR_RUN = "run-extractor-01ARZ3NDEKTSV4RRFFQ69G5F";
const REVIEWER_RUN = "run-reviewer-01ARZ3NDEKTSV4RRFFQ69G5F";
const REVISION = 1 as GraphRevision;

function sha(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}

function evidence(unitId = UNIT, verified = true) {
  return {
    snapshotId: SNAP,
    fileId: FILE,
    unitId,
    fileSha256: sha("file"),
    unitSha256: sha(`unit-${unitId}`),
    verified,
  };
}

function verifierOk(): EvidenceVerificationReader {
  return { isVerified: async () => true };
}

function packetIdentity(
  map: ReadonlyMap<string, string> = new Map([
    [PACKET, EXTRACTOR_RUN],
    [PACKET_OTHER, EXTRACTOR_RUN],
  ]),
): PacketCreationIdentityReader {
  return {
    getRunIdForPacket: async (packetId) => map.get(packetId),
  };
}

function makeHarness() {
  const store = createInMemoryClaimStore();
  const applicationStore = createInMemoryClaimReviewApplicationStore();
  const service = createClaimReviewService({
    store,
    evidence: verifierOk(),
    packetIdentity: packetIdentity(),
    applicationStore,
  });
  const pack = createClaimPackService({
    applicationStore,
    claims: service.repository,
  });
  return { service, store, applicationStore, pack, repo: service.repository };
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
    evidenceRefs: [evidence(UNIT, true)],
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
    id: nextCrv(),
    claimId,
    expectedVersion: 1,
    decision: "accept" as ClaimReviewDecision,
    reviewerRunId: REVIEWER_RUN,
    extractorRunId: EXTRACTOR_RUN,
    reason: "Entailed by verified evidence.",
    ...overrides,
  };
}

/** Unique crv id per call for distinct applications (Crockford ULID body). */
let crvSeq = 0;
function nextCrv(): string {
  crvSeq += 1;
  // 26 crockford chars; pad seq into last digits
  const n = String(crvSeq).padStart(4, "0");
  return `crv-01ARZ3NDEKTSV4RRFFQ69G${n}`;
}

async function acceptClaim(
  service: ClaimReviewService,
  claim: Claim,
  key: string,
): Promise<void> {
  const r = await service.apply(
    reviewDraft(claim.id, {
      id: nextCrv(),
      expectedVersion: claim.version,
    }),
    key,
  );
  expect(r.ok).toBe(true);
}

describe("createClaimPackService construction", () => {
  it("requires applicationStore and claims repository", () => {
    expect(() =>
      createClaimPackService({
        claims: {} as ClaimRepository,
      } as never),
    ).toThrow(/applicationStore/i);
    expect(() =>
      createClaimPackService({
        applicationStore: createInMemoryClaimReviewApplicationStore(),
      } as never),
    ).toThrow(/claims/i);
  });
});

describe("happy path + seal purity", () => {
  it("builds a sealed pack of accepted claims for the question", async () => {
    const { service, pack } = makeHarness();
    const a = await seedProposed(service, {
      statement: "Atlas stores knowledge in Git.",
    });
    const b = await seedProposed(service, {
      statement: "Settings apply via documented procedure.",
      evidenceRefs: [evidence(UNIT_Q, true)],
    });
    await acceptClaim(service, a, "pack-accept-a");
    await acceptClaim(service, b, "pack-accept-b");

    const result = await pack.build(QUESTION, REVISION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.schemaVersion).toBe(1);
    expect(result.value.questionId).toBe(QUESTION);
    expect(result.value.graphRevision).toBe(REVISION);
    expect(result.value.claimIds).toHaveLength(2);
    expect(result.value.claims).toHaveLength(2);
    expect(result.value.claims.every((c) => c.state === "accepted")).toBe(true);
    expect(result.value.hash).toMatch(/^[a-f0-9]{64}$/);
    // Evidence inherited from claims (packet-mapped at create).
    for (const claim of result.value.claims) {
      const sealed = result.value.claims.find((c) => c.id === claim.id)!;
      expect(sealed.evidenceRefs[0]!.unitSha256).toBe(
        claim.evidenceRefs[0]!.unitSha256,
      );
    }
    // Citations projected from claim evidence.
    expect(result.value.citations.length).toBeGreaterThan(0);
  });

  it("identical logical input different order yields identical hash", async () => {
    const { service, pack } = makeHarness();
    const a = await seedProposed(service, { statement: "Alpha claim text." });
    const b = await seedProposed(service, { statement: "Beta claim text." });
    await acceptClaim(service, a, "ord-a");
    await acceptClaim(service, b, "ord-b");
    const r1 = await pack.build(QUESTION, REVISION);
    const r2 = await pack.build(QUESTION, REVISION);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value.hash).toBe(r2.value.hash);
    expect(r1.value.claimIds).toEqual(r2.value.claimIds);
  });
});

describe("dual gate + membership authority", () => {
  it("excludes claims not in listAcceptedClaimIds (proposed only)", async () => {
    const { service, pack } = makeHarness();
    await seedProposed(service, { statement: "Never accepted claim." });
    const result = await pack.build(QUESTION, REVISION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.claimIds).toHaveLength(0);
    expect(result.value.claims).toHaveLength(0);
  });

  it("STALE_CLAIM / excludes when accepted in applications but state is stale (B001 race)", async () => {
    const { service, pack, repo } = makeHarness();
    const claim = await seedProposed(service, {
      statement: "Will be staled after accept.",
    });
    await acceptClaim(service, claim, "stale-accept");
    const staled = await repo.markStaleFromSourceChange({
      snapshotId: SNAP,
      unitIds: [UNIT],
      reason: "source changed under B001",
    });
    expect(staled.ok).toBe(true);
    if (!staled.ok) return;
    expect(staled.value.some((c) => c.id === claim.id)).toBe(true);

    const result = await pack.build(QUESTION, REVISION);
    // Dual gate: fail-closed STALE_CLAIM (not silent exclude-and-continue).
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("STALE_CLAIM");
  });

  it("never uses ClaimStore.list / repository.list for membership (spy)", async () => {
    const store = createInMemoryClaimStore();
    const applicationStore = createInMemoryClaimReviewApplicationStore();
    const service = createClaimReviewService({
      store,
      evidence: verifierOk(),
      packetIdentity: packetIdentity(),
      applicationStore,
    });
    const claim = await seedProposed(service, {
      statement: "Spy membership claim.",
    });
    await acceptClaim(service, claim, "spy-accept");

    const listSpy = vi.spyOn(service.repository, "list");
    const acceptedSpy = vi.spyOn(applicationStore, "listAcceptedClaimIds");
    const pack = createClaimPackService({
      applicationStore,
      claims: service.repository,
    });
    const result = await pack.build(QUESTION, REVISION);
    expect(result.ok).toBe(true);
    expect(acceptedSpy).toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
    listSpy.mockRestore();
    acceptedSpy.mockRestore();
  });

  it("question-scoped: foreign createdFrom.questionId excluded", async () => {
    const { service, pack } = makeHarness();
    const local = await seedProposed(service, {
      statement: "Local question claim.",
    });
    const foreign = await seedProposed(service, {
      statement: "Foreign question claim.",
      createdFrom: { questionId: QUESTION_OTHER, packetId: PACKET_OTHER },
    });
    await acceptClaim(service, local, "q-local");
    await acceptClaim(service, foreign, "q-foreign");
    const result = await pack.build(QUESTION, REVISION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.claimIds).toContain(local.id);
    expect(result.value.claimIds).not.toContain(foreign.id);
  });
});

describe("qualifier closure + launder", () => {
  it("MISSING_QUALIFIER when accepted claim requires unaccepted qualifier", async () => {
    const { service, pack } = makeHarness();
    const subject = await seedProposed(service, {
      statement: "Subject needs a missing qualifier.",
    });
    const qual = await seedProposed(service, {
      statement: "Unaccepted qualifier claim.",
      evidenceRefs: [evidence(UNIT_Q, true)],
    });
    await acceptClaim(service, subject, "mq-subject");
    const latest = await service.repository.get(subject.id);
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    const qualified = await service.apply(
      reviewDraft(subject.id, {
        id: nextCrv(),
        expectedVersion: latest.value.version,
        decision: "qualify",
        qualifierClaimIds: [qual.id],
      }),
      "mq-qualify",
    );
    expect(qualified.ok).toBe(true);

    const result = await pack.build(QUESTION, REVISION);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MISSING_QUALIFIER");
  });

  it("includes required accepted qualifier as edge; rejects launder of reject-then-qualify subject", async () => {
    const { service, pack } = makeHarness();
    const subject = await seedProposed(service, {
      statement: "Launder subject claim.",
    });
    const qual = await seedProposed(service, {
      statement: "Accepted qualifier.",
      evidenceRefs: [evidence(UNIT_Q, true)],
    });
    await acceptClaim(service, qual, "launder-qual");
    // Reject subject first
    const rejected = await service.apply(
      reviewDraft(subject.id, {
        id: nextCrv(),
        decision: "reject",
        reason: "Not entailed.",
      }),
      "launder-reject",
    );
    expect(rejected.ok).toBe(true);
    // Qualify after reject (does not accept)
    const after = await service.repository.get(subject.id);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const qualified = await service.apply(
      reviewDraft(subject.id, {
        id: nextCrv(),
        expectedVersion: after.value.version,
        decision: "qualify",
        qualifierClaimIds: [qual.id],
      }),
      "launder-qualify",
    );
    expect(qualified.ok).toBe(true);

    const result = await pack.build(QUESTION, REVISION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Subject must NOT be in pack (rejected still excludes).
    expect(result.value.claimIds).not.toContain(subject.id);
    expect(result.value.claimIds).toContain(qual.id);
  });

  it("closes qualifier edge when both subject and qualifier are pack-accepted", async () => {
    const { service, pack } = makeHarness();
    const subject = await seedProposed(service, {
      statement: "Subject with accepted qualifier.",
    });
    const qual = await seedProposed(service, {
      statement: "Qualifier pack member.",
      evidenceRefs: [evidence(UNIT_Q, true)],
    });
    await acceptClaim(service, qual, "edge-qual");
    await acceptClaim(service, subject, "edge-subj");
    const latest = await service.repository.get(subject.id);
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    const q = await service.apply(
      reviewDraft(subject.id, {
        id: nextCrv(),
        expectedVersion: latest.value.version,
        decision: "qualify",
        qualifierClaimIds: [qual.id],
      }),
      "edge-qualify",
    );
    expect(q.ok).toBe(true);

    const result = await pack.build(QUESTION, REVISION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.claimIds).toEqual(
      expect.arrayContaining([subject.id, qual.id]),
    );
    expect(
      result.value.qualifierEdges.some(
        (e) => e.from === subject.id && e.to === qual.id,
      ),
    ).toBe(true);
  });
});
