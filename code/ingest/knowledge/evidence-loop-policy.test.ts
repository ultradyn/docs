import { describe, expect, it } from "vitest";

import type { BoundedFollowUp } from "../../domain/ingest/evidence-verdict.js";

import {
  DEFAULT_EVIDENCE_LOOP_BUDGET,
  canonicalNoveltyKey,
  evaluateEvidenceLoop,
  type EvidenceLoopBudget,
  type EvidenceLoopHistory,
  type EvidenceLoopStep,
} from "./evidence-loop-policy.js";

const Q = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PKT = "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EVV = "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV";

function followUp(
  overrides: Partial<BoundedFollowUp> & {
    missingFacetIds?: string[];
    subject?: string;
  } = {},
): BoundedFollowUp {
  const {
    missingFacetIds = ["components"],
    subject = "component inventory",
    ...rest
  } = overrides;
  return {
    missingFacetIds,
    requiredSearch: {
      subject,
      scope: "docs",
      exclusions: ["sdk"],
      ...(rest.requiredSearch ?? {}),
    },
    whyCurrentPacketFails: rest.whyCurrentPacketFails ?? "gap on components",
  };
}

function refineStep(
  version: number,
  follow: BoundedFollowUp | null,
  overrides: Partial<EvidenceLoopStep> = {},
): EvidenceLoopStep {
  return {
    packetId: PKT,
    packetVersion: version,
    verdictId: EVV,
    verdictVersion: version,
    verdict: "needs_more_evidence",
    followUpRequest: follow,
    ...overrides,
  };
}

function history(
  steps: EvidenceLoopStep[],
  overrides: Partial<EvidenceLoopHistory> = {},
): EvidenceLoopHistory {
  return {
    questionId: Q,
    steps,
    ...overrides,
  };
}

function budget(
  overrides: Partial<EvidenceLoopBudget> = {},
): EvidenceLoopBudget {
  return {
    maxRefinements: 3,
    ...overrides,
  };
}

describe("exports", () => {
  it("exports evaluateEvidenceLoop", () => {
    expect(typeof evaluateEvidenceLoop).toBe("function");
  });

  it("exports canonicalNoveltyKey", () => {
    expect(typeof canonicalNoveltyKey).toBe("function");
  });

  it("exports DEFAULT_EVIDENCE_LOOP_BUDGET with positive maxRefinements", () => {
    expect(DEFAULT_EVIDENCE_LOOP_BUDGET.maxRefinements).toBeGreaterThan(0);
  });
});

describe("canonicalNoveltyKey", () => {
  it("is fixed-field and ignores key order / set order", () => {
    const a = followUp({
      missingFacetIds: ["z", "a"],
      subject: "auth",
    });
    const b: BoundedFollowUp = {
      whyCurrentPacketFails: a.whyCurrentPacketFails,
      missingFacetIds: ["a", "z"],
      requiredSearch: {
        exclusions: ["sdk"],
        scope: "docs",
        subject: "auth",
      },
    };
    expect(canonicalNoveltyKey(a)).toBe(canonicalNoveltyKey(b));
    expect(canonicalNoveltyKey(a)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when search subject or missing facets change", () => {
    const base = followUp({ subject: "auth", missingFacetIds: ["a"] });
    const otherSubject = followUp({ subject: "tokens", missingFacetIds: ["a"] });
    const otherFacet = followUp({ subject: "auth", missingFacetIds: ["b"] });
    expect(canonicalNoveltyKey(base)).not.toBe(canonicalNoveltyKey(otherSubject));
    expect(canonicalNoveltyKey(base)).not.toBe(canonicalNoveltyKey(otherFacet));
  });

  it("does not treat whyCurrentPacketFails as novelty (search obligation only)", () => {
    const a = followUp({ subject: "auth" });
    const b = followUp({
      subject: "auth",
      whyCurrentPacketFails: "completely different prose",
    });
    expect(canonicalNoveltyKey(a)).toBe(canonicalNoveltyKey(b));
  });
});

describe("evaluateEvidenceLoop — novel continue", () => {
  it("continues when latest refine is novel and under budget", () => {
    const result = evaluateEvidenceLoop(
      history([refineStep(1, followUp({ subject: "v1" }))]),
      budget({ maxRefinements: 3 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.route).toBe("continue");
    expect(result.value.refinementCount).toBe(1);
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("continues for a second novel refine under budget", () => {
    const result = evaluateEvidenceLoop(
      history([
        refineStep(1, followUp({ subject: "first", missingFacetIds: ["a"] })),
        refineStep(2, followUp({ subject: "second", missingFacetIds: ["b"] })),
      ]),
      budget({ maxRefinements: 3 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.route).toBe("continue");
    expect(result.value.refinementCount).toBe(2);
  });
});

describe("evaluateEvidenceLoop — non-novel and budget", () => {
  it("routes human_action on repeated non-novel search obligation", () => {
    const same = followUp({ subject: "auth", missingFacetIds: ["purpose"] });
    const result = evaluateEvidenceLoop(
      history([refineStep(1, same), refineStep(2, same)]),
      budget({ maxRefinements: 5 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.route).toBe("human_action");
    // Must not invent acceptance or no-evidence
    expect(result.value.route).not.toBe("accepted" as never);
    expect(["continue", "search_incomplete", "human_action"]).toContain(
      result.value.route,
    );
  });

  it("routes search_incomplete when refinement budget is exhausted", () => {
    const result = evaluateEvidenceLoop(
      history([
        refineStep(1, followUp({ subject: "a" })),
        refineStep(2, followUp({ subject: "b" })),
        refineStep(3, followUp({ subject: "c" })),
      ]),
      budget({ maxRefinements: 3 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.route).toBe("search_incomplete");
    expect(result.value.refinementCount).toBe(3);
  });

  it("budget exhaustion wins when latest is also non-novel", () => {
    const same = followUp({ subject: "same" });
    const result = evaluateEvidenceLoop(
      history([
        refineStep(1, same),
        refineStep(2, followUp({ subject: "other" })),
        refineStep(3, same),
      ]),
      budget({ maxRefinements: 3 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Exhausted budget is search_incomplete (not a false gap synthesis)
    expect(result.value.route).toBe("search_incomplete");
  });

  it("does not synthesize accepted or no_supported_answer on any terminal", () => {
    const decisions = [
      evaluateEvidenceLoop(
        history([refineStep(1, followUp()), refineStep(2, followUp())]),
        budget({ maxRefinements: 5 }),
      ),
      evaluateEvidenceLoop(
        history([
          refineStep(1, followUp({ subject: "1" })),
          refineStep(2, followUp({ subject: "2" })),
        ]),
        budget({ maxRefinements: 2 }),
      ),
    ];
    for (const decision of decisions) {
      expect(decision.ok).toBe(true);
      if (!decision.ok) continue;
      expect(
        ["continue", "search_incomplete", "human_action"] as const,
      ).toContain(decision.value.route);
      expect(decision.value).not.toHaveProperty("synthesizedVerdict");
      expect(decision.value).not.toHaveProperty("accepted");
    }
  });
});

describe("evaluateEvidenceLoop — history receipt preserves IDs", () => {
  it("includes every packet and verdict id from history on terminal routes", () => {
    const steps = [
      refineStep(1, followUp({ subject: "a" }), {
        packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
        verdictId: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }),
      refineStep(2, followUp({ subject: "a" }), {
        packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
        verdictId: "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV",
        packetVersion: 2,
        verdictVersion: 2,
      }),
    ];
    const result = evaluateEvidenceLoop(history(steps), budget({ maxRefinements: 5 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.route).toBe("human_action");
    expect(result.value.historyReceipt.packetRefs).toEqual([
      { packetId: PKT, packetVersion: 1 },
      { packetId: PKT, packetVersion: 2 },
    ]);
    expect(result.value.historyReceipt.verdictRefs).toEqual([
      { verdictId: EVV, verdictVersion: 1 },
      { verdictId: EVV, verdictVersion: 2 },
    ]);
    expect(Object.isFrozen(result.value.historyReceipt)).toBe(true);
    expect(Object.isFrozen(result.value.historyReceipt.packetRefs)).toBe(true);
  });

  it("preserves IDs on search_incomplete without dropping earlier steps", () => {
    const steps = [
      refineStep(1, followUp({ subject: "a" })),
      refineStep(2, followUp({ subject: "b" })),
      refineStep(3, followUp({ subject: "c" })),
    ];
    const result = evaluateEvidenceLoop(
      history(steps),
      budget({ maxRefinements: 3 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.historyReceipt.packetRefs).toHaveLength(3);
    expect(result.value.historyReceipt.verdictRefs).toHaveLength(3);
  });
});

describe("evaluateEvidenceLoop — terminal non-refine steps", () => {
  it("does not force refine when latest is already accepted", () => {
    const result = evaluateEvidenceLoop(
      history([
        {
          packetId: PKT,
          packetVersion: 1,
          verdictId: EVV,
          verdictVersion: 1,
          verdict: "accepted",
          followUpRequest: null,
        },
      ]),
      budget(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Loop is complete — not a refine continue
    expect(result.value.route).toBe("continue");
    expect(result.value.reason).toMatch(/complete|terminal|accepted/i);
  });

  it("does not rewrite no_supported_answer into another terminal", () => {
    const result = evaluateEvidenceLoop(
      history([
        {
          packetId: PKT,
          packetVersion: 1,
          verdictId: EVV,
          verdictVersion: 1,
          verdict: "no_supported_answer",
          followUpRequest: null,
        },
      ]),
      budget(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.route).toBe("continue");
    expect(result.value.reason).toMatch(/complete|terminal|no_supported/i);
  });
});

describe("evaluateEvidenceLoop — input hygiene", () => {
  it("rejects non-plain / unknown keys / hostile accessors", () => {
    expect(evaluateEvidenceLoop(null as never, budget()).ok).toBe(false);
    expect(
      evaluateEvidenceLoop(
        { questionId: Q, steps: [], evil: true } as never,
        budget(),
      ).ok,
    ).toBe(false);

    let accessed = false;
    const hostile = {
      questionId: Q,
      get steps() {
        accessed = true;
        throw new Error("nope");
      },
    };
    const result = evaluateEvidenceLoop(hostile as never, budget());
    expect(accessed).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
  });

  it("rejects empty steps and invalid budget", () => {
    expect(evaluateEvidenceLoop(history([]), budget()).ok).toBe(false);
    expect(
      evaluateEvidenceLoop(
        history([refineStep(1, followUp())]),
        { maxRefinements: 0 },
      ).ok,
    ).toBe(false);
    expect(
      evaluateEvidenceLoop(
        history([refineStep(1, followUp())]),
        { maxRefinements: -1 },
      ).ok,
    ).toBe(false);
  });

  it("rejects needs_more_evidence without BoundedFollowUp", () => {
    const result = evaluateEvidenceLoop(
      history([refineStep(1, null)]),
      budget(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
  });

  it("rejects malformed questionId / packetId brands", () => {
    const result = evaluateEvidenceLoop(
      history([refineStep(1, followUp())], {
        questionId: "not-a-question" as never,
      }),
      budget(),
    );
    expect(result.ok).toBe(false);
  });
});

describe("evaluateEvidenceLoop — pure policy (no ledger side effects)", () => {
  it("is referentially transparent for identical inputs", () => {
    const h = history([
      refineStep(1, followUp({ subject: "x" })),
      refineStep(2, followUp({ subject: "y" })),
    ]);
    const b = budget({ maxRefinements: 3 });
    const a = evaluateEvidenceLoop(h, b);
    const c = evaluateEvidenceLoop(h, b);
    expect(a).toEqual(c);
  });

  it("does not mutate caller history or budget", () => {
    const steps = [refineStep(1, followUp({ subject: "a" }))];
    const h = history(steps);
    const b = budget({ maxRefinements: 2 });
    const before = JSON.stringify({ h, b });
    evaluateEvidenceLoop(h, b);
    expect(JSON.stringify({ h, b })).toBe(before);
  });
});

describe("public barrel", () => {
  it("re-exports evaluateEvidenceLoop from knowledge barrel", async () => {
    const barrel = await import("./index.js");
    expect(
      typeof (barrel as { evaluateEvidenceLoop?: unknown }).evaluateEvidenceLoop,
    ).toBe("function");
  });
});
