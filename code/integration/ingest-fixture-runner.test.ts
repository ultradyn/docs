import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createIngestFixtureResultStore,
  runIngestFixture,
  type IngestFixtureAdapter,
  type IngestFixtureInput,
  type IngestFixtureKind,
  type IngestFixtureResultStore,
} from "./index.js";

const kinds: IngestFixtureKind[] = [
  "deterministic",
  "agent",
  "workflow",
  "retrieval",
  "claim",
  "navigation",
];

const zeroCounts = {
  evidence: { truePositive: 0, falsePositive: 0, falseNegative: 0 },
  noEvidence: { falseNoEvidence: 0, actualAnswerable: 0 },
  claims: { entailed: 0, reviewed: 0 },
  merges: { falseMerge: 0, proposedMerge: 0 },
  contradictions: { found: 0, expected: 0 },
  sources: { covered: 0, total: 0 },
  answers: { sufficient: 0, evaluated: 0 },
} as const;

function completedFixtures() {
  return Object.fromEntries(
    kinds.map((kind) => [
      kind,
      { status: "complete", decisive: { verdict: "accepted" } },
    ]),
  );
}

function baseline(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    corpus: "tiny",
    cacheEnabled: false,
    versions: {
      model: "fake-v1",
      prompt: "prompt-v1",
      tools: "tools-v1",
      index: "index-v1",
      schemas: "schemas-v1",
    },
    fixtures: completedFixtures(),
    ...overrides,
  };
}

function adapter(
  kind: IngestFixtureKind,
  calls: IngestFixtureKind[],
  received?: unknown[],
): IngestFixtureAdapter {
  return {
    async run(runInput) {
      calls.push(kind);
      received?.push(runInput);
      return { decisive: { verdict: "accepted" }, counts: zeroCounts };
    },
  };
}

function fixtureInput(
  calls: IngestFixtureKind[] = [],
  storeOverrides: Partial<IngestFixtureResultStore> = {},
  received?: unknown[],
): IngestFixtureInput {
  return {
    corpus: "tiny",
    versions: baseline().versions,
    cacheEnabled: false,
    adapters: Object.fromEntries(
      kinds.map((kind) => [kind, adapter(kind, calls, received)]),
    ),
    resultStore: {
      readBaseline: vi.fn(async () => JSON.stringify(baseline())),
      writeResult: vi.fn(async () => undefined),
      ...storeOverrides,
    },
  };
}

describe("deterministic ingestion fixture runner", () => {
  it("executes all six public fixture adapters in deterministic order", async () => {
    const calls: IngestFixtureKind[] = [];
    const received: unknown[] = [];

    const result = await runIngestFixture(fixtureInput(calls, {}, received));

    expect(calls).toEqual(kinds);
    expect(received).toEqual(
      kinds.map((kind) => ({
        kind,
        corpus: "tiny",
        versions: baseline().versions,
        cacheEnabled: false,
      })),
    );
    expect(result.status).toBe("complete");
  });

  it("reports every missing adapter as not implemented with decisive pointers", async () => {
    const input = fixtureInput();
    delete input.adapters!.retrieval;
    delete input.adapters!.navigation;

    const result = await runIngestFixture(input);

    expect(result.status).toBe("not_implemented");
    expect(result.fixtures.retrieval.status).toBe("not_implemented");
    expect(result.decisiveDiffs).toEqual([
      "/fixtures/navigation/status",
      "/fixtures/retrieval/status",
    ]);
  });

  it("treats an omitted adapter collection as all fixtures not implemented", async () => {
    const input = fixtureInput();
    delete (input as Partial<IngestFixtureInput>).adapters;

    const result = await runIngestFixture(input);

    expect(result.status).toBe("not_implemented");
    expect(result.decisiveDiffs).toHaveLength(6);
    expect(Object.values(result.fixtures)).toEqual(
      kinds.map(() => ({ status: "not_implemented", decisive: null })),
    );
  });

  it("requires cache off and exactly five usable version strings", async () => {
    await expect(
      runIngestFixture({ ...fixtureInput(), cacheEnabled: true as false }),
    ).rejects.toThrow(/cache/i);
    await expect(
      runIngestFixture({
        ...fixtureInput(),
        versions: { ...baseline().versions, model: "   " },
      }),
    ).rejects.toThrow(/versions\.model/);
    await expect(
      runIngestFixture({
        ...fixtureInput(),
        versions: { ...baseline().versions, unexpected: "v1" } as never,
      }),
    ).rejects.toThrow(/exactly/i);
  });

  it("snapshots versions before adapters can mutate caller input", async () => {
    const input = fixtureInput();
    input.adapters!.deterministic = {
      run: vi.fn(async ({ versions }) => {
        versions.model = "mutated";
        return { decisive: { verdict: "accepted" }, counts: zeroCounts };
      }),
    };
    const agentRun = vi.fn(async () => ({
      decisive: { verdict: "accepted" },
      counts: zeroCounts,
    }));
    input.adapters!.agent = { run: agentRun };

    const result = await runIngestFixture(input);

    expect(agentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        versions: expect.objectContaining({ model: "fake-v1" }),
      }),
    );
    expect(result.versions.model).toBe("fake-v1");
  });

  it("scores counts aggregated from adapter executions", async () => {
    const input = fixtureInput();
    input.adapters!.deterministic = {
      run: vi.fn(async () => ({
        decisive: { verdict: "accepted" },
        counts: {
          ...zeroCounts,
          evidence: { truePositive: 2, falsePositive: 1, falseNegative: 2 },
        },
      })),
    };
    input.adapters!.agent = {
      run: vi.fn(async () => ({
        decisive: { verdict: "accepted" },
        counts: {
          ...zeroCounts,
          evidence: { truePositive: 1, falsePositive: 0, falseNegative: 0 },
        },
      })),
    };

    const result = await runIngestFixture(input);

    expect(result.metrics.evidenceRecall).toBe(3 / 5);
    expect(result.metrics.evidencePrecision).toBe(3 / 4);
  });

  it("reads a versioned baseline, compares decisive literals, and persists the result", async () => {
    const writeResult = vi.fn(async () => undefined);
    const input = fixtureInput([], {
      readBaseline: vi.fn(async () =>
        JSON.stringify(
          baseline({
            fixtures: {
              ...completedFixtures(),
              claim: { status: "complete", decisive: { verdict: "rejected" } },
            },
          }),
        ),
      ),
      writeResult,
    });

    const result = await runIngestFixture(input);

    expect(result.decisiveDiffs).toEqual(["/fixtures/claim/decisive/verdict"]);
    expect(writeResult).toHaveBeenCalledOnce();
    expect(writeResult).toHaveBeenCalledWith(result);
  });

  it("rejects malformed or schema-incompatible baseline JSON", async () => {
    await expect(
      runIngestFixture(
        fixtureInput([], { readBaseline: vi.fn(async () => "{") }),
      ),
    ).rejects.toThrow(/malformed JSON/);
    const invalid = baseline();
    delete (invalid.versions as Partial<typeof invalid.versions>).model;
    await expect(
      runIngestFixture(
        fixtureInput([], {
          readBaseline: vi.fn(async () => JSON.stringify(invalid)),
        }),
      ),
    ).rejects.toThrow(/versions\.model/);
    await expect(
      runIngestFixture(
        fixtureInput([], {
          readBaseline: vi.fn(async () =>
            JSON.stringify({ ...baseline(), unexpected: true }),
          ),
        }),
      ),
    ).rejects.toThrow(/exactly/i);
  });

  it("rejects a baseline for different fixture versions", async () => {
    const input = fixtureInput([], {
      readBaseline: vi.fn(async () =>
        JSON.stringify(
          baseline({
            versions: { ...baseline().versions, model: "other-model-v1" },
          }),
        ),
      ),
    });

    await expect(runIngestFixture(input)).rejects.toThrow(
      /baseline versions do not match/i,
    );
  });

  it("serializes stable runs identically and rejects explicit undefined", async () => {
    const reordered = fixtureInput();
    reordered.versions = {
      tools: "tools-v1",
      schemas: "schemas-v1",
      prompt: "prompt-v1",
      model: "fake-v1",
      index: "index-v1",
    };
    const first = await runIngestFixture(fixtureInput());
    const second = await runIngestFixture(reordered);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const invalid = fixtureInput();
    invalid.adapters!.claim = {
      run: vi.fn(async () => ({
        decisive: { verdict: undefined },
        counts: zeroCounts,
      })),
    };
    await expect(runIngestFixture(invalid)).rejects.toThrow(/valid JSON/);
  });

  it("consumes the committed baseline through the public filesystem result store", async () => {
    const baselinePath = fileURLToPath(
      new URL("./fixtures/ingest-results/baseline.json", import.meta.url),
    );
    let persisted = "";
    const store = createIngestFixtureResultStore(
      {
        readText: (path) => readFile(path, "utf8"),
        writeText: async (_path, contents) => {
          persisted = contents;
        },
      },
      { baselinePath, resultPath: "ignored-result.json" },
    );
    const input = fixtureInput([], store);
    input.versions = {
      model: "deterministic-fake-v1",
      prompt: "r0-v1",
      tools: "r0-v1",
      index: "r0-v1",
      schemas: "ingest-v1",
    };

    const result = await runIngestFixture(input);

    expect(result.decisiveDiffs).toEqual([]);
    expect(JSON.parse(persisted)).toEqual(result);
  });

  it("rejects present-but-invalid adapters instead of treating them as unavailable", async () => {
    for (const invalidAdapter of [undefined, null, {}]) {
      const input = fixtureInput();
      input.adapters!.claim = invalidAdapter as never;
      await expect(runIngestFixture(input)).rejects.toThrow(
        /adapters\.claim\.run/,
      );
    }
  });

  it("rejects malformed adapter output including non-JSON sparse arrays", async () => {
    const malformedCounts = fixtureInput();
    malformedCounts.adapters!.claim = {
      run: vi.fn(async () => ({
        decisive: { verdict: "accepted" },
        counts: {} as never,
      })),
    };
    await expect(runIngestFixture(malformedCounts)).rejects.toThrow(
      /fixtures\.claim\.counts/,
    );

    const cancellingCounts = fixtureInput();
    cancellingCounts.adapters!.deterministic = {
      run: vi.fn(async () => ({
        decisive: { verdict: "accepted" },
        counts: {
          ...zeroCounts,
          evidence: { truePositive: 0, falsePositive: -1, falseNegative: 0 },
        },
      })),
    };
    cancellingCounts.adapters!.agent = {
      run: vi.fn(async () => ({
        decisive: { verdict: "accepted" },
        counts: {
          ...zeroCounts,
          evidence: { truePositive: 0, falsePositive: 1, falseNegative: 0 },
        },
      })),
    };
    await expect(runIngestFixture(cancellingCounts)).rejects.toThrow(
      /non-negative integer/,
    );

    const hiddenDecisive = fixtureInput();
    const decisiveWithHiddenProperty: Record<string, unknown> = {
      verdict: "accepted",
    };
    Object.defineProperty(decisiveWithHiddenProperty, "hidden", {
      value: true,
      enumerable: false,
    });
    hiddenDecisive.adapters!.claim = {
      run: vi.fn(async () => ({
        decisive: decisiveWithHiddenProperty,
        counts: zeroCounts,
      })),
    };
    await expect(runIngestFixture(hiddenDecisive)).rejects.toThrow(
      /valid JSON/,
    );

    const sparseDecisive = fixtureInput();
    sparseDecisive.adapters!.claim = {
      run: vi.fn(async () => ({
        decisive: new Array(1),
        counts: zeroCounts,
      })),
    };
    await expect(runIngestFixture(sparseDecisive)).rejects.toThrow(
      /valid JSON/,
    );
  });

  it("uses code-unit ordering and precise escaped array/property pointers", async () => {
    const input = fixtureInput([], {
      readBaseline: vi.fn(async () =>
        JSON.stringify(
          baseline({
            fixtures: {
              ...completedFixtures(),
              claim: {
                status: "complete",
                decisive: { "z/key": ["a", "b"], "ä~key": true },
              },
            },
          }),
        ),
      ),
    });
    input.adapters!.claim = {
      run: vi.fn(async () => ({
        decisive: { "z/key": ["x", "b", "c"], "ä~key": false },
        counts: zeroCounts,
      })),
    };

    const result = await runIngestFixture(input);

    expect(result.decisiveDiffs).toEqual([
      "/fixtures/claim/decisive/z~1key/0",
      "/fixtures/claim/decisive/z~1key/2",
      "/fixtures/claim/decisive/ä~0key",
    ]);
  });
});
