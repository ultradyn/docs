/**
 * T-30-01 RED — contract surface.
 * Iterates INGEST_ROLE_TOOL_ALLOWLIST.researcher; each tool exists, records a
 * schema-valid receipt, and routes through the policy gate (or honest unbacked).
 */
import { describe, expect, it } from "vitest";

import { INGEST_ROLE_TOOL_ALLOWLIST } from "../../agents/ingest-manifest.js";
import { SearchReceiptSchema } from "../../domain/ingest/search-receipt.js";
import type { SnapshotId } from "../../domain/ingest/index.js";

import { createSourceTools } from "./source-tools.js";
import {
  createFakeUnitAccessResolver,
  createFakeUnitStore,
  createFakePolicyGate,
} from "./testing.js";

const SNAPSHOT = `snap-${"a".repeat(64)}` as SnapshotId;
const RESEARCHER_TOOLS = INGEST_ROLE_TOOL_ALLOWLIST.researcher;

const WIRED = new Set([
  "source.exact",
  "source.lexical",
  "source.open_unit",
]);
const UNBACKED = new Set([
  "source.maps",
  "source.follow_links",
  "source.vector_optional",
]);

function tools(overrides: Record<string, unknown> = {}) {
  return createSourceTools({
    profileId: "policy-docs",
    principalId: "session:researcher-1",
    snapshotId: SNAPSHOT,
    policyGate: createFakePolicyGate(),
    units: createFakeUnitAccessResolver(),
    unitStore: createFakeUnitStore(),
    ...overrides,
  });
}

describe("exports + construction", () => {
  it("exports createSourceTools", async () => {
    const mod = await import("./source-tools.js");
    expect(typeof mod.createSourceTools).toBe("function");
  });

  it("requires profileId, principalId, snapshotId, policyGate at construction", () => {
    expect(() =>
      createSourceTools({
        principalId: "p",
        snapshotId: SNAPSHOT,
        policyGate: createFakePolicyGate(),
      } as never),
    ).toThrow(/profile/i);
    expect(() =>
      createSourceTools({
        profileId: "policy-docs",
        snapshotId: SNAPSHOT,
        policyGate: createFakePolicyGate(),
      } as never),
    ).toThrow(/principal/i);
    expect(() =>
      createSourceTools({
        profileId: "policy-docs",
        principalId: "p",
        policyGate: createFakePolicyGate(),
      } as never),
    ).toThrow(/snapshot/i);
    expect(() =>
      createSourceTools({
        profileId: "policy-docs",
        principalId: "p",
        snapshotId: SNAPSHOT,
      } as never),
    ).toThrow(/policyGate|gate/i);
  });

  it("retrieval barrel re-exports createSourceTools", async () => {
    const barrel = await import("./index.js");
    expect(
      typeof (barrel as { createSourceTools?: unknown }).createSourceTools,
    ).toBe("function");
  });

  it("testing fakes are not on retrieval barrel", async () => {
    const barrel = await import("./index.js");
    expect(
      (barrel as { createFakeUnitStore?: unknown }).createFakeUnitStore,
    ).toBeUndefined();
    expect(
      (barrel as { createFakeUnitAccessResolver?: unknown })
        .createFakeUnitAccessResolver,
    ).toBeUndefined();
  });
});

describe("contract — researcher allowlist surface", () => {
  it("pins exactly the six researcher tools (no source.search_authority)", () => {
    expect([...RESEARCHER_TOOLS]).toEqual([
      "source.exact",
      "source.maps",
      "source.lexical",
      "source.open_unit",
      "source.follow_links",
      "source.vector_optional",
    ]);
    expect(RESEARCHER_TOOLS).not.toContain("source.search_authority");
    expect(RESEARCHER_TOOLS).not.toContain("source.authority");
  });

  it("createSourceTools exposes every allowlisted tool name as a callable", () => {
    const api = tools();
    for (const name of RESEARCHER_TOOLS) {
      const short = name.replace(/^source\./, "");
      // Tool methods use short names matching allowlist suffix
      const method = (api as Record<string, unknown>)[short];
      expect(typeof method).toBe("function");
    }
    // Must NOT expose authority even if asked by hostile keys
    expect((api as Record<string, unknown>).search_authority).toBeUndefined();
    expect((api as Record<string, unknown>).authority).toBeUndefined();
  });

  it.each([...RESEARCHER_TOOLS])(
    "%s records a schema-valid SearchReceipt with snapshot/index/filter/candidate fields",
    async (toolName) => {
      const api = tools();
      const short = toolName.replace(/^source\./, "") as
        | "exact"
        | "maps"
        | "lexical"
        | "open_unit"
        | "follow_links"
        | "vector_optional";
      const result = await api[short]({
        query: "delivery worker",
        unitId: "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      });
      // Wired tools may ok or fail on missing index data; unbacked return not-available
      expect(result).toBeDefined();
      expect(typeof result).toBe("object");
      expect("receipt" in (result as object) || "ok" in (result as object)).toBe(
        true,
      );

      // Normalize: every tool result is IngestResult with receipt on success OR
      // error with receipt still present for audit.
      const receipt =
        result &&
        typeof result === "object" &&
        "receipt" in result
          ? (result as { receipt: unknown }).receipt
          : result &&
              typeof result === "object" &&
              "ok" in result &&
              (result as { ok: boolean }).ok === true &&
              "value" in result &&
              (result as { value: { receipt?: unknown } }).value?.receipt;

      expect(receipt).toBeDefined();
      const parsed = SearchReceiptSchema.safeParse(receipt);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.snapshotId).toBe(SNAPSHOT);
      expect(typeof parsed.data.indexVersion).toBe("string");
      expect(parsed.data.indexVersion.length).toBeGreaterThan(0);
      expect(parsed.data.indexedRepresentationsSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(parsed.data.filters).toBeDefined();
      expect(Array.isArray(parsed.data.candidateIds)).toBe(true);
      expect(Array.isArray(parsed.data.selectedIds)).toBe(true);
      expect(Object.isFrozen(parsed.data)).toBe(true);
    },
  );

  it("unbacked tools return TOOL_NOT_AVAILABLE with empty candidates (not a soft pass)", async () => {
    const api = tools();
    for (const name of UNBACKED) {
      const short = name.replace(/^source\./, "") as
        | "maps"
        | "follow_links"
        | "vector_optional";
      const result = await api[short]({ query: "x" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("TOOL_NOT_AVAILABLE");
        expect(result.message).not.toMatch(/grant|allowlist|profile/i);
      }
      // Receipt still present with empty candidates
      const receipt = (result as { receipt?: unknown }).receipt;
      expect(receipt).toBeDefined();
      const parsed = SearchReceiptSchema.safeParse(receipt);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.candidateIds).toEqual([]);
        expect(parsed.data.selectedIds).toEqual([]);
      }
    }
  });

  it("documents wired vs unbacked sets for RED checkpoint", () => {
    expect([...WIRED].sort()).toEqual(
      ["source.exact", "source.lexical", "source.open_unit"].sort(),
    );
    expect([...UNBACKED].sort()).toEqual(
      [
        "source.follow_links",
        "source.maps",
        "source.vector_optional",
      ].sort(),
    );
  });
});
