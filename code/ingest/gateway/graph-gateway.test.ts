/**
 * T-23-01 — Graph mutation gateway (Tier A).
 *
 * Surfaces: unit | concurrency | idempotency | authoritative integration |
 * crash recovery | lifecycle | visibility gate | command strictness.
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
  createInMemoryGraphGatewayStores,
} from "./graph-gateway.js";

const UNIT = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CONCRETE_WORDING =
  "Which exponential backoff schedule do delivery workers use after a 429 response?";
const DUPLICATE_WORDING =
  "Which exponential backoff schedule do delivery workers use after a 429 response?";
const GENERIC_WORDING = "what is the information";

function branchOp(wording: string, sourceUnitIds: string[] = [UNIT]) {
  return {
    type: "create_generated_branch" as const,
    wording,
    sourceUnitIds,
  };
}

function cmd(
  key: string,
  expectedRevision: number,
  wording: string,
  extra: Record<string, unknown> = {},
) {
  return {
    expectedRevision: expectedRevision as GraphRevision,
    idempotencyKey: key,
    operations: [branchOp(wording)],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// unit surface
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

  it("invalid entity / edge type fails without a graph commit", async () => {
    const gw = createGraphGateway();
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
    const gw = createGraphGateway();
    const result = await gw.apply({
      expectedRevision: 0 as GraphRevision,
      idempotencyKey: "unit-missing-entity",
      operations: [
        {
          type: "create_generated_branch",
          wording: CONCRETE_WORDING,
          sourceUnitIds: [UNIT],
          // Valid Crockford ULID body that is not registered as a human/generated entity
          parentQuestionId: "q-01ARZ3NDEKTSV4RRFFQ69G5FAX",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MISSING_ENTITY");
    expect(await gw.listCommits()).toHaveLength(0);
  });

  it("deep-freezes successful commit outputs", async () => {
    const gw = createGraphGateway();
    const result = await gw.apply(cmd("unit-freeze", 0, CONCRETE_WORDING));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.events)).toBe(true);
  });

  it("STRICT command rejects smuggled obligations/admitted/lexical/link keys", async () => {
    const gw = createGraphGateway();
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
// concurrency surface
// ---------------------------------------------------------------------------
describe("concurrency surface", () => {
  it("two writes at same revision → one success + one STALE_REVISION; loser writes NOTHING", async () => {
    const gw = createGraphGateway();
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

    // Loser wrote NOTHING — still only the winner's records
    expect(await gw.listCommits()).toHaveLength(1);
    expect(await gw.countGeneratedQuestions()).toBe(1);
    expect(await gw.countGeneratedLinks()).toBe(1);
    expect(await gw.countSelfOwnedUnresolvedObligations()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// idempotency surface
// ---------------------------------------------------------------------------
describe("idempotency surface", () => {
  it("same key twice returns prior complete result (in-process)", async () => {
    const gw = createGraphGateway();
    const body = cmd("idem-inproc", 0, CONCRETE_WORDING);
    const a = await gw.apply(body);
    const b = await gw.apply(body);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.value.commitId).toBe(a.value.commitId);
    expect(b.value.revision).toBe(a.value.revision);
    expect(await gw.listCommits()).toHaveLength(1);
  });

  it("DURABLE: fresh gateway instance over shared stores replays prior commit", async () => {
    const shared = createInMemoryGraphGatewayStores();
    const g1 = createGraphGateway({ stores: shared });
    const body = cmd("idem-durable", 0, CONCRETE_WORDING);
    const first = await g1.apply(body);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const g2 = createGraphGateway({ stores: shared });
    const second = await g2.apply(body);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.commitId).toBe(first.value.commitId);
    expect(await g2.listCommits()).toHaveLength(1);
    expect(await g2.countGeneratedQuestions()).toBe(1);
  });

  it("same key different payload is IDEMPOTENCY_CONFLICT", async () => {
    const gw = createGraphGateway();
    const key = "idem-conflict";
    const a = await gw.apply(cmd(key, 0, CONCRETE_WORDING));
    expect(a.ok).toBe(true);
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
// authoritative integration
// ---------------------------------------------------------------------------
describe("authoritative integration", () => {
  it("proposal that OMITS an existing admitted duplicate is rejected from repository state", async () => {
    const gw = createGraphGateway();
    const seed = await gw.apply(cmd("auth-seed-dup", 0, CONCRETE_WORDING));
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;

    const dup = await gw.apply(
      cmd("auth-dup-omit", seed.value.revision as number, DUPLICATE_WORDING),
    );
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe("ADMISSION_REJECTED");
    expect(await gw.countGeneratedQuestions()).toBe(1);
    expect(await gw.listCommits()).toHaveLength(1);
  });

  it("proposal that FABRICATES an open obligation is rejected (smuggle fails typed)", async () => {
    const gw = createGraphGateway();
    // Smuggling claimedObligationId is INVALID_INPUT (strict command)
    const smuggled = await gw.apply({
      ...cmd("auth-fake-obl", 0, CONCRETE_WORDING),
      claimedObligationId: "obl-01ARZ3NDEKTSV4RRFFQ69G5FAKE",
    });
    expect(smuggled.ok).toBe(false);
    if (!smuggled.ok) expect(smuggled.code).toBe("INVALID_INPUT");
    expect(await gw.listCommits()).toHaveLength(0);
    expect(await gw.countGeneratedQuestions()).toBe(0);
  });

  it("successful command creates question + link + one self-owned unresolved obligation + one commit", async () => {
    const gw = createGraphGateway();
    const result = await gw.apply(cmd("auth-success", 0, CONCRETE_WORDING));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revision).toBeGreaterThan(0 as GraphRevision);
    expect(await gw.listCommits()).toHaveLength(1);
    expect(await gw.countGeneratedQuestions()).toBe(1);
    expect(await gw.countGeneratedLinks()).toBe(1);
    expect(await gw.countSelfOwnedUnresolvedObligations()).toBe(1);
    expect(result.value.createdQuestionId).toMatch(/^q-/);
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("rejected admission writes NOTHING on all four stores", async () => {
    const gw = createGraphGateway();
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
  it("after crash, precursors are unreachable through commits (sanctioned path)", async () => {
    const shared = createInMemoryGraphGatewayStores();
    let crashed = false;
    const g1 = createGraphGateway({
      stores: shared,
      hooks: {
        afterPrecursorBeforeCommit: async () => {
          if (!crashed) {
            crashed = true;
            throw new Error("injected-crash afterPrecursorBeforeCommit");
          }
        },
      },
    });

    await expect(
      g1.apply(cmd("vis-crash", 0, CONCRETE_WORDING)),
    ).rejects.toThrow(/injected-crash/);

    expect(await g1.listCommits()).toHaveLength(0);
    // Precursors may exist in store counts, but MUST NOT be commit-reachable
    const questions = await g1.countGeneratedQuestions();
    if (questions > 0) {
      for (const id of shared.questions.keys()) {
        expect(await g1.isReachableViaCommit(id)).toBe(false);
      }
      for (const id of shared.obligations.keys()) {
        expect(await g1.isReachableViaCommit(id)).toBe(false);
      }
    }

    // Positive control: after success, subjects ARE reachable
    const g2 = createGraphGateway({
      stores: createInMemoryGraphGatewayStores(),
    });
    const ok = await g2.apply(cmd("vis-ok", 0, CONCRETE_WORDING));
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(await g2.isReachableViaCommit(ok.value.createdQuestionId!)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// crash recovery
// ---------------------------------------------------------------------------
describe("crash recovery", () => {
  it("mid-transaction crash leaves no visible branch; fresh instance reconciles", async () => {
    const shared = createInMemoryGraphGatewayStores();
    let crashed = false;
    const g1 = createGraphGateway({
      stores: shared,
      hooks: {
        afterPrecursorBeforeCommit: async () => {
          if (!crashed) {
            crashed = true;
            throw new Error("injected-crash afterPrecursorBeforeCommit");
          }
        },
      },
    });

    await expect(g1.apply(cmd("crash-1", 0, CONCRETE_WORDING))).rejects.toThrow(
      /injected-crash/,
    );
    expect(await g1.listCommits()).toHaveLength(0);

    const g2 = createGraphGateway({ stores: shared });
    const recovered = await g2.reconcilePendingOperations();
    expect(recovered.ok).toBe(true);
    // Abandon disposition: still no commits (precursors unreferenced)
    expect(await g2.listCommits()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------
describe("lifecycle surface", () => {
  it("human question creation remains on canonical path (not via gateway)", async () => {
    const gw = createGraphGateway();
    expect(
      (gw as { createHumanQuestion?: unknown }).createHumanQuestion,
    ).toBeUndefined();
    gw.registerHumanQuestion(
      "q-01ARZ3NDEKTSV4RRFFQ69G5FHHH",
      "Human-authored demand question",
    );
    // Human questions are not gateway commits
    expect(await gw.listCommits()).toHaveLength(0);
    const lifecycle = await import("../knowledge/index.js");
    expect(typeof lifecycle.assessQuestionProposal).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// barrel discipline
// ---------------------------------------------------------------------------
describe("barrel discipline", () => {
  it("gateway barrel exports createGraphGateway and not in-memory store factories", async () => {
    const barrel = await import("./index.js");
    expect(typeof barrel.createGraphGateway).toBe("function");
    expect(
      (barrel as { createInMemoryGraphGatewayStores?: unknown })
        .createInMemoryGraphGatewayStores,
    ).toBeUndefined();
  });

  it("ingest root barrel re-exports createGraphGateway", async () => {
    const root = await import("../index.js");
    expect(typeof root.createGraphGateway).toBe("function");
  });
});
