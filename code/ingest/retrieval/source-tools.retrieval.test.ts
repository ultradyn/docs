/**
 * T-30-01 RED — retrieval surface.
 * exact + lexical return filtered results with receipts; open_unit via UnitStore seam.
 */
import { describe, expect, it } from "vitest";

import type { SnapshotId, SourceUnitId } from "../../domain/ingest/index.js";
import { SearchReceiptSchema } from "../../domain/ingest/search-receipt.js";

import { createSourceTools } from "./source-tools.js";
import {
  createFakeUnitAccessResolver,
  createFakeUnitStore,
  createFakePolicyGate,
  createFakeExactMap,
  createFakeLexicalIndex,
} from "./testing.js";

const SNAPSHOT = `snap-${"b".repeat(64)}` as SnapshotId;
const UNIT_A = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceUnitId;
const UNIT_B = "unit-01ARZ3NDEKTSV4RRFFQ69G5FBW" as SourceUnitId;

function tools(overrides: Record<string, unknown> = {}) {
  return createSourceTools({
    profileId: "policy-docs",
    principalId: "session:researcher-1",
    snapshotId: SNAPSHOT,
    policyGate: createFakePolicyGate({
      allow: [UNIT_A],
      deny: [UNIT_B],
    }),
    units: createFakeUnitAccessResolver({
      allowed: { [UNIT_A]: true, [UNIT_B]: false },
    }),
    unitStore: createFakeUnitStore({
      [UNIT_A]: {
        unitId: UNIT_A,
        textSha256: "a".repeat(64),
        text: "delivery worker retries endpoints",
      },
    }),
    exactMap: createFakeExactMap({
      hits: [
        { unitId: UNIT_A, score: 1 },
        { unitId: UNIT_B, score: 0.5 },
      ],
    }),
    lexicalIndex: createFakeLexicalIndex({
      hits: [
        { unitId: UNIT_A, score: 1 },
        { unitId: UNIT_B, score: 0.4 },
      ],
    }),
    ...overrides,
  });
}

describe("retrieval — exact", () => {
  it("exact returns filtered response (never raw) with receipt", async () => {
    const api = tools();
    const result = await api.exact({ query: "delivery" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filtered).toBeDefined();
    expect(result.value.filtered.selectedIds).toContain(UNIT_A);
    expect(result.value.filtered.selectedIds).not.toContain(UNIT_B);
    expect(result.value.filtered.deniedIds?.length ?? 0).toBeGreaterThan(0);
    // Never expose raw unfiltered hits
    expect(result.value).not.toHaveProperty("raw");
    expect(result.value).not.toHaveProperty("unfiltered");
    const parsed = SearchReceiptSchema.safeParse(result.value.receipt);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.snapshotId).toBe(SNAPSHOT);
    expect(parsed.data.candidateIds.length).toBeGreaterThan(0);
    expect(Object.isFrozen(result.value)).toBe(true);
  });
});

describe("retrieval — lexical", () => {
  it("lexical returns filtered response with receipt", async () => {
    const api = tools();
    const result = await api.lexical({ query: "retries" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filtered.selectedIds).toContain(UNIT_A);
    expect(result.value.filtered.selectedIds).not.toContain(UNIT_B);
    const parsed = SearchReceiptSchema.safeParse(result.value.receipt);
    expect(parsed.success).toBe(true);
  });
});

describe("retrieval — open_unit", () => {
  it("open_unit verifies hash via UnitStore and returns projectUnitPreview", async () => {
    const api = tools();
    const result = await api.open_unit({
      unitId: UNIT_A,
      expectedHash: "a".repeat(64),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.preview.unitId).toBe(UNIT_A);
    expect(result.value.preview.quote).toBeDefined();
    const parsed = SearchReceiptSchema.safeParse(result.value.receipt);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.candidateIds).toEqual([UNIT_A]);
    expect(parsed.data.selectedIds).toEqual([UNIT_A]);
  });

  it("open_unit fails closed on hash mismatch", async () => {
    const api = tools();
    const result = await api.open_unit({
      unitId: UNIT_A,
      expectedHash: "b".repeat(64),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["HASH_MISMATCH", "UNIT_NOT_FOUND", "ACCESS_DENIED"]).toContain(
        result.code,
      );
    }
  });
});
