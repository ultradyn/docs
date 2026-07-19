import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SEMANTIC_BENCHMARK_LIMITS,
  SEMANTIC_BENCHMARK_THRESHOLDS,
  compareRetrievalRuns,
  renderSemanticBenchmarkResult,
  runSemanticBenchmark,
  type RetrievalBenchmarkRun,
} from "./index.js";

const provenance = [
  {
    corpus: "tiny",
    expectedGraphSha256:
      "a6261cedc3818bd09d2acee02cb92e9d6fe5d0aa9a12aaf0c9a40e167f7cdfdc",
    queryCount: 4,
  },
  {
    corpus: "small",
    expectedGraphSha256:
      "a539b027ed0e8d39f3b986fbbab58581d54919791b7ecf48664a4b20f720c9c8",
    queryCount: 3,
  },
] as const;

function run(
  strategy: "lexical" | "dense" | "hybrid",
  selections: readonly (readonly string[])[],
  latencies: readonly number[],
  costs: readonly number[],
): RetrievalBenchmarkRun {
  const cases = (
    [
      {
        caseId: "tiny-purpose",
        corpus: "tiny",
        relevantUnitIds: ["tiny-unit-overview"],
      },
      {
        caseId: "tiny-settings",
        corpus: "tiny",
        relevantUnitIds: [
          "tiny-unit-procedure",
          "tiny-unit-conflicting-procedure",
        ],
      },
      {
        caseId: "tiny-export",
        corpus: "tiny",
        relevantUnitIds: ["tiny-unit-legacy-export"],
      },
      {
        caseId: "tiny-unsupported",
        corpus: "tiny",
        relevantUnitIds: [],
      },
      {
        caseId: "small-custody",
        corpus: "small",
        relevantUnitIds: ["small-unit-04", "small-unit-09"],
      },
      {
        caseId: "small-state",
        corpus: "small",
        relevantUnitIds: ["small-unit-15"],
      },
      {
        caseId: "small-local",
        corpus: "small",
        relevantUnitIds: ["small-unit-18", "small-unit-22"],
      },
    ] as const
  ).map((fixtureCase, index) => ({
    ...fixtureCase,
    selectedUnitIds: [...selections[index]!],
    latencyMs: latencies[index]!,
    costAud: costs[index]!,
  }));

  return {
    schemaVersion: 1,
    runId: `${strategy}-deterministic-v1`,
    strategy,
    fixtureProvenance: structuredClone(provenance),
    cases,
  };
}

const lexical = run(
  "lexical",
  [
    ["tiny-unit-overview"],
    ["tiny-unit-procedure"],
    ["tiny-unit-legacy-export"],
    [],
    ["small-unit-04"],
    ["small-unit-15"],
    ["small-unit-22"],
  ],
  [3, 4, 3, 4, 5, 4, 5],
  [0, 0, 0, 0, 0, 0, 0],
);

const dense = run(
  "dense",
  [
    ["tiny-unit-overview", "tiny-unit-overview-copy"],
    ["tiny-unit-procedure", "tiny-unit-conflicting-procedure"],
    ["tiny-unit-legacy-export", "tiny-unit-overview"],
    ["tiny-unit-disconnected-note"],
    ["small-unit-04"],
    ["small-unit-15"],
    ["small-unit-22"],
  ],
  [20, 25, 22, 30, 24, 23, 25],
  [0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001],
);

const hybrid = run(
  "hybrid",
  [
    ["tiny-unit-overview"],
    ["tiny-unit-procedure", "tiny-unit-conflicting-procedure"],
    ["tiny-unit-legacy-export"],
    [],
    ["small-unit-04"],
    ["small-unit-15"],
    ["small-unit-22"],
  ],
  [12, 15, 13, 16, 14, 13, 15],
  [0.0005, 0.0005, 0.0005, 0.0005, 0.0005, 0.0005, 0.0005],
);

describe("offline semantic retrieval benchmark", () => {
  it("pins the material-improvement policy independently of candidate results", () => {
    expect(SEMANTIC_BENCHMARK_THRESHOLDS).toEqual({
      minimumRecallDelta: 0.15,
      minimumPrecisionDelta: 0,
      maximumP95LatencyDeltaMs: 20,
      maximumCostDeltaAud: 0.01,
    });
    expect(Object.isFrozen(SEMANTIC_BENCHMARK_THRESHOLDS)).toBe(true);
  });

  it("reports exact quality, nearest-rank p95 latency, and AUD cost deltas together", () => {
    expect(compareRetrievalRuns(lexical, dense)).toEqual({
      recallDelta: 7 / 9 - 2 / 3,
      precisionDelta: 0.7 - 1,
      p95LatencyDeltaMs: 25,
      costDeltaAud: 0.007,
      activation: "disabled",
    });
    expect(compareRetrievalRuns(lexical, hybrid)).toEqual({
      recallDelta: 7 / 9 - 2 / 3,
      precisionDelta: 0,
      p95LatencyDeltaMs: 11,
      costDeltaAud: 0.0035,
      activation: "disabled",
    });
  });

  it("produces a deterministic machine result for dense and hybrid candidates", () => {
    const first = runSemanticBenchmark(lexical, [dense, hybrid]);
    const second = runSemanticBenchmark(
      structuredClone(lexical),
      structuredClone([dense, hybrid]),
    );

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: 1,
      benchmarkId: "automatic-ingestion-semantic-v1",
      fixtureProvenance: provenance,
      baseline: {
        strategy: "lexical",
        queryCount: 7,
        truePositive: 6,
        falsePositive: 0,
        falseNegative: 3,
        recall: 2 / 3,
        precision: 1,
        p95LatencyMs: 5,
        costAud: 0,
      },
      candidates: [
        {
          strategy: "dense",
          thresholdMet: false,
          activation: "disabled",
        },
        {
          strategy: "hybrid",
          thresholdMet: false,
          activation: "disabled",
        },
      ],
      decision: {
        activation: "disabled",
        migrationRequired: false,
        futureAdrRequired: true,
        reason: "material-improvement-threshold-not-met",
      },
    });
  });

  it("keeps lexical behavior and requires no migration when candidates are absent", () => {
    const result = runSemanticBenchmark(lexical, []);

    expect(result.baseline).toMatchObject({
      strategy: "lexical",
      recall: 2 / 3,
      precision: 1,
    });
    expect(result.candidates).toEqual([]);
    expect(result.decision).toEqual({
      activation: "disabled",
      migrationRequired: false,
      futureAdrRequired: true,
      reason: "semantic-candidate-absent",
    });
  });

  it("still requires a future ADR rather than activating a qualifying candidate", () => {
    const qualifying = run(
      "hybrid",
      [
        ["tiny-unit-overview"],
        ["tiny-unit-procedure", "tiny-unit-conflicting-procedure"],
        ["tiny-unit-legacy-export"],
        [],
        ["small-unit-04", "small-unit-09"],
        ["small-unit-15"],
        ["small-unit-18", "small-unit-22"],
      ],
      [4, 5, 4, 5, 6, 5, 6],
      [0, 0, 0, 0, 0, 0, 0],
    );

    const result = runSemanticBenchmark(lexical, [qualifying]);

    expect(result.candidates[0]).toMatchObject({
      thresholdMet: true,
      activation: "disabled",
    });
    expect(result.decision).toEqual({
      activation: "disabled",
      migrationRequired: false,
      futureAdrRequired: true,
      reason: "future-adr-required",
    });
  });

  it("emits a stable portable receipt with metrics but no query or source text", () => {
    const rendered = renderSemanticBenchmarkResult(
      runSemanticBenchmark(lexical, [dense, hybrid]),
    );

    expect(rendered.endsWith("\n")).toBe(true);
    expect(JSON.parse(rendered)).toEqual(
      runSemanticBenchmark(lexical, [dense, hybrid]),
    );
    expect(rendered).not.toContain("Where does Atlas");
    expect(rendered).not.toContain("tiny-purpose");
    expect(rendered).not.toContain("tiny-unit-overview");
    expect(rendered).not.toContain("selectedUnitIds");
    expect(rendered).not.toContain("relevantUnitIds");
  });

  it("reproduces the committed machine result exactly from committed fake runs", async () => {
    const directory = new URL("./fixtures/ingest-results/", import.meta.url);
    const runs = JSON.parse(
      await readFile(
        new URL("semantic-benchmark-runs.json", directory),
        "utf8",
      ),
    ) as {
      lexical: RetrievalBenchmarkRun;
      candidates: RetrievalBenchmarkRun[];
    };
    const expected = await readFile(
      new URL("semantic-benchmark-result.json", directory),
      "utf8",
    );

    expect(
      renderSemanticBenchmarkResult(
        runSemanticBenchmark(runs.lexical, runs.candidates),
      ),
    ).toBe(expected);
  });

  it("binds provenance to the current committed expected graphs", async () => {
    const corpusDirectory = new URL(
      "./fixtures/ingest-corpus/",
      import.meta.url,
    );

    for (const fixture of provenance) {
      const bytes = await readFile(
        new URL(`${fixture.corpus}/expected-graph.json`, corpusDirectory),
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        fixture.expectedGraphSha256,
      );
    }
  });

  it("strictly rejects unknown, mismatched, duplicate, and unbounded input", () => {
    expect(() =>
      compareRetrievalRuns(
        { ...lexical, unexpected: true } as RetrievalBenchmarkRun,
        dense,
      ),
    ).toThrow(/unexpected/i);
    expect(() =>
      compareRetrievalRuns(lexical, {
        ...dense,
        cases: dense.cases.slice(1),
      }),
    ).toThrow(/match.*case|case.*match/i);
    expect(() =>
      compareRetrievalRuns(lexical, {
        ...dense,
        cases: [dense.cases[0]!, dense.cases[0]!],
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      compareRetrievalRuns(lexical, {
        ...dense,
        cases: dense.cases.map((fixtureCase, index) =>
          index === 0
            ? {
                ...fixtureCase,
                selectedUnitIds: Array.from(
                  { length: SEMANTIC_BENCHMARK_LIMITS.maxUnitIdsPerCase + 1 },
                  (_, itemIndex) => `unit-${itemIndex}`,
                ),
              }
            : fixtureCase,
        ),
      }),
    ).toThrow(/selectedUnitIds/i);
    expect(() =>
      compareRetrievalRuns(lexical, {
        ...dense,
        cases: dense.cases.map((fixtureCase, index) =>
          index === 0
            ? { ...fixtureCase, latencyMs: Number.POSITIVE_INFINITY }
            : fixtureCase,
        ),
      }),
    ).toThrow(/latencyMs/i);
  });

  it("rejects accessor and sparse-array input without invoking accessors", () => {
    let accessed = false;
    const accessorRun = { ...lexical } as Record<string, unknown>;
    Object.defineProperty(accessorRun, "cases", {
      enumerable: true,
      get() {
        accessed = true;
        return lexical.cases;
      },
    });
    expect(() =>
      compareRetrievalRuns(
        accessorRun as unknown as RetrievalBenchmarkRun,
        dense,
      ),
    ).toThrow(/data field/i);
    expect(accessed).toBe(false);

    const sparseCases = new Array(lexical.cases.length);
    expect(() =>
      compareRetrievalRuns({ ...lexical, cases: sparseCases as never }, dense),
    ).toThrow(/data item/i);
  });

  it("rejects candidates that disguise lexical runs or alter corpus provenance", () => {
    expect(() =>
      compareRetrievalRuns(lexical, { ...dense, strategy: "lexical" }),
    ).toThrow(/candidate.*dense.*hybrid/i);
    expect(() =>
      compareRetrievalRuns(lexical, {
        ...dense,
        fixtureProvenance: [
          {
            ...dense.fixtureProvenance[0]!,
            expectedGraphSha256: "0".repeat(64),
          },
          dense.fixtureProvenance[1]!,
        ],
      }),
    ).toThrow(/provenance.*match/i);
  });

  it("does not mutate caller-owned benchmark fixtures", () => {
    const lexicalBefore = structuredClone(lexical);
    const candidatesBefore = structuredClone([dense, hybrid]);

    runSemanticBenchmark(lexical, [dense, hybrid]);

    expect(lexical).toEqual(lexicalBefore);
    expect([dense, hybrid]).toEqual(candidatesBefore);
  });

  it("leaves the production retrieval surface lexical-only with no vector export", async () => {
    const retrievalIndex = await readFile(
      fileURLToPath(new URL("../ingest/retrieval/index.ts", import.meta.url)),
      "utf8",
    );

    expect(retrievalIndex).toBe(
      'export * from "./exact-map.js";\nexport * from "./lexical-index.js";\n',
    );
    expect(retrievalIndex).not.toMatch(/semantic|dense|vector|embedding/i);
  });
});
