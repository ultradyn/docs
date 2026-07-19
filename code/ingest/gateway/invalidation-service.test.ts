/**
 * T-23-03 — Precise invalidation propagation (RED-first).
 *
 * HONESTY (binding, mirrored in production header):
 * - relations are projection INPUT (same as T-23-02), not durable edges.
 * - projectDependencyGraph.readiness() is NOT a publish authority.
 * - assertPublishable is a separate pure gate (plan membership + durable stale).
 * - Precision is measured ONLY on unambiguous fixtures (truth fully determined).
 *   Fail-closed over-invalidation always wins on ambiguous fixtures; precision
 *   there is non-gating so the metric cannot pressure under-invalidation.
 * - ArtifactClass is ALWAYS explicit — never inferred from id prefix (prefix
 *   sniff fails open when a new prefix appears).
 * - Graph commits for invalidation go through GraphGateway (sole mutation path).
 */
import { describe, expect, it } from "vitest";

import {
  GraphEventSchema,
  GraphOperationTypeSchema,
} from "../../domain/ingest/graph-event.js";
import type { GraphEvent } from "../../domain/ingest/graph-event.js";
import type { GraphRevision } from "../../domain/ingest/types.js";

import type { DependencyRelation } from "./dependency-graph.js";
import {
  assertPublishable,
  createInvalidationService,
  type ArtifactClass,
  type ClassifiedArtifact,
  type InvalidationEvent,
  type InvalidationPlan,
} from "./invalidation-service.js";

// ---------------------------------------------------------------------------
// Fixed ids (bodies are ULID-shaped; class is ALWAYS from the map, never prefix)
// ---------------------------------------------------------------------------

const UNIT_A = "unit-01ARZ3NDEKTSV4RRFFQ69G5FUA";
const UNIT_U = "unit-01ARZ3NDEKTSV4RRFFQ69G5FUB";
const PKT_A = "pkt-01ARZ3NDEKTSV4RRFFQ69G5FPA";
const CLM_A = "clm-01ARZ3NDEKTSV4RRFFQ69G5FCA";
const ANS_A = "ans-01ARZ3NDEKTSV4RRFFQ69G5FAA";
const CLM_C1 = "clm-01ARZ3NDEKTSV4RRFFQ69G5FC1";
const CLM_C2 = "clm-01ARZ3NDEKTSV4RRFFQ69G5FC2";
const ANS_C = "ans-01ARZ3NDEKTSV4RRFFQ69G5FAC";
const PKT_U = "pkt-01ARZ3NDEKTSV4RRFFQ69G5FPU";
const CLM_U = "clm-01ARZ3NDEKTSV4RRFFQ69G5FCU";
const ANS_U = "ans-01ARZ3NDEKTSV4RRFFQ69G5FAU";
const ANS_AMBIG = "ans-01ARZ3NDEKTSV4RRFFQ69G5FAM";
const MISSING_DEP = "missing-01ARZ3NDEKTSV4RRFFQ69G5FMX";

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

function classified(
  id: string,
  artifactClass: ArtifactClass,
): ClassifiedArtifact {
  return { id, artifactClass };
}

/** Unambiguous labeled graph: full multi-hop chain, SCC, clean sibling branch. */
function unambiguousFixture(): {
  events: GraphEvent[];
  relations: DependencyRelation[];
  artifacts: ClassifiedArtifact[];
} {
  const artifacts: ClassifiedArtifact[] = [
    classified(UNIT_A, "unit"),
    classified(UNIT_U, "unit"),
    classified(PKT_A, "packet"),
    classified(CLM_A, "claim"),
    classified(ANS_A, "composition"),
    classified(CLM_C1, "claim"),
    classified(CLM_C2, "claim"),
    classified(ANS_C, "composition"),
    classified(PKT_U, "packet"),
    classified(CLM_U, "claim"),
    classified(ANS_U, "composition"),
  ];
  const subjectIds = artifacts.map((a) => a.id);
  const events = [event("01", 1, subjectIds)];
  const relations = [
    rel(PKT_A, UNIT_A),
    rel(CLM_A, PKT_A),
    rel(ANS_A, CLM_A),
    rel(CLM_C1, CLM_C2),
    rel(CLM_C2, CLM_C1),
    rel(ANS_C, CLM_C1),
    rel(PKT_U, UNIT_U),
    rel(CLM_U, PKT_U),
    rel(ANS_U, CLM_U),
  ];
  return { events, relations, artifacts };
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

function setEq(a: readonly string[], b: readonly string[]): boolean {
  const sa = [...a].sort((x, y) => x.localeCompare(y));
  const sb = [...b].sort((x, y) => x.localeCompare(y));
  return JSON.stringify(sa) === JSON.stringify(sb);
}

function precisionRecall(
  S: readonly string[],
  Sstar: readonly string[],
): { precision: number; recall: number } {
  const s = new Set(S);
  const star = new Set(Sstar);
  let inter = 0;
  for (const id of s) if (star.has(id)) inter += 1;
  const precision = s.size === 0 ? 0 : inter / s.size;
  const recall = star.size === 0 ? 0 : inter / star.size;
  return { precision, recall };
}

function planOf(
  event: InvalidationEvent,
  fixture: ReturnType<typeof unambiguousFixture>,
): InvalidationPlan {
  const svc = createInvalidationService();
  const result = svc.plan({
    event,
    events: fixture.events,
    relations: fixture.relations,
    artifacts: fixture.artifacts,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

// ---------------------------------------------------------------------------
// Schema: closed op set gains propagate_invalidation (gateway is sole writer)
// ---------------------------------------------------------------------------

describe("T-23-03 schema surface", () => {
  it("GraphOperationTypeSchema accepts propagate_invalidation", () => {
    const parsed = GraphOperationTypeSchema.safeParse("propagate_invalidation");
    expect(parsed.success).toBe(true);
  });

  it("GraphEventSchema accepts propagate_invalidation operationType", () => {
    const parsed = GraphEventSchema.safeParse({
      schemaVersion: 1,
      id: GEV("EV"),
      revision: 1,
      operationType: "propagate_invalidation",
      subjectIds: [CLM_A],
    });
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unambiguous precision/recall (gating) — truth fully determined
// ---------------------------------------------------------------------------

describe("unambiguous labeled precision (gating)", () => {
  it("L1 multi-hop from UNIT_A: recall+precision 1.0 with non-vacuous S*", () => {
    const fixture = unambiguousFixture();
    // Roots included in stale set; reverse-closure through packet→claim→answer
    const Sstar = [UNIT_A, PKT_A, CLM_A, ANS_A];
    expect(Sstar.length).toBeGreaterThanOrEqual(4);

    const plan = planOf(
      {
        kind: "source_unit_changed",
        snapshotId: "snap-1",
        unitIds: [UNIT_A],
        rootArtifactIds: [UNIT_A],
      },
      fixture,
    );

    const clean = [UNIT_U, PKT_U, CLM_U, ANS_U, CLM_C1, CLM_C2, ANS_C];
    for (const id of clean) {
      expect(plan.staleAllIds).not.toContain(id);
    }

    const { precision, recall } = precisionRecall(plan.staleAllIds, Sstar);
    expect(plan.staleAllIds.length).toBeGreaterThanOrEqual(1);
    expect(Sstar.length).toBeGreaterThanOrEqual(4);
    expect(recall).toBe(1);
    expect(precision).toBe(1);
    expect(setEq(plan.staleAllIds, Sstar)).toBe(true);
    expect(plan.stalePacketIds).toEqual([PKT_A]);
    expect(plan.staleClaimIds).toEqual([CLM_A]);
    expect(plan.staleCompositionIds).toEqual([ANS_A]);
  });

  it("L3 SCC: invalidating CLM_C1 stales entire component + dependents", () => {
    const fixture = unambiguousFixture();
    const Sstar = [CLM_C1, CLM_C2, ANS_C];
    const plan = planOf(
      {
        kind: "human_curiosity",
        rootArtifactIds: [CLM_C1],
        reason: "operator injected curiosity at cycle member",
      },
      fixture,
    );
    const { precision, recall } = precisionRecall(plan.staleAllIds, Sstar);
    expect(recall).toBe(1);
    expect(precision).toBe(1);
    expect(setEq(plan.staleAllIds, Sstar)).toBe(true);
    // Clean sibling branch untouched
    expect(plan.staleAllIds).not.toContain(ANS_A);
    expect(plan.staleAllIds).not.toContain(ANS_U);
  });

  it("L5 dedup_revocation propagates reverse-closure only", () => {
    const fixture = unambiguousFixture();
    const Sstar = [CLM_A, ANS_A];
    const plan = planOf(
      {
        kind: "dedup_revocation",
        rootArtifactIds: [CLM_A],
        reason: "equivalence revoked",
      },
      fixture,
    );
    expect(precisionRecall(plan.staleAllIds, Sstar)).toEqual({
      precision: 1,
      recall: 1,
    });
    expect(plan.staleAllIds).not.toContain(CLM_U);
  });

  it("vacuous precision/recall is rejected (empty S* cannot pass)", () => {
    // Meta-guard: our helper must not treat empty S* as perfect recall.
    const empty = precisionRecall([PKT_A], []);
    expect(empty.recall).toBe(0);
    const emptyS = precisionRecall([], [PKT_A]);
    expect(emptyS.precision).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ambiguous fixture — fail-closed over-invalidation is CORRECT; precision non-gating
// ---------------------------------------------------------------------------

describe("ambiguous fixture (fail-closed wins; precision non-gating)", () => {
  it("node with missing upstream dep is over-invalidated when any root changes", () => {
    const base = unambiguousFixture();
    // ANS_AMBIG depends on a missing id — we cannot prove independence from UNIT_A.
    const artifacts = [
      ...base.artifacts,
      classified(ANS_AMBIG, "composition"),
    ];
    const events = [event("02", 1, artifacts.map((a) => a.id))];
    const relations = [...base.relations, rel(ANS_AMBIG, MISSING_DEP)];

    const svc = createInvalidationService();
    const result = svc.plan({
      event: {
        kind: "source_unit_changed",
        snapshotId: "snap-1",
        unitIds: [UNIT_A],
        rootArtifactIds: [UNIT_A],
      },
      events,
      relations,
      artifacts,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const S = result.value.staleAllIds;
    const Smin = [UNIT_A, PKT_A, CLM_A, ANS_A];
    for (const id of Smin) expect(S).toContain(id);
    // Fail-closed: ambiguous artifact MUST be stale even though no recorded path
    // from UNIT_A reaches it.
    expect(S).toContain(ANS_AMBIG);

    // Precision is intentionally non-gating here (would be <1 if S* were only Smin).
    const naive = precisionRecall(S, Smin);
    expect(naive.precision).toBeLessThan(1);
    expect(naive.recall).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("shuffled relations and events yield byte-identical plans", () => {
    const fixture = unambiguousFixture();
    const eventInput: InvalidationEvent = {
      kind: "human_curiosity",
      rootArtifactIds: [UNIT_A, CLM_C1],
      reason: "multi-root",
    };
    const svc = createInvalidationService();
    const a = svc.plan({
      event: eventInput,
      events: fixture.events,
      relations: fixture.relations,
      artifacts: fixture.artifacts,
    });
    const b = svc.plan({
      event: eventInput,
      events: shuffle(fixture.events, 42),
      relations: shuffle(fixture.relations, 99),
      artifacts: shuffle(fixture.artifacts, 7),
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // Non-vacuous: both plans must actually invalidate something.
    expect(a.value.staleAllIds.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(a.value)).toBe(JSON.stringify(b.value));
    // Shuffle actually permutes
    expect(shuffle(fixture.relations, 99).map((r) => r.dependentId).join(",")).not.toBe(
      fixture.relations.map((r) => r.dependentId).join(","),
    );
  });
});

// ---------------------------------------------------------------------------
// Explicit class required (no prefix sniff)
// ---------------------------------------------------------------------------

describe("explicit ArtifactClass (no prefix inference)", () => {
  it("missing classification for a walked id fails closed with INVALID_INPUT", () => {
    const fixture = unambiguousFixture();
    // Drop CLM_A classification — walk from UNIT_A still reaches it.
    const artifacts = fixture.artifacts.filter((a) => a.id !== CLM_A);
    const svc = createInvalidationService();
    const result = svc.plan({
      event: {
        kind: "source_unit_changed",
        snapshotId: "snap-1",
        unitIds: [UNIT_A],
        rootArtifactIds: [UNIT_A],
      },
      events: fixture.events,
      relations: fixture.relations,
      artifacts,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_INPUT");
  });
});

// ---------------------------------------------------------------------------
// Publishable gate — separate from readiness()
// ---------------------------------------------------------------------------

describe("assertPublishable (not readiness)", () => {
  it("rejects ids in the plan stale sets", () => {
    const fixture = unambiguousFixture();
    const plan = planOf(
      {
        kind: "source_unit_changed",
        snapshotId: "snap-1",
        unitIds: [UNIT_A],
        rootArtifactIds: [UNIT_A],
      },
      fixture,
    );
    expect(assertPublishable(ANS_A, { plan }).ok).toBe(false);
    expect(assertPublishable(ANS_U, { plan }).ok).toBe(true);
  });

  it("rejects durable state stale even if omitted from plan", () => {
    const r = assertPublishable(CLM_U, {
      plan: {
        roots: [],
        stalePacketIds: [],
        staleClaimIds: [],
        staleCompositionIds: [],
        staleDocumentIds: [],
        staleFixtureIds: [],
        staleCertificateIds: [],
        staleAllIds: [],
      },
      durableStates: { [CLM_U]: "stale" },
    });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hygiene: no delete surface; barrel export
// ---------------------------------------------------------------------------

describe("hygiene", () => {
  it("production module source has no delete/erase/purge/unlink", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "invalidation-service.ts",
    );
    const src = await fs.readFile(file, "utf8");
    // Allow the words only in comments that forbid them — still ban call shapes.
    expect(src).not.toMatch(/\.(delete|erase|purge|unlink)\s*\(/);
  });

  it("gateway barrel exports createInvalidationService and assertPublishable", async () => {
    const barrel = await import("./index.js");
    expect(typeof barrel.createInvalidationService).toBe("function");
    expect(typeof barrel.assertPublishable).toBe("function");
  });
});
