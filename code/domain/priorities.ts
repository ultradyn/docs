import type { PriorityTier } from "./schemas.js";

export interface PriorityAssignment {
  tier: PriorityTier;
  rationale: string;
  source: "rule" | "override";
}

export interface PriorityFacts {
  origin: "raw" | "generated";
  depth: number;
  contradiction?: boolean;
  reopenedAfterRejection?: boolean;
  demandPromoted?: boolean;
  unsatisfiedGoalOnActiveQuestion?: boolean;
  extraDetail?: boolean;
  override?: { tier: PriorityTier; rationale: string };
}

export function assignPriority(facts: PriorityFacts): PriorityAssignment {
  if (facts.override) {
    return { ...facts.override, source: "override" };
  }
  if (facts.contradiction) {
    return {
      tier: "P1",
      rationale: "An unresolved contradiction is an active blocker.",
      source: "rule",
    };
  }
  if (facts.reopenedAfterRejection) {
    return {
      tier: "P1",
      rationale:
        "An explicit asker rejection reopens the question as an active blocker.",
      source: "rule",
    };
  }
  if (facts.demandPromoted) {
    return {
      tier: "P2",
      rationale: "New asker demand promoted a previously deferred question.",
      source: "rule",
    };
  }
  if (facts.unsatisfiedGoalOnActiveQuestion) {
    return {
      tier: "P2",
      rationale: "An active question still has a declared unsatisfied goal.",
      source: "rule",
    };
  }
  if (facts.origin === "raw") {
    return {
      tier: "P3",
      rationale: "Raw questions default to P3.",
      source: "rule",
    };
  }
  if (facts.depth <= 1 && !facts.extraDetail) {
    return {
      tier: "P4",
      rationale:
        "A noncontradictory generated question at depth 1 defaults to P4.",
      source: "rule",
    };
  }
  return {
    tier: "P5",
    rationale: "A deeper generated or extra-detail question defaults to P5.",
    source: "rule",
  };
}
