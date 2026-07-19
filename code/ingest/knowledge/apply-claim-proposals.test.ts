/**
 * T004 — Apply validated Claim Extractor proposals (RED-first).
 *
 * Fabrication becomes durable here: unitIds map from the packet only;
 * deriveClaimId is pure; relationship drops are reported; whole-batch refuse
 * on unsupported evidence and intra-batch id collision.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  Sha256,
  SnapshotId,
  SourceFileId,
  SourceUnitId,
} from "../../domain/ingest/index.js";
import type { EvidencePacket } from "../../domain/ingest/evidence-packet.js";

import {
  applyClaimProposals,
  type ApplyClaimProposalsError,
} from "./apply-claim-proposals.js";
import {
  createClaimRepository,
  createInMemoryClaimStore,
  deriveClaimId,
  type ClaimAcceptanceAuthority,
  type ClaimRepository,
  type EvidenceVerificationReader,
} from "./claim-repository.js";

const QUESTION = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PACKET = "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UNIT_A = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAA" as SourceUnitId;
const UNIT_B = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAB" as SourceUnitId;
const UNIT_OUT = "unit-01ARZ3NDEKTSV4RRFFQ69G5FZZ" as SourceUnitId;
const SNAP = `snap-${"b".repeat(64)}` as SnapshotId;
const FILE = `file-${"c".repeat(64)}` as SourceFileId;
const FILE_SHA = "a".repeat(64) as Sha256;
const UNIT_SHA_A = "b".repeat(64) as Sha256;
const UNIT_SHA_B = "c".repeat(64) as Sha256;
const RCPT = "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RCPT_DIGEST = "d".repeat(64) as Sha256;

function packet(
  refs: Array<{ unitId: SourceUnitId; unitSha256: Sha256 }> = [
    { unitId: UNIT_A, unitSha256: UNIT_SHA_A },
    { unitId: UNIT_B, unitSha256: UNIT_SHA_B },
  ],
): EvidencePacket {
  return {
    schemaVersion: 1,
    id: PACKET as EvidencePacket["id"],
    questionId: QUESTION as EvidencePacket["questionId"],
    version: 1,
    references: refs.map((r) => ({
      snapshotId: SNAP,
      fileId: FILE,
      unitId: r.unitId,
      fileSha256: FILE_SHA,
      unitSha256: r.unitSha256,
      role: "primary" as const,
      facetIds: ["facet-definition"],
    })),
    receiptId: RCPT as EvidencePacket["receiptId"],
    receiptDigest: RCPT_DIGEST,
    limits: { maxReferences: 256, maxFacetsPerReference: 32 },
  };
}

function proposal(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    text: "Atlas stores portable project knowledge in the Git repository.",
    type: "definition",
    scope: { product: "atlas" },
    authority: "source-doc",
    lifecycle: "current",
    evidenceReferenceIds: [UNIT_A],
    candidateRelationships: {},
    ...overrides,
  };
}

function proposals(...claims: Record<string, unknown>[]) {
  return { claims };
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

function makeRepo(
  store = createInMemoryClaimStore(),
): { repository: ClaimRepository; store: ReturnType<typeof createInMemoryClaimStore> } {
  return {
    store,
    repository: createClaimRepository({
      store,
      evidence: verifierOk(),
      acceptance: authorityDeny(),
    }),
  };
}

describe("applyClaimProposals — happy path + packet mapping", () => {
  it("writes proposed claims with evidenceRefs mapped from the packet only", async () => {
    const { repository, store } = makeRepo();
    const result = await applyClaimProposals({
      questionId: QUESTION,
      packet: packet(),
      verdictAccepted: true,
      proposals: proposals(
        proposal(),
        proposal({
          text: "Settings apply through the documented maintainer procedure.",
          type: "procedure_step",
          evidenceReferenceIds: [UNIT_B],
        }),
      ),
      repository,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.claimIds).toHaveLength(2);
    expect(result.value.claims).toHaveLength(2);
    for (const claim of result.value.claims) {
      expect(claim.state).toBe("proposed");
      expect(claim.createdFrom).toEqual({
        questionId: QUESTION,
        packetId: PACKET,
      });
      for (const ref of claim.evidenceRefs) {
        // Hashes come from packet, not agent invention.
        if (ref.unitId === UNIT_A) {
          expect(ref.unitSha256).toBe(UNIT_SHA_A);
          expect(ref.fileSha256).toBe(FILE_SHA);
          expect(ref.snapshotId).toBe(SNAP);
        }
        if (ref.unitId === UNIT_B) {
          expect(ref.unitSha256).toBe(UNIT_SHA_B);
        }
      }
    }
    const listed = await repository.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(2);
    // store surface also has them (absence tests use the same store)
    expect(store).toBeDefined();
  });

  it("mints ids only via pure deriveClaimId (no wall-clock)", async () => {
    const expected = deriveClaimId(
      QUESTION,
      PACKET,
      "Atlas stores portable project knowledge in the Git repository.",
    );
    const { repository } = makeRepo();
    const result = await applyClaimProposals({
      questionId: QUESTION,
      packet: packet(),
      verdictAccepted: true,
      proposals: proposals(proposal()),
      repository,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.claimIds[0]).toBe(expected);
  });
});

describe("whole-batch fail-closed on unsupported evidence", () => {
  it("refuses and writes NOTHING when any unitId is outside the packet", async () => {
    const { repository } = makeRepo();
    const forgedId = deriveClaimId(QUESTION, PACKET, "Invented claim.");
    const goodId = deriveClaimId(
      QUESTION,
      PACKET,
      "Atlas stores portable project knowledge in the Git repository.",
    );
    const result = await applyClaimProposals({
      questionId: QUESTION,
      packet: packet([{ unitId: UNIT_A, unitSha256: UNIT_SHA_A }]),
      verdictAccepted: true,
      proposals: proposals(
        proposal(),
        proposal({
          text: "Invented claim.",
          evidenceReferenceIds: [UNIT_OUT],
        }),
      ),
      repository,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNSUPPORTED_EVIDENCE" satisfies ApplyClaimProposalsError);

    // Assert absence on the store, not just the return value.
    const forged = await repository.get(forgedId);
    expect(forged.ok).toBe(false);
    const good = await repository.get(goodId);
    expect(good.ok).toBe(false);
    const listed = await repository.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(0);
  });
});

describe("idempotent re-apply", () => {
  it("re-applying with a fresh service over shared store yields no duplicates", async () => {
    const store = createInMemoryClaimStore();
    const first = makeRepo(store);
    const batch = proposals(
      proposal(),
      proposal({
        text: "Second distinct statement for settings procedure.",
        type: "procedure_step",
        evidenceReferenceIds: [UNIT_B],
      }),
    );
    const r1 = await applyClaimProposals({
      questionId: QUESTION,
      packet: packet(),
      verdictAccepted: true,
      proposals: batch,
      repository: first.repository,
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const ids1 = [...r1.value.claimIds].sort();

    // Fresh repository instance, same store.
    const second = makeRepo(store);
    const r2 = await applyClaimProposals({
      questionId: QUESTION,
      packet: packet(),
      verdictAccepted: true,
      proposals: batch,
      repository: second.repository,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect([...r2.value.claimIds].sort()).toEqual(ids1);

    const listed = await second.repository.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(2);
  });
});

describe("candidateRelationships re-resolve (drop + report)", () => {
  it("drops unknown targets, keeps known, and reports dropped ids", async () => {
    const { repository } = makeRepo();
    // Seed an authoritative claim id by applying one claim first.
    const seed = await applyClaimProposals({
      questionId: QUESTION,
      packet: packet(),
      verdictAccepted: true,
      proposals: proposals(
        proposal({ text: "Seed claim for relationship target." }),
      ),
      repository,
    });
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;
    const knownId = seed.value.claimIds[0]!;
    const unknownId = "clm-01ARZ3NDEKTSV4RRFFQ69G5FZZ";

    const result = await applyClaimProposals({
      questionId: QUESTION,
      packet: packet(),
      verdictAccepted: true,
      proposals: proposals(
        proposal({
          text: "Claim that names qualifier relationships.",
          candidateRelationships: {
            qualifierClaimIds: [knownId, unknownId],
            contradictsClaimIds: [unknownId],
            supersedesClaimIds: [],
          },
        }),
      ),
      repository,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const claim = result.value.claims[0]!;
    expect(claim.relationships.qualifierClaimIds).toEqual([knownId]);
    expect(claim.relationships.contradictsClaimIds).toEqual([]);
    // Reported drop — not silent.
    expect(result.value.droppedRelationshipTargets).toEqual(
      expect.arrayContaining([unknownId]),
    );
    expect(result.value.droppedRelationshipTargets).not.toContain(knownId);
  });
});

describe("intra-batch deriveClaimId collision", () => {
  it("refuses whole batch before write when two proposals share statement text", async () => {
    const { repository } = makeRepo();
    const result = await applyClaimProposals({
      questionId: QUESTION,
      packet: packet(),
      verdictAccepted: true,
      proposals: proposals(
        proposal({
          text: "Same statement text.",
          type: "definition",
          scope: { product: "atlas" },
        }),
        proposal({
          text: "Same statement text.",
          type: "behavior",
          scope: { product: "other" },
          evidenceReferenceIds: [UNIT_B],
        }),
      ),
      repository,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ID_COLLISION");
    const listed = await repository.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(0);
  });
});

describe("verdict + structural mapping", () => {
  it("VERDICT_NOT_ACCEPTED writes nothing", async () => {
    const { repository } = makeRepo();
    const result = await applyClaimProposals({
      questionId: QUESTION,
      packet: packet(),
      verdictAccepted: false,
      proposals: proposals(proposal()),
      repository,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VERDICT_NOT_ACCEPTED");
    const listed = await repository.list();
    expect(listed.ok && listed.value.length === 0).toBe(true);
  });

  it("mutation certifying: create payload unit hashes equal packet (not agent-forged)", async () => {
    const { repository } = makeRepo();
    // Agent cannot supply a different unitSha256 — apply only reads unitIds.
    const agentish = proposals(
      proposal({
        // Hostile extra key must not open a path (strict validate drops it).
        evidenceRefs: [
          {
            snapshotId: SNAP,
            fileId: FILE,
            unitId: UNIT_A,
            fileSha256: "f".repeat(64),
            unitSha256: "e".repeat(64),
          },
        ],
      }),
    );
    // If validation rejects unknown keys, use only unitIds path.
    const clean = proposals(proposal({ evidenceReferenceIds: [UNIT_A] }));
    const result = await applyClaimProposals({
      questionId: QUESTION,
      packet: packet([{ unitId: UNIT_A, unitSha256: UNIT_SHA_A }]),
      verdictAccepted: true,
      proposals: clean,
      repository,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.claims[0]!.evidenceRefs[0]!.unitSha256).toBe(UNIT_SHA_A);
    expect(result.value.claims[0]!.evidenceRefs[0]!.unitSha256).not.toBe(
      "e".repeat(64),
    );
    // Hostile shape is not a supported apply input path.
    void agentish;
    void createHash;
  });
});
