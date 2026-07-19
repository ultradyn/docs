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

const SNAPSHOT = `snap-${"b".repeat(64)}` as SnapshotId;
const FILE_A = `file-${"a".repeat(64)}` as SourceFileId;
const UNIT_A = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceUnitId;
const QUESTION = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV" as QuestionId;

function sha(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}
const FILE_HASH_A = sha("file-a-bytes");
const UNIT_HASH_A = sha("unit-a-text");

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

function linksOk() {
  return {
    get: async (id: string) =>
      id === QUESTION
        ? { questionId: QUESTION, snapshotId: SNAPSHOT }
        : undefined,
  };
}

function refA() {
  return {
    snapshotId: SNAPSHOT,
    fileId: FILE_A,
    unitId: UNIT_A,
    fileSha256: FILE_HASH_A,
    unitSha256: UNIT_HASH_A,
    role: "primary" as const,
    facetIds: ["facet-core"],
  };
}

describe("fix-wave: receipts required + verify rehash", () => {
  it("createEvidenceService without receipts throws or rejects construction", () => {
    expect(() =>
      createEvidenceService({
        store: createInMemoryEvidencePacketStore(),
        links: linksOk() as never,
        // receipts omitted
      } as never),
    ).toThrow(/receipt/i);
  });

  it("verifyReferences always rehashes canonical receipt; missing receipt fails", async () => {
    const receipts = new Map<string, SearchReceipt>();
    const receipt = healthyReceipt();
    receipts.set(receipt.id, receipt);
    const svc = createEvidenceService({
      store: createInMemoryEvidencePacketStore(),
      links: linksOk() as never,
      receipts: { get: async (id) => receipts.get(id) },
    });
    const appended = await svc.appendPacket({
      questionId: QUESTION,
      references: [refA()],
      receipt,
      receiptDigest: receiptDigestOf(receipt),
      context: context(),
    });
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    receipts.delete(receipt.id);
    const missing = await svc.verifyReferences(
      appended.value.id,
      appended.value.version,
      context(),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(["RECEIPT_INVALID", "HASH_MISMATCH"]).toContain(missing.code);
    }
  });

  it("verifyReferences fails when stored receipt is tampered", async () => {
    const receipts = new Map<string, SearchReceipt>();
    const receipt = healthyReceipt();
    receipts.set(receipt.id, receipt);
    const svc = createEvidenceService({
      store: createInMemoryEvidencePacketStore(),
      links: linksOk() as never,
      receipts: { get: async (id) => receipts.get(id) },
    });
    const appended = await svc.appendPacket({
      questionId: QUESTION,
      references: [refA()],
      receipt,
      receiptDigest: receiptDigestOf(receipt),
      context: context(),
    });
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    receipts.set(receipt.id, healthyReceipt({ query: "tampered" }));
    const bad = await svc.verifyReferences(
      appended.value.id,
      appended.value.version,
      context(),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("RECEIPT_INVALID");
  });
});

describe("fix-wave: canonical digests", () => {
  it("receiptDigestOf is stable under filter key reorder", async () => {
    const a = receiptDigestOf(
      healthyReceipt({
        filters: { scope: ["docs"], unitKinds: ["section"] },
      }),
    );
    const b = receiptDigestOf(
      healthyReceipt({
        filters: { unitKinds: ["section"], scope: ["docs"] },
      }),
    );
    expect(a).toBe(b);
  });

  it("different payloads yield different digests", () => {
    expect(receiptDigestOf(healthyReceipt({ query: "a" }))).not.toBe(
      receiptDigestOf(healthyReceipt({ query: "b" })),
    );
  });
});

describe("fix-wave: descriptor-relative custody", () => {
  it("createFileEvidencePacketStore uses descriptor-relative leaf ops (no pathname dir leak API)", async () => {
    const mod = await import("./evidence-service.js");
    // Internal helper should not be exported as returning pathname-only dirs.
    expect(typeof (mod as { openBoundPath?: unknown }).openBoundPath).toBe(
      "undefined",
    );
    expect(typeof mod.createFileEvidencePacketStore).toBe("function");
  });

  it("parent component swap mid-operation does not read outside", async () => {
    if (process.platform !== "linux") {
      const store = createFileEvidencePacketStore("/tmp/nope");
      await expect(
        store.append({
          schemaVersion: 1,
          id: deriveEvidencePacketId(QUESTION),
          questionId: QUESTION,
          version: 1,
          references: [refA()],
          receiptId: healthyReceipt().id,
          receiptDigest: receiptDigestOf(healthyReceipt()),
          limits: { maxReferences: 8, maxFacetsPerReference: 4 },
        }),
      ).rejects.toThrow(/fail-closed|Descriptor|Refusing/i);
      return;
    }
    // Binding held via fd: after openBound walk, swapping .ultradyn to outside
    // must not allow successful outside write. We plant a root, write v1, then
    // swap an ancestor and attempt get — must fail closed or still read bound inode.
    const { mkdtemp, mkdir, symlink, rm, rename } =
      await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = await mkdtemp(join(tmpdir(), "ev-swap-"));
    const root = join(base, "root");
    const outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    const store = createFileEvidencePacketStore(root);
    const packet = {
      schemaVersion: 1 as const,
      id: deriveEvidencePacketId(QUESTION),
      questionId: QUESTION,
      version: 1,
      references: [refA()],
      receiptId: healthyReceipt().id,
      receiptDigest: receiptDigestOf(healthyReceipt()),
      limits: { maxReferences: 8, maxFacetsPerReference: 4 },
    };
    expect(await store.append(packet)).toBe("created");
    // Swap .ultradyn to outside
    await rename(join(root, ".ultradyn"), join(base, "ultradyn-moved"));
    await symlink(outside, join(root, ".ultradyn"));
    // Further appends/gets must not succeed writing into outside
    await expect(store.append({ ...packet, version: 2 })).rejects.toBeDefined();
    const { readdir } = await import("node:fs/promises");
    const outsideNames = await readdir(outside);
    expect(outsideNames.filter((n) => n.endsWith(".json"))).toEqual([]);
    await rm(base, { recursive: true, force: true });
  });
});
