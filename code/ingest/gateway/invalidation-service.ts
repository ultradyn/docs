/**
 * T-23-03 — Invalidation propagation (RED stub / surface).
 *
 * HONESTY (binding):
 * - `relations` are projection INPUT (same contract as T-23-02), not durable edges.
 * - Completeness of invalidation equals completeness of the caller-supplied
 *   relation set plus fail-closed rules for missing upstream deps.
 * - `projectDependencyGraph.readiness()` is NOT a publish authority and MUST NOT
 *   be wired as one here. Use `assertPublishable` (plan membership + durable
 *   stale state) instead.
 * - Precision metrics apply only where the correct set is fully determined
 *   (unambiguous fixtures). Where truth is not determined, fail-closed
 *   over-invalidation wins; precision is non-gating on those fixtures.
 * - ArtifactClass is always explicit. Never infer class from id prefix — prefix
 *   sniffing fails open for unknown brands (treats them as "not that class" /
 *   "not affected"), which is the forbidden direction under invalidation.
 * - Graph commits for invalidation MUST go through GraphGateway (sole sanctioned
 *   graph-mutation path). This module does not open a second writer to the
 *   durable commit log.
 * - Append-only custody: create superseding stale versions / commits; never
 *   delete, erase, purge, or unlink.
 */
import type { GraphEvent } from "../../domain/ingest/graph-event.js";
import type { IngestResult } from "../../domain/ingest/types.js";

import type { DependencyRelation } from "./dependency-graph.js";

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
  void id;
  void input;
  // RED: not implemented — always refuse so publish tests fail until GREEN.
  return Object.freeze({
    ok: false as const,
    code: "STALE" as const,
    message: "assertPublishable not implemented (T-23-03 RED)",
  });
}

export function createInvalidationService(): InvalidationService {
  return {
    plan() {
      // RED: empty plan so precision/recall and membership asserts fail.
      return Object.freeze({
        ok: true as const,
        value: Object.freeze({
          roots: Object.freeze([] as string[]),
          stalePacketIds: Object.freeze([] as string[]),
          staleClaimIds: Object.freeze([] as string[]),
          staleCompositionIds: Object.freeze([] as string[]),
          staleDocumentIds: Object.freeze([] as string[]),
          staleFixtureIds: Object.freeze([] as string[]),
          staleCertificateIds: Object.freeze([] as string[]),
          staleAllIds: Object.freeze([] as string[]),
        }),
      });
    },
  };
}
