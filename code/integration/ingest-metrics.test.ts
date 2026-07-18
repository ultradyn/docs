import { describe, expect, it } from "vitest";
import { scoreIngestRun, type IngestMetricCounts } from "./index.js";

const worked: IngestMetricCounts = {
  evidence: { truePositive: 8, falsePositive: 2, falseNegative: 4 },
  noEvidence: { falseNoEvidence: 3, actualAnswerable: 12 },
  claims: { entailed: 9, reviewed: 12 },
  merges: { falseMerge: 1, proposedMerge: 5 },
  contradictions: { found: 3, expected: 4 },
  sources: { covered: 18, total: 20 },
  answers: { sufficient: 7, evaluated: 10 },
};

describe("ingestion quality metrics", () => {
  it("scores a worked literal confusion matrix", () => {
    expect(scoreIngestRun(worked)).toEqual({
      evidenceRecall: 2 / 3,
      evidencePrecision: 0.8,
      falseNoEvidenceRate: 0.25,
      claimEntailmentRate: 0.75,
      falseMergeRate: 0.2,
      contradictionRecall: 0.75,
      sourceCoverage: 0.9,
      answerSufficiency: 0.7,
    });
  });

  it("keeps source coverage distinct from answer sufficiency", () => {
    const metrics = scoreIngestRun(worked);
    expect(metrics.sourceCoverage).not.toBe(metrics.answerSufficiency);
  });

  it("returns zero for an empty denominator", () => {
    const zero = scoreIngestRun({
      evidence: { truePositive: 0, falsePositive: 0, falseNegative: 0 },
      noEvidence: { falseNoEvidence: 0, actualAnswerable: 0 },
      claims: { entailed: 0, reviewed: 0 },
      merges: { falseMerge: 0, proposedMerge: 0 },
      contradictions: { found: 0, expected: 0 },
      sources: { covered: 0, total: 0 },
      answers: { sufficient: 0, evaluated: 0 },
    });
    expect(Object.values(zero)).toEqual(Array(8).fill(0));
  });

  it("rejects impossible or negative counts", () => {
    expect(() =>
      scoreIngestRun({
        ...worked,
        evidence: { truePositive: -1, falsePositive: 0, falseNegative: 0 },
      }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      scoreIngestRun({ ...worked, sources: { covered: 21, total: 20 } }),
    ).toThrow(/covered cannot exceed total/);
  });
});
