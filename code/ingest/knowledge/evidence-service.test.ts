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

function healthyReceipt(overrides: Partial<SearchReceipt> = {}): SearchReceipt {
  const base = {
    schemaVersion: 1 as const,
    id: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SearchReceipt["id"],
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
    candidateIds: [UNIT_A, UNIT_B] as SourceUnitId[],
    selectedIds: [UNIT_A] as SourceUnitId[],
    failures: [] as string[],
    ...overrides,
  };
  return SearchReceiptSchema.parse(base);
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

function service() {
  return createEvidenceService({ store: createInMemoryEvidencePacketStore() });
}

describe("EvidencePacketSchema", () => {
  it("accepts a strict packet and rejects the legacy placeholder", () => {
    const packet = {
      schemaVersion: 1,
      id: deriveEvidencePacketId(QUESTION),
      questionId: QUESTION,
      version: 1,
      references: [refA()],
      receiptId: healthyReceipt().id,
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
    const ok = await service().appendPacket({
      questionId: QUESTION,
      references: [],
      receipt: healthyReceipt({
        selectedIds: [],
        candidateIds: [],
        query: "zzzz-miss",
      }),
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
      context: {
        fileSha256: (snapshotId, fileId) =>
          snapshotId === otherSnap && fileId === FILE_A
            ? FILE_HASH_A
            : undefined,
        unitBinding: (snapshotId, unitId) =>
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
      context: context(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

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
      receipt: healthyReceipt({
        selectedIds: [UNIT_A, UNIT_B],
        candidateIds: [UNIT_A, UNIT_B],
      }),
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
      context: context(),
    });
    const result = await svc.appendPacket({
      questionId: QUESTION,
      references: [refA()],
      receipt: healthyReceipt(),
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
