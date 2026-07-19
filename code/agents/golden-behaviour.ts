/**
 * B008 — Behavioural golden coverage (RED stub).
 *
 * Shape pins (validateAgentFixtures) remain. This module will require every
 * non-LEGACY agent to register a domain-validator executor for NNN goldens.
 *
 * LEGACY_SHAPE_ONLY is frozen — not a default for new agents.
 * evidence-critic / claim-extractor / claim-reviewer are NEVER on LEGACY.
 */
import type { AgentFixtureValidation } from "./runtime.js";

/**
 * Frozen allowlist of agents permitted to ship shape-only goldens.
 * Residual: researcher (and others) promote when an executed suite lands.
 * Do not add names without dual-axis review. Dead entries forbidden (must match scaffold).
 */
export const LEGACY_SHAPE_ONLY_AGENTS: ReadonlySet<string> = new Set([
  // RED stub: empty set — GREEN fills frozen exact list of all except the three.
]);

export type GoldenBehaviourResult =
  | { ok: true }
  | { ok: false; detail: string };

export type GoldenBehaviourExecutor = {
  execute(
    caseId: string,
    input: unknown,
    expected: unknown,
  ): GoldenBehaviourResult | Promise<GoldenBehaviourResult>;
};

/** RED stub: no executors registered. */
export const BEHAVIOURAL_GOLDEN_EXECUTORS: ReadonlyMap<
  string,
  GoldenBehaviourExecutor
> = new Map();

/**
 * RED stub — always reports missing behavioural coverage.
 */
export async function validateAgentBehaviouralGoldens(
  _root: string,
): Promise<AgentFixtureValidation[]> {
  return [
    {
      name: "_b008-stub",
      cases: 0,
      valid: false,
      errors: ["B008 behavioural golden coverage not implemented (RED)."],
    },
  ];
}
