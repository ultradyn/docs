/**
 * T-31-01 — Evidence Critic (RED-first, Tier A).
 *
 * Surfaces: agent_fixture | claim (packet/verdict) | retrieval (open_reference allowlist).
 * Invariants:
 * - Schema forbids child proposals (no child* keys, no depthFindings free-text).
 * - Every packet material reference must be classified (fail closed).
 * - Every required facet must have a state (fail closed).
 * - accepted is narrowest: all facets satisfied; unknown facet state fails closed.
 * - QUALIFIER_DROPPED re-derived from packet vs classifications.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Sha256, SourceUnitId } from "../../domain/ingest/types.js";
import { resolveShippedPath } from "../../shared/shipped-layout.js";

import {
  EVIDENCE_CRITIC_LIMITS,
  EvidenceCriticProposalSchema,
  createEvidenceCriticAgent,
  validateEvidenceCriticProposal,
  type EvidenceCriticError,
  type EvidenceCriticProposal,
} from "./evidence-critic-agent.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const scaffoldRoot = resolveShippedPath(
  repoRoot,
  "agents",
  "evidence-critic",
);
const fixturesRoot = join(scaffoldRoot, "fixtures");

const QUESTION = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PACKET = "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UNIT_A = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAA" as SourceUnitId;
const UNIT_Q = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAQ" as SourceUnitId;
const DIGEST = "a".repeat(64) as Sha256;
const SNAP = `snap-${"b".repeat(64)}`;
const FILE = `file-${"c".repeat(64)}`;
const RCPT = "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV";

function sha(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}

function packet(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    id: PACKET,
    questionId: QUESTION,
    version: 1,
    references: [
      {
        snapshotId: SNAP,
        fileId: FILE,
        unitId: UNIT_A,
        fileSha256: DIGEST,
        unitSha256: sha("a"),
        role: "primary" as const,
        facetIds: ["facet-definition"],
      },
      {
        snapshotId: SNAP,
        fileId: FILE,
        unitId: UNIT_Q,
        fileSha256: DIGEST,
        unitSha256: sha("q"),
        role: "supporting" as const,
        facetIds: ["facet-constraint"],
      },
    ],
    receiptId: RCPT,
    receiptDigest: DIGEST,
    limits: { maxReferences: 32, maxFacetsPerReference: 8 },
    ...overrides,
  };
}

function validProposal(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    questionId: QUESTION,
    packetId: PACKET,
    referenceClassifications: [
      {
        unitId: UNIT_A,
        classification: "necessary_primary",
        reason: "Defines the primary behavior under review.",
      },
      {
        unitId: UNIT_Q,
        classification: "necessary_qualifying",
        reason: "Qualifies the scope of the primary claim.",
      },
    ],
    facetStates: [
      {
        facetId: "facet-definition",
        state: "satisfied",
        reason: "Primary unit supports the definition facet.",
        sourceUnitIds: [UNIT_A],
      },
      {
        facetId: "facet-constraint",
        state: "satisfied",
        reason: "Qualifier unit supports the constraint facet.",
        sourceUnitIds: [UNIT_Q],
      },
    ],
    verdict: "accepted",
    refinement: null,
    ...overrides,
  };
}

const REQUIRED_FACETS = ["facet-definition", "facet-constraint"] as const;

// ---------------------------------------------------------------------------
// Schema impossibility — no children
// ---------------------------------------------------------------------------
describe("schema impossibility — no child proposals", () => {
  it("exports EvidenceCriticProposalSchema and rejects childQuestions keys", () => {
    expect(typeof EvidenceCriticProposalSchema?.safeParse).toBe("function");
    const withChild = validProposal({
      childQuestions: [{ question: "What about archives?" }],
    });
    expect(EvidenceCriticProposalSchema.safeParse(withChild).success).toBe(
      false,
    );
    // Validator path must surface CHILD_PROPOSAL_FORBIDDEN (not only schema miss).
    // Mutation-proofs the explicit smuggling-key guard in validateEvidenceCriticProposal.
    const result = validateEvidenceCriticProposal(withChild, {
      packet: packet(),
      requiredFacetIds: [...REQUIRED_FACETS],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("CHILD_PROPOSAL_FORBIDDEN");
  });

  it("rejects deferredQuestions / spawnedQuestions / answer free-text keys", () => {
    for (const bad of [
      { deferredQuestions: [{ question: "depth?" }] },
      { spawnedQuestions: ["q-child"] },
      { answer: "Final prose answer." },
      { depthFindings: ["What is the retention policy for archived units?"] },
    ]) {
      expect(
        EvidenceCriticProposalSchema.safeParse(validProposal(bad)).success,
      ).toBe(false);
      const result = validateEvidenceCriticProposal(validProposal(bad), {
        packet: packet(),
        requiredFacetIds: [...REQUIRED_FACETS],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("CHILD_PROPOSAL_FORBIDDEN");
    }
  });

  it("scaffold invalid-child fixture is REJECTED", async () => {
    const raw = await readFile(join(fixturesRoot, "invalid-child.json"), "utf8");
    const fixture = JSON.parse(raw) as unknown;
    const result = validateEvidenceCriticProposal(fixture, {
      packet: packet(),
      requiredFacetIds: [...REQUIRED_FACETS],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CHILD_PROPOSAL_FORBIDDEN");
    }
  });

  it("scaffold valid fixture is ACCEPTED when complete", async () => {
    const raw = await readFile(join(fixturesRoot, "valid.json"), "utf8");
    const fixture = JSON.parse(raw) as unknown;
    const result = validateEvidenceCriticProposal(fixture, {
      packet: packet(),
      requiredFacetIds: [...REQUIRED_FACETS],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe("accepted");
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("reason fields are length-bounded (not unbounded free text)", () => {
    const long = "x".repeat(EVIDENCE_CRITIC_LIMITS.maxReasonChars + 1);
    const tooLong = validProposal({
      referenceClassifications: [
        {
          unitId: UNIT_A,
          classification: "necessary_primary",
          reason: long,
        },
        {
          unitId: UNIT_Q,
          classification: "necessary_qualifying",
          reason: "ok",
        },
      ],
    });
    expect(EvidenceCriticProposalSchema.safeParse(tooLong).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fail closed: every material ref + required facet
// ---------------------------------------------------------------------------
describe("fail closed evaluation completeness", () => {
  it("UNEVALUATED_REFERENCE when a packet unitId lacks classification", () => {
    const incomplete = validProposal({
      referenceClassifications: [
        {
          unitId: UNIT_A,
          classification: "necessary_primary",
          reason: "Only primary classified.",
        },
        // UNIT_Q missing
      ],
    });
    const result = validateEvidenceCriticProposal(incomplete, {
      packet: packet(),
      requiredFacetIds: [...REQUIRED_FACETS],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNEVALUATED_REFERENCE");
  });

  it("UNEVALUATED_FACET when a required facet lacks a state", () => {
    const incomplete = validProposal({
      facetStates: [
        {
          facetId: "facet-definition",
          state: "satisfied",
          reason: "Only one facet.",
          sourceUnitIds: [UNIT_A],
        },
      ],
    });
    const result = validateEvidenceCriticProposal(incomplete, {
      packet: packet(),
      requiredFacetIds: [...REQUIRED_FACETS],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNEVALUATED_FACET");
  });

  it("positive control: complete classification + facets can accept", () => {
    const result = validateEvidenceCriticProposal(validProposal(), {
      packet: packet(),
      requiredFacetIds: [...REQUIRED_FACETS],
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// accepted is narrowest
// ---------------------------------------------------------------------------
describe("accepted verdict is narrowest", () => {
  it("partial / missing / conflicting facets never yield accepted", () => {
    for (const state of ["partial", "missing", "conflicting"] as const) {
      const bad = validProposal({
        facetStates: [
          {
            facetId: "facet-definition",
            state: "satisfied",
            reason: "ok",
            sourceUnitIds: [UNIT_A],
          },
          {
            facetId: "facet-constraint",
            state,
            reason: "not fully satisfied",
            sourceUnitIds: [UNIT_Q],
          },
        ],
        verdict: "accepted",
      });
      const result = validateEvidenceCriticProposal(bad, {
        packet: packet(),
        requiredFacetIds: [...REQUIRED_FACETS],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(["INVALID_VERDICT", "FACET_NOT_SATISFIED"]).toContain(
          result.code,
        );
      }
    }
  });

  it("unknown facet state fails closed (not fallthrough to accepted)", () => {
    const bad = validProposal({
      facetStates: [
        {
          facetId: "facet-definition",
          state: "satisfied",
          reason: "ok",
          sourceUnitIds: [UNIT_A],
        },
        {
          facetId: "facet-constraint",
          state: "totally_novel_state",
          reason: "unknown",
          sourceUnitIds: [UNIT_Q],
        },
      ],
      verdict: "accepted",
    });
    const result = validateEvidenceCriticProposal(bad, {
      packet: packet(),
      requiredFacetIds: [...REQUIRED_FACETS],
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Qualifier preservation (packet-authoritative)
// ---------------------------------------------------------------------------
describe("qualifier preservation against packet", () => {
  it("QUALIFIER_DROPPED when necessary_qualifying unit is absent from packet", () => {
    const pkt = packet({
      references: [
        {
          snapshotId: SNAP,
          fileId: FILE,
          unitId: UNIT_A,
          fileSha256: DIGEST,
          unitSha256: sha("a"),
          role: "primary",
          facetIds: ["facet-definition", "facet-constraint"],
        },
        // UNIT_Q dropped from packet while still classified as necessary_qualifying
      ],
    });
    const proposal = validProposal({
      referenceClassifications: [
        {
          unitId: UNIT_A,
          classification: "necessary_primary",
          reason: "primary",
        },
        {
          unitId: UNIT_Q,
          classification: "necessary_qualifying",
          reason: "qualifier claimed but not in packet",
        },
      ],
      facetStates: [
        {
          facetId: "facet-definition",
          state: "satisfied",
          reason: "ok",
          sourceUnitIds: [UNIT_A],
        },
        {
          facetId: "facet-constraint",
          state: "satisfied",
          reason: "claimed",
          sourceUnitIds: [UNIT_A],
        },
      ],
    });
    const result = validateEvidenceCriticProposal(proposal, {
      packet: pkt,
      requiredFacetIds: [...REQUIRED_FACETS],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["QUALIFIER_DROPPED", "UNEVALUATED_REFERENCE"]).toContain(
        result.code,
      );
    }
  });

  it("positive control: qualifying unit present in packet allows accepted", () => {
    const result = validateEvidenceCriticProposal(validProposal(), {
      packet: packet(),
      requiredFacetIds: [...REQUIRED_FACETS],
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Agent / barrel / limits
// ---------------------------------------------------------------------------
describe("runEvidenceCritic surface", () => {
  it("createEvidenceCriticAgent validates before return", async () => {
    expect(typeof createEvidenceCriticAgent).toBe("function");
    const agent = createEvidenceCriticAgent({
      propose: async () => validProposal(),
    });
    const result = await agent.runEvidenceCritic({
      questionId: QUESTION,
      question: "How does retry work?",
      facets: [...REQUIRED_FACETS],
      packet: packet(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe("accepted");
  });

  it("proposer that emits childQuestions is rejected", async () => {
    const agent = createEvidenceCriticAgent({
      propose: async () =>
        validProposal({
          childQuestions: [{ question: "What about retention?" }],
        }),
    });
    const result = await agent.runEvidenceCritic({
      questionId: QUESTION,
      question: "How?",
      facets: [...REQUIRED_FACETS],
      packet: packet(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CHILD_PROPOSAL_FORBIDDEN");
      expect(result.message).not.toContain("retention");
    }
  });

  it("public ingest/agents barrel exports createEvidenceCriticAgent", async () => {
    const barrel = await import("./index.js");
    expect(typeof barrel.createEvidenceCriticAgent).toBe("function");
    expect(typeof barrel.validateEvidenceCriticProposal).toBe("function");
  });

  it("EVIDENCE_CRITIC_LIMITS are positive", () => {
    expect(EVIDENCE_CRITIC_LIMITS.maxReasonChars).toBeGreaterThan(0);
    expect(EVIDENCE_CRITIC_LIMITS.maxReasonChars).toBeLessThanOrEqual(2_000);
  });
});

describe("type surface", () => {
  it("EvidenceCriticProposalSchema and factory exist", () => {
    expect(typeof EvidenceCriticProposalSchema?.safeParse).toBe("function");
    expect(typeof createEvidenceCriticAgent).toBe("function");
    const _p: EvidenceCriticProposal | undefined = undefined;
    const _e: EvidenceCriticError | undefined = undefined;
    void _p;
    void _e;
  });
});
