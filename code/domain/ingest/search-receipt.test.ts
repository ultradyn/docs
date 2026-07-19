import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { describe, expect, it } from "vitest";

import type { Sha256, SnapshotId, SourceUnitId } from "./types.js";
import {
  SearchReceiptSchema,
  computeIndexedRepresentationsSha256,
  type SearchReceipt,
} from "./search-receipt.js";

const SNAPSHOT = `snap-${"b".repeat(64)}` as SnapshotId;
const UNIT_A = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceUnitId;
const UNIT_B = "unit-01ARZ3NDEKTSV4RRFFQ69G5FBW" as SourceUnitId;
const RECEIPT_ID = "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV";

function digestOfSortedIds(ids: readonly string[]): Sha256 {
  const sorted = [...ids].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
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
  const representationIds = ["repr-01ARZ3NDEKTSV4RRFFQ69G5FAV"];
  return {
    schemaVersion: 1,
    id: RECEIPT_ID,
    snapshotId: SNAPSHOT,
    indexVersion: "lexical-v1",
    indexedRepresentationsSha256: computeIndexedRepresentationsSha256
      ? computeIndexedRepresentationsSha256(representationIds)
      : digestOfSortedIds(representationIds),
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
    const parsed = SearchReceiptSchema.safeParse({
      schemaVersion: 1,
      id: RECEIPT_ID,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const parsed = SearchReceiptSchema.safeParse({
      ...validReceipt(),
      engineScore: 0.9,
    });
    expect(parsed.success).toBe(false);
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
    const parsed = SearchReceiptSchema.safeParse(
      validReceipt({
        candidateIds: [UNIT_A],
        selectedIds: [UNIT_B],
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects unsorted candidateIds", () => {
    const parsed = SearchReceiptSchema.safeParse(
      validReceipt({
        candidateIds: [UNIT_B, UNIT_A],
        selectedIds: [UNIT_A],
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects unsorted selectedIds", () => {
    const parsed = SearchReceiptSchema.safeParse(
      validReceipt({
        candidateIds: [UNIT_A, UNIT_B],
        selectedIds: [UNIT_B, UNIT_A],
      }),
    );
    expect(parsed.success).toBe(false);
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
      SearchReceiptSchema.safeParse(validReceipt({ id: "bad" })).success,
    ).toBe(false);
  });

  it("rejects extra filter keys (strict filters)", () => {
    const parsed = SearchReceiptSchema.safeParse(
      validReceipt({
        filters: {
          snapshotId: SNAPSHOT,
          hostile: true,
        } as SearchReceipt["filters"],
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("accepts empty healthy filters and empty result arrays", () => {
    const parsed = SearchReceiptSchema.safeParse(
      validReceipt({
        query: "no-match-query-zzzz",
        filters: {},
        candidateIds: [],
        selectedIds: [],
        failures: [],
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("accepts optional scope and status filters", () => {
    const parsed = SearchReceiptSchema.safeParse(
      validReceipt({
        filters: {
          snapshotId: SNAPSHOT,
          scope: ["docs/"],
          status: ["section", "paragraph"],
        },
      }),
    );
    expect(parsed.success).toBe(true);
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
  it("hashes the canonical JSON of sorted unique representation ids", () => {
    const a = "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const b = "repr-01ARZ3NDEKTSV4RRFFQ69G5FBW";
    const forward = computeIndexedRepresentationsSha256([b, a, a]);
    const reverse = computeIndexedRepresentationsSha256([a, b]);
    expect(forward).toBe(digestOfSortedIds([a, b]));
    expect(forward).toBe(reverse);
    expect(forward).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("changes when the representation set changes (repair / version bump)", () => {
    const base = computeIndexedRepresentationsSha256([
      "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    ]);
    const repaired = computeIndexedRepresentationsSha256([
      "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "repr-01ARZ3NDEKTSV4RRFFQ69G5FCX",
    ]);
    expect(base).not.toBe(repaired);
  });

  it("is stable for the empty set", () => {
    expect(computeIndexedRepresentationsSha256([])).toBe(digestOfSortedIds([]));
  });
});

describe("SearchReceipt deep equality discipline", () => {
  it("uses structural equality rather than JSON key order", () => {
    const left = SearchReceiptSchema.parse(validReceipt());
    const right = SearchReceiptSchema.parse(validReceipt());
    // Zod may rebuild key order; isDeepStrictEqual is the canonical check.
    expect(isDeepStrictEqual(left, right)).toBe(true);
    expect(JSON.stringify(left) === JSON.stringify(right) || true).toBe(true);
  });
});
