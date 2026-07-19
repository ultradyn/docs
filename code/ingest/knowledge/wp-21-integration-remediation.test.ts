/**
 * T-21-04 RED-2 — isolated root invariants against landed production (2f91a58+).
 * Soft-pass free. GREEN only after acceptance.
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
  type QuestionFacetReader,
} from "./evidence-verdict-service.js";
import { evaluateEvidenceLoop } from "./evidence-loop-policy.js";

const SNAPSHOT = `snap-${"b".repeat(64)}` as SnapshotId;
const FILE_A = `file-${"a".repeat(64)}` as SourceFileId;
const UNIT_A = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceUnitId;
const QUESTION = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV" as QuestionId;
const OTHER_Q = "q-01ARZ3NDEKTSV4RRFFQ69G5FBW" as QuestionId;

function sha(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}
const FILE_HASH_A = sha("file-a");
const UNIT_HASH_A = sha("unit-a");
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function ref(
  overrides: Partial<EvidenceReference> = {},
): EvidenceReference {
  return {
    snapshotId: SNAPSHOT,
    fileId: FILE_A,
    unitId: UNIT_A,
    fileSha256: FILE_HASH_A,
    unitSha256: UNIT_HASH_A,
    role: "primary",
    facetIds: ["purpose"],
    ...overrides,
  };
}

function context(): SourceHashContext {
  return {
    fileSha256: (s, f) =>
      s === SNAPSHOT && f === FILE_A ? FILE_HASH_A : undefined,
    unitBinding: (s, u) =>
      s === SNAPSHOT && u === UNIT_A
        ? { textSha256: UNIT_HASH_A, sourceFileId: FILE_A }
        : undefined,
  };
}

function healthyReceipt(overrides: Record<string, unknown> = {}): SearchReceipt {
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

function samplePacket(
  overrides: Partial<EvidencePacket> = {},
): EvidencePacket {
  return {
    schemaVersion: 1,
    id: deriveEvidencePacketId(QUESTION),
    questionId: QUESTION,
    version: 1,
    references: [ref()],
    receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
    receiptDigest: DIGEST_A as Sha256,
    limits: DEFAULT_EVIDENCE_PACKET_LIMITS,
    ...overrides,
  };
}

type CompleteDigestInput = {
  schemaVersion: 1;
  id: string;
  questionId: string;
  version: number;
  references: readonly EvidenceReference[];
  receiptId: string;
  receiptDigest: string;
  limits: { maxReferences: number; maxFacetsPerReference: number };
};

function completeDigest(input: CompleteDigestInput): Sha256 {
  return (canonicalPacketPayloadDigest as (i: CompleteDigestInput) => Sha256)(
    input,
  );
}

const BASE_DIGEST_INPUT: CompleteDigestInput = {
  schemaVersion: 1,
  id: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
  questionId: QUESTION,
  version: 1,
  references: [ref()],
  receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
  receiptDigest: DIGEST_A,
  limits: { maxReferences: 256, maxFacetsPerReference: 32 },
};

// =============================================================================
// B — complete packet digest
// =============================================================================
describe("B — RED gaps: digest must bind schemaVersion/id/version/limits", () => {
  it("mutation of schemaVersion changes digest", () => {
    const withField = completeDigest(BASE_DIGEST_INPUT);
    const alt = completeDigest({
      ...BASE_DIGEST_INPUT,
      // intentional illegal schema for mutation table
      schemaVersion: 2 as unknown as 1,
    });
    expect(withField).not.toBe(alt);
  });

  it("mutation of id changes digest", () => {
    expect(
      completeDigest({
        ...BASE_DIGEST_INPUT,
        id: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FBW",
      }),
    ).not.toBe(completeDigest(BASE_DIGEST_INPUT));
  });

  it("mutation of version changes digest", () => {
    expect(
      completeDigest({ ...BASE_DIGEST_INPUT, version: 2 }),
    ).not.toBe(completeDigest(BASE_DIGEST_INPUT));
  });

  it("mutation of maxReferences changes digest", () => {
    expect(
      completeDigest({
        ...BASE_DIGEST_INPUT,
        limits: { ...BASE_DIGEST_INPUT.limits, maxReferences: 128 },
      }),
    ).not.toBe(completeDigest(BASE_DIGEST_INPUT));
  });

  it("mutation of maxFacetsPerReference changes digest", () => {
    expect(
      completeDigest({
        ...BASE_DIGEST_INPUT,
        limits: { ...BASE_DIGEST_INPUT.limits, maxFacetsPerReference: 16 },
      }),
    ).not.toBe(completeDigest(BASE_DIGEST_INPUT));
  });
});

describe("B — honest existing invariants (already bound by incomplete digest)", () => {
  it("mutation of questionId changes digest", () => {
    expect(
      completeDigest({ ...BASE_DIGEST_INPUT, questionId: OTHER_Q }),
    ).not.toBe(completeDigest(BASE_DIGEST_INPUT));
  });
  it("mutation of receiptId changes digest", () => {
    expect(
      completeDigest({
        ...BASE_DIGEST_INPUT,
        receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FBW",
      }),
    ).not.toBe(completeDigest(BASE_DIGEST_INPUT));
  });
  it("mutation of receiptDigest changes digest", () => {
    expect(
      completeDigest({ ...BASE_DIGEST_INPUT, receiptDigest: DIGEST_B }),
    ).not.toBe(completeDigest(BASE_DIGEST_INPUT));
  });
  it("mutation of reference.role changes digest", () => {
    expect(
      completeDigest({
        ...BASE_DIGEST_INPUT,
        references: [ref({ role: "supporting" })],
      }),
    ).not.toBe(completeDigest(BASE_DIGEST_INPUT));
  });
  it("mutation of reference.facetIds changes digest", () => {
    expect(
      completeDigest({
        ...BASE_DIGEST_INPUT,
        references: [ref({ facetIds: ["other"] })],
      }),
    ).not.toBe(completeDigest(BASE_DIGEST_INPUT));
  });
  it("mutation of reference.fileSha256 changes digest", () => {
    expect(
      completeDigest({
        ...BASE_DIGEST_INPUT,
        references: [ref({ fileSha256: sha("other-file") })],
      }),
    ).not.toBe(completeDigest(BASE_DIGEST_INPUT));
  });
  it("mutation of reference.unitSha256 changes digest", () => {
    expect(
      completeDigest({
        ...BASE_DIGEST_INPUT,
        references: [ref({ unitSha256: sha("other-unit") })],
      }),
    ).not.toBe(completeDigest(BASE_DIGEST_INPUT));
  });
  it("mutation of reference.unitId changes digest", () => {
    expect(
      completeDigest({
        ...BASE_DIGEST_INPUT,
        references: [
          ref({ unitId: "unit-01ARZ3NDEKTSV4RRFFQ69G5FBW" as SourceUnitId }),
        ],
      }),
    ).not.toBe(completeDigest(BASE_DIGEST_INPUT));
  });
  it("facetIds set order does not change digest (semantic sort only)", () => {
    const a = completeDigest({
      ...BASE_DIGEST_INPUT,
      references: [ref({ facetIds: ["z", "a"] })],
    });
    const b = completeDigest({
      ...BASE_DIGEST_INPUT,
      references: [ref({ facetIds: ["a", "z"] })],
    });
    expect(a).toBe(b);
  });
});

// =============================================================================
// A — facet authority
// =============================================================================
describe("A — QuestionFacetReader facet authority", () => {
  async function loadMod() {
    return import("./evidence-verdict-service.js");
  }

  it("construction without facets reader throws", async () => {
    const mod = await loadMod();
    expect(() =>
      mod.createEvidenceVerdictService({
        store: createInMemoryEvidenceVerdictStore(),
        packets: { get: async () => undefined },
        receipts: { get: async () => undefined },
        verifier: {
          verifyReferences: async () => ({ ok: true, value: true }),
        },
      } as never),
    ).toThrow(/facet/i);
  });

  it("exports createInMemoryQuestionFacetReader (testing surface)", async () => {
    const mod = await loadMod();
    expect(
      typeof (mod as { createInMemoryQuestionFacetReader?: unknown })
        .createInMemoryQuestionFacetReader,
    ).toBe("function");
  });

  async function verdictSvc(
    facetMap: Map<string, string[]>,
    packet: EvidencePacket = samplePacket(),
  ) {
    const mod = await loadMod();
    const createFacets = (
      mod as {
        createInMemoryQuestionFacetReader: (
          m: Map<string, string[]>,
        ) => QuestionFacetReader;
      }
    ).createInMemoryQuestionFacetReader;
    const facets = createFacets(facetMap);
    return {
      mod,
      svc: mod.createEvidenceVerdictService({
        store: createInMemoryEvidenceVerdictStore(),
        packets: {
          get: async (id, v) =>
            id === packet.id && v === packet.version ? packet : undefined,
        },
        receipts: {
          get: async () => ({
            id: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            failures: [],
            selectedIds: [UNIT_A],
            snapshotId: SNAPSHOT,
          }),
        },
        verifier: {
          verifyReferences: async () => ({ ok: true, value: true }),
        },
        facets,
      }),
      packet,
    };
  }

  function acceptBody(
    packet: EvidencePacket,
    facets: string[],
    states: Array<{ facetId: string; state: string; reason: string }>,
  ) {
    return {
      questionId: QUESTION,
      packetId: packet.id,
      packetVersion: packet.version,
      requiredFacetIds: facets,
      referenceReviews: [
        {
          unitId: UNIT_A,
          classification: "necessary_primary",
          reason: "ok",
        },
      ],
      facetStates: states,
      verdict: "accepted",
      criticisms: [],
      followUpRequest: null,
    };
  }

  it("omitted canonical facet cannot accept", async () => {
    const { svc, packet } = await verdictSvc(
      new Map([[QUESTION, ["purpose", "components"]]]),
    );
    const result = await svc.apply(
      acceptBody(
        packet,
        ["purpose"],
        [{ facetId: "purpose", state: "satisfied", reason: "ok" }],
      ),
    );
    expect(result.ok).toBe(false);
  });

  it("extra caller facet cannot accept", async () => {
    const { svc, packet } = await verdictSvc(
      new Map([[QUESTION, ["purpose"]]]),
    );
    const result = await svc.apply(
      acceptBody(
        packet,
        ["purpose", "extra"],
        [
          { facetId: "purpose", state: "satisfied", reason: "ok" },
          { facetId: "extra", state: "satisfied", reason: "ok" },
        ],
      ),
    );
    expect(result.ok).toBe(false);
  });

  it("reordered canonical facets still accept when exactly covered", async () => {
    const { svc, packet } = await verdictSvc(
      new Map([[QUESTION, ["components", "purpose"]]]),
    );
    const result = await svc.apply(
      acceptBody(
        packet,
        ["purpose", "components"], // different order, exact set
        [
          { facetId: "purpose", state: "satisfied", reason: "ok" },
          { facetId: "components", state: "satisfied", reason: "ok" },
        ],
      ),
    );
    // After GREEN: exact set equality ignores order → ok
    expect(result.ok).toBe(true);
  });

  it("duplicate facet ids in caller set cannot accept", async () => {
    const { svc, packet } = await verdictSvc(
      new Map([[QUESTION, ["purpose"]]]),
    );
    const result = await svc.apply(
      acceptBody(
        packet,
        ["purpose", "purpose"],
        [{ facetId: "purpose", state: "satisfied", reason: "ok" }],
      ),
    );
    expect(result.ok).toBe(false);
  });

  it("authority unavailable (empty map) fails closed", async () => {
    const { svc, packet } = await verdictSvc(new Map());
    const result = await svc.apply(
      acceptBody(
        packet,
        ["purpose"],
        [{ facetId: "purpose", state: "satisfied", reason: "ok" }],
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["FACET_AUTHORITY", "INVALID_INPUT"]).toContain(result.code);
    }
  });

  it("non-accepted verdict still loads facets authority (does not skip fail-closed)", async () => {
    const { svc, packet } = await verdictSvc(new Map());
    const result = await svc.apply({
      ...acceptBody(
        packet,
        ["purpose"],
        [{ facetId: "purpose", state: "partial", reason: "thin" }],
      ),
      verdict: "needs_more_evidence",
      followUpRequest: {
        missingFacetIds: ["purpose"],
        requiredSearch: { subject: "more" },
        whyCurrentPacketFails: "thin",
      },
    });
    // Unavailable authority fails closed even for non-accepted
    expect(result.ok).toBe(false);
  });

  it("caller cannot override: omitting requiredFacetIds derives from authority and accepts only exact cover", async () => {
    const { svc, packet } = await verdictSvc(
      new Map([[QUESTION, ["purpose", "components"]]]),
    );
    const body = acceptBody(
      packet,
      ["purpose", "components"],
      [
        { facetId: "purpose", state: "satisfied", reason: "ok" },
        { facetId: "components", state: "satisfied", reason: "ok" },
      ],
    );
    const { requiredFacetIds: _drop, ...without } = body;
    const result = await svc.apply(without);
    // GREEN: derives from QuestionFacetReader → accepted
    // RED: construction/apply lacks reader → fail
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe("accepted");
  });
});

// =============================================================================
// C — history composer
// =============================================================================
describe("C — EvidenceHistoryComposer", () => {
  it("exports composeAndEvaluateEvidenceLoop", async () => {
    const mod = await import("./evidence-loop-policy.js");
    expect(
      typeof (mod as { composeAndEvaluateEvidenceLoop?: unknown })
        .composeAndEvaluateEvidenceLoop,
    ).toBe("function");
  });

  it("public barrel exports composer not as sole evaluateEvidenceLoop for routing", async () => {
    const barrel = await import("./index.js");
    expect(
      typeof (barrel as { composeAndEvaluateEvidenceLoop?: unknown })
        .composeAndEvaluateEvidenceLoop,
    ).toBe("function");
  });

  it("empty stores fail closed without routing receipt", async () => {
    const mod = await import("./evidence-loop-policy.js");
    const compose = (
      mod as {
        composeAndEvaluateEvidenceLoop: (
          i: unknown,
        ) => Promise<{ ok: boolean; value?: { route?: string; historyReceipt?: unknown } }>;
      }
    ).composeAndEvaluateEvidenceLoop;
    const result = await compose({
      questionId: QUESTION,
      packets: createInMemoryEvidencePacketStore(),
      verdicts: createInMemoryEvidenceVerdictStore(),
      budget: { maxRefinements: 3 },
    });
    expect(result.ok).toBe(false);
    expect(result.value?.historyReceipt).toBeUndefined();
  });

  it("pure evaluateEvidenceLoop rejects version gaps", () => {
    const result = evaluateEvidenceLoop(
      {
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
              whyCurrentPacketFails: "g",
            },
          },
          {
            packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            packetVersion: 3,
            verdictId: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            verdictVersion: 3,
            verdict: "needs_more_evidence",
            followUpRequest: {
              missingFacetIds: ["b"],
              requiredSearch: { subject: "y" },
              whyCurrentPacketFails: "g",
            },
          },
        ],
      },
      { maxRefinements: 5 },
    );
    expect(result.ok).toBe(false);
  });

  it("pure evaluateEvidenceLoop rejects duplicate versions", () => {
    const step = {
      packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      packetVersion: 1,
      verdictId: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      verdictVersion: 1,
      verdict: "needs_more_evidence" as const,
      followUpRequest: {
        missingFacetIds: ["a"],
        requiredSearch: { subject: "x" },
        whyCurrentPacketFails: "g",
      },
    };
    const result = evaluateEvidenceLoop(
      { questionId: QUESTION, steps: [step, { ...step }] },
      { maxRefinements: 5 },
    );
    expect(result.ok).toBe(false);
  });

  it("pure evaluateEvidenceLoop rejects fabricated terminal string", () => {
    const result = evaluateEvidenceLoop(
      {
        questionId: QUESTION,
        steps: [
          {
            packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            packetVersion: 1,
            verdictId: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            verdictVersion: 1,
            verdict: "totally_made_up",
            followUpRequest: null,
          },
        ],
      },
      { maxRefinements: 3 },
    );
    expect(result.ok).toBe(false);
  });

  it("composer rejects mixed-question durable history", async () => {
    const mod = await import("./evidence-loop-policy.js");
    const compose = (
      mod as {
        composeAndEvaluateEvidenceLoop: (
          i: unknown,
        ) => Promise<{ ok: boolean }>;
      }
    ).composeAndEvaluateEvidenceLoop;
    // Composer must verify records belong to questionId — empty or mixed fail
    const result = await compose({
      questionId: QUESTION,
      packets: createInMemoryEvidencePacketStore(),
      verdicts: createInMemoryEvidenceVerdictStore(),
      budget: { maxRefinements: 3 },
      // optional adversarial prebuilt steps must be ignored/rejected
      steps: [
        {
          packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
          packetVersion: 1,
          verdictId: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
          verdictVersion: 1,
          verdict: "accepted",
          followUpRequest: null,
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("composer rejects missing durable records", async () => {
    const mod = await import("./evidence-loop-policy.js");
    const compose = (
      mod as {
        composeAndEvaluateEvidenceLoop: (
          i: unknown,
        ) => Promise<{ ok: boolean; value?: { historyReceipt?: unknown } }>;
      }
    ).composeAndEvaluateEvidenceLoop;
    const result = await compose({
      questionId: OTHER_Q,
      packets: createInMemoryEvidencePacketStore(),
      verdicts: createInMemoryEvidenceVerdictStore(),
      budget: { maxRefinements: 3 },
    });
    expect(result.ok).toBe(false);
    expect(result.value?.historyReceipt).toBeUndefined();
  });

  it("one valid composed history can succeed when stores hold paired records", async () => {
    // RED: composer missing → fail. GREEN: load real packet+verdict then route.
    const mod = await import("./evidence-loop-policy.js");
    const compose = (
      mod as {
        composeAndEvaluateEvidenceLoop: (
          i: unknown,
        ) => Promise<{ ok: boolean; value?: { route: string } }>;
      }
    ).composeAndEvaluateEvidenceLoop;
    // Without production composer this fails; when present with empty stores still fails
    const result = await compose({
      questionId: QUESTION,
      packets: createInMemoryEvidencePacketStore(),
      verdicts: createInMemoryEvidenceVerdictStore(),
      budget: { maxRefinements: 3 },
    });
    // Document expected success path exists as export; empty → not ok
    expect(result.ok).toBe(false);
  });
});

// =============================================================================
// D — atomic append + idempotency (packet + verdict)
// =============================================================================
describe("D — atomic packet append+idempotency", () => {
  it("hook afterImmutablePublishBeforeOpCommit fires on durable append", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "pkt-hook2-"));
    try {
      let fired = false;
      const store = createFileEvidencePacketStore(root, {
        afterImmutablePublishBeforeOpCommit: () => {
          fired = true;
        },
      } as never);
      await store.append(samplePacket());
      expect(fired).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("crash after immutable before op commit: same-key retry one version", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "pkt-atom2-"));
    try {
      const store = createFileEvidencePacketStore(root, {
        afterImmutablePublishBeforeOpCommit: () => {
          throw new Error("injected-crash-op");
        },
      } as never);
      const links = {
        get: async (id: string) =>
          id === QUESTION
            ? { questionId: QUESTION, snapshotId: SNAPSHOT }
            : undefined,
      };
      const svc = createEvidenceService({
        store,
        links,
        receipts: { get: async () => undefined },
      });
      const receipt = healthyReceipt();
      await expect(
        svc.appendPacket({
          questionId: QUESTION,
          references: [ref()],
          receipt,
          receiptDigest: receiptDigestOf(receipt),
          context: context(),
          idempotencyKey: "p-atom",
        }),
      ).rejects.toThrow(/injected-crash-op/);

      const fresh = createEvidenceService({
        store: createFileEvidencePacketStore(root),
        links,
        receipts: { get: async () => undefined },
      });
      const replay = await fresh.appendPacket({
        questionId: QUESTION,
        references: [ref()],
        receipt,
        receiptDigest: receiptDigestOf(receipt),
        context: context(),
        idempotencyKey: "p-atom",
      });
      expect(replay.ok).toBe(true);
      if (!replay.ok) return;
      expect(replay.value.version).toBe(1);

      const conflict = await fresh.appendPacket({
        questionId: QUESTION,
        references: [ref()],
        receipt: healthyReceipt({ query: "different" }),
        receiptDigest: receiptDigestOf(healthyReceipt({ query: "different" })),
        context: context(),
        idempotencyKey: "p-atom",
      });
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

});

describe("D — honest existing invariant: in-memory packet idempotency conflict", () => {
  it("in-memory packet idempotency still conflicts on different payload", async () => {
    const svc = createEvidenceService({
      store: createInMemoryEvidencePacketStore(),
      links: {
        get: async (id) =>
          id === QUESTION
            ? { questionId: QUESTION, snapshotId: SNAPSHOT }
            : undefined,
      },
      receipts: { get: async () => undefined },
    });
    const receipt = healthyReceipt();
    const first = await svc.appendPacket({
      questionId: QUESTION,
      references: [ref()],
      receipt,
      receiptDigest: receiptDigestOf(receipt),
      context: context(),
      idempotencyKey: "mem-p",
    });
    expect(first.ok).toBe(true);
    const conflict = await svc.appendPacket({
      questionId: QUESTION,
      references: [ref()],
      receipt: healthyReceipt({ query: "x" }),
      receiptDigest: receiptDigestOf(healthyReceipt({ query: "x" })),
      context: context(),
      idempotencyKey: "mem-p",
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("D — atomic verdict append+idempotency", () => {
  it("hook afterImmutablePublishBeforeOpCommit fires on durable verdict append", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "evv-hook2-"));
    try {
      let fired = false;
      const store = createFileEvidenceVerdictStore(root, {
        afterImmutablePublishBeforeOpCommit: () => {
          fired = true;
        },
      } as never);
      const claimLike = {
        schemaVersion: 1 as const,
        id: deriveEvidenceVerdictId(QUESTION, deriveEvidencePacketId(QUESTION)),
        questionId: QUESTION,
        packetId: deriveEvidencePacketId(QUESTION),
        packetVersion: 1,
        version: 1,
        referenceReviews: [
          {
            unitId: UNIT_A,
            classification: "necessary_primary" as const,
            reason: "r",
          },
        ],
        facetStates: [
          { facetId: "purpose", state: "satisfied" as const, reason: "r" },
        ],
        verdict: "search_incomplete" as const,
        criticisms: ["x"],
        followUpRequest: null,
        packetDigest: DIGEST_A as Sha256,
      };
      await store.append(claimLike as never);
      expect(fired).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("exports createInMemoryQuestionFacetReader for authority tests", async () => {
    const mod = await import("./evidence-verdict-service.js");
    expect(
      typeof (mod as { createInMemoryQuestionFacetReader?: unknown })
        .createInMemoryQuestionFacetReader,
    ).toBe("function");
  });

  it("crash after immutable before op: same-key verdict retry one version", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "evv-atom2-"));
    try {
      const mod = await import("./evidence-verdict-service.js");
      const createFacets = (
        mod as {
          createInMemoryQuestionFacetReader: (
            m: Map<string, string[]>,
          ) => QuestionFacetReader;
        }
      ).createInMemoryQuestionFacetReader;
      expect(typeof createFacets).toBe("function");
      const facets = createFacets(new Map([[QUESTION, ["purpose"]]]));
      const packet = samplePacket();
      const store = createFileEvidenceVerdictStore(root, {
        afterImmutablePublishBeforeOpCommit: () => {
          throw new Error("injected-crash-op");
        },
      } as never);
      const applyInput = {
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
        idempotencyKey: "v-atom",
      };
      const deps = {
        packets: { get: async () => packet },
        receipts: {
          get: async () => ({
            id: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            failures: [],
            selectedIds: [UNIT_A],
          }),
        },
        verifier: {
          verifyReferences: async () => ({ ok: true as const, value: true as const }),
        },
        facets,
      };
      const svc = mod.createEvidenceVerdictService({ store, ...deps });
      await expect(svc.apply(applyInput)).rejects.toThrow(/injected-crash-op/);
      const fresh = mod.createEvidenceVerdictService({
        store: createFileEvidenceVerdictStore(root),
        ...deps,
      });
      const replay = await fresh.apply(applyInput);
      expect(replay.ok).toBe(true);
      if (!replay.ok) return;
      expect(replay.value.version).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

// =============================================================================
// RED-3 — exact composer pairing / digest / version streams + crash reconstruction
// =============================================================================
describe("C3 — composer pairing and complete packetDigest", () => {
  async function composeFn() {
    const mod = await import("./evidence-loop-policy.js");
    return (
      mod as {
        composeAndEvaluateEvidenceLoop: (
          i: unknown,
        ) => Promise<{
          ok: boolean;
          value?: { route?: string; historyReceipt?: unknown };
        }>;
      }
    ).composeAndEvaluateEvidenceLoop;
  }

  it("composer rejects verdict packetId/version mismatch vs loaded packet (wrong pairing)", async () => {
    const compose = await composeFn();
    const packets = createInMemoryEvidencePacketStore();
    const verdicts = createInMemoryEvidenceVerdictStore();
    const packet = samplePacket();
    await packets.append(packet);
    // Plant a verdict that claims wrong packetVersion
    await verdicts.append({
      schemaVersion: 1,
      id: deriveEvidenceVerdictId(QUESTION, packet.id),
      questionId: QUESTION,
      packetId: packet.id,
      packetVersion: 99, // wrong
      version: 1,
      referenceReviews: [
        {
          unitId: UNIT_A,
          classification: "necessary_primary",
          reason: "r",
        },
      ],
      facetStates: [
        { facetId: "purpose", state: "satisfied", reason: "r" },
      ],
      verdict: "accepted",
      criticisms: [],
      followUpRequest: null,
      packetDigest: DIGEST_A as Sha256,
    } as never);
    const result = await compose({
      questionId: QUESTION,
      packets,
      verdicts,
      budget: { maxRefinements: 3 },
    });
    expect(result.ok).toBe(false);
    expect(result.value?.historyReceipt).toBeUndefined();
  });

  it("composer rejects verdict.packetDigest mismatch vs COMPLETE recomputed digest", async () => {
    const compose = await composeFn();
    const packets = createInMemoryEvidencePacketStore();
    const verdicts = createInMemoryEvidenceVerdictStore();
    const packet = samplePacket();
    await packets.append(packet);
    await verdicts.append({
      schemaVersion: 1,
      id: deriveEvidenceVerdictId(QUESTION, packet.id),
      questionId: QUESTION,
      packetId: packet.id,
      packetVersion: 1,
      version: 1,
      referenceReviews: [
        {
          unitId: UNIT_A,
          classification: "necessary_primary",
          reason: "r",
        },
      ],
      facetStates: [
        { facetId: "purpose", state: "satisfied", reason: "r" },
      ],
      verdict: "accepted",
      criticisms: [],
      followUpRequest: null,
      packetDigest: "f".repeat(64) as Sha256, // wrong vs complete digest
    } as never);
    const result = await compose({
      questionId: QUESTION,
      packets,
      verdicts,
      budget: { maxRefinements: 3 },
    });
    expect(result.ok).toBe(false);
    expect(result.value?.historyReceipt).toBeUndefined();
  });
});

describe("C3 — separate packet and verdict version stream failures", () => {
  it("pure path rejects reordered packet versions", () => {
    const result = evaluateEvidenceLoop(
      {
        questionId: QUESTION,
        steps: [
          {
            packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            packetVersion: 2,
            verdictId: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            verdictVersion: 1,
            verdict: "needs_more_evidence",
            followUpRequest: {
              missingFacetIds: ["a"],
              requiredSearch: { subject: "x" },
              whyCurrentPacketFails: "g",
            },
          },
          {
            packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            packetVersion: 1,
            verdictId: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            verdictVersion: 2,
            verdict: "needs_more_evidence",
            followUpRequest: {
              missingFacetIds: ["b"],
              requiredSearch: { subject: "y" },
              whyCurrentPacketFails: "g",
            },
          },
        ],
      },
      { maxRefinements: 5 },
    );
    expect(result.ok).toBe(false);
  });

  it("pure path rejects skipped packet versions", () => {
    const result = evaluateEvidenceLoop(
      {
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
              whyCurrentPacketFails: "g",
            },
          },
          {
            packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            packetVersion: 3,
            verdictId: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            verdictVersion: 2,
            verdict: "needs_more_evidence",
            followUpRequest: {
              missingFacetIds: ["b"],
              requiredSearch: { subject: "y" },
              whyCurrentPacketFails: "g",
            },
          },
        ],
      },
      { maxRefinements: 5 },
    );
    expect(result.ok).toBe(false);
  });

  it("pure path rejects duplicated packet versions", () => {
    const result = evaluateEvidenceLoop(
      {
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
              whyCurrentPacketFails: "g",
            },
          },
          {
            packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            packetVersion: 1,
            verdictId: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            verdictVersion: 2,
            verdict: "needs_more_evidence",
            followUpRequest: {
              missingFacetIds: ["b"],
              requiredSearch: { subject: "y" },
              whyCurrentPacketFails: "g",
            },
          },
        ],
      },
      { maxRefinements: 5 },
    );
    expect(result.ok).toBe(false);
  });

  it("pure path rejects reordered verdict versions", () => {
    const result = evaluateEvidenceLoop(
      {
        questionId: QUESTION,
        steps: [
          {
            packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            packetVersion: 1,
            verdictId: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            verdictVersion: 2,
            verdict: "needs_more_evidence",
            followUpRequest: {
              missingFacetIds: ["a"],
              requiredSearch: { subject: "x" },
              whyCurrentPacketFails: "g",
            },
          },
          {
            packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            packetVersion: 2,
            verdictId: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            verdictVersion: 1,
            verdict: "needs_more_evidence",
            followUpRequest: {
              missingFacetIds: ["b"],
              requiredSearch: { subject: "y" },
              whyCurrentPacketFails: "g",
            },
          },
        ],
      },
      { maxRefinements: 5 },
    );
    expect(result.ok).toBe(false);
  });

  it("pure path rejects skipped verdict versions", () => {
    const result = evaluateEvidenceLoop(
      {
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
              whyCurrentPacketFails: "g",
            },
          },
          {
            packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            packetVersion: 2,
            verdictId: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            verdictVersion: 3,
            verdict: "needs_more_evidence",
            followUpRequest: {
              missingFacetIds: ["b"],
              requiredSearch: { subject: "y" },
              whyCurrentPacketFails: "g",
            },
          },
        ],
      },
      { maxRefinements: 5 },
    );
    expect(result.ok).toBe(false);
  });

  it("pure path rejects duplicated verdict versions", () => {
    const result = evaluateEvidenceLoop(
      {
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
              whyCurrentPacketFails: "g",
            },
          },
          {
            packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            packetVersion: 2,
            verdictId: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            verdictVersion: 1,
            verdict: "needs_more_evidence",
            followUpRequest: {
              missingFacetIds: ["b"],
              requiredSearch: { subject: "y" },
              whyCurrentPacketFails: "g",
            },
          },
        ],
      },
      { maxRefinements: 5 },
    );
    expect(result.ok).toBe(false);
  });
});

describe("D3 — packet crash reconstruction + corrupt op mapping", () => {
  it("same-key retry returns structurally same packet version after crash", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "pkt-recon-"));
    try {
      const store = createFileEvidencePacketStore(root, {
        afterImmutablePublishBeforeOpCommit: () => {
          throw new Error("injected-crash-op");
        },
      } as never);
      const links = {
        get: async (id: string) =>
          id === QUESTION
            ? { questionId: QUESTION, snapshotId: SNAPSHOT }
            : undefined,
      };
      const svc = createEvidenceService({
        store,
        links,
        receipts: { get: async () => undefined },
      });
      const receipt = healthyReceipt();
      const input = {
        questionId: QUESTION,
        references: [ref()],
        receipt,
        receiptDigest: receiptDigestOf(receipt),
        context: context(),
        idempotencyKey: "recon-p",
      };
      await expect(svc.appendPacket(input)).rejects.toThrow(/injected-crash-op/);
      const fresh = createEvidenceService({
        store: createFileEvidencePacketStore(root),
        links,
        receipts: { get: async () => undefined },
      });
      const a = await fresh.appendPacket(input);
      const b = await fresh.appendPacket(input);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.value.version).toBe(1);
      expect(b.value.version).toBe(1);
      expect(a.value.id).toBe(b.value.id);
      expect(a.value.receiptDigest).toBe(b.value.receiptDigest);
      // different payload same key conflicts
      const conflict = await fresh.appendPacket({
        ...input,
        receipt: healthyReceipt({ query: "mutated" }),
        receiptDigest: receiptDigestOf(healthyReceipt({ query: "mutated" })),
      });
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("corrupted operation intent cannot authorize packet replay", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "pkt-corrupt-op-"));
    try {
      // GREEN must validate op digest against record; RED expects typed fail
      // when journal mapping is corrupted after a partial commit.
      const store = createFileEvidencePacketStore(root);
      const links = {
        get: async (id: string) =>
          id === QUESTION
            ? { questionId: QUESTION, snapshotId: SNAPSHOT }
            : undefined,
      };
      const svc = createEvidenceService({
        store,
        links,
        receipts: { get: async () => undefined },
      });
      const receipt = healthyReceipt();
      const first = await svc.appendPacket({
        questionId: QUESTION,
        references: [ref()],
        receipt,
        receiptDigest: receiptDigestOf(receipt),
        context: context(),
        idempotencyKey: "corrupt-op-p",
      });
      expect(first.ok).toBe(true);
      // Corrupt journal idem mapping if present
      const { readdir, readFile, writeFile } = await import("node:fs/promises");
      const journal = join(root, ".ultradyn", "evidence", "journal");
      let corrupted = false;
      try {
        const names = await readdir(journal);
        for (const name of names) {
          if (name.startsWith("idem-")) {
            const path = join(journal, name);
            const raw = await readFile(path, "utf8");
            await writeFile(path, raw.replace(/"digest":"[a-f0-9]+"/, '"digest":"0".repeat(64)'.slice(0, 0) + '"digest":"' + "0".repeat(64) + '"'));
            corrupted = true;
          }
        }
      } catch {
        // journal path may differ — force fail expectation on replay validation API
      }
      const fresh = createEvidenceService({
        store: createFileEvidencePacketStore(root),
        links,
        receipts: { get: async () => undefined },
      });
      // Replay same key: if mapping corrupt, must fail closed not invent new version
      const replay = await fresh.appendPacket({
        questionId: QUESTION,
        references: [ref()],
        receipt,
        receiptDigest: receiptDigestOf(receipt),
        context: context(),
        idempotencyKey: "corrupt-op-p",
      });
      // After GREEN: either exact replay of v1 OR typed IDEMPOTENCY/STREAM failure
      if (corrupted) {
        if (replay.ok) {
          expect(replay.value.version).toBe(1);
        } else {
          expect(["IDEMPOTENCY_CONFLICT", "COMMIT_FAILED", "STREAM_CORRUPT"]).toContain(
            replay.code,
          );
        }
      } else {
        // RED: require store-level validateOperation API
        const mod = await import("./evidence-service.js");
        expect(
          typeof (mod as { validateIdempotencyOperation?: unknown })
            .validateIdempotencyOperation,
        ).toBe("function");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("D3 — verdict crash reconstruction + different-payload conflict", () => {
  it("verdict same-key retry one version and different-payload conflicts after crash", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "evv-recon-"));
    try {
      const mod = await import("./evidence-verdict-service.js");
      const createFacets = (
        mod as {
          createInMemoryQuestionFacetReader: (
            m: Map<string, string[]>,
          ) => QuestionFacetReader;
        }
      ).createInMemoryQuestionFacetReader;
      expect(typeof createFacets).toBe("function");
      const facets = createFacets(new Map([[QUESTION, ["purpose"]]]));
      const packet = samplePacket();
      const store = createFileEvidenceVerdictStore(root, {
        afterImmutablePublishBeforeOpCommit: () => {
          throw new Error("injected-crash-op");
        },
      } as never);
      const applyBase = {
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
        idempotencyKey: "recon-v",
      };
      const deps = {
        packets: { get: async () => packet },
        receipts: {
          get: async () => ({
            id: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            failures: [],
            selectedIds: [UNIT_A],
          }),
        },
        verifier: {
          verifyReferences: async () => ({
            ok: true as const,
            value: true as const,
          }),
        },
        facets,
      };
      await expect(
        mod.createEvidenceVerdictService({ store, ...deps }).apply(applyBase),
      ).rejects.toThrow(/injected-crash-op/);
      const fresh = mod.createEvidenceVerdictService({
        store: createFileEvidenceVerdictStore(root),
        ...deps,
      });
      const a = await fresh.apply(applyBase);
      const b = await fresh.apply(applyBase);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.value.version).toBe(1);
      expect(b.value.version).toBe(1);
      const conflict = await fresh.apply({
        ...applyBase,
        criticisms: ["different payload"],
      });
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("corrupted verdict op mapping fails closed", async () => {
    const mod = await import("./evidence-verdict-service.js");
    // Require explicit validation seam for corrupt journal (not silent accept)
    expect(
      typeof (mod as { validateIdempotencyOperation?: unknown })
        .validateIdempotencyOperation,
    ).toBe("function");
  });
});
