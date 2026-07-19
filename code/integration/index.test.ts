import { describe, expect, it } from "vitest";

import * as integration from "./index.js";

describe("integration public module surface", () => {
  it("exports only the deliberate change-request entry points", () => {
    expect(Object.keys(integration).sort()).toEqual([
      "ChangeRequestBlockedError",
      "INGEST_FIXTURE_KINDS",
      "LocalChangeRequestManager",
      "SEMANTIC_BENCHMARK_LIMITS",
      "SEMANTIC_BENCHMARK_THRESHOLDS",
      "compareRetrievalRuns",
      "createIngestFixtureResultStore",
      "nodeFileReader",
      "renderSemanticBenchmarkResult",
      "runIngestFixture",
      "runSemanticBenchmark",
      "scoreIngestRun",
      "validateIngestBundle",
    ]);
  });
});
