/**
 * B008 — Behavioural golden registry (fail-closed).
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveShippedPath } from "../shared/shipped-layout.js";
import {
  BEHAVIOURAL_GOLDEN_EXECUTORS,
  BEHAVIOURAL_REQUIRED_AGENTS,
  LEGACY_SHAPE_ONLY_AGENTS,
  LEGACY_SHAPE_ONLY_SIZE,
  assertIngestThreeNeverLegacy,
  legacyRotDetail,
  missingExecutorDetail,
  validateAgentBehaviouralGoldens,
} from "./golden-behaviour.js";
import { validateAgentFixtures } from "./runtime.js";

const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const shippedAgentsRoot = resolveShippedPath(repositoryRoot, "agents");

describe("LEGACY_SHAPE_ONLY freeze", () => {
  it("is the frozen exact sorted set with size pin", () => {
    expect(LEGACY_SHAPE_ONLY_AGENTS.size).toBe(LEGACY_SHAPE_ONLY_SIZE);
    expect([...LEGACY_SHAPE_ONLY_AGENTS].sort()).toEqual([
      "agent-smith",
      "critic",
      "diff-summarizer",
      "goal-clerk",
      "integrator",
      "librarian",
      "matcher",
      "prioritizer",
      "registrar",
      "researcher",
      "reviewer",
      "simulated-asker",
      "structurer",
    ]);
  });

  it("every LEGACY name is a real scaffold dir; bogus name is flagged", async () => {
    const results = await validateAgentFixtures(shippedAgentsRoot);
    const discovered = new Set(results.map((r) => r.name));
    expect(legacyRotDetail(LEGACY_SHAPE_ONLY_AGENTS, discovered)).toBeUndefined();
    // Positive control: detect rot
    const withBogus = new Set([...LEGACY_SHAPE_ONLY_AGENTS, "not-a-real-agent"]);
    expect(legacyRotDetail(withBogus, discovered)).toMatch(/not-a-real-agent/);
  });

  it("ingest three are never on LEGACY (and would fail if added)", () => {
    expect(assertIngestThreeNeverLegacy()).toBeUndefined();
    for (const name of BEHAVIOURAL_REQUIRED_AGENTS) {
      expect(LEGACY_SHAPE_ONLY_AGENTS.has(name)).toBe(false);
    }
    // Positive control: if claim-reviewer were on LEGACY, check fails
    const polluted = new Set(LEGACY_SHAPE_ONLY_AGENTS);
    polluted.add("claim-reviewer");
    expect(assertIngestThreeNeverLegacy(polluted)).toMatch(/claim-reviewer/);
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
    const behavioural =
      await validateAgentBehaviouralGoldens(shippedAgentsRoot);
    const failed = behavioural.filter((r) => !r.valid);
    expect(
      failed,
      JSON.stringify(failed.map((f) => ({ name: f.name, errors: f.errors }))),
    ).toEqual([]);
  });

  it("registered agent does not report missing executor; unregistered non-legacy does", () => {
    // Positive control: registered claim-extractor is fine
    expect(
      missingExecutorDetail(
        "claim-extractor",
        LEGACY_SHAPE_ONLY_AGENTS,
        BEHAVIOURAL_GOLDEN_EXECUTORS,
      ),
    ).toBeUndefined();
    // Missing case by name
    expect(
      missingExecutorDetail(
        "brand-new-agent",
        LEGACY_SHAPE_ONLY_AGENTS,
        BEHAVIOURAL_GOLDEN_EXECUTORS,
      ),
    ).toMatch(/brand-new-agent: missing behavioural golden executor/);
    // Legacy skips
    expect(
      missingExecutorDetail(
        "librarian",
        LEGACY_SHAPE_ONLY_AGENTS,
        BEHAVIOURAL_GOLDEN_EXECUTORS,
      ),
    ).toBeUndefined();
  });
});

describe("two axes distinct — shape green, behaviour fails on corruption", () => {
  it("claim-extractor: schema-legal wrong unitId keeps shape green and fails behavioural", async () => {
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

    // Shape axis: fixture registry still green for real goldens
    const shapeResults = await validateAgentFixtures(shippedAgentsRoot);
    const extractorShape = shapeResults.find(
      (r) => r.name === "claim-extractor",
    );
    expect(extractorShape?.valid).toBe(true);

    // Behavioural axis: corrupted expected fails domain gate
    const executor = BEHAVIOURAL_GOLDEN_EXECUTORS.get("claim-extractor");
    expect(executor).toBeDefined();
    const behavioural = await executor!.execute(
      "001-corrupt",
      input,
      corrupted,
    );
    expect(behavioural.ok).toBe(false);
    if (behavioural.ok) return;
    expect(behavioural.detail).toMatch(/UNSUPPORTED_EVIDENCE|claim-extractor/);
  });
});
