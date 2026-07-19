import { describe, expect, it } from "vitest";

import {
  compareEvidenceRoles,
  ABLATION_DECISION_RULE,
  type RoleRunReport,
} from "./evidence-role-ablation.js";

/**
 * A note on what these tests are for.
 *
 * The plan requires a FALSIFIABLE decision. So the tests below deliberately
 * include a case where the split role LOSES and the decision must come out
 * "revisit". If the only covered outcome were "retain-split", this suite would
 * be a confirmation exercise dressed as a measurement — it would pass whether
 * or not the comparison worked, as long as it always agreed with what we built.
 */

const VERSIONS = {
  corpusSha256: "a".repeat(64),
  modelVersion: "fake-model-v1",
  promptVersion: "evidence-critic-v1",
  metricDefinitionVersion: "rubric-v1",
} as const;

function report(overrides: Partial<RoleRunReport> = {}): RoleRunReport {
  return {
    role: "split",
    ...VERSIONS,
    falseAcceptances: 1,
    totalJudgements: 20,
    refinementsUseful: 8,
    refinementsTotal: 10,
    childBranches: 4,
    parentQuestions: 4,
    costAud: 0.5,
    outputsByRepeat: [["a", "b"], ["a", "b"], ["a", "b"]],
    ...overrides,
  } as RoleRunReport;
}

describe("version binding", () => {
  it("REFUSES to compare reports from different corpora", () => {
    const result = compareEvidenceRoles(
      report({ role: "split" }),
      report({ role: "combined", corpusSha256: "b".repeat(64) }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VERSION_MISMATCH");
  });

  it("REFUSES to compare reports from different model versions", () => {
    const result = compareEvidenceRoles(
      report({ role: "split" }),
      report({ role: "combined", modelVersion: "fake-model-v2" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VERSION_MISMATCH");
  });

  it("REFUSES to compare reports from different prompt versions", () => {
    const result = compareEvidenceRoles(
      report({ role: "split" }),
      report({ role: "combined", promptVersion: "evidence-critic-v2" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VERSION_MISMATCH");
  });

  it("REFUSES reports scored under different metric definitions", () => {
    // Same prompt string, different scoring rubric. These LOOK comparable and
    // are not: if "useful refinement" was redefined between runs, the two
    // refinementQuality numbers are not measuring the same thing.
    const result = compareEvidenceRoles(
      report({ role: "split" }),
      report({ role: "combined", metricDefinitionVersion: "rubric-v2" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VERSION_MISMATCH");
  });

  it("REFUSES two reports of the same role", () => {
    // Comparing split against split is not an ablation; it is a repeat.
    const result = compareEvidenceRoles(
      report({ role: "split" }),
      report({ role: "split" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_INPUT");
  });
});

describe("exact metrics", () => {
  it("computes each metric from the worked input, not from stored conclusions", () => {
    const result = compareEvidenceRoles(
      report({
        role: "split",
        falseAcceptances: 1,
        totalJudgements: 20,
        refinementsUseful: 8,
        refinementsTotal: 10,
        childBranches: 4,
        parentQuestions: 4,
        costAud: 0.5,
        outputsByRepeat: [["a"], ["a"], ["a"]],
      }),
      report({
        role: "combined",
        falseAcceptances: 5,
        totalJudgements: 20,
        refinementsUseful: 3,
        refinementsTotal: 10,
        childBranches: 12,
        parentQuestions: 4,
        costAud: 0.4,
        outputsByRepeat: [["a"], ["b"], ["a"]],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.split.falseAcceptance).toBeCloseTo(0.05, 6);
    expect(result.value.combined.falseAcceptance).toBeCloseTo(0.25, 6);
    expect(result.value.split.refinementQuality).toBeCloseTo(0.8, 6);
    expect(result.value.combined.refinementQuality).toBeCloseTo(0.3, 6);
    expect(result.value.split.branchFactor).toBeCloseTo(1, 6);
    expect(result.value.combined.branchFactor).toBeCloseTo(3, 6);
    expect(result.value.split.costAud).toBeCloseTo(0.5, 6);
    // Stability: 3 identical repeats = 1; one differing repeat < 1.
    expect(result.value.split.outputStability).toBeCloseTo(1, 6);
    expect(result.value.combined.outputStability).toBeLessThan(1);
  });

  it("REFUSES counts that would produce a rate outside [0,1]", () => {
    // A garbage rate that still yields a confident decision is the same family
    // as a vacuous denominator — the output looks like a measurement.
    for (const bad of [
      { falseAcceptances: -1 },
      { falseAcceptances: 999, totalJudgements: 20 },
      { refinementsUseful: 99, refinementsTotal: 10 },
      { costAud: -5 },
    ]) {
      const result = compareEvidenceRoles(
        report({ role: "split", ...bad }),
        report({ role: "combined" }),
      );
      expect(result.ok, `expected refusal for ${JSON.stringify(bad)}`).toBe(
        false,
      );
      if (result.ok) continue;
      expect(result.code).toBe("INSUFFICIENT_DATA");
    }
    // Positive control: in-range counts still produce a result, so the above
    // cannot be satisfied by a function that refuses everything.
    const ok = compareEvidenceRoles(
      report({ role: "split" }),
      report({ role: "combined" }),
    );
    expect(ok.ok).toBe(true);
  });

  it("REFUSES a zero denominator rather than reporting a vacuous rate", () => {
    // 0/0 must not become 0 or 1 — both would read as a measurement.
    const result = compareEvidenceRoles(
      report({ role: "split", totalJudgements: 0 }),
      report({ role: "combined" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INSUFFICIENT_DATA");
  });
});

describe("falsifiable decision", () => {
  it("returns retain-split when the split role is materially better", () => {
    const result = compareEvidenceRoles(
      report({ role: "split", falseAcceptances: 1, refinementsUseful: 9 }),
      report({ role: "combined", falseAcceptances: 6, refinementsUseful: 2 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe("retain-split");
  });

  it("returns REVISIT when the split role is NOT materially better", () => {
    /**
     * This is the test that makes the exercise falsifiable. If the decision
     * rule cannot produce "revisit" on data where the split role fails to earn
     * its cost, then the ablation only ever ratifies the existing architecture
     * and the acceptance criterion "must provide a material gain OR BE
     * REVISITED" is unmeetable by construction.
     */
    const result = compareEvidenceRoles(
      report({ role: "split", falseAcceptances: 4, refinementsUseful: 5, costAud: 2.0 }),
      report({ role: "combined", falseAcceptances: 4, refinementsUseful: 5, costAud: 0.4 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe("revisit");
  });

  it("publishes the decision rule as data, fixed before the numbers", () => {
    // The rule must be inspectable, so a reader can check it was not tuned to
    // fit the observed result after the fact.
    expect(ABLATION_DECISION_RULE).toBeDefined();
    expect(Object.isFrozen(ABLATION_DECISION_RULE)).toBe(true);
    expect(typeof ABLATION_DECISION_RULE.minFalseAcceptanceReduction).toBe(
      "number",
    );
    expect(typeof ABLATION_DECISION_RULE.minRefinementQualityGain).toBe(
      "number",
    );
    expect(typeof ABLATION_DECISION_RULE.maxCostMultiple).toBe("number");
  });
});

describe("hygiene", () => {
  it("deep-freezes the result and states its own limits", async () => {
    const result = compareEvidenceRoles(
      report({ role: "split" }),
      report({ role: "combined" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
    // The result must carry its own caveat so a reader quoting the decision
    // cannot strip the context that it came from recorded fixtures.
    expect(result.value.limitations.length).toBeGreaterThan(0);
  });
});
