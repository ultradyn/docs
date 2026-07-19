/**
 * B008 — Behavioural golden coverage (fail-closed for non-legacy agents).
 *
 * HONESTY:
 * - validateAgentFixtures remains SHAPE-only (Ajv + input policy). That is
 *   necessary and insufficient.
 * - This module is the second axis: domain validators on NNN-expected goldens.
 * - LEGACY_SHAPE_ONLY is a frozen explicit allowlist, not a default. New agents
 *   must register an executor or the ships-all behavioural pass fails by name.
 * - evidence-critic, claim-extractor, claim-reviewer are NEVER on LEGACY.
 * - researcher remains LEGACY until a dedicated executed suite lands (residual).
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { validateClaimExtractorProposal } from "../ingest/agents/claim-extractor-agent.js";
import { validateClaimReviewerProposal } from "../ingest/agents/claim-reviewer-agent.js";
import { validateEvidenceCriticProposal } from "../ingest/agents/evidence-critic-agent.js";

import type { AgentFixtureValidation } from "./runtime.js";

/** Agents that must have domain-validator golden executors (never on LEGACY). */
export const BEHAVIOURAL_REQUIRED_AGENTS = Object.freeze([
  "evidence-critic",
  "claim-extractor",
  "claim-reviewer",
] as const);

/**
 * Frozen allowlist of agents permitted to ship shape-only goldens.
 * Sorted for pin tests. Adding a name requires dual-axis review.
 * Residual: researcher (and transcript agents) promote when executed suites land.
 */
export const LEGACY_SHAPE_ONLY_AGENTS: ReadonlySet<string> = new Set([
  "agent-smith",
  "critic",
  "diff-summarizer",
  "goal-clerk",
  "integrator",
  "librarian",
  "matcher",
  "prioritizer",
  "registrar",
  "researcher", // promote when executed suite lands
  "reviewer",
  "simulated-asker",
  "structurer",
]);

/** Exact size pin for LEGACY freeze (all current scaffolds except the three). */
export const LEGACY_SHAPE_ONLY_SIZE = 13;

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

function fail(detail: string): GoldenBehaviourResult {
  return { ok: false, detail };
}

function ok(): GoldenBehaviourResult {
  return { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const claimExtractorExecutor: GoldenBehaviourExecutor = {
  execute(_caseId, input, expected) {
    if (!isRecord(input)) return fail("claim-extractor input not object");
    const result = validateClaimExtractorProposal(expected, {
      packet: input.packet,
      verdictAccepted: input.verdictAccepted === true,
    });
    if (!result.ok) return fail(`claim-extractor: ${result.code}`);
    return ok();
  },
};

const claimReviewerExecutor: GoldenBehaviourExecutor = {
  execute(_caseId, input, expected) {
    if (!isRecord(input)) return fail("claim-reviewer input not object");
    if (
      typeof input.reviewerRunId !== "string" ||
      typeof input.extractorRunId !== "string" ||
      !Array.isArray(input.claims)
    ) {
      return fail("claim-reviewer input missing run ids or claims");
    }
    const result = validateClaimReviewerProposal(expected, {
      packet: input.packet,
      claims: input.claims,
      reviewerRunId: input.reviewerRunId,
      extractorRunId: input.extractorRunId,
    });
    if (!result.ok) return fail(`claim-reviewer: ${result.code}`);
    return ok();
  },
};

/**
 * Evidence-critic NNN-input packets are shape stubs; behavioural goldens use the
 * complete-minimal contract packet (same as integration harness T-31-02).
 */
function makeEvidenceCriticExecutor(
  fixturesRoot: string,
): GoldenBehaviourExecutor {
  return {
    async execute(caseId, input, expected) {
      void input; // NNN-input packet is a shape stub; use complete-minimal
      const completePath = join(fixturesRoot, "complete-minimal.json");
      let complete: {
        packet: unknown;
        requiredFacetIds: readonly string[];
      };
      try {
        complete = JSON.parse(await readFile(completePath, "utf8")) as {
          packet: unknown;
          requiredFacetIds: readonly string[];
        };
      } catch (error) {
        return fail(
          `evidence-critic: cannot load complete-minimal.json: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (!Array.isArray(complete.requiredFacetIds)) {
        return fail("evidence-critic: complete-minimal missing facets");
      }
      const result = validateEvidenceCriticProposal(expected, {
        packet: complete.packet,
        requiredFacetIds: [...complete.requiredFacetIds],
      });
      if (!result.ok) {
        return fail(`evidence-critic ${caseId}: ${result.code}`);
      }
      return ok();
    },
  };
}

/**
 * Registered behavioural agents. evidence-critic is factory-bound per fixtures
 * root (see validateAgentBehaviouralGoldens); map entry is a presence marker
 * with a fail-closed unbound stub so registration checks stay uniform.
 */
export const BEHAVIOURAL_GOLDEN_EXECUTORS: ReadonlyMap<
  string,
  GoldenBehaviourExecutor
> = new Map([
  ["claim-extractor", claimExtractorExecutor],
  ["claim-reviewer", claimReviewerExecutor],
  [
    "evidence-critic",
    {
      execute: () =>
        fail(
          "evidence-critic executor requires fixturesRoot binding (internal)",
        ),
    },
  ],
]);

export function assertIngestThreeNeverLegacy(
  legacy: ReadonlySet<string> = LEGACY_SHAPE_ONLY_AGENTS,
): string | undefined {
  for (const name of BEHAVIOURAL_REQUIRED_AGENTS) {
    if (legacy.has(name)) {
      return `${name} must not be on LEGACY_SHAPE_ONLY`;
    }
  }
  return undefined;
}

/**
 * Pure check: every name in `legacy` must exist in `discoveredScaffoldNames`.
 * Returns error detail if rot detected (bogus allowlist entry).
 */
export function legacyRotDetail(
  legacy: ReadonlySet<string>,
  discoveredScaffoldNames: ReadonlySet<string>,
): string | undefined {
  for (const name of legacy) {
    if (!discoveredScaffoldNames.has(name)) {
      return `dead LEGACY_SHAPE_ONLY entry (no scaffold dir): ${name}`;
    }
  }
  return undefined;
}

/**
 * Pure check: non-legacy agent without executor → named error.
 */
export function missingExecutorDetail(
  agentName: string,
  legacy: ReadonlySet<string>,
  executors: ReadonlyMap<string, GoldenBehaviourExecutor>,
): string | undefined {
  if (legacy.has(agentName)) return undefined;
  if (executors.has(agentName)) return undefined;
  return `${agentName}: missing behavioural golden executor (not on LEGACY_SHAPE_ONLY)`;
}

export async function validateAgentBehaviouralGoldens(
  root: string,
): Promise<AgentFixtureValidation[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const results: AgentFixtureValidation[] = [];

  for (const name of names) {
    const errors: string[] = [];
    const fixturesDir = join(root, name, "fixtures");

    if (LEGACY_SHAPE_ONLY_AGENTS.has(name)) {
      results.push({
        name,
        cases: 0,
        valid: true,
        errors: [],
      });
      continue;
    }

    const missing = missingExecutorDetail(
      name,
      LEGACY_SHAPE_ONLY_AGENTS,
      BEHAVIOURAL_GOLDEN_EXECUTORS,
    );
    if (missing) {
      results.push({
        name,
        cases: 0,
        valid: false,
        errors: [missing],
      });
      continue;
    }

    const executor: GoldenBehaviourExecutor =
      name === "evidence-critic"
        ? makeEvidenceCriticExecutor(fixturesDir)
        : BEHAVIOURAL_GOLDEN_EXECUTORS.get(name)!;

    let inputFiles: string[];
    try {
      const files = await readdir(fixturesDir);
      inputFiles = files
        .filter((f) => /^\d{3}-input\.json$/u.test(f))
        .sort();
    } catch (error) {
      results.push({
        name,
        cases: 0,
        valid: false,
        errors: [
          `fixtures unreadable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      });
      continue;
    }

    if (inputFiles.length < 1) {
      errors.push(`${name}: no NNN-input.json behavioural goldens`);
    }

    for (const inputFile of inputFiles) {
      const caseId = inputFile.replace("-input.json", "");
      const expectedFile = `${caseId}-expected.json`;
      try {
        const input = JSON.parse(
          await readFile(join(fixturesDir, inputFile), "utf8"),
        ) as unknown;
        const expected = JSON.parse(
          await readFile(join(fixturesDir, expectedFile), "utf8"),
        ) as unknown;
        const outcome = await executor.execute(caseId, input, expected);
        if (!outcome.ok) {
          errors.push(`${caseId}: ${outcome.detail}`);
        }
      } catch (error) {
        errors.push(
          `${caseId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    results.push({
      name,
      cases: inputFiles.length,
      valid: errors.length === 0,
      errors,
    });
  }

  // Global freeze checks as synthetic rows (visible failures)
  const discovered = new Set(names);
  const rot = legacyRotDetail(LEGACY_SHAPE_ONLY_AGENTS, discovered);
  if (rot) {
    results.push({
      name: "_legacy-rot",
      cases: 0,
      valid: false,
      errors: [rot],
    });
  }
  const ingestLegacy = assertIngestThreeNeverLegacy();
  if (ingestLegacy) {
    results.push({
      name: "_ingest-not-legacy",
      cases: 0,
      valid: false,
      errors: [ingestLegacy],
    });
  }
  if (LEGACY_SHAPE_ONLY_AGENTS.size !== LEGACY_SHAPE_ONLY_SIZE) {
    results.push({
      name: "_legacy-size",
      cases: 0,
      valid: false,
      errors: [
        `LEGACY_SHAPE_ONLY size ${LEGACY_SHAPE_ONLY_AGENTS.size} !== pin ${LEGACY_SHAPE_ONLY_SIZE}`,
      ],
    });
  }

  return results;
}
