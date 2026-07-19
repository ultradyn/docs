/**
 * T-31-02 — Evidence-criticism fixture harness (executed, not schema-only).
 *
 * Schema goldens 001-003 under the agent fixtures directory are for
 * validateAgentFixtures only (shape). Behavioural coverage is the named JSON
 * cases loaded here and run through validateEvidenceCriticProposal.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  createEvidenceCriticAgent,
  validateEvidenceCriticProposal,
  type EvidenceCriticError,
} from "../ingest/agents/evidence-critic-agent.js";

export const EVIDENCE_CRITIC_NAMED_CASES = [
  "partial",
  "irrelevant",
  "redundant",
  "wrong-scope",
  "deprecation",
  "conflict",
  "no-evidence",
  "prompt-injection",
] as const;

export type EvidenceCriticNamedCaseId =
  (typeof EVIDENCE_CRITIC_NAMED_CASES)[number];

/** Pinned thresholds — denominators are exact regression pins (>0). */
export const EvidenceCriticThresholds = Object.freeze({
  weakPacketAcceptance: 0,
  completeMinimalAcceptance: 1,
  injectionRoleChanges: 0,
  weakPacketCount: 7,
  /** Two hand-authored complete_minimal shapes (not a 1/1 smoke pin). */
  completeMinimalCount: 2,
  injectionCaseCount: 1,
});

export type EvidenceCriticFixtureCase = {
  readonly caseId: string;
  readonly kind: "weak" | "complete_minimal" | "injection";
  readonly packet: unknown;
  readonly requiredFacetIds: readonly string[];
  readonly proposal: unknown;
  readonly expected:
    | { readonly ok: true; readonly verdict: string }
    | { readonly ok: false; readonly code: string };
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

export async function loadNamedEvidenceCriticFixtures(
  fixturesRoot: string,
): Promise<readonly EvidenceCriticFixtureCase[]> {
  const files = await readdir(fixturesRoot);
  const cases: EvidenceCriticFixtureCase[] = [];

  for (const caseId of EVIDENCE_CRITIC_NAMED_CASES) {
    const file = `${caseId}.json`;
    if (!files.includes(file)) {
      throw new Error(`Missing named criticism fixture: ${file}`);
    }
    const raw = JSON.parse(
      await readFile(join(fixturesRoot, file), "utf8"),
    ) as EvidenceCriticFixtureCase;
    if (raw.caseId !== caseId) {
      throw new Error(`Fixture ${file} caseId mismatch: ${raw.caseId}`);
    }
    if (
      raw.kind !== "weak" &&
      raw.kind !== "complete_minimal" &&
      raw.kind !== "injection"
    ) {
      throw new Error(`Fixture ${file} has invalid kind`);
    }
    cases.push(deepFreeze(raw));
  }

  // complete-minimal cases: two hand-authored shapes (two-facet + single-facet)
  const completeFiles = files
    .filter((f) => /^complete-minimal.*\.json$/u.test(f))
    .sort();
  if (completeFiles.length < 2) {
    throw new Error(
      "Need at least two complete-minimal*.json behavioural fixtures",
    );
  }
  for (const file of completeFiles) {
    const complete = JSON.parse(
      await readFile(join(fixturesRoot, file), "utf8"),
    ) as EvidenceCriticFixtureCase;
    if (complete.kind !== "complete_minimal") {
      throw new Error(`${file} must have kind complete_minimal`);
    }
    cases.push(deepFreeze(complete));
  }

  return Object.freeze(cases);
}

export function runEvidenceCriticFixtureCase(
  fixture: EvidenceCriticFixtureCase,
): { matched: boolean; detail: string } {
  const actual = validateEvidenceCriticProposal(fixture.proposal, {
    packet: fixture.packet,
    requiredFacetIds: [...fixture.requiredFacetIds],
  });

  if (fixture.expected.ok) {
    if (!actual.ok) {
      return {
        matched: false,
        detail: `expected ok verdict=${fixture.expected.verdict} got code=${actual.code}`,
      };
    }
    if (actual.value.verdict !== fixture.expected.verdict) {
      return {
        matched: false,
        detail: `expected verdict=${fixture.expected.verdict} got ${actual.value.verdict}`,
      };
    }
    return { matched: true, detail: "ok" };
  }

  if (actual.ok) {
    return {
      matched: false,
      detail: `expected code=${fixture.expected.code} got ok verdict=${actual.value.verdict}`,
    };
  }
  if (actual.code !== fixture.expected.code) {
    return {
      matched: false,
      detail: `expected code=${fixture.expected.code} got ${actual.code}`,
    };
  }
  return { matched: true, detail: "ok" };
}

export type MeasuredEvidenceCriticThresholds = {
  readonly weakPacketAcceptance: number;
  readonly completeMinimalAcceptance: number;
  readonly injectionRoleChanges: number;
  readonly weakPacketCount: number;
  readonly completeMinimalCount: number;
  readonly injectionCaseCount: number;
};

export function measureEvidenceCriticThresholds(
  cases: readonly EvidenceCriticFixtureCase[],
): MeasuredEvidenceCriticThresholds {
  const weak = cases.filter((c) => c.kind === "weak");
  const complete = cases.filter((c) => c.kind === "complete_minimal");
  const injection = cases.filter((c) => c.kind === "injection");

  if (weak.length === 0 || complete.length === 0 || injection.length === 0) {
    throw new Error(
      "Threshold denominators must be non-empty (weak/complete_minimal/injection)",
    );
  }

  let weakAccepted = 0;
  for (const c of weak) {
    const actual = validateEvidenceCriticProposal(c.proposal, {
      packet: c.packet,
      requiredFacetIds: [...c.requiredFacetIds],
    });
    if (actual.ok && actual.value.verdict === "accepted") weakAccepted += 1;
  }

  let completeAccepted = 0;
  for (const c of complete) {
    const actual = validateEvidenceCriticProposal(c.proposal, {
      packet: c.packet,
      requiredFacetIds: [...c.requiredFacetIds],
    });
    if (actual.ok && actual.value.verdict === "accepted") completeAccepted += 1;
  }

  let injectionRoleChanges = 0;
  for (const c of injection) {
    const actual = validateEvidenceCriticProposal(c.proposal, {
      packet: c.packet,
      requiredFacetIds: [...c.requiredFacetIds],
    });
    // Role/child smuggling that still accepts counts as a change
    if (actual.ok && actual.value.verdict === "accepted") {
      injectionRoleChanges += 1;
    }
  }

  return Object.freeze({
    weakPacketAcceptance: weakAccepted / weak.length,
    completeMinimalAcceptance: completeAccepted / complete.length,
    injectionRoleChanges,
    weakPacketCount: weak.length,
    completeMinimalCount: complete.length,
    injectionCaseCount: injection.length,
  });
}

export function createEvidenceCriticFixtureProposer(registry: {
  readonly cases?: ReadonlyMap<string, unknown>;
}): (input: {
  readonly questionId: string;
  readonly question: string;
  readonly facets: readonly string[];
  readonly packet: unknown;
  readonly caseId?: string;
}) => Promise<unknown> {
  const map = registry.cases ?? new Map<string, unknown>();
  return async (input) => {
    const caseId = input.caseId;
    if (!caseId || !map.has(caseId)) {
      throw new Error(
        `unregistered evidence-critic fixture case: ${caseId ?? "(missing)"}`,
      );
    }
    return map.get(caseId);
  };
}

/**
 * Run a numbered schema golden (001-003 expected) through the behavioural
 * validator with a full packet — REQUIRED 1: goldens must be executed, not only shape-checked.
 */
export function executeSchemaGoldenProposal(
  proposal: unknown,
  packet: unknown,
  requiredFacetIds: readonly string[],
): { ok: boolean; code?: EvidenceCriticError; verdict?: string } {
  const result = validateEvidenceCriticProposal(proposal, {
    packet,
    requiredFacetIds: [...requiredFacetIds],
  });
  if (result.ok) return { ok: true, verdict: result.value.verdict };
  return { ok: false, code: result.code };
}

export { createEvidenceCriticAgent };
