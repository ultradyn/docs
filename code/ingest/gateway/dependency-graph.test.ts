/**
 * T-23-02 — Dependency graph + deterministic SCCs (RED-first).
 *
 * Surfaces: unit | claim | workflow (plan).
 * Invariants:
 * - Cycles condense into sorted SCCs; every known node in exactly one component.
 * - Missing / unknown dependency → readiness MISSING_DEPENDENCY (fail closed).
 * - Same logical graph from shuffled event/relation orders → identical condensed().
 * - GraphEvent types imported from domain (no lookalikes).
 */
import { describe, expect, it } from "vitest";

import type { GraphEvent } from "../../domain/ingest/graph-event.js";
import type { GraphRevision } from "../../domain/ingest/types.js";

import {
  projectDependencyGraph,
  type DependencyRelation,
} from "./dependency-graph.js";

// Fixed ULID-shaped event ids (domain GraphEventIdSchema).
const GEV = (n: string) => `gev-01ARZ3NDEKTSV4RRFFQ69G5F${n}` as const;

function event(
  idSuffix: string,
  revision: number,
  subjectIds: readonly string[],
): GraphEvent {
  return {
    schemaVersion: 1,
    id: GEV(idSuffix),
    revision: revision as GraphRevision,
    operationType: "create_generated_branch",
    subjectIds: [...subjectIds],
  };
}

function rel(dependentId: string, dependencyId: string): DependencyRelation {
  return { dependentId, dependencyId };
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

function componentIds(
  components: readonly { readonly memberIds: readonly string[] }[],
): string[][] {
  return components.map((c) => [...c.memberIds]);
}

function partitionMembers(
  components: readonly { readonly memberIds: readonly string[] }[],
): string[] {
  return components.flatMap((c) => [...c.memberIds]).sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Cycles → SCCs
// ---------------------------------------------------------------------------
describe("cyclic condensation", () => {
  it("literal cyclic fixture condenses into sorted SCCs with every node once", () => {
    // A → B → C → A cycle; D depends on A (outside cycle)
    const events = [
      event("AA", 1, ["src-A", "pkt-B", "claim-C"]),
      event("AB", 2, ["ans-D"]),
    ];
    const relations = [
      rel("pkt-B", "src-A"),
      rel("claim-C", "pkt-B"),
      rel("src-A", "claim-C"), // closes cycle src-A ↔ pkt-B ↔ claim-C
      rel("ans-D", "src-A"),
    ];
    const graph = projectDependencyGraph({ events, relations });
    const condensed = graph.condensed();
    expect(Array.isArray(condensed)).toBe(true);
    expect(condensed.length).toBeGreaterThanOrEqual(1);

    // Every known artifact appears exactly once across components
    const members = partitionMembers(condensed);
    expect(members).toEqual(["ans-D", "claim-C", "pkt-B", "src-A"]);

    // Cycle nodes share one multi-member SCC
    const cycleScc = condensed.find(
      (c) =>
        c.memberIds.includes("src-A") &&
        c.memberIds.includes("pkt-B") &&
        c.memberIds.includes("claim-C"),
    );
    expect(cycleScc).toBeDefined();
    expect(cycleScc!.memberIds).toEqual(["claim-C", "pkt-B", "src-A"]); // sorted

    // Member lists sorted; condensed ordered by min(memberId)
    for (const c of condensed) {
      expect([...c.memberIds]).toEqual(
        [...c.memberIds].sort((a, b) => a.localeCompare(b)),
      );
    }
    const mins = condensed.map((c) => c.memberIds[0]!);
    expect(mins).toEqual([...mins].sort((a, b) => a.localeCompare(b)));
  });

  it("does not throw or drop members when projecting a pure 2-cycle", () => {
    const events = [event("AC", 1, ["n-1", "n-2"])];
    const relations = [rel("n-1", "n-2"), rel("n-2", "n-1")];
    const graph = projectDependencyGraph({ events, relations });
    const condensed = graph.condensed();
    expect(partitionMembers(condensed)).toEqual(["n-1", "n-2"]);
    expect(condensed).toHaveLength(1);
    expect(condensed[0]!.memberIds).toEqual(["n-1", "n-2"]);
  });
});

// ---------------------------------------------------------------------------
// dependenciesOf
// ---------------------------------------------------------------------------
describe("dependenciesOf + knownIds", () => {
  it("returns direct dependency IDs sorted for every artifact", () => {
    const events = [event("BA", 1, ["src-1", "pkt-1", "claim-1"])];
    const relations = [
      rel("pkt-1", "src-1"),
      rel("claim-1", "pkt-1"),
      rel("claim-1", "src-1"), // branching: claim depends on packet and source
    ];
    const graph = projectDependencyGraph({ events, relations });
    expect(graph.dependenciesOf("claim-1")).toEqual(["pkt-1", "src-1"]);
    expect(graph.dependenciesOf("pkt-1")).toEqual(["src-1"]);
    expect(graph.dependenciesOf("src-1")).toEqual([]);
  });

  it("knownIds distinguishes unknown id from known-with-empty-deps", () => {
    const events = [event("BB", 1, ["leaf"])];
    const graph = projectDependencyGraph({ events, relations: [] });
    expect(graph.knownIds()).toEqual(["leaf"]);
    expect(graph.dependenciesOf("leaf")).toEqual([]);
    expect(graph.dependenciesOf("ghost")).toEqual([]);
    expect(graph.knownIds().includes("ghost")).toBe(false);
    expect(graph.readiness("leaf").ok).toBe(true);
    expect(graph.readiness("ghost").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readiness fail-closed
// ---------------------------------------------------------------------------
describe("readiness fail-closed", () => {
  it("missing dependency blocks readiness", () => {
    const events = [event("CA", 1, ["claim-x"])];
    // claim-x depends on pkt-missing which is NOT a known node
    const relations = [rel("claim-x", "pkt-missing")];
    const graph = projectDependencyGraph({ events, relations });
    const result = graph.readiness("claim-x");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MISSING_DEPENDENCY");
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("unknown id is not ready (no information ⇏ ready)", () => {
    const events = [event("CB", 1, ["only-known"])];
    const graph = projectDependencyGraph({ events, relations: [] });
    const result = graph.readiness("never-seen");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MISSING_DEPENDENCY");
  });

  it("positive control: complete dependency set is ready", () => {
    const events = [event("CC", 1, ["src-ok", "pkt-ok", "claim-ok"])];
    const relations = [
      rel("pkt-ok", "src-ok"),
      rel("claim-ok", "pkt-ok"),
    ];
    const graph = projectDependencyGraph({ events, relations });
    const result = graph.readiness("claim-ok");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("ready");
  });

  it("cycle among fully-known nodes does not block readiness", () => {
    const events = [event("CD", 1, ["a", "b"])];
    const relations = [rel("a", "b"), rel("b", "a")];
    const graph = projectDependencyGraph({ events, relations });
    expect(graph.readiness("a").ok).toBe(true);
    expect(graph.readiness("b").ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Determinism under shuffle
// ---------------------------------------------------------------------------
describe("determinism under insertion order shuffle", () => {
  it("shuffled events and relations yield identical condensed() and readiness", () => {
    const baseEvents = [
      event("DA", 1, ["s1", "e1"]),
      event("DB", 2, ["c1", "ans1"]),
      event("DC", 3, ["s2"]),
    ];
    const baseRelations = [
      rel("e1", "s1"),
      rel("c1", "e1"),
      rel("c1", "s2"),
      rel("ans1", "c1"),
      rel("s2", "s1"), // creates multi-hop / potential structure
    ];

    const g1 = projectDependencyGraph({
      events: baseEvents,
      relations: baseRelations,
    });
    const g2 = projectDependencyGraph({
      events: shuffle(baseEvents, 42),
      relations: shuffle(baseRelations, 99),
    });
    const g3 = projectDependencyGraph({
      events: shuffle(baseEvents, 7),
      relations: shuffle(baseRelations, 13),
    });

    expect(JSON.stringify(componentIds(g2.condensed()))).toBe(
      JSON.stringify(componentIds(g1.condensed())),
    );
    expect(JSON.stringify(componentIds(g3.condensed()))).toBe(
      JSON.stringify(componentIds(g1.condensed())),
    );

    for (const id of ["s1", "e1", "c1", "ans1", "s2"]) {
      expect(g2.dependenciesOf(id)).toEqual(g1.dependenciesOf(id));
      expect(g3.dependenciesOf(id)).toEqual(g1.dependenciesOf(id));
      expect(g2.readiness(id)).toEqual(g1.readiness(id));
      expect(g3.readiness(id)).toEqual(g1.readiness(id));
    }
  });
});

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------
describe("gateway barrel", () => {
  it("exports projectDependencyGraph that projects a trivial ready graph", async () => {
    const barrel = await import("./index.js");
    expect(typeof barrel.projectDependencyGraph).toBe("function");
    // Discriminating: must exercise behaviour (fails on not-implemented placeholder).
    const graph = barrel.projectDependencyGraph({
      events: [event("ZZ", 1, ["solo"])],
      relations: [],
    });
    expect(graph.knownIds()).toEqual(["solo"]);
    expect(graph.readiness("solo").ok).toBe(true);
    expect(graph.condensed()).toEqual([{ memberIds: ["solo"] }]);
  });
});