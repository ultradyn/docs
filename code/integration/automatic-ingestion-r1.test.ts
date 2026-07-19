/**
 * T-60-03 RED — R1 acceptance AS-01..AS-04 (tiny+small).
 *
 * NAIL 2: cacheEnabled:false is ENFORCED via provider CALL COUNTER spy —
 * not a declared flag alone. Harness must assert provider was invoked the
 * expected number of times with zero cache hits.
 *
 * GREEN: wire runR1Acceptance + real counters. RED: module/export missing
 * or not_implemented until pipeline lands.
 */
import { describe, expect, it, vi } from "vitest";

import { reviewAnswerComposition } from "../ingest/knowledge/answer-validity.js";

const R1_SCENARIOS = ["AS-01", "AS-02", "AS-03", "AS-04"] as const;
export type R1ScenarioId = (typeof R1_SCENARIOS)[number];

export type R1ProviderCounters = {
  /** Total live provider/getClaim invocations during the scenario. */
  providerCalls: number;
  /** Must remain 0 when cacheEnabled:false. */
  cacheHits: number;
};

export type R1ScenarioResult = {
  scenario: R1ScenarioId;
  corpus: "tiny" | "small";
  cacheEnabled: false;
  status: "complete" | "not_implemented";
  promotable?: boolean;
  counters: R1ProviderCounters;
  detail?: string;
};

export type RunR1Acceptance = (input: {
  scenario: R1ScenarioId;
  corpus: "tiny" | "small";
  cacheEnabled: false;
  /** Spy hooks — GREEN harness increments on real provider use. */
  onProviderCall?: () => void;
  onCacheHit?: () => void;
}) => Promise<R1ScenarioResult>;

describe("automatic ingestion R1 acceptance (T-60-03)", () => {
  it("exports reviewAnswerComposition for the promotable gate", () => {
    expect(typeof reviewAnswerComposition).toBe("function");
  });

  it("AS-01..AS-04 run with cacheEnabled:false and enforce zero cache hits via counters", async () => {
    const mod = await import("./automatic-ingestion-r1.js").catch(() => null);
    expect(mod, "automatic-ingestion-r1 module must exist").not.toBeNull();
    if (mod === null) return;

    const run = mod.runR1Acceptance as RunR1Acceptance;
    expect(typeof run).toBe("function");

    for (const scenario of R1_SCENARIOS) {
      let providerCalls = 0;
      let cacheHits = 0;
      const result = await run({
        scenario,
        corpus: "tiny",
        cacheEnabled: false,
        onProviderCall: () => {
          providerCalls += 1;
        },
        onCacheHit: () => {
          cacheHits += 1;
        },
      });
      expect(result.scenario).toBe(scenario);
      expect(result.cacheEnabled).toBe(false);
      expect(["complete", "not_implemented"]).toContain(result.status);

      // NAIL 2: counters are part of the result mechanism
      expect(result.counters).toBeDefined();
      expect(typeof result.counters.providerCalls).toBe("number");
      expect(typeof result.counters.cacheHits).toBe("number");
      expect(result.counters.cacheHits).toBe(0);
      expect(cacheHits).toBe(0);

      if (result.status === "complete") {
        // Zero-cache full path must actually call providers
        expect(result.counters.providerCalls).toBeGreaterThan(0);
        expect(providerCalls).toBe(result.counters.providerCalls);
      }
    }
  });

  it("AS-03 honest source gap is never promotable when complete", async () => {
    const mod = await import("./automatic-ingestion-r1.js").catch(() => null);
    expect(mod).not.toBeNull();
    if (mod === null) return;
    const run = mod.runR1Acceptance as RunR1Acceptance;
    const result = await run({
      scenario: "AS-03",
      corpus: "tiny",
      cacheEnabled: false,
    });
    expect(result.counters.cacheHits).toBe(0);
    if (result.status === "complete") {
      expect(result.promotable).toBe(false);
      expect(result.counters.providerCalls).toBeGreaterThan(0);
    } else {
      expect(result.status).toBe("not_implemented");
    }
  });

  it("small corpus AS-01: cacheEnabled false + counter mechanism present", async () => {
    const mod = await import("./automatic-ingestion-r1.js").catch(() => null);
    expect(mod).not.toBeNull();
    if (mod === null) return;
    const run = mod.runR1Acceptance as RunR1Acceptance;
    const onProviderCall = vi.fn();
    const onCacheHit = vi.fn();
    const result = await run({
      scenario: "AS-01",
      corpus: "small",
      cacheEnabled: false,
      onProviderCall,
      onCacheHit,
    });
    expect(result.cacheEnabled).toBe(false);
    expect(result.counters.cacheHits).toBe(0);
    expect(onCacheHit).not.toHaveBeenCalled();
    if (result.status === "complete") {
      expect(result.counters.providerCalls).toBeGreaterThan(0);
      expect(onProviderCall).toHaveBeenCalledTimes(
        result.counters.providerCalls,
      );
    }
  });
});
