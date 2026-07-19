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

const WIRED = new Set(["source.exact", "source.lexical", "source.open_unit"]);
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
      const method = (api as unknown as Record<string, unknown>)[short];
      expect(typeof method).toBe("function");
    }
    // Must NOT expose authority even if asked by hostile keys
    expect(
      (api as unknown as Record<string, unknown>).search_authority,
    ).toBeUndefined();
    expect(
      (api as unknown as Record<string, unknown>).authority,
    ).toBeUndefined();
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
      expect(
        "receipt" in (result as object) || "ok" in (result as object),
      ).toBe(true);

      // Normalize: every tool result is IngestResult with receipt on success OR
      // error with receipt still present for audit.
      const receipt =
        result && typeof result === "object" && "receipt" in result
          ? (result as { receipt: unknown }).receipt
          : result &&
            typeof result === "object" &&
            "ok" in result &&
            (result as { ok: boolean }).ok === true &&
            "value" in result &&
            (result as { value: { receipt?: unknown } }).value?.receipt;

      expect(receipt).toBeDefined();
      expect(Object.isFrozen(receipt)).toBe(true);
      const parsed = SearchReceiptSchema.safeParse(receipt);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.snapshotId).toBe(SNAPSHOT);
      expect(typeof parsed.data.indexVersion).toBe("string");
      expect(parsed.data.indexVersion.length).toBeGreaterThan(0);
      expect(parsed.data.indexedRepresentationsSha256).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(parsed.data.filters).toBeDefined();
      expect(Array.isArray(parsed.data.candidateIds)).toBe(true);
      expect(Array.isArray(parsed.data.selectedIds)).toBe(true);
    },
  );

  it("unbacked tools return TOOL_NOT_AVAILABLE with empty candidates (not a soft pass)", async () => {
    const api = tools();
    for (const name of UNBACKED) {
      const short = name.replace(/^source\./, "") as
        "maps" | "follow_links" | "vector_optional";
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
      ["source.follow_links", "source.maps", "source.vector_optional"].sort(),
    );
  });

  it("receipt index identity comes from the SearchBackend (not a hardcoded constant)", async () => {
    const { createFakeExactMap, createFakeLexicalIndex } =
      await import("./testing.js");
    const exactA = createFakeExactMap({
      hits: [],
      identity: {
        indexVersion: "exact-map-test-A",
        indexedRepresentationsSha256: "1".repeat(64) as never,
      },
    });
    const exactB = createFakeExactMap({
      hits: [],
      identity: {
        indexVersion: "exact-map-test-B",
        indexedRepresentationsSha256: "2".repeat(64) as never,
      },
    });
    const apiA = createSourceTools({
      profileId: "policy-docs",
      principalId: "session:researcher-1",
      snapshotId: SNAPSHOT,
      policyGate: createFakePolicyGate(),
      units: createFakeUnitAccessResolver(),
      unitStore: createFakeUnitStore(),
      exactMap: exactA,
      lexicalIndex: createFakeLexicalIndex({ hits: [] }),
    });
    const apiB = createSourceTools({
      profileId: "policy-docs",
      principalId: "session:researcher-1",
      snapshotId: SNAPSHOT,
      policyGate: createFakePolicyGate(),
      units: createFakeUnitAccessResolver(),
      unitStore: createFakeUnitStore(),
      exactMap: exactB,
      lexicalIndex: createFakeLexicalIndex({ hits: [] }),
    });
    const a = await apiA.exact({ query: "q" });
    const b = await apiB.exact({ query: "q" });
    expect(a.receipt.indexVersion).toBe("exact-map-test-A");
    expect(b.receipt.indexVersion).toBe("exact-map-test-B");
    expect(a.receipt.indexedRepresentationsSha256).toBe("1".repeat(64));
    expect(b.receipt.indexedRepresentationsSha256).toBe("2".repeat(64));
    expect(a.receipt.indexVersion).not.toBe(b.receipt.indexVersion);
  });
});

// ---------------------------------------------------------------------------
// B004 — index identity must come from the configured backend, never from the
// backend's own response, and must never degrade to unbacked sentinels.
// ---------------------------------------------------------------------------
describe("B004 index identity provenance", () => {
  const GOOD_DIGEST = "b".repeat(64) as Sha256;

  function backendWith(identity: {
    indexVersion: string;
    indexedRepresentationsSha256: string;
  }) {
    return {
      identity: identity as unknown as SearchBackendIdentity,
      async search() {
        return {
          candidateIds: [],
          selectedIds: [],
          hits: [],
          // The backend ALSO offers identity inside its own response. This is
          // the smuggling channel: a hostile or misconfigured backend naming
          // the very index the receipt is supposed to independently attest.
          receipt: {
            indexVersion: "attacker-claimed-index",
            indexedRepresentationsSha256: "c".repeat(64),
          },
        } as unknown as SearchResponse;
      },
    };
  }

  it("FAILS CLOSED when configured identity is missing, ignoring response-supplied identity", async () => {
    const t = tools({
      lexicalIndex: backendWith({
        indexVersion: "",
        indexedRepresentationsSha256: "",
      }),
    });
    const result = await t.lexical({ query: "retention" });
    expect(result.ok, "empty configured identity must not produce a receipt").toBe(
      false,
    );
    if (result.ok) return;
    expect(result.code).toBe("INDEX_IDENTITY_UNAVAILABLE");
    // And it must not have silently adopted what the backend claimed.
    expect(JSON.stringify(result)).not.toContain("attacker-claimed-index");
  });

  it("FAILS CLOSED on a malformed configured corpus digest", async () => {
    const t = tools({
      lexicalIndex: backendWith({
        indexVersion: "lexical-v1",
        indexedRepresentationsSha256: "not-a-digest",
      }),
    });
    const result = await t.lexical({ query: "retention" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INDEX_IDENTITY_UNAVAILABLE");
  });

  it("applies to EXACT as well as lexical (shared runSearch path)", async () => {
    // exact and lexical both route through runSearch, so the guard is shared.
    // Asserting it rather than relying on reading the code: if someone later
    // gives exact its own path, this fails instead of silently losing cover.
    const t = tools({
      exactMap: backendWith({
        indexVersion: "",
        indexedRepresentationsSha256: "",
      }),
    });
    const result = await t.exact({ query: "retention" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INDEX_IDENTITY_UNAVAILABLE");
  });

  it("leaves genuinely unbacked tools alone (they never reach the identity path)", async () => {
    // maps / follow_links / vector_optional are unbacked BY DESIGN (T-30-01).
    // The B004 fix must not convert their honest TOOL_NOT_AVAILABLE into an
    // identity failure — that would trade one defect for a worse one.
    const t = tools();
    for (const name of ["maps", "follow_links", "vector_optional"] as const) {
      const result = await t[name]({ query: "retention" });
      expect(result.ok, `${name} should remain unavailable, not identity-failed`).toBe(
        false,
      );
      if (result.ok) continue;
      expect(result.code).toBe("TOOL_NOT_AVAILABLE");
    }
  });

  it("POSITIVE CONTROL: a properly configured backend still produces a receipt", async () => {
    // Without this the assertions above could be satisfied by a tool that
    // refuses everything, which would pass while breaking retrieval entirely.
    const t = tools({
      lexicalIndex: backendWith({
        indexVersion: "lexical-v1",
        indexedRepresentationsSha256: GOOD_DIGEST,
      }),
    });
    const result = await t.lexical({ query: "retention" });
    expect(result.ok, "correctly configured backend must still work").toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.indexVersion).toBe("lexical-v1");
    // Identity comes from configuration, never from the response.
    expect(result.value.receipt.indexedRepresentationsSha256).toBe(GOOD_DIGEST);
  });
});
