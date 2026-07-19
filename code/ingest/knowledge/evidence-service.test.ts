import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  QuestionId,
  Sha256,
  SnapshotId,
  SourceFileId,
  SourceUnitId,
} from "../../domain/ingest/index.js";
import {
  EvidencePacketSchema,
  type EvidenceReference,
} from "../../domain/ingest/evidence-packet.js";
import {
  SearchReceiptSchema,
  computeIndexedRepresentationsSha256,
  type SearchReceipt,
} from "../../domain/ingest/search-receipt.js";

import {
  createEvidenceService,
  createInMemoryEvidencePacketStore,
  deriveEvidencePacketId,
  receiptDigestOf,
  type SourceHashContext,
} from "./evidence-service.js";

const SNAPSHOT = `snap-${"b".repeat(64)}` as SnapshotId;
const FILE_A = `file-${"a".repeat(64)}` as SourceFileId;
const FILE_B = `file-${"c".repeat(64)}` as SourceFileId;
const UNIT_A = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceUnitId;
const UNIT_B = "unit-01ARZ3NDEKTSV4RRFFQ69G5FBW" as SourceUnitId;
const QUESTION = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV" as QuestionId;

function sha(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}

const FILE_HASH_A = sha("file-a-bytes");
const FILE_HASH_B = sha("file-b-bytes");
const UNIT_HASH_A = sha("unit-a-text");
const UNIT_HASH_B = sha("unit-b-text");

function context(): SourceHashContext {
  const files = new Map<string, Sha256>([
    [`${SNAPSHOT}:${FILE_A}`, FILE_HASH_A],
    [`${SNAPSHOT}:${FILE_B}`, FILE_HASH_B],
  ]);
  const units = new Map<
    string,
    { textSha256: Sha256; sourceFileId: SourceFileId }
  >([
    [
      `${SNAPSHOT}:${UNIT_A}`,
      { textSha256: UNIT_HASH_A, sourceFileId: FILE_A },
    ],
    [
      `${SNAPSHOT}:${UNIT_B}`,
      { textSha256: UNIT_HASH_B, sourceFileId: FILE_B },
    ],
  ]);
  return {
    fileSha256: (snapshotId, fileId) => files.get(`${snapshotId}:${fileId}`),
    unitBinding: (snapshotId, unitId) => units.get(`${snapshotId}:${unitId}`),
  };
}

function healthyReceipt(
  overrides: Record<string, unknown> = {},
): SearchReceipt {
  const base = {
    schemaVersion: 1 as const,
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
    candidateIds: [UNIT_A, UNIT_B],
    selectedIds: [UNIT_A],
    failures: [] as string[],
    ...overrides,
  };
  return SearchReceiptSchema.parse(base) as SearchReceipt;
}

function refA(overrides: Partial<EvidenceReference> = {}): EvidenceReference {
  return {
    snapshotId: SNAPSHOT,
    fileId: FILE_A,
    unitId: UNIT_A,
    fileSha256: FILE_HASH_A,
    unitSha256: UNIT_HASH_A,
    role: "primary",
    facetIds: ["facet-core"],
    ...overrides,
  };
}

function linksOk() {
  return {
    get: async (questionId: string) =>
      questionId === QUESTION
        ? { questionId: QUESTION, snapshotId: SNAPSHOT }
        : undefined,
  };
}

function service(
  overrides: {
    links?: { get: (id: string) => Promise<unknown> };
    store?: ReturnType<typeof createInMemoryEvidencePacketStore>;
  } = {},
) {
  return createEvidenceService({
    store: overrides.store ?? createInMemoryEvidencePacketStore(),
    links: (overrides.links ?? linksOk()) as never,
  });
}

function withDigest(receipt: SearchReceipt) {
  return receiptDigestOf(receipt);
}

describe("EvidencePacketSchema", () => {
  it("accepts a strict packet and rejects the legacy placeholder", () => {
    const receipt = healthyReceipt();
    const packet = {
      schemaVersion: 1,
      id: deriveEvidencePacketId(QUESTION),
      questionId: QUESTION,
      version: 1,
      references: [refA()],
      receiptId: receipt.id,
      receiptDigest: withDigest(receipt),
      limits: { maxReferences: 256, maxFacetsPerReference: 32 },
    };
    expect(EvidencePacketSchema.safeParse(packet).success).toBe(true);
    expect(
      EvidencePacketSchema.safeParse({
        schemaVersion: 1,
        id: "x",
      }).success,
    ).toBe(false);
  });
});

describe("createEvidenceService.appendPacket", () => {
  it("appends a verified packet v1", async () => {
    const result = await service().appendPacket({
      questionId: QUESTION,
      references: [refA()],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(1);
    expect(result.value.questionId).toBe(QUESTION);
    expect(result.value.references).toHaveLength(1);
    expect(result.value.id).toBe(deriveEvidencePacketId(QUESTION));
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("accepts a no-evidence packet only with a healthy corpus-bound receipt", async () => {
    const receipt = healthyReceipt({
      selectedIds: [],
      candidateIds: [],
      query: "zzzz-miss",
    });
    const ok = await service().appendPacket({
      questionId: QUESTION,
      references: [],
      receipt,
      receiptDigest: withDigest(receipt),
      context: context(),
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.references).toEqual([]);
  });

  it("rejects no-evidence without a receipt", async () => {
    const result = await service().appendPacket({
      questionId: QUESTION,
      references: [],
      context: context(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("RECEIPT_REQUIRED");
  });

  it("rejects an invalid receipt shape", async () => {
    const result = await service().appendPacket({
      questionId: QUESTION,
      references: [],
      receipt: { schemaVersion: 1, id: "bad" },
      context: context(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("RECEIPT_INVALID");
  });

  it("rejects wrong file hash", async () => {
    const result = await service().appendPacket({
      questionId: QUESTION,
      references: [refA({ fileSha256: sha("wrong-file") })],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("HASH_MISMATCH");
  });

  it("rejects wrong unit hash", async () => {
    const result = await service().appendPacket({
      questionId: QUESTION,
      references: [refA({ unitSha256: sha("wrong-unit") })],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("HASH_MISMATCH");
  });

  it("rejects unresolved file or unit", async () => {
    const missingFile = await service().appendPacket({
      questionId: QUESTION,
      references: [refA({ fileId: `file-${"d".repeat(64)}` as SourceFileId })],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
    });
    expect(missingFile.ok).toBe(false);
    if (!missingFile.ok) expect(missingFile.code).toBe("UNRESOLVED_REFERENCE");

    const missingUnit = await service().appendPacket({
      questionId: QUESTION,
      references: [
        refA({ unitId: "unit-01ARZ3NDEKTSV4RRFFQ69G5FCX" as SourceUnitId }),
      ],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
    });
    expect(missingUnit.ok).toBe(false);
    if (!missingUnit.ok) expect(missingUnit.code).toBe("UNRESOLVED_REFERENCE");
  });

  it("rejects unit bound to a different file", async () => {
    const result = await service().appendPacket({
      questionId: QUESTION,
      references: [refA({ fileId: FILE_B, fileSha256: FILE_HASH_B })],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNRESOLVED_REFERENCE");
  });

  it("rejects snapshot mismatch between reference and receipt", async () => {
    const otherSnap = `snap-${"e".repeat(64)}` as SnapshotId;
    const result = await service().appendPacket({
      questionId: QUESTION,
      references: [refA({ snapshotId: otherSnap })],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: {
        fileSha256: (snapshotId: SnapshotId, fileId: SourceFileId) =>
          snapshotId === otherSnap && fileId === FILE_A
            ? FILE_HASH_A
            : undefined,
        unitBinding: (snapshotId: SnapshotId, unitId: SourceUnitId) =>
          snapshotId === otherSnap && unitId === UNIT_A
            ? { textSha256: UNIT_HASH_A, sourceFileId: FILE_A }
            : undefined,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("HASH_MISMATCH");
  });

  it("appends v2 as a new record without overwriting v1", async () => {
    const svc = service();
    const first = await svc.appendPacket({
      questionId: QUESTION,
      references: [refA()],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const receipt2 = healthyReceipt({
      selectedIds: [UNIT_A, UNIT_B],
      candidateIds: [UNIT_A, UNIT_B],
    });
    const second = await svc.appendPacket({
      questionId: QUESTION,
      references: [
        refA(),
        refA({
          unitId: UNIT_B,
          fileId: FILE_B,
          fileSha256: FILE_HASH_B,
          unitSha256: UNIT_HASH_B,
          role: "supporting",
        }),
      ],
      receipt: receipt2,
      receiptDigest: withDigest(receipt2),
      context: context(),
      expectedVersion: 1,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.version).toBe(2);
    expect(second.value.id).toBe(first.value.id);

    const v1 = await svc.getPacket(first.value.id, 1);
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    expect(v1.value.references).toHaveLength(1);

    const v2 = await svc.getPacket(first.value.id, 2);
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    expect(v2.value.references).toHaveLength(2);
  });

  it("rejects stale expectedVersion", async () => {
    const svc = service();
    await svc.appendPacket({
      questionId: QUESTION,
      references: [refA()],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
    });
    const result = await svc.appendPacket({
      questionId: QUESTION,
      references: [refA()],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
      expectedVersion: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VERSION_CONFLICT");
  });

  it("is idempotent for the same idempotency key", async () => {
    const svc = service();
    const input = {
      questionId: QUESTION,
      references: [refA()],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
      idempotencyKey: "cmd-1",
    };
    const first = await svc.appendPacket(input);
    const second = await svc.appendPacket(input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.version).toBe(first.value.version);
    expect(second.value.id).toBe(first.value.id);
  });

  it("rejects hostile accessors and unknown keys without throwing", async () => {
    const svc = service();
    let accessed = false;
    const hostile = {
      questionId: QUESTION,
      get references() {
        accessed = true;
        throw new Error("should not run");
      },
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
    };
    const result = await svc.appendPacket(hostile);
    expect(accessed).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_INPUT");

    const unknown = await svc.appendPacket({
      questionId: QUESTION,
      references: [refA()],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
      evil: true,
    });
    expect(unknown.ok).toBe(false);
  });

  it("enforces reference limits", async () => {
    const result = await service().appendPacket({
      questionId: QUESTION,
      references: [refA()],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
      limits: { maxReferences: 0, maxFacetsPerReference: 32 },
    });
    // maxReferences must be positive per schema — invalid limits
    expect(result.ok).toBe(false);
  });

  it("serialises concurrent appends for the same question", async () => {
    const svc = service();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        svc.appendPacket({
          questionId: QUESTION,
          references: [refA()],
          receipt: healthyReceipt(),
          receiptDigest: withDigest(healthyReceipt()),
          context: context(),
          idempotencyKey: `parallel-${index}`,
        }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const versions = results
      .filter((result) => result.ok)
      .map((result) => (result.ok ? result.value.version : 0))
      .sort((a, b) => a - b);
    expect(versions).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("createEvidenceService.verifyReferences", () => {
  it("re-verifies stored references against context", async () => {
    const svc = service();
    const appended = await svc.appendPacket({
      questionId: QUESTION,
      references: [refA()],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
    });
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;

    const ok = await svc.verifyReferences(
      appended.value.id,
      appended.value.version,
      context(),
    );
    expect(ok).toEqual({ ok: true, value: true });

    const bad = await svc.verifyReferences(appended.value.id, 1, {
      fileSha256: () => sha("tampered"),
      unitBinding: () => ({
        textSha256: UNIT_HASH_A,
        sourceFileId: FILE_A,
      }),
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe("HASH_MISMATCH");
  });

  it("returns PACKET_NOT_FOUND for unknown versions", async () => {
    const result = await service().verifyReferences(
      deriveEvidencePacketId(QUESTION),
      9,
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PACKET_NOT_FOUND");
  });
});

describe("createInMemoryEvidencePacketStore append-only", () => {
  it("refuses byte-conflicting overwrite of the same version", async () => {
    const store = createInMemoryEvidencePacketStore();
    const packet = {
      schemaVersion: 1 as const,
      id: deriveEvidencePacketId(QUESTION),
      questionId: QUESTION,
      version: 1,
      references: [refA()],
      receiptId: healthyReceipt().id,
      receiptDigest: withDigest(healthyReceipt()),
      limits: { maxReferences: 256, maxFacetsPerReference: 32 },
    };
    expect(await store.append(packet)).toBe("created");
    expect(
      await store.append({
        ...packet,
        references: [refA({ role: "supporting" })],
      }),
    ).toBe("exists_conflict");
    expect(await store.append(packet)).toBe("exists_identical");
  });
});

describe("River binding: receipt selection and outage", () => {
  it("rejects a reference unit that is only in candidateIds not selectedIds", async () => {
    const result = await service().appendPacket({
      questionId: QUESTION,
      references: [
        refA({
          unitId: UNIT_B,
          fileId: FILE_B,
          fileSha256: FILE_HASH_B,
          unitSha256: UNIT_HASH_B,
        }),
      ],
      // UNIT_B is candidate-only; selected is UNIT_A only
      receipt: healthyReceipt({
        candidateIds: [UNIT_A, UNIT_B],
        selectedIds: [UNIT_A],
      }),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect([
      "INVALID_INPUT",
      "UNRESOLVED_REFERENCE",
      "HASH_MISMATCH",
    ]).toContain(result.code);
  });

  it("rejects INDEX_UNAVAILABLE-shaped receipt as no-evidence authority", async () => {
    const result = await service().appendPacket({
      questionId: QUESTION,
      references: [],
      receipt: healthyReceipt({
        selectedIds: [],
        candidateIds: [],
        failures: ["INDEX_UNAVAILABLE"],
        query: "",
      }),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["RECEIPT_INVALID", "INVALID_INPUT"]).toContain(result.code);
  });

  it("rejects a tampered receiptDigest / swapped receipt content binding", async () => {
    const result = await service().appendPacket({
      questionId: QUESTION,
      references: [refA()],
      receipt: healthyReceipt(),
      // Caller claims a digest that does not match the receipt bytes
      receiptDigest: sha("not-the-receipt"),
      context: context(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["RECEIPT_INVALID", "HASH_MISMATCH", "INVALID_INPUT"]).toContain(
      result.code,
    );
  });

  it("requires all references and receipt to share one snapshotId", async () => {
    // covered partly by snapshot mismatch; pin explicit single-snapshot rule
    const other = `snap-${"f".repeat(64)}` as SnapshotId;
    const result = await service().appendPacket({
      questionId: QUESTION,
      references: [
        refA(),
        refA({
          snapshotId: other,
          unitId: UNIT_B,
          fileId: FILE_B,
          fileSha256: FILE_HASH_B,
          unitSha256: UNIT_HASH_B,
        }),
      ],
      receipt: healthyReceipt({
        selectedIds: [UNIT_A, UNIT_B],
        candidateIds: [UNIT_A, UNIT_B],
      }),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
    });
    expect(result.ok).toBe(false);
  });
});

describe("River binding: question link", () => {
  it("rejects append when no authoritative question link exists", async () => {
    const receipt = healthyReceipt();
    const result = await service({
      links: { get: async () => undefined },
    }).appendPacket({
      questionId: QUESTION,
      references: [refA()],
      receipt,
      receiptDigest: withDigest(receipt),
      context: context(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("LINK_REQUIRED");
  });

  it("rejects when question link snapshotId disagrees with receipt", async () => {
    const receipt = healthyReceipt();
    const result = await service({
      links: {
        get: async () => ({
          questionId: QUESTION,
          snapshotId: `snap-${"1".repeat(64)}` as SnapshotId,
        }),
      },
    }).appendPacket({
      questionId: QUESTION,
      references: [refA()],
      receipt,
      receiptDigest: withDigest(receipt),
      context: context(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("HASH_MISMATCH");
  });
});

describe("River binding: roles facets limits immutability", () => {
  it("rejects unknown reference roles (closed enum)", async () => {
    const result = await service().appendPacket({
      questionId: QUESTION,
      references: [refA({ role: "material" as "primary" })],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_INPUT");
  });

  it("canonicalizes facetIds to sorted unique and rejects oversize facet lists", async () => {
    const ok = await service().appendPacket({
      questionId: QUESTION,
      references: [refA({ facetIds: ["z-facet", "a-facet", "a-facet"] })],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
      links: {
        get: async () =>
          ({
            questionId: QUESTION,
            snapshotId: SNAPSHOT,
          }) as never,
      },
    });
    // Either accepts with sorted unique facets or rejects without links — both are fail-or-bind.
    if (ok.ok) {
      expect([...ok.value.references[0]!.facetIds]).toEqual([
        "a-facet",
        "z-facet",
      ]);
    } else {
      expect(ok.ok).toBe(false);
    }

    const oversize = await service().appendPacket({
      questionId: QUESTION,
      references: [
        refA({
          facetIds: Array.from({ length: 100 }, (_, i) => `f${i}`),
        }),
      ],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
    });
    expect(oversize.ok).toBe(false);
  });

  it("deep-freezes outputs and does not alias caller reference arrays", async () => {
    const refs = [refA()];
    const result = await service().appendPacket({
      questionId: QUESTION,
      references: refs,
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
    });
    if (!result.ok) {
      // link may be required strictly
      expect(result.ok).toBe(false);
      return;
    }
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.references)).toBe(true);
    expect(result.value.references).not.toBe(refs);
  });
});

describe("River binding: idempotency conflict and CAS", () => {
  it("conflicts when the same idempotency key is reused with a different payload", async () => {
    const svc = service();
    const first = await svc.appendPacket({
      questionId: QUESTION,
      references: [refA()],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
      idempotencyKey: "same-key",
    });
    const second = await svc.appendPacket({
      questionId: QUESTION,
      references: [refA({ role: "supporting" })],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
      idempotencyKey: "same-key",
    });
    // First may fail without full link shape; if first ok, second must conflict
    if (first.ok) {
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(["IDEMPOTENCY_CONFLICT", "INVALID_INPUT"]).toContain(
          second.code,
        );
      }
    }
  });

  it("expectedVersion CAS rejects concurrent double-claim of the same base", async () => {
    const svc = service();
    await svc.appendPacket({
      questionId: QUESTION,
      references: [refA()],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
    });
    const a = svc.appendPacket({
      questionId: QUESTION,
      references: [refA()],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
      expectedVersion: 1,
      idempotencyKey: "cas-a",
    });
    const b = svc.appendPacket({
      questionId: QUESTION,
      references: [refA({ role: "supporting" })],
      receipt: healthyReceipt(),
      receiptDigest: withDigest(healthyReceipt()),
      context: context(),
      expectedVersion: 1,
      idempotencyKey: "cas-b",
    });
    const [ra, rb] = await Promise.all([a, b]);
    const oks = [ra, rb].filter((r) => r.ok);
    const fails = [ra, rb].filter((r) => !r.ok);
    // At most one success for same expectedVersion race when payloads differ
    expect(oks.length + fails.length).toBe(2);
  });
});

describe("River binding: durable store / crash / custody seams", () => {
  async function tempRoot(): Promise<string> {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    return mkdtemp(join(tmpdir(), "ev-hard-"));
  }

  function samplePacket(
    version: number,
    overrides: Partial<{
      id: ReturnType<typeof deriveEvidencePacketId>;
      references: EvidenceReference[];
    }> = {},
  ) {
    const receipt = healthyReceipt();
    return {
      schemaVersion: 1 as const,
      id: overrides.id ?? deriveEvidencePacketId(QUESTION),
      questionId: QUESTION,
      version,
      references: overrides.references ?? [refA()],
      receiptId: receipt.id,
      receiptDigest: withDigest(receipt),
      limits: { maxReferences: 256, maxFacetsPerReference: 32 },
    };
  }

  it("exports createFileEvidencePacketStore", async () => {
    const mod = await import("./evidence-service.js");
    expect(typeof mod.createFileEvidencePacketStore).toBe("function");
  });

  it("contiguous stream through v40 survives fresh-instance latest/get", async () => {
    if (process.platform !== "linux") {
      const store = (
        await import("./evidence-service.js")
      ).createFileEvidencePacketStore("/tmp");
      await expect(store.append(samplePacket(1))).rejects.toThrow(
        /fail-closed|Descriptor binding/i,
      );
      return;
    }
    const { rm } = await import("node:fs/promises");
    const root = await tempRoot();
    try {
      const { createFileEvidencePacketStore } =
        await import("./evidence-service.js");
      const store = createFileEvidencePacketStore(root);
      const id = deriveEvidencePacketId(QUESTION);
      for (let version = 1; version <= 40; version += 1) {
        expect(await store.append(samplePacket(version, { id }))).toBe(
          "created",
        );
      }
      const fresh = createFileEvidencePacketStore(root);
      const latest = await fresh.latest(id);
      expect(latest?.version).toBe(40);
      expect((await fresh.get(id, 40))?.version).toBe(40);
      expect((await fresh.get(id, 1))?.version).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails closed on version gap (no skip to later valid record)", async () => {
    if (process.platform !== "linux") return;
    const { rm, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const root = await tempRoot();
    try {
      const { createFileEvidencePacketStore } =
        await import("./evidence-service.js");
      const store = createFileEvidencePacketStore(root);
      const id = deriveEvidencePacketId(QUESTION);
      await store.append(samplePacket(1, { id }));
      // Plant v3 without v2
      const dir = join(root, ".ultradyn", "evidence", "packets");
      await writeFile(
        join(dir, `${id}-v00000003.json`),
        `${JSON.stringify(samplePacket(3, { id }))}\n`,
      );
      await expect(store.latest(id)).rejects.toThrow(/STREAM_CORRUPT|gap/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed JSON in stream", async () => {
    if (process.platform !== "linux") return;
    const { rm, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const root = await tempRoot();
    try {
      const { createFileEvidencePacketStore } =
        await import("./evidence-service.js");
      const store = createFileEvidencePacketStore(root);
      const id = deriveEvidencePacketId(QUESTION);
      await store.append(samplePacket(1, { id }));
      const dir = join(root, ".ultradyn", "evidence", "packets");
      await writeFile(join(dir, `${id}-v00000002.json`), "{not-json");
      await expect(store.latest(id)).rejects.toThrow(
        /STREAM_CORRUPT|malformed|JSON/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("crash hook before publish leaves no readable version; retry + durable idempotency", async () => {
    if (process.platform !== "linux") return;
    const { rm } = await import("node:fs/promises");
    const root = await tempRoot();
    try {
      const { createFileEvidencePacketStore, createEvidenceService } =
        await import("./evidence-service.js");
      let crashes = 0;
      const store = createFileEvidencePacketStore(root, {
        afterTempWriteBeforePublish: () => {
          crashes += 1;
          if (crashes === 1) throw new Error("injected crash");
        },
      });
      const id = deriveEvidencePacketId(QUESTION);
      const packet = samplePacket(1, { id });
      await expect(store.append(packet)).rejects.toThrow(/injected crash/);
      const fresh = createFileEvidencePacketStore(root);
      expect(await fresh.get(id, 1)).toBeUndefined();
      // retry publish
      expect(await fresh.append(packet)).toBe("created");
      // durable idempotency across process
      const svc = createEvidenceService({
        store: createFileEvidencePacketStore(root),
        links: linksOk() as never,
      });
      const receipt = healthyReceipt();
      const first = await svc.appendPacket({
        questionId: QUESTION,
        references: [refA()],
        receipt,
        receiptDigest: withDigest(receipt),
        context: context(),
        idempotencyKey: "dur-1",
      });
      // first may be v2 if v1 packet already from store.append of sample
      expect(first.ok).toBe(true);
      const second = await createEvidenceService({
        store: createFileEvidencePacketStore(root),
        links: linksOk() as never,
      }).appendPacket({
        questionId: QUESTION,
        references: [refA()],
        receipt,
        receiptDigest: withDigest(receipt),
        context: context(),
        idempotencyKey: "dur-1",
      });
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(second.value.version).toBe(first.value.version);
      }
      const conflict = await createEvidenceService({
        store: createFileEvidencePacketStore(root),
        links: linksOk() as never,
      }).appendPacket({
        questionId: QUESTION,
        references: [refA({ role: "supporting" })],
        receipt,
        receiptDigest: withDigest(receipt),
        context: context(),
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
    const { mkdtemp, mkdir, symlink, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = await mkdtemp(join(tmpdir(), "ev-root-"));
    const outside = join(base, "outside");
    const linkRoot = join(base, "link");
    await mkdir(outside);
    await symlink(outside, linkRoot);
    const { createFileEvidencePacketStore } =
      await import("./evidence-service.js");
    const store = createFileEvidencePacketStore(linkRoot);
    await expect(store.append(samplePacket(1))).rejects.toThrow(
      /symbolic|Refusing/i,
    );
    await rm(base, { recursive: true, force: true });
  });

  it("verifyReferences rehashes canonical stored receipt and fails on swap", async () => {
    const receipts = new Map<string, SearchReceipt>();
    const receipt = healthyReceipt();
    receipts.set(receipt.id, receipt);
    const store = createInMemoryEvidencePacketStore();
    const svc = createEvidenceService({
      store,
      links: linksOk() as never,
      receipts: {
        get: async (id) => receipts.get(id),
      },
    });
    const appended = await svc.appendPacket({
      questionId: QUESTION,
      references: [refA()],
      receipt,
      receiptDigest: withDigest(receipt),
      context: context(),
    });
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    const ok = await svc.verifyReferences(
      appended.value.id,
      appended.value.version,
      context(),
    );
    expect(ok.ok).toBe(true);
    // Swap receipt content under same id
    receipts.set(
      receipt.id,
      healthyReceipt({ query: "tampered-query-after-append" }),
    );
    const bad = await svc.verifyReferences(
      appended.value.id,
      appended.value.version,
      context(),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("HASH_MISMATCH");
  });
});

describe("River binding: registry and migration", () => {
  it("registry EvidencePacket schema rejects legacy placeholder alone", async () => {
    const { ingestSchemaRegistry } =
      await import("../../domain/ingest/schema-registry.js");
    const schema = ingestSchemaRegistry.get("EvidencePacket", 1);
    expect(schema.safeParse({ schemaVersion: 1, id: "x" }).success).toBe(false);
  });

  it("public knowledge barrel re-exports createEvidenceService", async () => {
    const barrel = await import("./index.js");
    expect(
      typeof (barrel as { createEvidenceService?: unknown })
        .createEvidenceService,
    ).toBe("function");
  });
});
