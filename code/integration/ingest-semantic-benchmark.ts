export const SEMANTIC_BENCHMARK_THRESHOLDS = Object.freeze({
  minimumRecallDelta: 0.15,
  minimumPrecisionDelta: 0,
  maximumP95LatencyDeltaMs: 20,
  maximumCostDeltaAud: 0.01,
});

export const SEMANTIC_BENCHMARK_LIMITS = Object.freeze({
  maxCases: 256,
  maxUnitIdsPerCase: 100,
  maxIdentifierChars: 256,
  maxLatencyMs: 60_000,
  maxCostAudPerCase: 100,
});

export type BenchmarkCorpus = "tiny" | "small";
export type RetrievalStrategy = "lexical" | "dense" | "hybrid";

export interface BenchmarkFixtureProvenance {
  readonly corpus: BenchmarkCorpus;
  readonly expectedGraphSha256: string;
  readonly queryCount: number;
}

export interface RetrievalBenchmarkCase {
  readonly caseId: string;
  readonly corpus: BenchmarkCorpus;
  readonly relevantUnitIds: readonly string[];
  readonly selectedUnitIds: readonly string[];
  readonly latencyMs: number;
  readonly costAud: number;
}

export interface RetrievalBenchmarkRun {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly strategy: RetrievalStrategy;
  readonly fixtureProvenance: readonly BenchmarkFixtureProvenance[];
  readonly cases: readonly RetrievalBenchmarkCase[];
}

export interface RetrievalRunMetrics {
  readonly strategy: RetrievalStrategy;
  readonly queryCount: number;
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
  readonly recall: number;
  readonly precision: number;
  readonly p95LatencyMs: number;
  readonly costAud: number;
}

export interface RetrievalComparison {
  readonly recallDelta: number;
  readonly precisionDelta: number;
  readonly p95LatencyDeltaMs: number;
  readonly costDeltaAud: number;
  readonly activation: "disabled";
}

export interface SemanticBenchmarkCandidateResult
  extends RetrievalRunMetrics, RetrievalComparison {
  readonly thresholdMet: boolean;
}

export interface SemanticBenchmarkResult {
  readonly schemaVersion: 1;
  readonly benchmarkId: "automatic-ingestion-semantic-v1";
  readonly thresholds: typeof SEMANTIC_BENCHMARK_THRESHOLDS;
  readonly fixtureProvenance: readonly BenchmarkFixtureProvenance[];
  readonly baseline: RetrievalRunMetrics;
  readonly candidates: readonly SemanticBenchmarkCandidateResult[];
  readonly decision: {
    readonly activation: "disabled";
    readonly migrationRequired: false;
    readonly futureAdrRequired: true;
    readonly reason:
      | "semantic-candidate-absent"
      | "material-improvement-threshold-not-met"
      | "future-adr-required";
  };
}

const RUN_KEYS = [
  "schemaVersion",
  "runId",
  "strategy",
  "fixtureProvenance",
  "cases",
] as const;
const PROVENANCE_KEYS = [
  "corpus",
  "expectedGraphSha256",
  "queryCount",
] as const;
const CASE_KEYS = [
  "caseId",
  "corpus",
  "relevantUnitIds",
  "selectedUnitIds",
  "latencyMs",
  "costAud",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const actual = Reflect.ownKeys(value);
  if (
    actual.some((key) => typeof key !== "string") ||
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${path} contains an unexpected or missing field`);
  }
}

function requireIdentifier(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > SEMANTIC_BENCHMARK_LIMITS.maxIdentifierChars
  ) {
    throw new Error(`${path} must be a bounded non-empty identifier`);
  }
  return value;
}

function requireNumber(value: unknown, path: string, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new Error(`${path} must be a finite bounded non-negative number`);
  }
  return value;
}

function requireCorpus(value: unknown, path: string): BenchmarkCorpus {
  if (value !== "tiny" && value !== "small") {
    throw new Error(`${path} must be tiny or small`);
  }
  return value;
}

function requireIdArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  if (value.length > SEMANTIC_BENCHMARK_LIMITS.maxUnitIdsPerCase) {
    throw new Error(`${path} exceeds the benchmark bound`);
  }
  const ids = value.map((item, index) =>
    requireIdentifier(item, `${path}[${index}]`),
  );
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${path} contains a duplicate unit id`);
  }
  return Object.freeze(ids);
}

function parseProvenance(
  value: unknown,
  path: string,
): readonly BenchmarkFixtureProvenance[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    throw new Error(`${path} must contain the bounded corpus provenance`);
  }
  const seen = new Set<string>();
  return Object.freeze(
    value.map((entry, index) => {
      const entryPath = `${path}[${index}]`;
      if (!isRecord(entry)) throw new Error(`${entryPath} must be an object`);
      requireExactKeys(entry, PROVENANCE_KEYS, entryPath);
      const corpus = requireCorpus(entry.corpus, `${entryPath}.corpus`);
      if (seen.has(corpus))
        throw new Error(`${path} contains a duplicate corpus`);
      seen.add(corpus);
      if (
        typeof entry.expectedGraphSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.expectedGraphSha256)
      ) {
        throw new Error(`${entryPath}.expectedGraphSha256 must be SHA-256`);
      }
      if (
        typeof entry.queryCount !== "number" ||
        !Number.isInteger(entry.queryCount) ||
        entry.queryCount < 1 ||
        entry.queryCount > SEMANTIC_BENCHMARK_LIMITS.maxCases
      ) {
        throw new Error(`${entryPath}.queryCount must be a bounded integer`);
      }
      return Object.freeze({
        corpus,
        expectedGraphSha256: entry.expectedGraphSha256,
        queryCount: entry.queryCount,
      });
    }),
  );
}

function parseRun(
  value: unknown,
  role: "baseline" | "candidate",
): RetrievalBenchmarkRun {
  if (!isRecord(value)) throw new Error(`${role} run must be an object`);
  requireExactKeys(value, RUN_KEYS, `${role} run`);
  if (value.schemaVersion !== 1)
    throw new Error(`${role} schemaVersion must be 1`);
  const runId = requireIdentifier(value.runId, `${role}.runId`);
  const allowedStrategies =
    role === "baseline" ? ["lexical"] : ["dense", "hybrid"];
  if (!allowedStrategies.includes(value.strategy as string)) {
    throw new Error(
      `${role} strategy must be ${role === "baseline" ? "lexical" : "dense or hybrid"}`,
    );
  }
  const strategy = value.strategy as RetrievalStrategy;
  const fixtureProvenance = parseProvenance(
    value.fixtureProvenance,
    `${role}.fixtureProvenance`,
  );
  if (
    !Array.isArray(value.cases) ||
    value.cases.length === 0 ||
    value.cases.length > SEMANTIC_BENCHMARK_LIMITS.maxCases
  ) {
    throw new Error(`${role}.cases must be non-empty and bounded`);
  }
  const seen = new Set<string>();
  const cases = value.cases.map((entry, index) => {
    const path = `${role}.cases[${index}]`;
    if (!isRecord(entry)) throw new Error(`${path} must be an object`);
    requireExactKeys(entry, CASE_KEYS, path);
    const caseId = requireIdentifier(entry.caseId, `${path}.caseId`);
    if (seen.has(caseId))
      throw new Error(`${role} cases contain a duplicate caseId`);
    seen.add(caseId);
    return Object.freeze({
      caseId,
      corpus: requireCorpus(entry.corpus, `${path}.corpus`),
      relevantUnitIds: requireIdArray(
        entry.relevantUnitIds,
        `${path}.relevantUnitIds`,
      ),
      selectedUnitIds: requireIdArray(
        entry.selectedUnitIds,
        `${path}.selectedUnitIds`,
      ),
      latencyMs: requireNumber(
        entry.latencyMs,
        `${path}.latencyMs`,
        SEMANTIC_BENCHMARK_LIMITS.maxLatencyMs,
      ),
      costAud: requireNumber(
        entry.costAud,
        `${path}.costAud`,
        SEMANTIC_BENCHMARK_LIMITS.maxCostAudPerCase,
      ),
    });
  });
  const counts = new Map<BenchmarkCorpus, number>();
  for (const fixtureCase of cases) {
    counts.set(fixtureCase.corpus, (counts.get(fixtureCase.corpus) ?? 0) + 1);
  }
  for (const item of fixtureProvenance) {
    if (counts.get(item.corpus) !== item.queryCount) {
      throw new Error(`${role} provenance queryCount does not match cases`);
    }
  }
  if (counts.size !== fixtureProvenance.length) {
    throw new Error(`${role} cases do not match provenance corpora`);
  }
  return Object.freeze({
    schemaVersion: 1,
    runId,
    strategy,
    fixtureProvenance,
    cases: Object.freeze(cases),
  });
}

function canonicalProvenance(
  value: readonly BenchmarkFixtureProvenance[],
): string {
  return JSON.stringify(
    [...value].sort((left, right) => left.corpus.localeCompare(right.corpus)),
  );
}

function requireComparable(
  baseline: RetrievalBenchmarkRun,
  candidate: RetrievalBenchmarkRun,
): void {
  if (
    canonicalProvenance(baseline.fixtureProvenance) !==
    canonicalProvenance(candidate.fixtureProvenance)
  ) {
    throw new Error(
      "Candidate fixture provenance must match the lexical baseline",
    );
  }
  const candidateById = new Map(
    candidate.cases.map((item) => [item.caseId, item]),
  );
  if (candidateById.size !== baseline.cases.length) {
    throw new Error("Candidate cases must match the lexical baseline cases");
  }
  for (const lexicalCase of baseline.cases) {
    const candidateCase = candidateById.get(lexicalCase.caseId);
    if (
      !candidateCase ||
      candidateCase.corpus !== lexicalCase.corpus ||
      JSON.stringify(candidateCase.relevantUnitIds) !==
        JSON.stringify(lexicalCase.relevantUnitIds)
    ) {
      throw new Error(
        "Candidate cases must match lexical case relevance exactly",
      );
    }
  }
}

function nearestRankP95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}

function metrics(run: RetrievalBenchmarkRun): RetrievalRunMetrics {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let costAud = 0;
  for (const fixtureCase of run.cases) {
    const relevant = new Set(fixtureCase.relevantUnitIds);
    const selected = new Set(fixtureCase.selectedUnitIds);
    for (const unitId of selected) {
      if (relevant.has(unitId)) truePositive += 1;
      else falsePositive += 1;
    }
    for (const unitId of relevant) {
      if (!selected.has(unitId)) falseNegative += 1;
    }
    costAud += fixtureCase.costAud;
  }
  return Object.freeze({
    strategy: run.strategy,
    queryCount: run.cases.length,
    truePositive,
    falsePositive,
    falseNegative,
    recall:
      truePositive + falseNegative === 0
        ? 1
        : truePositive / (truePositive + falseNegative),
    precision:
      truePositive + falsePositive === 0
        ? 1
        : truePositive / (truePositive + falsePositive),
    p95LatencyMs: nearestRankP95(run.cases.map((item) => item.latencyMs)),
    costAud,
  });
}

function parsedComparison(
  lexicalValue: unknown,
  candidateValue: unknown,
): { lexical: RetrievalBenchmarkRun; candidate: RetrievalBenchmarkRun } {
  const lexical = parseRun(lexicalValue, "baseline");
  const candidate = parseRun(candidateValue, "candidate");
  requireComparable(lexical, candidate);
  return { lexical, candidate };
}

export function compareRetrievalRuns(
  lexicalValue: RetrievalBenchmarkRun,
  candidateValue: RetrievalBenchmarkRun,
): RetrievalComparison {
  const { lexical, candidate } = parsedComparison(lexicalValue, candidateValue);
  const baselineMetrics = metrics(lexical);
  const candidateMetrics = metrics(candidate);
  return Object.freeze({
    recallDelta: candidateMetrics.recall - baselineMetrics.recall,
    precisionDelta: candidateMetrics.precision - baselineMetrics.precision,
    p95LatencyDeltaMs:
      candidateMetrics.p95LatencyMs - baselineMetrics.p95LatencyMs,
    costDeltaAud: candidateMetrics.costAud - baselineMetrics.costAud,
    activation: "disabled",
  });
}

function thresholdMet(comparison: RetrievalComparison): boolean {
  return (
    comparison.recallDelta >=
      SEMANTIC_BENCHMARK_THRESHOLDS.minimumRecallDelta &&
    comparison.precisionDelta >=
      SEMANTIC_BENCHMARK_THRESHOLDS.minimumPrecisionDelta &&
    comparison.p95LatencyDeltaMs <=
      SEMANTIC_BENCHMARK_THRESHOLDS.maximumP95LatencyDeltaMs &&
    comparison.costDeltaAud <= SEMANTIC_BENCHMARK_THRESHOLDS.maximumCostDeltaAud
  );
}

export function runSemanticBenchmark(
  lexicalValue: RetrievalBenchmarkRun,
  candidateValues: readonly RetrievalBenchmarkRun[],
): SemanticBenchmarkResult {
  const lexical = parseRun(lexicalValue, "baseline");
  if (!Array.isArray(candidateValues) || candidateValues.length > 2) {
    throw new Error("Candidates must be a bounded array");
  }
  const candidates = candidateValues.map((value) => {
    const candidate = parseRun(value, "candidate");
    requireComparable(lexical, candidate);
    const comparison = compareRetrievalRuns(lexical, candidate);
    return Object.freeze({
      ...metrics(candidate),
      ...comparison,
      thresholdMet: thresholdMet(comparison),
    });
  });
  if (
    new Set(candidates.map((item) => item.strategy)).size !== candidates.length
  ) {
    throw new Error("Candidate strategies must not be duplicated");
  }
  candidates.sort((left, right) => left.strategy.localeCompare(right.strategy));
  const anyThresholdMet = candidates.some((item) => item.thresholdMet);
  return Object.freeze({
    schemaVersion: 1,
    benchmarkId: "automatic-ingestion-semantic-v1",
    thresholds: SEMANTIC_BENCHMARK_THRESHOLDS,
    fixtureProvenance: lexical.fixtureProvenance,
    baseline: metrics(lexical),
    candidates: Object.freeze(candidates),
    decision: Object.freeze({
      activation: "disabled",
      migrationRequired: false,
      futureAdrRequired: true,
      reason:
        candidates.length === 0
          ? "semantic-candidate-absent"
          : anyThresholdMet
            ? "future-adr-required"
            : "material-improvement-threshold-not-met",
    }),
  });
}

export function renderSemanticBenchmarkResult(
  result: SemanticBenchmarkResult,
): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
