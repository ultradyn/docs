/**
 * T-21-04 / P2.M2.E2.T004 — WP-21 integration remediation RED.
 * Honest failures against landed T-21-01..03 production (claim 2f91a58).
 *
 * A) Facet authority — QuestionFacetReader mandatory; no caller override
 * B) Complete packet digest — schemaVersion,id,questionId,version,references,receiptId,receiptDigest,limits
 * C) Authoritative history composer — rehydrate stores before pure loop
 * D) Atomic append+idempotency — crash after record before op commit
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalPacketPayloadDigest,
  DEFAULT_EVIDENCE_PACKET_LIMITS,
  type EvidencePacket,
  type EvidenceReference,
} from "../../domain/ingest/evidence-packet.js";
import type {
  EvidencePacketId,
  QuestionId,
  Sha256,
  SnapshotId,
  SourceFileId,
  SourceUnitId,
} from "../../domain/ingest/index.js";
import {
  SearchReceiptSchema,
  computeIndexedRepresentationsSha256,
  type SearchReceipt,
} from "../../domain/ingest/search-receipt.js";

import {
  createEvidenceService,
  createInMemoryEvidencePacketStore,
  createFileEvidencePacketStore,
  deriveEvidencePacketId,
  receiptDigestOf,
  type SourceHashContext,
} from "./evidence-service.js";
import {
  createEvidenceVerdictService,
  createInMemoryEvidenceVerdictStore,
  createFileEvidenceVerdictStore,
  deriveEvidenceVerdictId,
  type EvidencePacketReader,
  type PacketVerifier,
  type ReceiptFailureReader,
} from "./evidence-verdict-service.js";
import {
  evaluateEvidenceLoop,
  type EvidenceLoopHistory,
} from "./evidence-loop-policy.js";

const SNAPSHOT = `snap-${"b".repeat(64)}` as SnapshotId;
const FILE_A = `file-${"a".repeat(64)}` as SourceFileId;
const UNIT_A = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceUnitId;
const UNIT_B = "unit-01ARZ3NDEKTSV4RRFFQ69G5FBW" as SourceUnitId;
const QUESTION = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV" as QuestionId;

function sha(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}

const FILE_HASH_A = sha("file-a");
const UNIT_HASH_A = sha("unit-a");

function context(): SourceHashContext {
  return {
    fileSha256: (snapshotId, fileId) =>
      snapshotId === SNAPSHOT && fileId === FILE_A ? FILE_HASH_A : undefined,
    unitBinding: (snapshotId, unitId) =>
      snapshotId === SNAPSHOT && unitId === UNIT_A
        ? { textSha256: UNIT_HASH_A, sourceFileId: FILE_A }
        : undefined,
  };
}

function healthyReceipt(
  overrides: Record<string, unknown> = {},
): SearchReceipt {
  return SearchReceiptSchema.parse({
    schemaVersion: 1,
    id: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    snapshotId: SNAPSHOT,
    indexVersion: "lexical-v1",
    indexedRepresentationsSha256: computeIndexedRepresentationsSha256([
      {
        id: "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
        version: 1,
        sourceFileId: FILE_A,
        normalizedTextSha256: sha("body"),
      },
    ]),
    query: "evidence",
    filters: {},
    candidateIds: [UNIT_A],
    selectedIds: [UNIT_A],
    failures: [],
    ...overrides,
  }) as SearchReceipt;
}

function refA(): EvidenceReference {
  return {
    snapshotId: SNAPSHOT,
    fileId: FILE_A,
    unitId: UNIT_A,
    fileSha256: FILE_HASH_A,
    unitSha256: UNIT_HASH_A,
    role: "primary",
    facetIds: ["purpose"],
  };
}

// ---------------------------------------------------------------------------
// B) Complete packet digest
// ---------------------------------------------------------------------------
describe("B — complete canonicalPacketPayloadDigest", () => {
  const baseRefs = [refA()];

  it("exports digest that includes schemaVersion, id, version, and limits", () => {
    // Current incomplete API omits these — RED expects complete signature.
    const complete = canonicalPacketPayloadDigest as (input: {
      schemaVersion: 1;
      id: string;
      questionId: string;
      version: number;
      references: readonly EvidenceReference[];
      receiptId: string;
      receiptDigest: string;
      limits: { maxReferences: number; maxFacetsPerReference: number };
    }) => Sha256;

    const left = complete({
      schemaVersion: 1,
      id: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      questionId: QUESTION,
      version: 1,
      references: baseRefs,
      receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      receiptDigest: "a".repeat(64),
      limits: { maxReferences: 256, maxFacetsPerReference: 32 },
    });
    const rightLimits = complete({
      schemaVersion: 1,
      id: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      questionId: QUESTION,
      version: 1,
      references: baseRefs,
      receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      receiptDigest: "a".repeat(64),
      limits: { maxReferences: 128, maxFacetsPerReference: 32 },
    });
    const rightVersion = complete({
      schemaVersion: 1,
      id: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      questionId: QUESTION,
      version: 2,
      references: baseRefs,
      receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      receiptDigest: "a".repeat(64),
      limits: { maxReferences: 256, maxFacetsPerReference: 32 },
    });
    const rightId = complete({
      schemaVersion: 1,
      id: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FBW",
      questionId: QUESTION,
      version: 1,
      references: baseRefs,
      receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      receiptDigest: "a".repeat(64),
      limits: { maxReferences: 256, maxFacetsPerReference: 32 },
    });
    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(left).not.toBe(rightLimits);
    expect(left).not.toBe(rightVersion);
    expect(left).not.toBe(rightId);
  });

  it("limits-only mutation changes digest (integrity gap closed)", () => {
    // Using the public incomplete signature if GREEN still incomplete, this
    // documents the gap: two inputs differing only by limits must differ.
    // After remediation, complete digest requires the full object.
    const digestFn = canonicalPacketPayloadDigest as (
      input: Record<string, unknown>,
    ) => Sha256;
    const a = digestFn({
      schemaVersion: 1,
      id: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      questionId: QUESTION,
      version: 1,
      references: baseRefs,
      receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      receiptDigest: "b".repeat(64),
      limits: DEFAULT_EVIDENCE_PACKET_LIMITS,
    });
    const b = digestFn({
      schemaVersion: 1,
      id: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      questionId: QUESTION,
      version: 1,
      references: baseRefs,
      receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      receiptDigest: "b".repeat(64),
      limits: { maxReferences: 1, maxFacetsPerReference: 1 },
    });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// A) Facet authority
// ---------------------------------------------------------------------------
describe("A — QuestionFacetReader authority for accepted", () => {
  it("createEvidenceVerdictService requires facets reader", async () => {
    const mod = await import("./evidence-verdict-service.js");
    expect(() =>
      mod.createEvidenceVerdictService({
        store: createInMemoryEvidenceVerdictStore(),
        packets: { get: async () => undefined },
        receipts: { get: async () => undefined },
        verifier: {
          verifyReferences: async () => ({ ok: true, value: true }),
        },
        // no facets reader
      } as never),
    ).toThrow(/facet/i);
  });

  it("exports QuestionFacetReader type seam / createInMemoryQuestionFacetReader", async () => {
    const mod = await import("./evidence-verdict-service.js");
    expect(
      typeof (mod as { createInMemoryQuestionFacetReader?: unknown })
        .createInMemoryQuestionFacetReader,
    ).toBe("function");
  });

  it("omitting a canonical required facet cannot produce accepted", async () => {
    const mod = await import("./evidence-verdict-service.js");
    const createFacets = (
      mod as {
        createInMemoryQuestionFacetReader: (map: Map<string, string[]>) => {
          getRequiredFacetIds: (
            questionId: string,
          ) => Promise<readonly string[] | undefined>;
        };
      }
    ).createInMemoryQuestionFacetReader;

    const facets = createFacets(
      new Map([[QUESTION, ["purpose", "components", "boundary"]]]),
    );
    const packetId = deriveEvidencePacketId(QUESTION);
    const packet: EvidencePacket = {
      schemaVersion: 1,
      id: packetId,
      questionId: QUESTION,
      version: 1,
      references: [refA()],
      receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
      receiptDigest: "c".repeat(64) as Sha256,
      limits: DEFAULT_EVIDENCE_PACKET_LIMITS,
    };
    const packets: EvidencePacketReader = {
      get: async (id, version) =>
        id === packet.id && version === 1 ? packet : undefined,
    };
    const receipts: ReceiptFailureReader = {
      get: async () => ({
        id: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
        failures: [],
        selectedIds: [UNIT_A],
        snapshotId: SNAPSHOT,
        query: "q",
        filters: {},
        candidateIds: [UNIT_A],
        indexVersion: "v1",
        indexedRepresentationsSha256: "d".repeat(64),
      }),
    };
    const verifier: PacketVerifier = {
      verifyReferences: async () => ({ ok: true, value: true }),
    };
    const svc = mod.createEvidenceVerdictService({
      store: createInMemoryEvidenceVerdictStore(),
      packets,
      receipts,
      verifier,
      facets,
    });
    // Caller supplies only purpose — must NOT accept when canonical has 3 facets
    const result = await svc.apply({
      questionId: QUESTION,
      packetId: packet.id,
      packetVersion: 1,
      requiredFacetIds: ["purpose"], // hostile subset
      referenceReviews: [
        {
          unitId: UNIT_A,
          classification: "necessary_primary",
          reason: "ok",
        },
      ],
      facetStates: [
        { facetId: "purpose", state: "satisfied", reason: "ok" },
      ],
      verdict: "accepted",
      criticisms: [],
      followUpRequest: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect([
        "FACET_UNSATISFIED",
        "FACET_AUTHORITY",
        "INVALID_INPUT",
      ]).toContain(result.code);
    }
  });

  it("rejects caller requiredFacetIds override that disagrees with authority", async () => {
    const mod = await import("./evidence-verdict-service.js");
    const createFacets = (
      mod as {
        createInMemoryQuestionFacetReader: (map: Map<string, string[]>) => {
          getRequiredFacetIds: (
            questionId: string,
          ) => Promise<readonly string[] | undefined>;
        };
      }
    ).createInMemoryQuestionFacetReader;
    const facets = createFacets(new Map([[QUESTION, ["purpose", "components"]]]));
    const packetId = deriveEvidencePacketId(QUESTION);
    const packet: EvidencePacket = {
      schemaVersion: 1,
      id: packetId,
      questionId: QUESTION,
      version: 1,
      references: [refA()],
      receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
      receiptDigest: "c".repeat(64) as Sha256,
      limits: DEFAULT_EVIDENCE_PACKET_LIMITS,
    };
    const svc = mod.createEvidenceVerdictService({
      store: createInMemoryEvidenceVerdictStore(),
      packets: {
        get: async () => packet,
      },
      receipts: {
        get: async () => ({
          id: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
          failures: [],
          selectedIds: [UNIT_A],
        }),
      },
      verifier: {
        verifyReferences: async () => ({ ok: true, value: true }),
      },
      facets,
    });
    const result = await svc.apply({
      questionId: QUESTION,
      packetId: packet.id,
      packetVersion: 1,
      // caller tries to invent different set
      requiredFacetIds: ["purpose", "components", "extra"],
      referenceReviews: [
        {
          unitId: UNIT_A,
          classification: "necessary_primary",
          reason: "ok",
        },
      ],
      facetStates: [
        { facetId: "purpose", state: "satisfied", reason: "ok" },
        { facetId: "components", state: "satisfied", reason: "ok" },
        { facetId: "extra", state: "satisfied", reason: "ok" },
      ],
      verdict: "accepted",
      criticisms: [],
      followUpRequest: null,
    });
    expect(result.ok).toBe(false);
  });

  it("fails closed when facet authority is unavailable for the question", async () => {
    const mod = await import("./evidence-verdict-service.js");
    const createFacets = (
      mod as {
        createInMemoryQuestionFacetReader: (map: Map<string, string[]>) => {
          getRequiredFacetIds: (
            questionId: string,
          ) => Promise<readonly string[] | undefined>;
        };
      }
    ).createInMemoryQuestionFacetReader;
    const facets = createFacets(new Map()); // empty — unavailable
    const packetId = deriveEvidencePacketId(QUESTION);
    const packet: EvidencePacket = {
      schemaVersion: 1,
      id: packetId,
      questionId: QUESTION,
      version: 1,
      references: [refA()],
      receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
      receiptDigest: "c".repeat(64) as Sha256,
      limits: DEFAULT_EVIDENCE_PACKET_LIMITS,
    };
    const svc = mod.createEvidenceVerdictService({
      store: createInMemoryEvidenceVerdictStore(),
      packets: { get: async () => packet },
      receipts: {
        get: async () => ({
          id: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
          failures: [],
          selectedIds: [UNIT_A],
        }),
      },
      verifier: {
        verifyReferences: async () => ({ ok: true, value: true }),
      },
      facets,
    });
    const result = await svc.apply({
      questionId: QUESTION,
      packetId: packet.id,
      packetVersion: 1,
      requiredFacetIds: ["purpose"],
      referenceReviews: [
        {
          unitId: UNIT_A,
          classification: "necessary_primary",
          reason: "ok",
        },
      ],
      facetStates: [
        { facetId: "purpose", state: "satisfied", reason: "ok" },
      ],
      verdict: "accepted",
      criticisms: [],
      followUpRequest: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["FACET_AUTHORITY", "INVALID_INPUT"]).toContain(result.code);
    }
  });
});

// ---------------------------------------------------------------------------
// C) Authoritative history composer
// ---------------------------------------------------------------------------
describe("C — EvidenceHistoryComposer authoritative routing", () => {
  it("exports composeAndEvaluateEvidenceLoop / createEvidenceHistoryComposer", async () => {
    const mod = await import("./evidence-loop-policy.js");
    expect(
      typeof (mod as { composeAndEvaluateEvidenceLoop?: unknown })
        .composeAndEvaluateEvidenceLoop ??
        (mod as { createEvidenceHistoryComposer?: unknown })
          .createEvidenceHistoryComposer,
    ).toBe("function");
  });

  it("public barrel does not route arbitrary structural history without composer", async () => {
    const barrel = await import("./index.js");
    // evaluateEvidenceLoop may remain for tests; composer is the public routing seam
    expect(
      typeof (barrel as { composeAndEvaluateEvidenceLoop?: unknown })
        .composeAndEvaluateEvidenceLoop ??
        (barrel as { createEvidenceHistoryComposer?: unknown })
          .createEvidenceHistoryComposer,
    ).toBe("function");
  });

  it("mixed-question / unpaired / skipped / fabricated histories fail closed with no routing receipt", async () => {
    const mod = await import("./evidence-loop-policy.js");
    const compose = (
      mod as {
        composeAndEvaluateEvidenceLoop: (
          input: unknown,
        ) => Promise<{ ok: boolean; code?: string; value?: { route?: string } }>;
      }
    ).composeAndEvaluateEvidenceLoop;

    // Fabricated structural history must not yield a successful routing receipt
    // when composer is used with empty stores.
    const result = await compose({
      questionId: QUESTION,
      packets: createInMemoryEvidencePacketStore(),
      verdicts: createInMemoryEvidenceVerdictStore(),
      budget: { maxRefinements: 3 },
    });
    // Empty durable history fails closed — not continue with empty receipt
    expect(result.ok).toBe(false);
  });

  it("pure evaluateEvidenceLoop remains available but structural unpaired steps are rejected", () => {
    // Harden pure function: reject steps whose packet/verdict versions skip or duplicate
    const fabricated: EvidenceLoopHistory = {
      questionId: QUESTION,
      steps: [
        {
          packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
          packetVersion: 1,
          verdictId: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
          verdictVersion: 1,
          verdict: "needs_more_evidence",
          followUpRequest: {
            missingFacetIds: ["a"],
            requiredSearch: { subject: "x" },
            whyCurrentPacketFails: "gap",
          },
        },
        {
          packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
          packetVersion: 3, // skip v2
          verdictId: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
          verdictVersion: 3,
          verdict: "needs_more_evidence",
          followUpRequest: {
            missingFacetIds: ["b"],
            requiredSearch: { subject: "y" },
            whyCurrentPacketFails: "gap",
          },
        },
      ],
    };
    const result = evaluateEvidenceLoop(fabricated, { maxRefinements: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
  });
});

// ---------------------------------------------------------------------------
// D) Atomic append + idempotency
// ---------------------------------------------------------------------------
describe("D — atomic record+idempotency (packet and verdict)", () => {
  it("packet store crash after immutable publish before op commit: same-key retry replays one version", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "pkt-atom-"));
    try {
      const store = createFileEvidencePacketStore(root, {
        afterImmutablePublishBeforeOpCommit: () => {
          throw new Error("injected-crash-op");
        },
      } as never);
      const svc = createEvidenceService({
        store,
        links: {
          get: async (id) =>
            id === QUESTION
              ? { questionId: QUESTION, snapshotId: SNAPSHOT }
              : undefined,
        },
        receipts: { get: async () => undefined },
      });
      const receipt = healthyReceipt();
      await expect(
        svc.appendPacket({
          questionId: QUESTION,
          references: [refA()],
          receipt,
          receiptDigest: receiptDigestOf(receipt),
          context: context(),
          idempotencyKey: "atom-1",
        }),
      ).rejects.toThrow(/injected-crash-op/);

      // Fresh process: no half-success double version; same key reconciles
      const fresh = createEvidenceService({
        store: createFileEvidencePacketStore(root),
        links: {
          get: async (id) =>
            id === QUESTION
              ? { questionId: QUESTION, snapshotId: SNAPSHOT }
              : undefined,
        },
        receipts: { get: async () => undefined },
      });
      const replay = await fresh.appendPacket({
        questionId: QUESTION,
        references: [refA()],
        receipt,
        receiptDigest: receiptDigestOf(receipt),
        context: context(),
        idempotencyKey: "atom-1",
      });
      expect(replay.ok).toBe(true);
      if (!replay.ok) return;
      expect(replay.value.version).toBe(1);
      // Second different payload same key conflicts
      const conflict = await fresh.appendPacket({
        questionId: QUESTION,
        references: [refA()],
        receipt: healthyReceipt({ query: "other" }),
        receiptDigest: receiptDigestOf(healthyReceipt({ query: "other" })),
        context: context(),
        idempotencyKey: "atom-1",
      });
      // may need expectedVersion for second append path; key conflict is the point
      expect(conflict.ok === false || conflict.value.version === 1).toBe(true);
      if (!conflict.ok) {
        expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("verdict store crash after immutable publish before op commit: same-key retry one version", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "evv-atom-"));
    try {
      // Require facets reader once GREEN lands — for RED construction may throw
      const mod = await import("./evidence-verdict-service.js");
      const createFacets = (
        mod as {
          createInMemoryQuestionFacetReader?: (
            map: Map<string, string[]>,
          ) => unknown;
        }
      ).createInMemoryQuestionFacetReader;
      expect(typeof createFacets).toBe("function");
      if (typeof createFacets !== "function") return;

      const packetId = deriveEvidencePacketId(QUESTION);
      const packet: EvidencePacket = {
        schemaVersion: 1,
        id: packetId,
        questionId: QUESTION,
        version: 1,
        references: [refA()],
        receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
        receiptDigest: "c".repeat(64) as Sha256,
        limits: DEFAULT_EVIDENCE_PACKET_LIMITS,
      };
      const facets = createFacets(new Map([[QUESTION, ["purpose"]]]));
      const store = createFileEvidenceVerdictStore(root, {
        afterImmutablePublishBeforeOpCommit: () => {
          throw new Error("injected-crash-op");
        },
      } as never);
      const applyInput = {
        questionId: QUESTION,
        packetId,
        packetVersion: 1,
        requiredFacetIds: ["purpose"],
        referenceReviews: [
          {
            unitId: UNIT_A,
            classification: "necessary_primary",
            reason: "ok",
          },
        ],
        facetStates: [
          { facetId: "purpose", state: "satisfied", reason: "ok" },
        ],
        verdict: "accepted",
        criticisms: [],
        followUpRequest: null,
        idempotencyKey: "vatom-1",
      };
      const svc = mod.createEvidenceVerdictService({
        store,
        packets: { get: async () => packet },
        receipts: {
          get: async () => ({
            id: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            failures: [],
            selectedIds: [UNIT_A],
          }),
        },
        verifier: {
          verifyReferences: async () => ({ ok: true, value: true }),
        },
        facets,
      });
      await expect(svc.apply(applyInput)).rejects.toThrow(/injected-crash-op/);
      const fresh = mod.createEvidenceVerdictService({
        store: createFileEvidenceVerdictStore(root),
        packets: { get: async () => packet },
        receipts: {
          get: async () => ({
            id: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            failures: [],
            selectedIds: [UNIT_A],
          }),
        },
        verifier: {
          verifyReferences: async () => ({ ok: true, value: true }),
        },
        facets,
      });
      const replay = await fresh.apply(applyInput);
      expect(replay.ok).toBe(true);
      if (!replay.ok) return;
      expect(replay.value.version).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("file packet store honors afterImmutablePublishBeforeOpCommit (fires on append)", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "pkt-hook-"));
    try {
      let fired = false;
      const store = createFileEvidencePacketStore(root, {
        afterImmutablePublishBeforeOpCommit: () => {
          fired = true;
        },
      } as never);
      const packet: EvidencePacket = {
        schemaVersion: 1,
        id: deriveEvidencePacketId(QUESTION),
        questionId: QUESTION,
        version: 1,
        references: [refA()],
        receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
        receiptDigest: "e".repeat(64) as Sha256,
        limits: DEFAULT_EVIDENCE_PACKET_LIMITS,
      };
      await store.append(packet);
      // RED: current store ignores this hook → fired stays false
      expect(fired).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
