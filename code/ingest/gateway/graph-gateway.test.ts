/**
 * T-23-01 — Graph mutation gateway (Tier A, post-River C1/C2 rework).
 */
import { describe, expect, it } from "vitest";

import {
  GraphCommitSchema,
  GraphEventSchema,
  GraphOperationSchema,
  GraphRevisionSchema,
  type GraphRevision,
} from "../../domain/ingest/graph-event.js";

import {
  GRAPH_GATEWAY_LIMITS,
  createGraphGateway,
  createInMemoryGraphGatewayDeps,
} from "./graph-gateway.js";

const UNIT = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CONCRETE_WORDING =
  "Which exponential backoff schedule do delivery workers use after a 429 response?";
const GENERIC_WORDING = "what is the information";

function branchOp(wording: string, sourceUnitIds: string[] = [UNIT]) {
  return {
    type: "create_generated_branch" as const,
    wording,
    sourceUnitIds,
  };
}

function cmd(key: string, expectedRevision: number, wording: string) {
  return {
    expectedRevision: expectedRevision as GraphRevision,
    idempotencyKey: key,
    operations: [branchOp(wording)],
  };
}

function makeGw(hooks?: {
  afterPrecursorBeforeCommit?: () => void | Promise<void>;
}) {
  const deps = createInMemoryGraphGatewayDeps(hooks);
  const gw = createGraphGateway(deps);
  return { gw, deps };
}

// ---------------------------------------------------------------------------
// unit
// ---------------------------------------------------------------------------
describe("unit surface", () => {
  it("exports GraphEvent/Commit schemas and createGraphGateway", () => {
    expect(typeof GraphEventSchema?.safeParse).toBe("function");
    expect(typeof GraphCommitSchema?.safeParse).toBe("function");
    expect(typeof GraphOperationSchema?.safeParse).toBe("function");
    expect(typeof GraphRevisionSchema?.safeParse).toBe("function");
    expect(typeof createGraphGateway).toBe("function");
    expect(GRAPH_GATEWAY_LIMITS.maxOperationsPerCommand).toBeGreaterThan(0);
  });

  it("invalid edge type fails without a graph commit", async () => {
    const { gw } = makeGw();
    const result = await gw.apply({
      expectedRevision: 0 as GraphRevision,
      idempotencyKey: "unit-invalid-edge",
      operations: [
        {
          type: "not-a-real-edge-type",
          wording: CONCRETE_WORDING,
          sourceUnitIds: [UNIT],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["INVALID_EDGE", "INVALID_INPUT"]).toContain(result.code);
      expect(result.message).not.toContain("not-a-real-edge-type");
    }
    expect(await gw.listCommits()).toHaveLength(0);
  });

  it("missing entity fails without a graph commit", async () => {
    const { gw } = makeGw();
    const result = await gw.apply({
      expectedRevision: 0 as GraphRevision,
      idempotencyKey: "unit-missing-entity",
      operations: [
        {
          type: "create_generated_branch",
          wording: CONCRETE_WORDING,
          sourceUnitIds: [UNIT],
          parentQuestionId: "q-01ARZ3NDEKTSV4RRFFQ69G5FAX",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MISSING_ENTITY");
    expect(await gw.listCommits()).toHaveLength(0);
  });

  it("deep-freezes successful commit outputs", async () => {
    const { gw } = makeGw();
    const result = await gw.apply(cmd("unit-freeze", 0, CONCRETE_WORDING));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("STRICT command rejects smuggled obligations/admitted/lexical/link keys", async () => {
    const { gw } = makeGw();
    for (const smuggle of [
      { obligations: [] },
      { admitted: [] },
      { lexicalCandidates: [] },
      { link: { origin: "ingestion-generated" } },
      { claimedObligationId: "obl-01ARZ3NDEKTSV4RRFFQ69G5FAKE" },
    ]) {
      const result = await gw.apply({
        ...cmd("smuggle-" + Object.keys(smuggle)[0], 0, CONCRETE_WORDING),
        ...smuggle,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
    }
    expect(await gw.listCommits()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------
describe("concurrency surface", () => {
  it("two writes at same revision → one success + one STALE_REVISION; loser writes NOTHING", async () => {
    const { gw } = makeGw();
    const first = await gw.apply(cmd("conc-first", 0, CONCRETE_WORDING));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await gw.listCommits()).toHaveLength(1);
    expect(await gw.countGeneratedQuestions()).toBe(1);
    expect(await gw.countGeneratedLinks()).toBe(1);
    expect(await gw.countSelfOwnedUnresolvedObligations()).toBe(1);

    const second = await gw.apply(
      cmd(
        "conc-second",
        0,
        "What is the exact retry budget for webhook delivery failures?",
      ),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("STALE_REVISION");
    expect(await gw.listCommits()).toHaveLength(1);
    expect(await gw.countGeneratedQuestions()).toBe(1);
    expect(await gw.countGeneratedLinks()).toBe(1);
    expect(await gw.countSelfOwnedUnresolvedObligations()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// idempotency (simulated restart = shared deps, new gateway instance)
// ---------------------------------------------------------------------------
describe("idempotency surface", () => {
  it("same key twice returns prior complete result (in-process)", async () => {
    const { gw } = makeGw();
    const body = cmd("idem-inproc", 0, CONCRETE_WORDING);
    const a = await gw.apply(body);
    const b = await gw.apply(body);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.value.commitId).toBe(a.value.commitId);
    expect(await gw.listCommits()).toHaveLength(1);
  });

  it("SIMULATED restart: fresh gateway over shared deps replays prior commit", async () => {
    // Note: shared in-memory Maps — simulates restart; does not prove OS-level durability.
    const deps = createInMemoryGraphGatewayDeps();
    const g1 = createGraphGateway(deps);
    const body = cmd("idem-durable", 0, CONCRETE_WORDING);
    const first = await g1.apply(body);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const g2 = createGraphGateway(deps);
    const second = await g2.apply(body);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.commitId).toBe(first.value.commitId);
    expect(await g2.listCommits()).toHaveLength(1);
  });

  it("same key different payload is IDEMPOTENCY_CONFLICT", async () => {
    const { gw } = makeGw();
    const key = "idem-conflict";
    expect((await gw.apply(cmd(key, 0, CONCRETE_WORDING))).ok).toBe(true);
    const b = await gw.apply(
      cmd(
        key,
        0,
        "What is the concrete timeout value for cache eviction windows?",
      ),
    );
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// authoritative integration + C1 gate
// ---------------------------------------------------------------------------
describe("authoritative integration", () => {
  it("proposal that OMITS an existing admitted duplicate is rejected from commit-reachable state", async () => {
    const { gw } = makeGw();
    const seed = await gw.apply(cmd("auth-seed-dup", 0, CONCRETE_WORDING));
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;

    const dup = await gw.apply(
      cmd("auth-dup-omit", seed.value.revision as number, CONCRETE_WORDING),
    );
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe("ADMISSION_REJECTED");
    expect(await gw.countGeneratedQuestions()).toBe(1);
    expect(await gw.listCommits()).toHaveLength(1);
  });

  it("I-A: SAME key after crash RESUMES and completes (one of each record)", async () => {
    let crashed = false;
    const deps = createInMemoryGraphGatewayDeps({
      afterPrecursorBeforeCommit: async () => {
        if (!crashed) {
          crashed = true;
          throw new Error("injected-crash afterPrecursorBeforeCommit");
        }
      },
    });
    const g1 = createGraphGateway(deps);
    await expect(
      g1.apply(cmd("ia-same-key", 0, CONCRETE_WORDING)),
    ).rejects.toThrow(/injected-crash/);
    expect(await g1.listCommits()).toHaveLength(0);

    // Resume WITHOUT crash hook — SAME key must SUCCEED (not COMMIT_FAILED forever)
    const g2 = createGraphGateway({
      commits: deps.commits,
      questions: deps.questions,
      links: deps.links,
      obligations: deps.obligations,
      wordings: deps.wordings,
      ...(deps.humanQuestions ? { humanQuestions: deps.humanQuestions } : {}),
    });
    const retry = await g2.apply(cmd("ia-same-key", 0, CONCRETE_WORDING));
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    // Discriminating: commit must reference THIS resume's subject ids (not merely
    // that an orphan count equals one — that would pass if append were a no-op).
    expect(await g2.listCommits()).toHaveLength(1);
    expect(retry.value.createdQuestionId).toMatch(/^q-/);
    expect(retry.value.createdObligationId).toMatch(/^obl-/);
    expect(await g2.isReachableViaCommit(retry.value.createdQuestionId!)).toBe(
      true,
    );
    expect(
      await g2.isReachableViaCommit(retry.value.createdObligationId!),
    ).toBe(true);
    expect(await g2.countGeneratedLinks()).toBe(1);
    expect(await g2.countSelfOwnedUnresolvedObligations()).toBe(1);
    // Commit event subjectIds bind the obligation this resume finalized
    const subjects = retry.value.events.flatMap((e) => e.subjectIds);
    expect(subjects).toContain(retry.value.createdObligationId);

    // Retry twice: still exactly one commit (idempotent)
    const again = await g2.apply(cmd("ia-same-key", 0, CONCRETE_WORDING));
    expect(again.ok && again.value.commitId).toBe(retry.value.commitId);
    expect(await g2.listCommits()).toHaveLength(1);
  });

  it("I-A: SAME key DIFFERENT payload after crash is IDEMPOTENCY_CONFLICT", async () => {
    let crashed = false;
    const deps = createInMemoryGraphGatewayDeps({
      afterPrecursorBeforeCommit: async () => {
        if (!crashed) {
          crashed = true;
          throw new Error("injected-crash afterPrecursorBeforeCommit");
        }
      },
    });
    const g1 = createGraphGateway(deps);
    await expect(
      g1.apply(cmd("ia-payload", 0, CONCRETE_WORDING)),
    ).rejects.toThrow(/injected-crash/);

    const g2 = createGraphGateway({
      commits: deps.commits,
      questions: deps.questions,
      links: deps.links,
      obligations: deps.obligations,
      wordings: deps.wordings,
    });
    const conflict = await g2.apply(
      cmd(
        "ia-payload",
        0,
        "What is the concrete timeout value for cache eviction windows?",
      ),
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("C1: crash orphan does NOT poison admission for different key same wording", async () => {
    const deps = createInMemoryGraphGatewayDeps({
      afterPrecursorBeforeCommit: async () => {
        throw new Error("injected-crash afterPrecursorBeforeCommit");
      },
    });
    const g1 = createGraphGateway(deps);
    await expect(
      g1.apply(cmd("c1-crash", 0, CONCRETE_WORDING)),
    ).rejects.toThrow(/injected-crash/);
    expect(await g1.listCommits()).toHaveLength(0);

    // Fresh instance over same seams, WITHOUT crash hook
    const g2 = createGraphGateway({
      commits: deps.commits,
      questions: deps.questions,
      links: deps.links,
      obligations: deps.obligations,
      wordings: deps.wordings,
      ...(deps.humanQuestions ? { humanQuestions: deps.humanQuestions } : {}),
    });
    await g2.abandonPendingOperations();
    // Same wording must NOT be ADMISSION_REJECTED due to unreachable orphan
    const retry = await g2.apply(cmd("c1-retry", 0, CONCRETE_WORDING));
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(await g2.listCommits()).toHaveLength(1);
  });

  it("successful command creates question + link + self-owned unresolved obligation + commit", async () => {
    const { gw } = makeGw();
    const result = await gw.apply(cmd("auth-success", 0, CONCRETE_WORDING));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await gw.listCommits()).toHaveLength(1);
    expect(await gw.countGeneratedQuestions()).toBe(1);
    expect(await gw.countGeneratedLinks()).toBe(1);
    expect(await gw.countSelfOwnedUnresolvedObligations()).toBe(1);
    expect(result.value.createdQuestionId).toMatch(/^q-/);
    expect(await gw.isReachableViaCommit(result.value.createdQuestionId!)).toBe(
      true,
    );
  });

  it("rejected admission writes NOTHING on all four stores", async () => {
    const { gw } = makeGw();
    expect(await gw.listCommits()).toHaveLength(0);
    expect(await gw.countGeneratedQuestions()).toBe(0);
    expect(await gw.countGeneratedLinks()).toBe(0);
    expect(await gw.countSelfOwnedUnresolvedObligations()).toBe(0);

    const rejected = await gw.apply(
      cmd("auth-reject-nothing", 0, GENERIC_WORDING),
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("ADMISSION_REJECTED");
    expect(await gw.listCommits()).toHaveLength(0);
    expect(await gw.countGeneratedQuestions()).toBe(0);
    expect(await gw.countGeneratedLinks()).toBe(0);
    expect(await gw.countSelfOwnedUnresolvedObligations()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// visibility gate
// ---------------------------------------------------------------------------
describe("visibility gate", () => {
  it("after crash, precursors are unreachable through commits", async () => {
    let crashed = false;
    const deps = createInMemoryGraphGatewayDeps({
      afterPrecursorBeforeCommit: async () => {
        if (!crashed) {
          crashed = true;
          throw new Error("injected-crash afterPrecursorBeforeCommit");
        }
      },
    });
    const g1 = createGraphGateway(deps);
    await expect(
      g1.apply(cmd("vis-crash", 0, CONCRETE_WORDING)),
    ).rejects.toThrow(/injected-crash/);
    expect(await g1.listCommits()).toHaveLength(0);
    const all = await deps.questions.listAll();
    for (const q of all) {
      expect(await g1.isReachableViaCommit(q.id)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// crash abandon
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Discriminating tests for reserveCreate / append verdict handling
// (mutation-tested: removing the production check MUST fail these)
// ---------------------------------------------------------------------------
describe("obligation primitive verdicts", () => {
  it("append version_conflict fails closed with NO commit", async () => {
    const deps = createInMemoryGraphGatewayDeps();
    deps.obligationFake.setTestHooks({ forceAppendVersionConflict: 7 });
    const gw = createGraphGateway(deps);
    const result = await gw.apply(cmd("vc-fail", 0, CONCRETE_WORDING));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("COMMIT_FAILED");
    expect(await gw.listCommits()).toHaveLength(0);
    // Positive baseline: without the force hook, same command would commit
    const ok = await gw.apply(cmd("vc-ok", 0, CONCRETE_WORDING));
    expect(ok.ok).toBe(true);
    expect(await gw.listCommits()).toHaveLength(1);
  });

  it("reserveCreate returned id (≠ local allocate) is used on the commit", async () => {
    // Valid crockford ULID body (26); deliberately not equal to key-derived id
    const validForced =
      "obl-01ARZ3NDEKTSV4RRFFQ69G5FZZ" as import("../../domain/ingest/types.js").ObligationId;

    const deps = createInMemoryGraphGatewayDeps();
    deps.obligationFake.setTestHooks({ forceReservedId: validForced });
    const gw = createGraphGateway(deps);
    const result = await gw.apply(cmd("reserve-id", 0, CONCRETE_WORDING));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Downstream commit MUST use the reserved id, not a purely local derivation
    expect(result.value.createdObligationId).toBe(validForced);
    expect(await gw.isReachableViaCommit(validForced)).toBe(true);
  });
});

describe("crash abandon", () => {
  it("mid-transaction crash leaves no commits; abandon clears intents", async () => {
    let crashed = false;
    const deps = createInMemoryGraphGatewayDeps({
      afterPrecursorBeforeCommit: async () => {
        if (!crashed) {
          crashed = true;
          throw new Error("injected-crash afterPrecursorBeforeCommit");
        }
      },
    });
    const g1 = createGraphGateway(deps);
    await expect(g1.apply(cmd("crash-1", 0, CONCRETE_WORDING))).rejects.toThrow(
      /injected-crash/,
    );
    expect(await g1.listCommits()).toHaveLength(0);

    const g2 = createGraphGateway(deps);
    const abandoned = await g2.abandonPendingOperations();
    expect(abandoned.ok).toBe(true);
    if (!abandoned.ok) return;
    expect(abandoned.value.abandoned).toBeGreaterThanOrEqual(1);
    expect(await g2.listCommits()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// lifecycle + barrel
// ---------------------------------------------------------------------------
describe("lifecycle surface", () => {
  it("human question creation remains on canonical path (not via gateway)", async () => {
    const { gw } = makeGw();
    expect(
      (gw as { createHumanQuestion?: unknown }).createHumanQuestion,
    ).toBeUndefined();
    gw.registerHumanQuestion(
      "q-01ARZ3NDEKTSV4RRFFQ69G5FHHH",
      "Human-authored demand",
    );
    expect(await gw.listCommits()).toHaveLength(0);
    const lifecycle = await import("../knowledge/index.js");
    expect(typeof lifecycle.assessQuestionProposal).toBe("function");
  });
});

describe("barrel discipline", () => {
  it("gateway barrel exports createGraphGateway and not in-memory factories", async () => {
    const barrel = await import("./index.js");
    expect(typeof barrel.createGraphGateway).toBe("function");
    expect(
      (barrel as { createInMemoryGraphGatewayDeps?: unknown })
        .createInMemoryGraphGatewayDeps,
    ).toBeUndefined();
    expect(
      (barrel as { createInMemoryGraphCommitStore?: unknown })
        .createInMemoryGraphCommitStore,
    ).toBeUndefined();
  });

  it("ingest root barrel re-exports createGraphGateway", async () => {
    const root = await import("../index.js");
    expect(typeof root.createGraphGateway).toBe("function");
  });
});
