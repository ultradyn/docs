/**
 * T-30-02 — Researcher agent contract (RED-first).
 *
 * Invariants (acceptance criteria, not features):
 * 1) Final-answer prose and child questions are SCHEMA-IMPOSSIBLE.
 * 2) outcome no_evidence requires a sufficient healthy receipt.
 * 3) Minimal-complete references for critic inspection PASS.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveShippedPath } from "../../shared/shipped-layout.js";
import {
  RESEARCHER_LIMITS,
  ResearcherProposalSchema,
  createResearcherAgent,
  loadResearcherOutputSchema,
  runResearcher,
  validateResearcherProposal,
  type ResearcherProposal,
} from "./researcher-agent.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const scaffoldRoot = resolveShippedPath(repoRoot, "agents", "researcher");
const fixturesRoot = join(scaffoldRoot, "fixtures");

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const SNAP = `snap-${"b".repeat(64)}`;
const FILE = `file-${"a".repeat(64)}`;
const UNIT = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const QUESTION = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RCPT = "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DIGEST = "a".repeat(64);

function minimalReference(overrides: Record<string, unknown> = {}) {
  return {
    snapshotId: SNAP,
    fileId: FILE,
    unitId: UNIT,
    fileSha256: DIGEST,
    unitSha256: sha("unit"),
    role: "primary",
    facetIds: ["facet-definition"],
    ...overrides,
  };
}

function healthyReceipt(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    id: RCPT,
    snapshotId: SNAP,
    indexVersion: "lexical-v1",
    indexedRepresentationsSha256: DIGEST,
    query: "how does auth work",
    filters: {},
    candidateIds: [UNIT],
    selectedIds: [UNIT],
    failures: [] as string[],
    ...overrides,
  };
}

function packetProposal(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    questionId: QUESTION,
    outcome: "packet",
    receiptIds: [RCPT],
    packet: {
      references: [minimalReference()],
      facetSupport: [{ facetId: "facet-definition", referenceCount: 1 }],
      limits: { maxReferences: 32, maxFacetsPerReference: 8 },
    },
    ...overrides,
  };
}

function noEvidenceProposal(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    questionId: QUESTION,
    outcome: "no_evidence",
    receiptIds: [RCPT],
    packet: {
      references: [],
      facetSupport: [],
      limits: { maxReferences: 32, maxFacetsPerReference: 8 },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// schema impossibility (AC1)
// ---------------------------------------------------------------------------
describe("schema impossibility — no final answer / no child questions", () => {
  it("exports ResearcherProposalSchema and rejects free-text answer fields", () => {
    expect(typeof ResearcherProposalSchema?.safeParse).toBe("function");
    const withAnswer = packetProposal({ answer: "Auth works like this..." });
    expect(ResearcherProposalSchema.safeParse(withAnswer).success).toBe(false);

    const withFinal = packetProposal({ finalAnswer: "Done." });
    expect(ResearcherProposalSchema.safeParse(withFinal).success).toBe(false);

    const withProse = packetProposal({ prose: "narrative" });
    expect(ResearcherProposalSchema.safeParse(withProse).success).toBe(false);
  });

  it("rejects child / spawned question fields", () => {
    const withChild = packetProposal({
      childQuestions: [{ question: "What about refresh tokens?" }],
    });
    expect(ResearcherProposalSchema.safeParse(withChild).success).toBe(false);

    const withSpawn = packetProposal({
      spawnedQuestions: ["q-child"],
    });
    expect(ResearcherProposalSchema.safeParse(withSpawn).success).toBe(false);

    const withDeferred = packetProposal({
      deferredQuestions: [{ question: "depth?" }],
    });
    expect(ResearcherProposalSchema.safeParse(withDeferred).success).toBe(
      false,
    );
  });

  it("scaffold invalid-answer fixture is REJECTED by output schema", async () => {
    const raw = await readFile(
      join(fixturesRoot, "invalid-answer.json"),
      "utf8",
    );
    const fixture = JSON.parse(raw) as unknown;
    const schema = await loadResearcherOutputSchema(scaffoldRoot);
    expect(schema).toBeDefined();
    const result = validateResearcherProposal(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_PROPOSAL");
  });

  it("scaffold invalid-child fixture is REJECTED by output schema", async () => {
    const raw = await readFile(
      join(fixturesRoot, "invalid-child.json"),
      "utf8",
    );
    const fixture = JSON.parse(raw) as unknown;
    const result = validateResearcherProposal(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_PROPOSAL");
  });

  it("scaffold valid fixture is ACCEPTED", async () => {
    const raw = await readFile(join(fixturesRoot, "valid.json"), "utf8");
    const fixture = JSON.parse(raw) as unknown;
    const result = validateResearcherProposal(fixture, {
      receipts: [healthyReceipt()],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("packet");
    expect(result.value.packet.references.length).toBeGreaterThan(0);
    expect(Object.isFrozen(result.value)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// no_evidence requires healthy receipt (AC2)
// ---------------------------------------------------------------------------
describe("no_evidence requires sufficient healthy receipt", () => {
  it("no_evidence without receiptIds FAILS", () => {
    const raw = noEvidenceProposal({ receiptIds: [] });
    const result = validateResearcherProposal(raw, { receipts: [] });
    expect(result.ok).toBe(false);
    // Schema requires minItems:1 on receiptIds — structural, not soft policy.
    if (!result.ok) expect(result.code).toBe("INVALID_PROPOSAL");
  });

  it("no_evidence with receiptIds but no healthy receipt material FAILS", () => {
    const raw = noEvidenceProposal({ receiptIds: [RCPT] });
    // receipts map empty — cannot prove search ran
    const result = validateResearcherProposal(raw, { receipts: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INSUFFICIENT_RECEIPT");
  });

  it("no_evidence with a sufficient healthy receipt PASSES", () => {
    const raw = noEvidenceProposal();
    const result = validateResearcherProposal(raw, {
      receipts: [healthyReceipt()],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("no_evidence");
    expect(result.value.receiptIds).toContain(RCPT);
    expect(result.value.packet.references).toHaveLength(0);
  });

  it("unhealthy receipt (missing required search fields) is not sufficient", () => {
    const raw = noEvidenceProposal();
    const broken = {
      schemaVersion: 1,
      id: RCPT,
      // missing snapshot/index/query — not a search proof
    };
    const result = validateResearcherProposal(raw, {
      receipts: [broken as never],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INSUFFICIENT_RECEIPT");
  });
});

// ---------------------------------------------------------------------------
// minimal complete references (AC3)
// ---------------------------------------------------------------------------
describe("references minimal but complete", () => {
  it("valid minimal-complete reference packet PASSES", () => {
    const raw = packetProposal();
    const result = validateResearcherProposal(raw, {
      receipts: [healthyReceipt()],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ref = result.value.packet.references[0]!;
    expect(ref.snapshotId).toMatch(/^snap-/);
    expect(ref.fileId).toMatch(/^file-/);
    expect(ref.unitId).toMatch(/^unit-/);
    expect(ref.fileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(ref.unitSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(["primary", "supporting"]).toContain(ref.role);
    expect(ref.facetIds.length).toBeGreaterThan(0);
  });

  it("packet outcome with empty references FAILS", () => {
    const raw = packetProposal({
      packet: {
        references: [],
        facetSupport: [],
        limits: { maxReferences: 32, maxFacetsPerReference: 8 },
      },
    });
    const result = validateResearcherProposal(raw, {
      receipts: [healthyReceipt()],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_PROPOSAL");
  });

  it("reference missing unitSha256 FAILS", () => {
    const ref = minimalReference();
    delete (ref as { unitSha256?: string }).unitSha256;
    const raw = packetProposal({
      packet: {
        references: [ref],
        facetSupport: [{ facetId: "facet-definition", referenceCount: 1 }],
        limits: { maxReferences: 32, maxFacetsPerReference: 8 },
      },
    });
    const result = validateResearcherProposal(raw, {
      receipts: [healthyReceipt()],
    });
    expect(result.ok).toBe(false);
  });

  it("respects RESEARCHER_LIMITS bounds", () => {
    expect(RESEARCHER_LIMITS.maxReferences).toBeGreaterThan(0);
    expect(RESEARCHER_LIMITS.maxReceiptIds).toBeGreaterThan(0);
    const tooMany = Array.from(
      { length: RESEARCHER_LIMITS.maxReferences + 1 },
      (_, i) =>
        minimalReference({
          unitId:
            `unit-01ARZ3NDEKTSV4RRFFQ69G5F${String(i).padStart(2, "0").slice(-2)}A`.slice(
              0,
              31,
            ),
          unitSha256: sha(`u-${i}`),
        }),
    );
    // Use valid unit ids — simpler: oversize facetSupport array instead
    const raw = packetProposal({
      packet: {
        references: [minimalReference()],
        facetSupport: Array.from(
          { length: RESEARCHER_LIMITS.maxFacetSupport + 1 },
          (_, i) => ({ facetId: `f-${i}`, referenceCount: 1 }),
        ),
        limits: { maxReferences: 32, maxFacetsPerReference: 8 },
      },
    });
    const result = validateResearcherProposal(raw, {
      receipts: [healthyReceipt()],
    });
    expect(result.ok).toBe(false);
    void tooMany;
  });
});

// ---------------------------------------------------------------------------
// runResearcher + hygiene
// ---------------------------------------------------------------------------
describe("runResearcher surface", () => {
  it("createResearcherAgent / runResearcher validate before return", async () => {
    expect(typeof createResearcherAgent).toBe("function");
    expect(typeof runResearcher).toBe("function");

    const agent = createResearcherAgent({
      // Deterministic test proposer — production uses provider; tests inject.
      propose: async () => packetProposal(),
    });
    const result = await agent.runResearcher({
      questionId: QUESTION,
      question: "How does auth work?",
      receipts: [healthyReceipt()],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.questionId).toBe(QUESTION);
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("runResearcher rejects a proposer that emits answer prose", async () => {
    const agent = createResearcherAgent({
      propose: async () =>
        packetProposal({ answer: "Here is the final answer." }),
    });
    const result = await agent.runResearcher({
      questionId: QUESTION,
      question: "How?",
      receipts: [healthyReceipt()],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_PROPOSAL");
      // fixed message — no answer text interpolated
      expect(result.message).not.toContain("final answer");
    }
  });

  it("runResearcher rejects no_evidence without healthy receipt context", async () => {
    const agent = createResearcherAgent({
      propose: async () => noEvidenceProposal(),
    });
    const result = await agent.runResearcher({
      questionId: QUESTION,
      question: "How?",
      receipts: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INSUFFICIENT_RECEIPT");
  });

  it("hostile input accessors are rejected without evaluating getters", async () => {
    const agent = createResearcherAgent({
      propose: async () => packetProposal(),
    });
    const hostile: Record<string, unknown> = {
      questionId: QUESTION,
    };
    Object.defineProperty(hostile, "question", {
      enumerable: true,
      get() {
        throw new Error("hostile");
      },
    });
    const result = await agent.runResearcher(hostile as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
  });

  it("public ingest/agents barrel exports createResearcherAgent", async () => {
    const barrel = await import("./index.js");
    expect(typeof barrel.createResearcherAgent).toBe("function");
    expect(typeof barrel.validateResearcherProposal).toBe("function");
  });
});

// Type pin: ensure ResearcherProposal is a real export with outcome field.
describe("type surface", () => {
  it("ResearcherProposalSchema describes outcome enum packet|no_evidence", () => {
    expect(typeof ResearcherProposalSchema?.safeParse).toBe("function");
    const parsed = ResearcherProposalSchema.safeParse(packetProposal());
    // At RED this fails (schema missing). At GREEN a valid packet must parse.
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(["packet", "no_evidence"]).toContain(
        (parsed.data as ResearcherProposal).outcome,
      );
    }
  });
});
