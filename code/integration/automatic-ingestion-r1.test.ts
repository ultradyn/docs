/**
 * T-60-04 RED — R1 AS-02/03/04 + small corpus (extends T-60-03 AS-01).
 *
 * NAIL 1: complete paths have providerCalls>0, cacheHits===0, spy matches counters.
 * NAIL 2: distinguishing outcomes from real mechanism (paired controls).
 * NAIL 3: seeded critic decisions labeled honestly in detail.
 * NAIL 4: no faked complete / silent not_implemented.
 */
import { describe, expect, it, vi } from "vitest";

import { reviewAnswerComposition } from "../ingest/knowledge/answer-validity.js";

const R1_SCENARIOS = ["AS-01", "AS-02", "AS-03", "AS-04"] as const;
export type R1ScenarioId = (typeof R1_SCENARIOS)[number];

export type R1ProviderCounters = {
  providerCalls: number;
  cacheHits: number;
};

export type R1ScenarioResult = {
  scenario: R1ScenarioId;
  corpus: "tiny" | "small";
  cacheEnabled: false;
  status: "complete" | "not_implemented";
  promotable?: boolean;
  counters: R1ProviderCounters;
  /** Packet version after refinement (AS-02). */
  packetVersion?: number;
  /** Prior packet version before refinement (AS-02). */
  priorPacketVersion?: number;
  /** True if curiosity planner was invoked (AS-04 spy surface). */
  curiosityPlannerInvoked?: boolean;
  detail?: string;
};

export type RunR1Acceptance = (input: {
  scenario: R1ScenarioId;
  corpus: "tiny" | "small";
  cacheEnabled: false;
  onProviderCall?: () => void;
  onCacheHit?: () => void;
  /** AS-04: optional force-early curiosity invoke for mutation tests. */
  forceEarlyCuriosity?: boolean;
  /** AS-03 control: use a supported pack path instead of gap. */
  forceSupportedPack?: boolean;
}) => Promise<R1ScenarioResult>;

describe("automatic ingestion R1 acceptance (T-60-04)", () => {
  it("exports reviewAnswerComposition for the promotable gate", () => {
    expect(typeof reviewAnswerComposition).toBe("function");
  });

  it("AS-01..AS-04 tiny all complete with zero-cache counters", async () => {
    const mod = await import("./automatic-ingestion-r1.js");
    const run = mod.runR1Acceptance as RunR1Acceptance;

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
      // NAIL 1 + 4: complete is required for tiny AS-01..04
      expect(result.status).toBe("complete");
      expect(result.counters.cacheHits).toBe(0);
      expect(cacheHits).toBe(0);
      expect(result.counters.providerCalls).toBeGreaterThan(0);
      expect(providerCalls).toBe(result.counters.providerCalls);
    }
  });

  it("AS-03: promotable false on gap; control supported pack is promotable true", async () => {
    const mod = await import("./automatic-ingestion-r1.js");
    const run = mod.runR1Acceptance as RunR1Acceptance;

    const gap = await run({
      scenario: "AS-03",
      corpus: "tiny",
      cacheEnabled: false,
    });
    expect(gap.status).toBe("complete");
    expect(gap.promotable).toBe(false);
    // NAIL 3: honesty — seeded critic must be labeled if seeded
    expect(gap.detail ?? "").toMatch(/seeded critic|no_supported_answer|insufficient/i);

    const control = await run({
      scenario: "AS-03",
      corpus: "tiny",
      cacheEnabled: false,
      forceSupportedPack: true,
    });
    expect(control.status).toBe("complete");
    expect(control.promotable).toBe(true);
  });

  it("AS-02: real packet version increment after critic refinement", async () => {
    const mod = await import("./automatic-ingestion-r1.js");
    const run = mod.runR1Acceptance as RunR1Acceptance;
    const result = await run({
      scenario: "AS-02",
      corpus: "tiny",
      cacheEnabled: false,
    });
    expect(result.status).toBe("complete");
    expect(result.priorPacketVersion).toBeDefined();
    expect(result.packetVersion).toBeDefined();
    expect(result.packetVersion!).toBeGreaterThan(result.priorPacketVersion!);
    expect(result.detail ?? "").toMatch(/seeded critic|missing facet|packet version/i);
  });

  it("AS-04: curiosity planner not invoked before terminal; spy trips if forced early", async () => {
    const mod = await import("./automatic-ingestion-r1.js");
    const run = mod.runR1Acceptance as RunR1Acceptance;

    const ordered = await run({
      scenario: "AS-04",
      corpus: "tiny",
      cacheEnabled: false,
    });
    expect(ordered.status).toBe("complete");
    expect(ordered.curiosityPlannerInvoked).toBe(false);
    expect(ordered.detail ?? "").toMatch(/seeded critic|reject|curiosity/i);

    const forced = await run({
      scenario: "AS-04",
      corpus: "tiny",
      cacheEnabled: false,
      forceEarlyCuriosity: true,
    });
    // Early curiosity is a failure mode the harness detects
    expect(forced.curiosityPlannerInvoked).toBe(true);
    expect(forced.status).toBe("complete");
    // Scenario pin: when early curiosity forced, detail must flag ordering violation
    expect(forced.detail ?? "").toMatch(/curiosity.*early|ordering violation|out of order/i);
  });

  it("small corpus AS-01 complete with counters", async () => {
    const mod = await import("./automatic-ingestion-r1.js");
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
    expect(result.status).toBe("complete");
    expect(result.counters.providerCalls).toBeGreaterThan(0);
    expect(onProviderCall).toHaveBeenCalledTimes(result.counters.providerCalls);
  });
});
