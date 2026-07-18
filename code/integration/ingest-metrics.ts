export interface IngestMetricCounts {
  evidence: {
    truePositive: number;
    falsePositive: number;
    falseNegative: number;
  };
  noEvidence: { falseNoEvidence: number; actualAnswerable: number };
  claims: { entailed: number; reviewed: number };
  merges: { falseMerge: number; proposedMerge: number };
  contradictions: { found: number; expected: number };
  sources: { covered: number; total: number };
  answers: { sufficient: number; evaluated: number };
}

export interface IngestMetrics {
  evidenceRecall: number;
  evidencePrecision: number;
  falseNoEvidenceRate: number;
  claimEntailmentRate: number;
  falseMergeRate: number;
  contradictionRecall: number;
  sourceCoverage: number;
  answerSufficiency: number;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function requireCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

export function scoreIngestRun(counts: IngestMetricCounts): IngestMetrics {
  const entries: Array<[string, number]> = [
    ["evidence.truePositive", counts.evidence.truePositive],
    ["evidence.falsePositive", counts.evidence.falsePositive],
    ["evidence.falseNegative", counts.evidence.falseNegative],
    ["noEvidence.falseNoEvidence", counts.noEvidence.falseNoEvidence],
    ["noEvidence.actualAnswerable", counts.noEvidence.actualAnswerable],
    ["claims.entailed", counts.claims.entailed],
    ["claims.reviewed", counts.claims.reviewed],
    ["merges.falseMerge", counts.merges.falseMerge],
    ["merges.proposedMerge", counts.merges.proposedMerge],
    ["contradictions.found", counts.contradictions.found],
    ["contradictions.expected", counts.contradictions.expected],
    ["sources.covered", counts.sources.covered],
    ["sources.total", counts.sources.total],
    ["answers.sufficient", counts.answers.sufficient],
    ["answers.evaluated", counts.answers.evaluated],
  ];
  for (const [name, value] of entries) requireCount(name, value);

  for (const [name, numerator, denominator] of [
    [
      "falseNoEvidence",
      counts.noEvidence.falseNoEvidence,
      counts.noEvidence.actualAnswerable,
    ],
    ["entailed", counts.claims.entailed, counts.claims.reviewed],
    ["falseMerge", counts.merges.falseMerge, counts.merges.proposedMerge],
    ["found", counts.contradictions.found, counts.contradictions.expected],
    ["covered", counts.sources.covered, counts.sources.total],
    ["sufficient", counts.answers.sufficient, counts.answers.evaluated],
  ] as const) {
    if (numerator > denominator)
      throw new Error(
        `${name} cannot exceed ${name === "covered" ? "total" : "denominator"}`,
      );
  }

  return {
    evidenceRecall: ratio(
      counts.evidence.truePositive,
      counts.evidence.truePositive + counts.evidence.falseNegative,
    ),
    evidencePrecision: ratio(
      counts.evidence.truePositive,
      counts.evidence.truePositive + counts.evidence.falsePositive,
    ),
    falseNoEvidenceRate: ratio(
      counts.noEvidence.falseNoEvidence,
      counts.noEvidence.actualAnswerable,
    ),
    claimEntailmentRate: ratio(counts.claims.entailed, counts.claims.reviewed),
    falseMergeRate: ratio(
      counts.merges.falseMerge,
      counts.merges.proposedMerge,
    ),
    contradictionRecall: ratio(
      counts.contradictions.found,
      counts.contradictions.expected,
    ),
    sourceCoverage: ratio(counts.sources.covered, counts.sources.total),
    answerSufficiency: ratio(
      counts.answers.sufficient,
      counts.answers.evaluated,
    ),
  };
}
