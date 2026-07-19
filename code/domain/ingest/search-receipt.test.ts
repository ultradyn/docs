import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { describe, expect, it } from "vitest";

import type { Sha256, SnapshotId, SourceUnitId } from "./types.js";
import {
  SearchReceiptSchema,
  canonicalizeSearchFilters,
  computeIndexedRepresentationsSha256,
  type IndexedRepresentationBinding,
  type SearchReceipt,
} from "./search-receipt.js";

const SNAPSHOT = `snap-${"b".repeat(64)}` as SnapshotId;
const UNIT_A = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceUnitId;
const UNIT_B = "unit-01ARZ3NDEKTSV4RRFFQ69G5FBW" as SourceUnitId;
const RECEIPT_ID = "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV";

function binding(
  id: string,
  version = 1,
  sourceFileId = `file-${"a".repeat(64)}`,
  text = "body",
): IndexedRepresentationBinding {
  return {
    id,
    version,
    sourceFileId,
    normalizedTextSha256: createHash("sha256").update(text).digest("hex"),
  };
}

function digestOfBindings(
  records: readonly IndexedRepresentationBinding[],
): Sha256 {
  const byId = new Map(records.map((record) => [record.id, record]));
  const sorted = [...byId.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  return createHash("sha256")
    .update(JSON.stringify(sorted))
    .digest("hex") as Sha256;
}

function validReceipt(
  overrides: Partial<SearchReceipt> = {},
): Record<string, unknown> {
  const candidateIds = overrides.candidateIds ?? [UNIT_A, UNIT_B];
  const selectedIds = overrides.selectedIds ?? [UNIT_A];
  const bindings = [binding("repr-01ARZ3NDEKTSV4RRFFQ69G5FAV")];
  return {
    schemaVersion: 1,
    id: RECEIPT_ID,
    snapshotId: SNAPSHOT,
    indexVersion: "lexical-v1",
    indexedRepresentationsSha256: computeIndexedRepresentationsSha256(bindings),
    query: "deterministic source",
    filters: { snapshotId: SNAPSHOT },
    candidateIds,
    selectedIds,
    failures: [],
    ...overrides,
  };
}

describe("SearchReceiptSchema", () => {
  it("accepts a strict current portable receipt", () => {
    const input = validReceipt();
    const parsed = SearchReceiptSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.schemaVersion).toBe(1);
    expect(parsed.data.id).toBe(RECEIPT_ID);
    expect(parsed.data.snapshotId).toBe(SNAPSHOT);
    expect(parsed.data.indexVersion).toBe("lexical-v1");
    expect(parsed.data.query).toBe("deterministic source");
    expect(parsed.data.candidateIds).toEqual([UNIT_A, UNIT_B]);
    expect(parsed.data.selectedIds).toEqual([UNIT_A]);
    expect(parsed.data.failures).toEqual([]);
  });

  it("rejects the legacy placeholder shape {schemaVersion,id} alone", () => {
    expect(
      SearchReceiptSchema.safeParse({
        schemaVersion: 1,
        id: RECEIPT_ID,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(
      SearchReceiptSchema.safeParse({
        ...validReceipt(),
        engineScore: 0.9,
      }).success,
    ).toBe(false);
  });

  it("rejects empty indexVersion", () => {
    expect(
      SearchReceiptSchema.safeParse(validReceipt({ indexVersion: "" })).success,
    ).toBe(false);
  });

  it("rejects oversized indexVersion", () => {
    expect(
      SearchReceiptSchema.safeParse(
        validReceipt({ indexVersion: "x".repeat(257) }),
      ).success,
    ).toBe(false);
  });

  it("rejects a non-hex corpus digest", () => {
    expect(
      SearchReceiptSchema.safeParse(
        validReceipt({
          indexedRepresentationsSha256: "Z".repeat(64) as Sha256,
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects selectedIds that are not a subset of candidateIds", () => {
    expect(
      SearchReceiptSchema.safeParse(
        validReceipt({
          candidateIds: [UNIT_A],
          selectedIds: [UNIT_B],
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects unsorted candidateIds", () => {
    expect(
      SearchReceiptSchema.safeParse(
        validReceipt({
          candidateIds: [UNIT_B, UNIT_A],
          selectedIds: [UNIT_A],
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects unsorted selectedIds", () => {
    expect(
      SearchReceiptSchema.safeParse(
        validReceipt({
          candidateIds: [UNIT_A, UNIT_B],
          selectedIds: [UNIT_B, UNIT_A],
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects malformed unit ids in candidate/selected arrays", () => {
    expect(
      SearchReceiptSchema.safeParse(
        validReceipt({
          candidateIds: ["not-a-unit" as SourceUnitId],
          selectedIds: [],
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects malformed snapshot id", () => {
    expect(
      SearchReceiptSchema.safeParse(
        validReceipt({ snapshotId: "snap-not-hex" as SnapshotId }),
      ).success,
    ).toBe(false);
  });

  it("rejects malformed receipt id", () => {
    expect(
      SearchReceiptSchema.safeParse(
        validReceipt({ id: "bad" as SearchReceipt["id"] }),
      ).success,
    ).toBe(false);
  });

  it("rejects extra filter keys (strict filters)", () => {
    expect(
      SearchReceiptSchema.safeParse(
        validReceipt({
          filters: {
            snapshotId: SNAPSHOT,
            hostile: true,
          } as SearchReceipt["filters"],
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects legacy status filter key", () => {
    expect(
      SearchReceiptSchema.safeParse(
        validReceipt({
          filters: {
            status: ["section"],
          } as SearchReceipt["filters"],
        }),
      ).success,
    ).toBe(false);
  });

  it("accepts empty healthy filters and empty result arrays", () => {
    expect(
      SearchReceiptSchema.safeParse(
        validReceipt({
          query: "no-match-query-zzzz",
          filters: {},
          candidateIds: [],
          selectedIds: [],
          failures: [],
        }),
      ).success,
    ).toBe(true);
  });

  it("accepts optional scope and unitKinds filters", () => {
    expect(
      SearchReceiptSchema.safeParse(
        validReceipt({
          filters: {
            snapshotId: SNAPSHOT,
            scope: ["docs/"],
            unitKinds: ["section", "paragraph"],
          },
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects invalid unitKinds values", () => {
    expect(
      SearchReceiptSchema.safeParse(
        validReceipt({
          filters: {
            unitKinds: ["chapter" as "section"],
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("contains no source text fields", () => {
    const parsed = SearchReceiptSchema.safeParse(validReceipt());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect("content" in parsed.data).toBe(false);
    expect("text" in parsed.data).toBe(false);
    expect("normalizedText" in parsed.data).toBe(false);
    expect(JSON.stringify(parsed.data)).not.toMatch(/Body mentions/u);
  });
});

describe("computeIndexedRepresentationsSha256", () => {
  it("hashes sorted unique representation bindings, not bare ids", () => {
    const a = binding("repr-01ARZ3NDEKTSV4RRFFQ69G5FAV", 1, "file-a", "one");
    const b = binding("repr-01ARZ3NDEKTSV4RRFFQ69G5FBW", 1, "file-b", "two");
    const forward = computeIndexedRepresentationsSha256([b, a, a]);
    const reverse = computeIndexedRepresentationsSha256([a, b]);
    expect(forward).toBe(digestOfBindings([a, b]));
    expect(forward).toBe(reverse);
    expect(forward).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("changes when representation set membership changes", () => {
    const base = computeIndexedRepresentationsSha256([
      binding("repr-01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    ]);
    const repaired = computeIndexedRepresentationsSha256([
      binding("repr-01ARZ3NDEKTSV4RRFFQ69G5FAV"),
      binding("repr-01ARZ3NDEKTSV4RRFFQ69G5FCX"),
    ]);
    expect(base).not.toBe(repaired);
  });

  it("changes when the same id has different content digest", () => {
    const id = "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const before = computeIndexedRepresentationsSha256([
      binding(id, 1, "file-a", "original body"),
    ]);
    const after = computeIndexedRepresentationsSha256([
      binding(id, 1, "file-a", "repaired body"),
    ]);
    expect(before).not.toBe(after);
  });

  it("changes when version changes with same id and text", () => {
    const id = "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const v1 = computeIndexedRepresentationsSha256([
      binding(id, 1, "file-a", "same"),
    ]);
    const v2 = computeIndexedRepresentationsSha256([
      binding(id, 2, "file-a", "same"),
    ]);
    expect(v1).not.toBe(v2);
  });

  it("is stable for the empty set", () => {
    expect(computeIndexedRepresentationsSha256([])).toBe(digestOfBindings([]));
  });
});

describe("canonicalizeSearchFilters", () => {
  it("sorts and dedupes scope and unitKinds so order does not matter", () => {
    expect(
      canonicalizeSearchFilters({
        scope: ["docs/b", "docs/a", "docs/a"],
        unitKinds: ["paragraph", "section", "paragraph"],
      }),
    ).toEqual({
      scope: ["docs/a", "docs/b"],
      unitKinds: ["paragraph", "section"],
    });
  });
});

describe("SearchReceipt deep equality discipline", () => {
  it("uses structural equality rather than JSON key order", () => {
    const left = SearchReceiptSchema.parse(validReceipt());
    const right = SearchReceiptSchema.parse(validReceipt());
    expect(isDeepStrictEqual(left, right)).toBe(true);
  });
});
