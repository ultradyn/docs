/**
 * B008 — Behavioural golden registry (RED checkpoint).
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BEHAVIOURAL_GOLDEN_EXECUTORS,
  LEGACY_SHAPE_ONLY_AGENTS,
  validateAgentBehaviouralGoldens,
} from "./golden-behaviour.js";
import { validateAgentFixtures } from "./runtime.js";

const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const shippedAgentsRoot = join(repositoryRoot, "scaffold/agents");

const MUST_EXECUTE = [
  "evidence-critic",
  "claim-extractor",
  "claim-reviewer",
] as const;

describe("LEGACY_SHAPE_ONLY freeze", () => {
  it("is a non-empty frozen exact set of real scaffold dirs (not the three ingest)", async () => {
    // RED: empty stub fails size pin
    expect(LEGACY_SHAPE_ONLY_AGENTS.size).toBeGreaterThan(0);
    const sorted = [...LEGACY_SHAPE_ONLY_AGENTS].sort();
    // Exact pin will be filled on GREEN; size must match non-behavioural agents
    expect(sorted).not.toContain("evidence-critic");
    expect(sorted).not.toContain("claim-extractor");
    expect(sorted).not.toContain("claim-reviewer");
  });

  it("every LEGACY name corresponds to a real scaffold directory (no rot)", async () => {
    const results = await validateAgentFixtures(shippedAgentsRoot);
    const discovered = new Set(results.map((r) => r.name));
    for (const name of LEGACY_SHAPE_ONLY_AGENTS) {
      expect(discovered.has(name), `dead LEGACY entry: ${name}`).toBe(true);
    }
  });

  it("ingest three are never on LEGACY", () => {
    for (const name of MUST_EXECUTE) {
      expect(LEGACY_SHAPE_ONLY_AGENTS.has(name)).toBe(false);
    }
  });
});

describe("behavioural executors registered for non-legacy", () => {
  it("every non-legacy shipped agent has an executor", async () => {
    const results = await validateAgentFixtures(shippedAgentsRoot);
    for (const { name } of results) {
      if (LEGACY_SHAPE_ONLY_AGENTS.has(name)) continue;
      expect(
        BEHAVIOURAL_GOLDEN_EXECUTORS.has(name),
        `${name}: missing behavioural golden executor (not on LEGACY_SHAPE_ONLY)`,
      ).toBe(true);
    }
  });

  it("validateAgentBehaviouralGoldens is valid for all shipped agents", async () => {
    const behavioural = await validateAgentBehaviouralGoldens(shippedAgentsRoot);
    const failed = behavioural.filter((r) => !r.valid);
    expect(failed, JSON.stringify(failed.map((f) => f.errors))).toEqual([]);
  });
});

describe("two axes distinct — shape green, behaviour fails on corruption", () => {
  it("claim-extractor: schema-legal wrong unitId keeps Ajv green and fails behavioural", async () => {
    const fixturesRoot = join(
      shippedAgentsRoot,
      "claim-extractor/fixtures",
    );
    const input = JSON.parse(
      await readFile(join(fixturesRoot, "001-input.json"), "utf8"),
    ) as { packet: unknown; verdictAccepted: boolean };
    const expected = JSON.parse(
      await readFile(join(fixturesRoot, "001-expected.json"), "utf8"),
    ) as { claims: Array<Record<string, unknown>> };

    const corrupted = {
      claims: [
        {
          ...expected.claims[0],
          text: "Schema-legal fabricated claim citing missing unit.",
          evidenceReferenceIds: ["unit-01ARZ3NDEKTSV4RRFFQ69G5FZZ"],
        },
      ],
    };

    // Shape axis: load schema Ajv — still green
    const shapeResults = await validateAgentFixtures(shippedAgentsRoot);
    const extractorShape = shapeResults.find((r) => r.name === "claim-extractor");
    expect(extractorShape?.valid).toBe(true);

    // Direct shape of corrupted body (Ajv via fixture schema is separate — executor path)
    const executor = BEHAVIOURAL_GOLDEN_EXECUTORS.get("claim-extractor");
    expect(executor).toBeDefined();
    const behavioural = await executor!.execute("001-corrupt", input, corrupted);
    expect(behavioural.ok).toBe(false);
  });
});

describe("missing executor named failure", () => {
  it("reports missing executor by agent name for non-legacy without registration", async () => {
    // Structural: after GREEN, a name neither on LEGACY nor map fails validation list.
    // For RED we assert the public function fails overall (stub).
    const behavioural = await validateAgentBehaviouralGoldens(shippedAgentsRoot);
    expect(behavioural.some((r) => !r.valid)).toBe(true);
    const text = behavioural.flatMap((r) => r.errors).join(" ");
    expect(text.length).toBeGreaterThan(0);
  });
});
