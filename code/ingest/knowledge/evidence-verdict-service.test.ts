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
  createFileEvidenceVerdictStore,
  deriveEvidenceVerdictId,
  type EvidencePacketReader,
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

function packetReader(
  p: EvidencePacket = packet(),
): EvidencePacketReader {
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
          }
        : undefined,
  };
}

function acceptedInput(overrides: Record<string, unknown> = {}) {
  return {
    questionId: QUESTION,
    evidencePacketId: PACKET_ID,
    packetVersion: 1,
    requiredFacets: ["purpose", "components"],
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

function service(
  overrides: {
    packets?: EvidencePacketReader;
    receipts?: ReceiptFailureReader;
    store?: ReturnType<typeof createInMemoryEvidenceVerdictStore>;
  } = {},
) {
  return createEvidenceVerdictService({
    store: overrides.store ?? createInMemoryEvidenceVerdictStore(),
    packets: overrides.packets ?? packetReader(),
    receipts: overrides.receipts ?? receiptReader(),
  });
}

describe("EvidenceVerdictSchema (service surface)", () => {
  it("accepts full accepted shape once domain is complete", () => {
    // Soft: service tests primarily exercise apply; domain suite is authoritative.
    const sample = {
      schemaVersion: 1,
      id: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      questionId: QUESTION,
      evidencePacketId: PACKET_ID,
      packetVersion: 1,
      version: 1,
      referenceReviews: [
        {
          unitId: UNIT_A,
          classification: "necessary_primary",
          reason: "x",
        },
      ],
      facetStates: [
        { facetId: "purpose", state: "satisfied", reason: "x" },
      ],
      verdict: "accepted",
      criticisms: [],
      followUpRequest: null,
      packetDigest: "a".repeat(64),
    };
    expect(EvidenceVerdictSchema.safeParse(sample).success).toBe(true);
  });
});

describe("createEvidenceVerdictService construction", () => {
  it("requires packets reader at construction", () => {
    expect(() =>
      createEvidenceVerdictService({
        store: createInMemoryEvidenceVerdictStore(),
        receipts: receiptReader(),
      } as never),
    ).toThrow(/packets/i);
  });

  it("requires receipts reader at construction", () => {
    expect(() =>
      createEvidenceVerdictService({
        store: createInMemoryEvidenceVerdictStore(),
        packets: packetReader(),
      } as never),
    ).toThrow(/receipts/i);
  });
});

describe("apply — accepted lifecycle", () => {
  it("accepts when every required facet is satisfied and every packet ref classified", async () => {
    const result = await service().apply(acceptedInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe("accepted");
    expect(result.value.version).toBe(1);
    expect(result.value.id).toBe(deriveEvidenceVerdictId(QUESTION, PACKET_ID));
    expect(result.value.referenceReviews).toHaveLength(2);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(result.value.followUpRequest).toBeNull();
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
    const result = await service().apply(
      acceptedInput({
        requiredFacets: ["purpose", "components", "boundary"],
        facetStates: [
          {
            facetId: "purpose",
            state: "satisfied",
            sourceUnitIds: [UNIT_A],
            reason: "ok",
          },
          {
            facetId: "components",
            state: "satisfied",
            sourceUnitIds: [UNIT_B],
            reason: "ok",
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("FACET_UNSATISFIED");
  });

  it("rejects accepted when a material packet reference is unclassified", async () => {
    const result = await service().apply(
      acceptedInput({
        referenceReviews: [
          {
            unitId: UNIT_A,
            classification: "necessary_primary",
            reason: "ok",
          },
          // UNIT_B missing
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("REFERENCE_UNCLASSIFIED");
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
            unitId: UNIT_B,
            classification: "necessary_qualifying",
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
});

describe("apply — retrieval outage cannot become no_supported_answer", () => {
  it("rejects no_supported_answer when receipt carries INDEX_UNAVAILABLE", async () => {
    const p = packet();
    const result = await service({
      packets: packetReader(p),
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
          {
            unitId: UNIT_B,
            classification: "unverifiable",
            reason: "outage",
          },
        ],
        criticisms: ["index unavailable"],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("RETRIEVAL_OUTAGE");
  });

  it("rejects no_supported_answer for generic retrieval failure codes", async () => {
    const result = await service({
      receipts: receiptReader(["RETRIEVAL_UNAVAILABLE"]),
    }).apply(
      acceptedInput({
        verdict: "no_supported_answer",
        facetStates: [
          { facetId: "purpose", state: "missing", reason: "x" },
          { facetId: "components", state: "missing", reason: "x" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("RETRIEVAL_OUTAGE");
  });

  it("allows no_supported_answer only with a healthy receipt and full classification", async () => {
    const emptyPacket = packet({ references: [] });
    const healthy = receipt({ selectedIds: [], candidateIds: [] });
    const result = await service({
      packets: packetReader(emptyPacket),
      receipts: {
        get: async () => ({
          id: healthy.id,
          failures: [],
          selectedIds: [],
        }),
      },
    }).apply({
      questionId: QUESTION,
      evidencePacketId: PACKET_ID,
      packetVersion: 1,
      requiredFacets: ["purpose"],
      referenceReviews: [],
      facetStates: [
        {
          facetId: "purpose",
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
        criticisms: ["index outage"],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe("search_incomplete");
  });
});

describe("apply — needs_more_evidence and contradiction", () => {
  it("requires bounded followUpRequest for needs_more_evidence", async () => {
    const missing = await service().apply(
      acceptedInput({
        verdict: "needs_more_evidence",
        facetStates: [
          { facetId: "purpose", state: "partial", reason: "thin" },
          { facetId: "components", state: "missing", reason: "gap" },
        ],
        followUpRequest: null,
      }),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("FOLLOW_UP_REQUIRED");

    const ok = await service().apply(
      acceptedInput({
        verdict: "needs_more_evidence",
        facetStates: [
          { facetId: "purpose", state: "partial", reason: "thin" },
          { facetId: "components", state: "missing", reason: "gap" },
        ],
        followUpRequest: {
          missingFacets: ["components"],
          requiredSearch: {
            subject: "component list",
            scope: "docs",
            exclusions: [],
          },
          whyCurrentPacketFails: "components facet unsupported",
        },
      }),
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.verdict).toBe("needs_more_evidence");
    expect(ok.value.followUpRequest).not.toBeNull();
  });

  it("conflicting_or_deprecated yields P1 activation done:false without child proposals", async () => {
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
    // Activation command is a sibling of the durable verdict, not a child proposal.
    expect(result.activation).toEqual({
      priority: "P1",
      done: false,
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

  it("accepted must not carry follow-up or activation", async () => {
    const result = await service().apply(acceptedInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.followUpRequest).toBeNull();
    expect(result.activation).toBeUndefined();
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
      evidencePacketId: PACKET_ID,
      packetVersion: 1,
      requiredFacets: ["purpose", "components"],
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
});

describe("append-only versions, CAS, idempotency", () => {
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

describe("durable store / crash / custody seams", () => {
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
      const fresh = createFileEvidenceVerdictStore(root);
      const freshSvc = createEvidenceVerdictService({
        store: fresh,
        packets: packetReader(),
        receipts: receiptReader(),
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
      });
      await expect(svc.apply(acceptedInput())).rejects.toThrow(/injected-crash/);
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
        evidencePacketId: PACKET_ID,
        packetVersion: 1,
        version: 1,
        referenceReviews: [],
        facetStates: [],
        verdict: "search_incomplete",
        criticisms: ["x"],
        followUpRequest: null,
        packetDigest: "a".repeat(64),
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
      });
      const first = await svc.apply(acceptedInput());
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      // Corrupt by writing a gap file / malformed sibling under the stream dir.
      // Implementation places records under .ultradyn/evidence/verdicts/<id>/
      const streamDir = join(
        root,
        ".ultradyn",
        "evidence",
        "verdicts",
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

describe("public seams and registry", () => {
  it("registry EvidenceVerdict rejects legacy placeholder alone", async () => {
    const { ingestSchemaRegistry } =
      await import("../../domain/ingest/schema-registry.js");
    const schema = ingestSchemaRegistry.get("EvidenceVerdict", 1);
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

  it("domain barrel re-exports EvidenceVerdictSchema", async () => {
    const barrel = await import("../../domain/ingest/index.js");
    expect(
      typeof (barrel as { EvidenceVerdictSchema?: { safeParse?: unknown } })
        .EvidenceVerdictSchema?.safeParse,
    ).toBe("function");
  });
});
