/**
 * T-23-03 — Invalidation propagation.
 *
 * HONESTY (binding):
 * - `relations` are projection INPUT (same contract as T-23-02), not durable edges.
 * - Completeness of invalidation equals completeness of the caller-supplied
 *   relation set plus fail-closed rules for missing upstream deps.
 * - `projectDependencyGraph.readiness()` is NOT a publish authority and MUST NOT
 *   be wired as one here. Use `assertPublishable` (plan membership + durable
 *   stale state) instead. Keep the two separate at every call site.
 * - Precision metrics apply only where the correct set is fully determined
 *   (unambiguous fixtures). Where truth is not determined, fail-closed
 *   over-invalidation wins; precision is non-gating on those fixtures so the
 *   metric cannot pressure under-invalidation.
 * - ArtifactClass is always explicit. Never infer class from id prefix — prefix
 *   sniffing fails open for unknown brands (treats them as "not that class" /
 *   "not affected"), which is the forbidden direction under invalidation.
 * - Graph commits for invalidation MUST go through GraphGateway (sole sanctioned
 *   graph-mutation path). This module plans only; it does not open a second
 *   writer to the durable commit log. `propagate_invalidation` is registered on
 *   the closed GraphOperation set for event-record typing, but gateway.apply
 *   REFUSES execution today (typed INVALID_EDGE, exhaustive switch, tested).
 *   Wiring execution is a later mutation-authority change — not this tip.
 * - Append-only custody: create superseding stale versions / commits; never
 *   delete, erase, purge, or unlink.
 * - SCC policy (explicit step): if any member of a strong component is affected,
 *   every member is stale. Mutual reachability means independence is a lie.
 */
import type { GraphEvent } from "../../domain/ingest/graph-event.js";
import type { IngestResult } from "../../domain/ingest/types.js";

import {
  projectDependencyGraph,
  type DependencyRelation,
} from "./dependency-graph.js";

export type ArtifactClass =
  | "unit"
  | "packet"
  | "claim"
  | "composition"
  | "document"
  | "fixture"
  | "certificate";

export type ClassifiedArtifact = {
  readonly id: string;
  readonly artifactClass: ArtifactClass;
};

export type InvalidationEvent =
  | {
      readonly kind: "source_unit_changed";
      readonly snapshotId: string;
      readonly unitIds: readonly string[];
      readonly rootArtifactIds: readonly string[];
    }
  | {
      readonly kind: "human_curiosity";
      readonly rootArtifactIds: readonly string[];
      readonly reason: string;
    }
  | {
      readonly kind: "dedup_revocation";
      readonly rootArtifactIds: readonly string[];
      readonly reason: string;
      readonly equivalenceId?: string;
    };

export type InvalidationPlan = {
  readonly roots: readonly string[];
  readonly stalePacketIds: readonly string[];
  readonly staleClaimIds: readonly string[];
  readonly staleCompositionIds: readonly string[];
  readonly staleDocumentIds: readonly string[];
  readonly staleFixtureIds: readonly string[];
  readonly staleCertificateIds: readonly string[];
  readonly staleAllIds: readonly string[];
};

export type InvalidationError = "INVALID_INPUT" | "COMMIT_FAILED";

export type InvalidationService = {
  plan(input: {
    readonly event: InvalidationEvent;
    readonly events: readonly GraphEvent[];
    readonly relations: readonly DependencyRelation[];
    readonly artifacts: readonly ClassifiedArtifact[];
  }): IngestResult<InvalidationPlan, InvalidationError>;
};

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

function failure(
  code: InvalidationError,
  message: string,
): IngestResult<never, InvalidationError> {
  return Object.freeze({ ok: false as const, code, message });
}

function success<T>(value: T): IngestResult<T, InvalidationError> {
  return Object.freeze({ ok: true as const, value: deepFreeze(value) });
}

/**
 * Pure publish gate. NOT projectDependencyGraph.readiness().
 * Fails closed if id is in plan stale sets or durable state is "stale".
 */
export function assertPublishable(
  id: string,
  input: {
    readonly plan: InvalidationPlan;
    readonly durableStates?: Readonly<Record<string, string>>;
  },
): IngestResult<"publishable", "STALE" | "INVALID_INPUT"> {
  if (typeof id !== "string" || id.length === 0) {
    return Object.freeze({
      ok: false as const,
      code: "INVALID_INPUT" as const,
      message: "artifact id required",
    });
  }
  if (input.durableStates?.[id] === "stale") {
    return Object.freeze({
      ok: false as const,
      code: "STALE" as const,
      message: "artifact durable state is stale",
    });
  }
  if (input.plan.staleAllIds.includes(id)) {
    return Object.freeze({
      ok: false as const,
      code: "STALE" as const,
      message: "artifact is in invalidation plan stale set",
    });
  }
  return Object.freeze({ ok: true as const, value: "publishable" as const });
}

function reverseAdjacency(
  relations: readonly DependencyRelation[],
): Map<string, string[]> {
  const rev = new Map<string, string[]>();
  for (const r of relations) {
    const list = rev.get(r.dependencyId) ?? [];
    if (!list.includes(r.dependentId)) list.push(r.dependentId);
    rev.set(r.dependencyId, list);
  }
  for (const [k, list] of rev) {
    rev.set(
      k,
      [...list].sort((a, b) => a.localeCompare(b)),
    );
  }
  return rev;
}

export function createInvalidationService(): InvalidationService {
  return {
    plan(input) {
      if (
        input == null ||
        typeof input !== "object" ||
        input.event == null ||
        !Array.isArray(input.events) ||
        !Array.isArray(input.relations) ||
        !Array.isArray(input.artifacts)
      ) {
        return failure("INVALID_INPUT", "plan input incomplete");
      }

      const roots = sortedUnique(input.event.rootArtifactIds ?? []);
      if (roots.length === 0) {
        return failure("INVALID_INPUT", "rootArtifactIds required");
      }

      const classById = new Map<string, ArtifactClass>();
      for (const a of input.artifacts) {
        if (
          a == null ||
          typeof a.id !== "string" ||
          typeof a.artifactClass !== "string"
        ) {
          return failure("INVALID_INPUT", "artifact classification malformed");
        }
        classById.set(a.id, a.artifactClass);
      }

      for (const r of roots) {
        if (!classById.has(r)) {
          return failure(
            "INVALID_INPUT",
            "root artifact lacks explicit ArtifactClass",
          );
        }
      }

      const graph = projectDependencyGraph({
        events: input.events,
        relations: input.relations,
      });
      const known = new Set(graph.knownIds());
      const components = graph.condensed();
      const idToComponent = new Map<string, number>();
      for (let i = 0; i < components.length; i += 1) {
        for (const m of components[i]!.memberIds) {
          idToComponent.set(m, i);
        }
      }

      const rev = reverseAdjacency(input.relations);

      // Seed affected component indices (and synthetic set for unknown roots).
      const affected = new Set<number>();
      const extraStale = new Set<string>(); // roots / nodes outside condensed index
      for (const root of roots) {
        const idx = idToComponent.get(root);
        if (idx === undefined) {
          extraStale.add(root);
        } else {
          affected.add(idx);
        }
      }

      // Explicit SCC expand is part of seeding: any root in a multi-member
      // component marks the whole component (already true by indexing).
      // Reverse-close over dependent edges: if A is stale and B depends on A,
      // mark B's component.
      const queue = [...affected].sort((a, b) => a - b);
      while (queue.length > 0) {
        const ci = queue.shift()!;
        const members = components[ci]!.memberIds;
        for (const m of members) {
          for (const dependent of rev.get(m) ?? []) {
            const di = idToComponent.get(dependent);
            if (di === undefined) {
              extraStale.add(dependent);
              continue;
            }
            if (!affected.has(di)) {
              affected.add(di);
              queue.push(di);
              queue.sort((a, b) => a - b);
            }
          }
        }
      }
      // Also reverse-walk from extra roots not in components (should be rare).
      const extraQueue = [...extraStale].sort((a, b) => a.localeCompare(b));
      while (extraQueue.length > 0) {
        const m = extraQueue.shift()!;
        for (const dependent of rev.get(m) ?? []) {
          const di = idToComponent.get(dependent);
          if (di === undefined) {
            if (!extraStale.has(dependent)) {
              extraStale.add(dependent);
              extraQueue.push(dependent);
              extraQueue.sort((a, b) => a.localeCompare(b));
            }
            continue;
          }
          if (!affected.has(di)) {
            affected.add(di);
            // expand this component's reverse deps too
            const sub = [di];
            while (sub.length > 0) {
              const ci = sub.shift()!;
              for (const mem of components[ci]!.memberIds) {
                for (const dep of rev.get(mem) ?? []) {
                  const d2 = idToComponent.get(dep);
                  if (d2 === undefined) {
                    if (!extraStale.has(dep)) {
                      extraStale.add(dep);
                      extraQueue.push(dep);
                    }
                    continue;
                  }
                  if (!affected.has(d2)) {
                    affected.add(d2);
                    sub.push(d2);
                  }
                }
              }
            }
          }
        }
      }

      const stale = new Set<string>();
      for (const ci of affected) {
        for (const m of components[ci]!.memberIds) stale.add(m);
      }
      for (const id of extraStale) stale.add(id);
      for (const root of roots) stale.add(root);

      // Fail-closed ambiguity: a known classified node with a missing upstream
      // dependency cannot be proven independent of the invalidated roots.
      // Over-invalidating is required; precision on this set is non-gating.
      for (const id of known) {
        const deps = graph.dependenciesOf(id);
        for (const d of deps) {
          if (!known.has(d)) {
            stale.add(id);
            break;
          }
        }
      }

      // Every stale id must carry an explicit class — refuse, do not drop.
      for (const id of stale) {
        if (!classById.has(id)) {
          return failure(
            "INVALID_INPUT",
            "stale artifact lacks explicit ArtifactClass (no prefix inference)",
          );
        }
      }

      const byClass: Record<
        Exclude<ArtifactClass, "unit">,
        string[]
      > = {
        packet: [],
        claim: [],
        composition: [],
        document: [],
        fixture: [],
        certificate: [],
      };

      for (const id of sortedUnique(stale)) {
        const cls = classById.get(id)!;
        if (cls === "unit") continue; // units appear in roots/staleAll only
        byClass[cls].push(id);
      }

      const staleAllIds = sortedUnique(stale);
      return success({
        roots,
        stalePacketIds: Object.freeze(byClass.packet),
        staleClaimIds: Object.freeze(byClass.claim),
        staleCompositionIds: Object.freeze(byClass.composition),
        staleDocumentIds: Object.freeze(byClass.document),
        staleFixtureIds: Object.freeze(byClass.fixture),
        staleCertificateIds: Object.freeze(byClass.certificate),
        staleAllIds: Object.freeze(staleAllIds),
      });
    },
  };
}
