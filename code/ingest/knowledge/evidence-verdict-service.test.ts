import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  EvidencePacketId,
  QuestionId,
  Sha256,
  SnapshotId,
  SourceFileId,
  SourceUnitId,
} from "../../domain/ingest/index.js";
import {
  DEFAULT_EVIDENCE_PACKET_LIMITS,
  type EvidencePacket,
  type EvidenceReference,
} from "../../domain/ingest/evidence-packet.js";
import {
  EvidenceVerdictSchema,
  type EvidenceVerdict,
} from "../../domain/ingest/evidence-verdict.js";
import {
  SearchReceiptSchema,
  computeIndexedRepresentationsSha256,
  type SearchReceipt,
} from "../../domain/ingest/search-receipt.js";

import {
  createEvidenceVerdictService,
  createInMemoryEvidenceVerdictStore,
  createInMemoryQuestionFacetReader,
  createFileEvidenceVerdictStore,
  deriveEvidenceVerdictId,
  type EvidencePacketReader,
  type PacketVerifier,
  type QuestionFacetReader,
  type ReceiptFailureReader,
} from "./evidence-verdict-service.js";

const SNAPSHOT = `snap-${"b".repeat(64)}` as SnapshotId;
const FILE_A = `file-${"a".repeat(64)}` as SourceFileId;
const FILE_B = `file-${"c".repeat(64)}` as SourceFileId;
const UNIT_A = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceUnitId;
const UNIT_B = "unit-01ARZ3NDEKTSV4RRFFQ69G5FBW" as SourceUnitId;
const QUESTION = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV" as QuestionId;
const PACKET_ID = "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV" as EvidencePacketId;
const RECEIPT_ID = "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV";

function sha(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}

const FILE_HASH_A = sha("file-a-bytes");
const UNIT_HASH_A = sha("unit-a-text");
const UNIT_HASH_B = sha("unit-b-text");
const FILE_HASH_B = sha("file-b-bytes");

function receipt(overrides: Record<string, unknown> = {}): SearchReceipt {
  const base = {
    schemaVersion: 1 as const,
    id: RECEIPT_ID,
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
    candidateIds: [UNIT_A, UNIT_B],
    selectedIds: [UNIT_A, UNIT_B],
    failures: [] as string[],
    ...overrides,
  };
  return SearchReceiptSchema.parse(base) as SearchReceipt;
}

function ref(
  unitId: SourceUnitId,
  role: "primary" | "supporting",
  facetIds: string[],
  hashes: { file: Sha256; unit: Sha256; fileId: SourceFileId },
): EvidenceReference {
  return {
    snapshotId: SNAPSHOT,
    fileId: hashes.fileId,
    unitId,
    fileSha256: hashes.file,
    unitSha256: hashes.unit,
    role,
    facetIds,
  };
}

/** Default packet: UNIT_A primary (material), UNIT_B supporting. */
function packet(overrides: Partial<EvidencePacket> = {}): EvidencePacket {
  const rcpt = receipt();
  return {
    schemaVersion: 1,
    id: PACKET_ID,
    questionId: QUESTION,
    version: 1,
    references: [
      ref(UNIT_A, "primary", ["purpose"], {
        file: FILE_HASH_A,
        unit: UNIT_HASH_A,
        fileId: FILE_A,
      }),
      ref(UNIT_B, "supporting", ["components"], {
        file: FILE_HASH_B,
        unit: UNIT_HASH_B,
        fileId: FILE_B,
      }),
    ],
    receiptId: rcpt.id,
    receiptDigest: sha(`receipt:${rcpt.id}`),
    limits: DEFAULT_EVIDENCE_PACKET_LIMITS,
    ...overrides,
  };
}

function packetReader(p: EvidencePacket = packet()): EvidencePacketReader {
  return {
    get: async (packetId, version) =>
      packetId === p.id && version === p.version ? p : undefined,
  };
}

function receiptReader(
  failures: readonly string[] = [],
  healthy: SearchReceipt = receipt({ failures: [...failures] }),
): ReceiptFailureReader {
  return {
    get: async (receiptId) =>
      receiptId === healthy.id
        ? {
            id: healthy.id,
            failures: healthy.failures,
            selectedIds: healthy.selectedIds,
            snapshotId: healthy.snapshotId,
            query: healthy.query,
            filters: healthy.filters,
            candidateIds: healthy.candidateIds,
            indexVersion: healthy.indexVersion,
            indexedRepresentationsSha256: healthy.indexedRepresentationsSha256,
          }
        : undefined,
  };
}

function verifierOk(): PacketVerifier {
  return {
    verifyReferences: async () => ({ ok: true as const, value: true as const }),
  };
}

function verifierFail(code: string = "HASH_MISMATCH"): PacketVerifier {
  return {
    verifyReferences: async () => ({
      ok: false as const,
      code,
      message: "verify failed",
    }),
  };
}

/**
 * River §3.3: material = primary only. Reviews for supporting are optional
 * unless product chooses require-all; RED documents supporting-unclassified
 * as accept path when all primaries classified + facets satisfied.
 */
function acceptedInput(overrides: Record<string, unknown> = {}) {
  return {
    questionId: QUESTION,
    packetId: PACKET_ID,
    packetVersion: 1,
    requiredFacetIds: ["purpose", "components"],
    referenceReviews: [
      {
        unitId: UNIT_A,
        classification: "necessary_primary",
        reason: "Defines purpose.",
      },
      {
        unitId: UNIT_B,
        classification: "necessary_qualifying",
        reason: "Lists components.",
      },
    ],
    facetStates: [
      {
        facetId: "purpose",
        state: "satisfied",
        sourceUnitIds: [UNIT_A],
        reason: "Covered.",
      },
      {
        facetId: "components",
        state: "satisfied",
        sourceUnitIds: [UNIT_B],
        reason: "Covered.",
      },
    ],
    verdict: "accepted",
    criticisms: [] as string[],
    followUpRequest: null,
    ...overrides,
  };
}

function defaultFacets(): QuestionFacetReader {
  return createInMemoryQuestionFacetReader(
    new Map([[QUESTION, ["purpose", "components"]]]),
  );
}

function service(
  overrides: {
    packets?: EvidencePacketReader;
    receipts?: ReceiptFailureReader;
    verifier?: PacketVerifier;
    store?: ReturnType<typeof createInMemoryEvidenceVerdictStore>;
    facets?: QuestionFacetReader;
  } = {},
) {
  return createEvidenceVerdictService({
    store: overrides.store ?? createInMemoryEvidenceVerdictStore(),
    packets: overrides.packets ?? packetReader(),
    receipts: overrides.receipts ?? receiptReader(),
    verifier: overrides.verifier ?? verifierOk(),
    facets: overrides.facets ?? defaultFacets(),
  });
}

describe("createEvidenceVerdictService construction", () => {
  it("requires packets reader at construction", () => {
    expect(() =>
      createEvidenceVerdictService({
        store: createInMemoryEvidenceVerdictStore(),
        receipts: receiptReader(),
        verifier: verifierOk(),
        facets: defaultFacets(),
      } as never),
    ).toThrow(/packets/i);
  });

  it("requires receipts reader at construction", () => {
    expect(() =>
      createEvidenceVerdictService({
        store: createInMemoryEvidenceVerdictStore(),
        packets: packetReader(),
        verifier: verifierOk(),
        facets: defaultFacets(),
      } as never),
    ).toThrow(/receipts/i);
  });

  it("requires packet verifier at construction", () => {
    expect(() =>
      createEvidenceVerdictService({
        store: createInMemoryEvidenceVerdictStore(),
        packets: packetReader(),
        receipts: receiptReader(),
        facets: defaultFacets(),
      } as never),
    ).toThrow(/verifier/i);
  });

  it("requires facets reader at construction", () => {
    expect(() =>
      createEvidenceVerdictService({
        store: createInMemoryEvidenceVerdictStore(),
        packets: packetReader(),
        receipts: receiptReader(),
        verifier: verifierOk(),
      } as never),
    ).toThrow(/facet/i);
  });
});

describe("apply — accepted lifecycle (River §3.3–3.4)", () => {
  it("accepts when required facets satisfied and every primary classified", async () => {
    const result = await service().apply(acceptedInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe("accepted");
    expect(result.value.version).toBe(1);
    expect(result.value.packetId).toBe(PACKET_ID);
    expect(result.value.id).toBe(deriveEvidenceVerdictId(QUESTION, PACKET_ID));
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(result.value.followUpRequest).toBeNull();
    expect(result.transition).toEqual({
      done: true,
      activateP1: false,
      kind: "accepted",
    });
  });

  it("accepts with supporting ref unclassified when all primaries classified", async () => {
    // River: material = primary only; supporting reviews optional.
    const result = await service().apply(
      acceptedInput({
        referenceReviews: [
          {
            unitId: UNIT_A,
            classification: "necessary_primary",
            reason: "Primary only.",
          },
        ],
        // facets still cite supporting unit for evidence — allowed as long as ⊆ packet
        facetStates: [
          {
            facetId: "purpose",
            state: "satisfied",
            sourceUnitIds: [UNIT_A],
            reason: "Covered by primary.",
          },
          {
            facetId: "components",
            state: "satisfied",
            sourceUnitIds: [UNIT_A],
            reason: "Also covered by primary text.",
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe("accepted");
  });

  it("rejects accepted when a required facet is not satisfied", async () => {
    const result = await service().apply(
      acceptedInput({
        facetStates: [
          {
            facetId: "purpose",
            state: "satisfied",
            sourceUnitIds: [UNIT_A],
            reason: "ok",
          },
          {
            facetId: "components",
            state: "missing",
            sourceUnitIds: [],
            reason: "gap",
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("FACET_UNSATISFIED");
  });

  it("rejects accepted when a required facet is omitted entirely", async () => {
    // Authority requires purpose+components; omit components from facetStates.
    const result = await service().apply(
      acceptedInput({
        requiredFacetIds: ["purpose", "components"],
        facetStates: [
          {
            facetId: "purpose",
            state: "satisfied",
            sourceUnitIds: [UNIT_A],
            reason: "ok",
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("FACET_UNSATISFIED");
  });

  it("rejects accepted when a required facet is not_applicable", async () => {
    const result = await service().apply(
      acceptedInput({
        facetStates: [
          {
            facetId: "purpose",
            state: "satisfied",
            sourceUnitIds: [UNIT_A],
            reason: "ok",
          },
          {
            facetId: "components",
            state: "not_applicable",
            reason: "claimed N/A",
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("FACET_REQUIRED_NA");
  });

  it("rejects accepted when a primary (material) reference is unclassified", async () => {
    const result = await service().apply(
      acceptedInput({
        referenceReviews: [
          // only supporting classified — primary UNIT_A missing
          {
            unitId: UNIT_B,
            classification: "necessary_qualifying",
            reason: "supporting only",
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("REFERENCE_UNCLASSIFIED");
  });

  it("rejects accepted when material review is conflicting or unverifiable", async () => {
    for (const classification of ["conflicting", "unverifiable"] as const) {
      const result = await service().apply(
        acceptedInput({
          referenceReviews: [
            {
              unitId: UNIT_A,
              classification,
              reason: "cannot accept",
            },
            {
              unitId: UNIT_B,
              classification: "necessary_qualifying",
              reason: "ok",
            },
          ],
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect([
          "REFERENCE_INVALID",
          "FACET_UNSATISFIED",
          "INVALID_INPUT",
        ]).toContain(result.code);
      }
    }
  });

  it("rejects review of a unit not present on the packet", async () => {
    const foreign = "unit-01ARZ3NDEKTSV4RRFFQ69G5FCX" as SourceUnitId;
    const result = await service().apply(
      acceptedInput({
        referenceReviews: [
          {
            unitId: UNIT_A,
            classification: "necessary_primary",
            reason: "ok",
          },
          {
            unitId: foreign,
            classification: "irrelevant",
            reason: "not on packet",
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_INPUT");
  });

  it("rejects accepted on empty-ref packet", async () => {
    const empty = packet({ references: [] });
    const result = await service({ packets: packetReader(empty) }).apply(
      acceptedInput({
        referenceReviews: [],
        facetStates: [
          { facetId: "purpose", state: "satisfied", reason: "bogus" },
          { facetId: "components", state: "satisfied", reason: "bogus" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EMPTY_PACKET");
  });

  it("rejects apply when packet verifyReferences fails", async () => {
    const result = await service({ verifier: verifierFail() }).apply(
      acceptedInput(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PACKET_UNVERIFIED");
  });
});

describe("apply — retrieval outage cannot become no_supported_answer (River §3.6)", () => {
  it("rejects no_supported_answer when receipt carries INDEX_UNAVAILABLE", async () => {
    const result = await service({
      receipts: receiptReader(["INDEX_UNAVAILABLE"]),
    }).apply(
      acceptedInput({
        verdict: "no_supported_answer",
        facetStates: [
          {
            facetId: "purpose",
            state: "unsupported_in_snapshot",
            reason: "none",
          },
          {
            facetId: "components",
            state: "unsupported_in_snapshot",
            reason: "none",
          },
        ],
        referenceReviews: [
          {
            unitId: UNIT_A,
            classification: "unverifiable",
            reason: "outage",
          },
        ],
        criticisms: ["index unavailable"],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["OUTAGE_NOT_GAP", "RECEIPT_INVALID"]).toContain(result.code);
  });

  it("rejects no_supported_answer for SEARCH_UNAVAILABLE / PROVIDER_OUTAGE codes", async () => {
    for (const code of [
      "SEARCH_UNAVAILABLE",
      "PROVIDER_OUTAGE",
      "RETRIEVAL_UNAVAILABLE",
    ]) {
      const result = await service({
        receipts: receiptReader([code]),
      }).apply(
        acceptedInput({
          verdict: "no_supported_answer",
          facetStates: [
            { facetId: "purpose", state: "missing", reason: "x" },
            { facetId: "components", state: "missing", reason: "x" },
          ],
          referenceReviews: [
            {
              unitId: UNIT_A,
              classification: "unverifiable",
              reason: "outage",
            },
          ],
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(["OUTAGE_NOT_GAP", "RECEIPT_INVALID"]).toContain(result.code);
      }
    }
  });

  it("allows no_supported_answer only with a healthy receipt and zero material refs", async () => {
    const emptyPacket = packet({ references: [] });
    const healthy = receipt({ selectedIds: [], candidateIds: [] });
    const result = await service({
      packets: packetReader(emptyPacket),
      receipts: {
        get: async () => ({
          id: healthy.id,
          failures: [],
          selectedIds: [],
          snapshotId: healthy.snapshotId,
          query: healthy.query,
          filters: healthy.filters,
          candidateIds: [],
          indexVersion: healthy.indexVersion,
          indexedRepresentationsSha256: healthy.indexedRepresentationsSha256,
        }),
      },
    }).apply({
      questionId: QUESTION,
      packetId: PACKET_ID,
      packetVersion: 1,
      requiredFacetIds: ["purpose", "components"],
      referenceReviews: [],
      facetStates: [
        {
          facetId: "purpose",
          state: "unsupported_in_snapshot",
          reason: "No supporting unit under healthy search.",
        },
        {
          facetId: "components",
          state: "unsupported_in_snapshot",
          reason: "No supporting unit under healthy search.",
        },
      ],
      verdict: "no_supported_answer",
      criticisms: ["absence justified"],
      followUpRequest: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe("no_supported_answer");
    expect(result.transition).toEqual({
      done: true,
      activateP1: false,
      kind: "no_supported_answer",
    });
  });

  it("allows search_incomplete under retrieval outage (not no_supported_answer)", async () => {
    const result = await service({
      receipts: receiptReader(["INDEX_UNAVAILABLE"]),
    }).apply(
      acceptedInput({
        verdict: "search_incomplete",
        facetStates: [
          { facetId: "purpose", state: "partial", reason: "outage" },
          { facetId: "components", state: "partial", reason: "outage" },
        ],
        referenceReviews: [
          {
            unitId: UNIT_A,
            classification: "unverifiable",
            reason: "outage",
          },
        ],
        criticisms: ["index outage"],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe("search_incomplete");
    expect(result.transition).toEqual({
      done: true,
      activateP1: false,
      kind: "search_incomplete",
    });
  });
});

describe("apply — needs_more_evidence and contradiction (River §3.5 / §3.7)", () => {
  it("requires strict BoundedFollowUp for needs_more_evidence", async () => {
    const missing = await service().apply(
      acceptedInput({
        verdict: "needs_more_evidence",
        facetStates: [
          { facetId: "purpose", state: "partial", reason: "thin" },
          { facetId: "components", state: "missing", reason: "gap" },
        ],
        followUpRequest: null,
        referenceReviews: [
          {
            unitId: UNIT_A,
            classification: "necessary_primary",
            reason: "ok",
          },
        ],
      }),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("FOLLOW_UP_REQUIRED");

    const emptyBody = await service().apply(
      acceptedInput({
        verdict: "needs_more_evidence",
        facetStates: [
          { facetId: "purpose", state: "partial", reason: "thin" },
          { facetId: "components", state: "missing", reason: "gap" },
        ],
        followUpRequest: {
          missingFacetIds: [],
          requiredSearch: { subject: "" },
          whyCurrentPacketFails: "x",
        },
        referenceReviews: [
          {
            unitId: UNIT_A,
            classification: "necessary_primary",
            reason: "ok",
          },
        ],
      }),
    );
    expect(emptyBody.ok).toBe(false);

    const ok = await service().apply(
      acceptedInput({
        verdict: "needs_more_evidence",
        facetStates: [
          { facetId: "purpose", state: "partial", reason: "thin" },
          { facetId: "components", state: "missing", reason: "gap" },
        ],
        followUpRequest: {
          missingFacetIds: ["components"],
          requiredSearch: {
            subject: "component list",
            scope: "docs",
            exclusions: [],
          },
          whyCurrentPacketFails: "components facet unsupported",
        },
        referenceReviews: [
          {
            unitId: UNIT_A,
            classification: "necessary_primary",
            reason: "ok",
          },
        ],
      }),
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.verdict).toBe("needs_more_evidence");
    expect(ok.value.followUpRequest).not.toBeNull();
    expect(ok.transition).toEqual({
      done: false,
      activateP1: false,
      kind: "refine",
    });
  });

  it("conflicting_or_deprecated yields activateP1 + done:false without child proposals", async () => {
    const result = await service().apply(
      acceptedInput({
        verdict: "conflicting_or_deprecated",
        referenceReviews: [
          {
            unitId: UNIT_A,
            classification: "conflicting",
            reason: "Contradicts B",
          },
          {
            unitId: UNIT_B,
            classification: "conflicting",
            reason: "Contradicts A",
          },
        ],
        facetStates: [
          {
            facetId: "purpose",
            state: "conflicting",
            sourceUnitIds: [UNIT_A, UNIT_B],
            reason: "conflict",
          },
          {
            facetId: "components",
            state: "conflicting",
            reason: "conflict",
          },
        ],
        criticisms: ["material conflict"],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe("conflicting_or_deprecated");
    expect(result.transition).toEqual({
      done: false,
      activateP1: true,
      kind: "contradiction",
    });
    expect(
      (result.value as EvidenceVerdict & { childQuestionProposals?: unknown })
        .childQuestionProposals,
    ).toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(result.value, "childQuestions"),
    ).toBe(false);
  });

  it("any required facet state conflicting yields contradiction transition", async () => {
    const result = await service().apply(
      acceptedInput({
        verdict: "ambiguous_scope",
        facetStates: [
          {
            facetId: "purpose",
            state: "conflicting",
            reason: "two scopes",
          },
          {
            facetId: "components",
            state: "partial",
            reason: "thin",
          },
        ],
        referenceReviews: [
          {
            unitId: UNIT_A,
            classification: "conflicting",
            reason: "scope clash",
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transition).toEqual({
      done: false,
      activateP1: true,
      kind: "contradiction",
    });
  });

  it("blocked terminals yield done:false activateP1:false kind blocked", async () => {
    for (const verdict of [
      "human_authority_required",
      "source_processing_blocked",
      "ambiguous_scope",
    ] as const) {
      const result = await service().apply(
        acceptedInput({
          verdict,
          facetStates: [
            { facetId: "purpose", state: "ambiguous_scope", reason: "x" },
            { facetId: "components", state: "partial", reason: "x" },
          ],
          referenceReviews: [
            {
              unitId: UNIT_A,
              classification: "necessary_primary",
              reason: "ok",
            },
          ],
          criticisms: [verdict],
        }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.transition).toEqual({
        done: false,
        activateP1: false,
        kind: "blocked",
      });
    }
  });

  it("accepted must not carry follow-up", async () => {
    const result = await service().apply(acceptedInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.followUpRequest).toBeNull();
    expect(result.transition.activateP1).toBe(false);
    expect(result.transition.done).toBe(true);
  });
});

describe("apply — packet binding and input hygiene", () => {
  it("rejects missing packet", async () => {
    const result = await service({
      packets: { get: async () => undefined },
    }).apply(acceptedInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PACKET_NOT_FOUND");
  });

  it("rejects question mismatch with packet", async () => {
    const result = await service().apply(
      acceptedInput({
        questionId: "q-01ARZ3NDEKTSV4RRFFQ69G5FBW",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PACKET_MISMATCH");
  });

  it("rejects hostile accessors and unknown keys without throwing", async () => {
    let accessed = false;
    const hostile = {
      questionId: QUESTION,
      packetId: PACKET_ID,
      packetVersion: 1,
      requiredFacetIds: ["purpose", "components"],
      get referenceReviews() {
        accessed = true;
        throw new Error("should not run");
      },
      facetStates: [],
      verdict: "accepted",
      criticisms: [],
      followUpRequest: null,
    };
    const result = await service().apply(hostile);
    expect(accessed).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_INPUT");

    const unknown = await service().apply({
      ...acceptedInput(),
      evil: true,
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("INVALID_INPUT");

    const children = await service().apply({
      ...acceptedInput(),
      childQuestions: ["nope"],
    });
    expect(children.ok).toBe(false);
  });

  it("binds packetDigest from stored packet and freezes nested arrays", async () => {
    const result = await service().apply(acceptedInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.packetDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result.value.referenceReviews)).toBe(true);
    expect(Object.isFrozen(result.value.facetStates)).toBe(true);
    expect(Object.isFrozen(result.value.criticisms)).toBe(true);
  });

  it("rejects empty requiredFacetIds", async () => {
    const result = await service().apply(
      acceptedInput({ requiredFacetIds: [] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_INPUT");
  });
});

describe("append-only versions, CAS, idempotency (River §3.8)", () => {
  it("appends v2 without overwriting v1", async () => {
    const store = createInMemoryEvidenceVerdictStore();
    const svc = service({ store });
    const first = await svc.apply(acceptedInput());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await svc.apply(
      acceptedInput({
        criticisms: ["re-review"],
        expectedVersion: 1,
      }),
    );
    // River: one logical critic decision per packet version for success path —
    // different terminal/payload on same packetVersion without new packet → conflict
    // OR allow append-only history with expectedVersion. Prefer VERSION_CONFLICT
    // when different digest on same packetVersion without explicit supersede.
    // Binding: re-apply identical is replay; different → VERSION_CONFLICT when
    // prior exists without expectedVersion advancing stream carefully.
    // We lock: with expectedVersion:1, v2 append is allowed (audit history).
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.version).toBe(2);
    expect(second.value.id).toBe(first.value.id);

    const v1 = await svc.getVerdict(first.value.id, 1);
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    expect(v1.value.criticisms).toEqual([]);

    const v2 = await svc.getVerdict(first.value.id, 2);
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    expect(v2.value.criticisms).toEqual(["re-review"]);
  });

  it("rejects stale expectedVersion", async () => {
    const svc = service();
    await svc.apply(acceptedInput());
    const result = await svc.apply(
      acceptedInput({ expectedVersion: 0, criticisms: ["stale"] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VERSION_CONFLICT");
  });

  it("rejects second different verdict on same packetVersion without expectedVersion bump", async () => {
    const svc = service();
    const first = await svc.apply(acceptedInput());
    expect(first.ok).toBe(true);
    // No expectedVersion → cannot overwrite/replace accepted with different payload
    const second = await svc.apply(
      acceptedInput({ criticisms: ["sneaky upgrade"] }),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("VERSION_CONFLICT");
  });

  it("is idempotent for the same key and payload", async () => {
    const svc = service();
    const input = { ...acceptedInput(), idempotencyKey: "cmd-1" };
    const first = await svc.apply(input);
    const second = await svc.apply(input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.version).toBe(first.value.version);
  });

  it("rejects same idempotency key with different payload", async () => {
    const svc = service();
    const first = await svc.apply({
      ...acceptedInput(),
      idempotencyKey: "cmd-2",
    });
    expect(first.ok).toBe(true);
    const conflict = await svc.apply({
      ...acceptedInput({ criticisms: ["different"] }),
      idempotencyKey: "cmd-2",
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("durable store / crash / custody seams (River §3.9)", () => {
  it("exports createFileEvidenceVerdictStore", async () => {
    const mod = await import("./evidence-verdict-service.js");
    expect(typeof mod.createFileEvidenceVerdictStore).toBe("function");
  });

  it("survives fresh process latest/get for contiguous versions", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "evv-dur-"));
    try {
      const store = createFileEvidenceVerdictStore(root);
      const svc = createEvidenceVerdictService({
        store,
        packets: packetReader(),
        receipts: receiptReader(),
        verifier: verifierOk(),
        facets: defaultFacets(),
      });
      const first = await svc.apply(acceptedInput());
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      for (let version = 2; version <= 5; version += 1) {
        const next = await svc.apply(
          acceptedInput({
            criticisms: [`v${version}`],
            expectedVersion: version - 1,
          }),
        );
        expect(next.ok).toBe(true);
      }
      const freshSvc = createEvidenceVerdictService({
        store: createFileEvidenceVerdictStore(root),
        packets: packetReader(),
        receipts: receiptReader(),
        verifier: verifierOk(),
        facets: defaultFacets(),
      });
      const latest = await freshSvc.latest(first.value.id);
      expect(latest.ok).toBe(true);
      if (!latest.ok) return;
      expect(latest.value.version).toBe(5);
      const v3 = await freshSvc.getVerdict(first.value.id, 3);
      expect(v3.ok).toBe(true);
      if (!v3.ok) return;
      expect(v3.value.criticisms).toEqual(["v3"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("crash after temp write before publish leaves no readable half-verdict", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "evv-crash-"));
    try {
      const store = createFileEvidenceVerdictStore(root, {
        afterTempWriteBeforePublish: () => {
          throw new Error("injected-crash");
        },
      });
      const svc = createEvidenceVerdictService({
        store,
        packets: packetReader(),
        receipts: receiptReader(),
        verifier: verifierOk(),
        facets: defaultFacets(),
      });
      await expect(svc.apply(acceptedInput())).rejects.toThrow(
        /injected-crash/,
      );
      const fresh = createFileEvidenceVerdictStore(root);
      const latest = await fresh.latest(
        deriveEvidenceVerdictId(QUESTION, PACKET_ID),
      );
      expect(latest).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("durable idempotency survives restart and conflicts on different digest", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "evv-idem-"));
    try {
      const store = createFileEvidenceVerdictStore(root);
      const svc = createEvidenceVerdictService({
        store,
        packets: packetReader(),
        receipts: receiptReader(),
        verifier: verifierOk(),
        facets: defaultFacets(),
      });
      const first = await svc.apply({
        ...acceptedInput(),
        idempotencyKey: "dur-1",
      });
      expect(first.ok).toBe(true);
      const freshSvc = createEvidenceVerdictService({
        store: createFileEvidenceVerdictStore(root),
        packets: packetReader(),
        receipts: receiptReader(),
        verifier: verifierOk(),
        facets: defaultFacets(),
      });
      const replay = await freshSvc.apply({
        ...acceptedInput(),
        idempotencyKey: "dur-1",
      });
      expect(replay.ok).toBe(true);
      if (first.ok && replay.ok) {
        expect(replay.value.version).toBe(first.value.version);
      }
      const conflict = await createEvidenceVerdictService({
        store: createFileEvidenceVerdictStore(root),
        packets: packetReader(),
        receipts: receiptReader(),
        verifier: verifierOk(),
        facets: defaultFacets(),
      }).apply({
        ...acceptedInput({ criticisms: ["different"] }),
        idempotencyKey: "dur-1",
      });
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails closed when store root is a directory symlink", async () => {
    if (process.platform !== "linux") return;
    const base = await mkdtemp(join(tmpdir(), "evv-root-"));
    const outside = join(base, "outside");
    const linkRoot = join(base, "link");
    await mkdir(outside);
    await symlink(outside, linkRoot);
    const store = createFileEvidenceVerdictStore(linkRoot);
    await expect(
      store.append({
        schemaVersion: 1,
        id: deriveEvidenceVerdictId(QUESTION, PACKET_ID),
        questionId: QUESTION,
        packetId: PACKET_ID,
        packetVersion: 1,
        version: 1,
        referenceReviews: [],
        facetStates: [],
        verdict: "search_incomplete",
        criticisms: ["x"],
        followUpRequest: null,
        packetDigest: "a".repeat(64) as Sha256,
      } as EvidenceVerdict),
    ).rejects.toThrow(/symbolic|Refusing/i);
    await rm(base, { recursive: true, force: true });
  });

  it("fails closed on gap/malformed stream entries (no skip-to-later)", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "evv-gap-"));
    try {
      const store = createFileEvidenceVerdictStore(root);
      const svc = createEvidenceVerdictService({
        store,
        packets: packetReader(),
        receipts: receiptReader(),
        verifier: verifierOk(),
        facets: defaultFacets(),
      });
      const first = await svc.apply(acceptedInput());
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      // Path: .ultradyn/evidence-verdicts/<id>/ (River §3.9)
      const streamDir = join(
        root,
        ".ultradyn",
        "evidence-verdicts",
        first.value.id,
      );
      await writeFile(join(streamDir, "3.json"), "{not-json", "utf8");
      const fresh = createFileEvidenceVerdictStore(root);
      await expect(fresh.latest(first.value.id)).rejects.toThrow(
        /corrupt|malformed|gap|stream/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("public seams — full schema not placeholder (genuine RED)", () => {
  it("EvidenceVerdictSchema from domain module rejects legacy placeholder alone", () => {
    expect(
      EvidenceVerdictSchema.safeParse({
        schemaVersion: 1,
        id: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }).success,
    ).toBe(false);
  });

  it("EvidenceVerdictSchema from domain module accepts a complete verdict", () => {
    expect(
      EvidenceVerdictSchema.safeParse({
        schemaVersion: 1,
        id: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
        questionId: QUESTION,
        packetId: PACKET_ID,
        packetVersion: 1,
        version: 1,
        referenceReviews: [
          {
            unitId: UNIT_A,
            classification: "necessary_primary",
            reason: "x",
          },
        ],
        facetStates: [{ facetId: "purpose", state: "satisfied", reason: "x" }],
        verdict: "accepted",
        criticisms: [],
        followUpRequest: null,
        packetDigest: "a".repeat(64),
      }).success,
    ).toBe(true);
  });

  it("registry EvidenceVerdict rejects legacy placeholder and accepts full shape", async () => {
    const { ingestSchemaRegistry } =
      await import("../../domain/ingest/schema-registry.js");
    const schema = ingestSchemaRegistry.get("EvidenceVerdict", 1);
    expect(
      schema.safeParse({
        schemaVersion: 1,
        id: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        schemaVersion: 1,
        id: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
        questionId: QUESTION,
        packetId: PACKET_ID,
        packetVersion: 1,
        version: 1,
        referenceReviews: [
          {
            unitId: UNIT_A,
            classification: "necessary_primary",
            reason: "x",
          },
        ],
        facetStates: [{ facetId: "purpose", state: "satisfied", reason: "x" }],
        verdict: "accepted",
        criticisms: [],
        followUpRequest: null,
        packetDigest: "a".repeat(64),
      }).success,
    ).toBe(true);
  });

  it("domain barrel EvidenceVerdictSchema rejects placeholder (not soft typeof)", async () => {
    const barrel = await import("../../domain/ingest/index.js");
    const schema = (
      barrel as {
        EvidenceVerdictSchema: {
          safeParse: (v: unknown) => { success: boolean };
        };
      }
    ).EvidenceVerdictSchema;
    expect(typeof schema?.safeParse).toBe("function");
    expect(
      schema.safeParse({
        schemaVersion: 1,
        id: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }).success,
    ).toBe(false);
  });

  it("public knowledge barrel re-exports createEvidenceVerdictService", async () => {
    const barrel = await import("./index.js");
    expect(
      typeof (barrel as { createEvidenceVerdictService?: unknown })
        .createEvidenceVerdictService,
    ).toBe("function");
  });
});
