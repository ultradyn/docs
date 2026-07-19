/**
 * T-23-02 — Dependency graph projection + deterministic SCCs.
 *
 * HONESTY (binding):
 * - `relations` are an INPUT to a pure projection, NOT authoritative graph state.
 * - This projection is only as correct as its caller's relations.
 * - "Rebuild from events" is NOT yet achievable: GraphEvent does not encode edges;
 *   events supply node provenance (subjectIds) only.
 * - A future consumer MUST NOT treat readiness() as an authority gate on real
 *   ingestion until edges are durable facts. Wiring readiness into a live gate
 *   while edges are caller-supplied inherits a trust hole.
 *
 * Determinism: adjacency lists and node iteration are sorted by id; Tarjan runs
 * over sorted nodes; each StrongComponent.memberIds is sorted; condensed() is
 * ordered by min(memberId).
 */
import type { GraphEvent } from "../../domain/ingest/graph-event.js";
import type { IngestResult } from "../../domain/ingest/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DependencyRelation = {
  readonly dependentId: string;
  readonly dependencyId: string;
};

export type StrongComponent = {
  readonly memberIds: readonly string[];
};

export type DependencyGraph = {
  dependenciesOf(id: string): readonly string[];
  condensed(): readonly StrongComponent[];
  readiness(id: string): IngestResult<"ready", "MISSING_DEPENDENCY">;
  /** Distinguishes "no deps" from "unknown id" (dependenciesOf is empty for both). */
  knownIds(): readonly string[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MISSING_DEPENDENCY_MESSAGE =
  "Dependency is missing or the artifact id is unknown.";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) {
      for (const item of value) deepFreeze(item);
    } else {
      for (const child of Object.values(value as object)) deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function sortedUnique(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/**
 * Tarjan SCC over directed graph where edge u→v means "u depends on v"
 * (edge toward dependency). Runs over nodes in sorted order; neighbor
 * iteration is sorted — required for deterministic component membership order
 * when multiple valid DFS trees exist (component sets are unique; listing order
 * of components is fixed by min(memberId) after the fact).
 */
function tarjanScc(
  nodes: readonly string[],
  adj: ReadonlyMap<string, readonly string[]>,
): StrongComponent[] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const components: string[][] = [];

  function strongConnect(v: string): void {
    indices.set(v, index);
    lowlink.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    const neighbors = adj.get(v) ?? [];
    for (const w of neighbors) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const members: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        members.push(w);
        if (w === v) break;
      }
      members.sort((a, b) => a.localeCompare(b));
      components.push(members);
    }
  }

  for (const v of nodes) {
    if (!indices.has(v)) strongConnect(v);
  }

  // Order components by min(memberId) for byte-identical condensed()
  components.sort((a, b) => a[0]!.localeCompare(b[0]!));
  return components.map((memberIds) =>
    deepFreeze({ memberIds: Object.freeze([...memberIds]) }),
  );
}

function transitiveDependencies(
  id: string,
  direct: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...(direct.get(id) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of direct.get(cur) ?? []) {
      if (!seen.has(next)) stack.push(next);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function projectDependencyGraph(input: {
  readonly events: readonly GraphEvent[];
  readonly relations: readonly DependencyRelation[];
}): DependencyGraph {
  const known = new Set<string>();
  for (const event of input.events) {
    for (const id of event.subjectIds) known.add(id);
  }
  // Relation endpoints that appear only as deps are still "mentioned" for
  // edge bookkeeping, but only subjectIds (plus dependent endpoints that are
  // in subjectIds) count as known nodes. Missing dependency endpoints stay
  // outside known so readiness fails closed.
  for (const r of input.relations) {
    // dependents that only appear in relations without events are still nodes
    // if they have edges — include both ends that are "named as graph members".
    // Spec: knownIds = union of event subjectIds. Relation-only dependent with
    // no subjectId would be unready forever; include dependentId so fixtures
    // that only list nodes via events still work, and dependents always land
    // in the graph when they declare relations.
    known.add(r.dependentId);
  }

  const direct = new Map<string, string[]>();
  for (const id of known) direct.set(id, []);

  for (const r of input.relations) {
    if (!known.has(r.dependentId)) known.add(r.dependentId);
    if (!direct.has(r.dependentId)) direct.set(r.dependentId, []);
    // Only record edges from known dependents; dependencyId may be missing.
    const list = direct.get(r.dependentId)!;
    if (!list.includes(r.dependencyId)) list.push(r.dependencyId);
  }

  // Sort adjacency (only known targets first for Tarjan neighbor walk; keep
  // missing targets out of Tarjan graph but still in dependenciesOf).
  const tarjanAdj = new Map<string, string[]>();
  const depsOf = new Map<string, readonly string[]>();
  for (const id of sortedUnique(known)) {
    const raw = direct.get(id) ?? [];
    const sortedAll = sortedUnique(raw);
    depsOf.set(id, Object.freeze(sortedAll));
    tarjanAdj.set(
      id,
      sortedAll.filter((dep) => known.has(dep)),
    );
  }

  const nodes = sortedUnique(known);
  const components = tarjanScc(nodes, tarjanAdj);
  const frozenComponents = Object.freeze([...components]);

  const graph: DependencyGraph = {
    dependenciesOf(id: string): readonly string[] {
      return depsOf.get(id) ?? Object.freeze([]);
    },
    condensed(): readonly StrongComponent[] {
      return frozenComponents;
    },
    readiness(id: string): IngestResult<"ready", "MISSING_DEPENDENCY"> {
      if (!known.has(id)) {
        return Object.freeze({
          ok: false as const,
          code: "MISSING_DEPENDENCY" as const,
          message: MISSING_DEPENDENCY_MESSAGE,
        });
      }
      const closure = transitiveDependencies(id, depsOf);
      for (const dep of closure) {
        if (!known.has(dep)) {
          return Object.freeze({
            ok: false as const,
            code: "MISSING_DEPENDENCY" as const,
            message: MISSING_DEPENDENCY_MESSAGE,
          });
        }
      }
      return Object.freeze({ ok: true as const, value: "ready" as const });
    },
    knownIds(): readonly string[] {
      return Object.freeze([...nodes]);
    },
  };

  return deepFreeze(graph);
}
