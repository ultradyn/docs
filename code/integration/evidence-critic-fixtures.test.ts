/**
 * T-31-02 — Decisive evidence-criticism fixtures (RED-first).
 *
 * Every named fixture is EXECUTED via validateEvidenceCriticProposal.
 * Schema goldens 001-003 are documented as non-behavioural (see fixtures/README.md).
 *
 * Thresholds require non-zero denominators (vacuous 0/0 is a FAIL).
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveShippedPath } from "../shared/shipped-layout.js";
import {
  EVIDENCE_CRITIC_NAMED_CASES,
  EvidenceCriticThresholds,
  createEvidenceCriticFixtureProposer,
  executeSchemaGoldenProposal,
  loadNamedEvidenceCriticFixtures,
  measureEvidenceCriticThresholds,
  runEvidenceCriticFixtureCase,
  type EvidenceCriticFixtureCase,
} from "./evidence-critic-fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const fixturesRoot = resolveShippedPath(
  repoRoot,
  "agents",
  "evidence-critic",
  "fixtures",
);

describe("named criticism fixtures exist and are complete", () => {
  it("loads every plan-named case with packet, proposal, and expected", async () => {
    const cases = await loadNamedEvidenceCriticFixtures(fixturesRoot);
    const ids = cases.map((c) => c.caseId);
    for (const name of EVIDENCE_CRITIC_NAMED_CASES) {
      expect(ids).toContain(name);
    }
    expect(ids).toContain("complete-minimal");
    expect(ids).toContain("complete-minimal-b");
    for (const c of cases) {
      expect(c.packet).toBeTypeOf("object");
      expect(Array.isArray(c.requiredFacetIds)).toBe(true);
      expect(c.requiredFacetIds.length).toBeGreaterThan(0);
      expect(c.proposal).toBeTypeOf("object");
      expect(c.expected).toBeTypeOf("object");
      expect(
        c.kind === "weak" ||
          c.kind === "complete_minimal" ||
          c.kind === "injection",
      ).toBe(true);
    }
  });
});

describe("every named fixture is EXECUTED (not merely parsed)", () => {
  it("runEvidenceCriticFixtureCase matches hand-authored expected for each case", async () => {
    const cases = await loadNamedEvidenceCriticFixtures(fixturesRoot);
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      const result = runEvidenceCriticFixtureCase(c);
      expect(result.matched, `case ${c.caseId} mismatch: ${result.detail}`).toBe(
        true,
      );
    }
  });

  it("covers fail-closed codes among named fixtures", async () => {
    const cases = await loadNamedEvidenceCriticFixtures(fixturesRoot);
    const codes = new Set(
      cases
        .filter(
          (
            c,
          ): c is EvidenceCriticFixtureCase & {
            expected: { ok: false; code: string };
          } => c.expected.ok === false,
        )
        .map((c) => c.expected.code),
    );
    for (const required of [
      "UNEVALUATED_REFERENCE",
      "UNEVALUATED_FACET",
      "QUALIFIER_DROPPED",
      "CHILD_PROPOSAL_FORBIDDEN",
    ] as const) {
      expect(codes.has(required), `missing fail-closed fixture for ${required}`).toBe(
        true,
      );
    }
  });

  it("no accepted fixture encodes a child proposal key", async () => {
    const cases = await loadNamedEvidenceCriticFixtures(fixturesRoot);
    for (const c of cases) {
      if (c.expected.ok !== true) continue;
      const proposal = c.proposal as Record<string, unknown>;
      for (const bad of [
        "childQuestions",
        "deferredQuestions",
        "spawnedQuestions",
        "depthFindings",
      ]) {
        expect(proposal[bad], `${c.caseId} must not accept with ${bad}`).toBeUndefined();
      }
    }
  });
});

describe("EvidenceCriticThresholds (non-vacuous denominators)", () => {
  it("exports pinned thresholds and measures matching values", async () => {
    expect(EvidenceCriticThresholds.weakPacketAcceptance).toBe(0);
    expect(EvidenceCriticThresholds.completeMinimalAcceptance).toBe(1);
    expect(EvidenceCriticThresholds.injectionRoleChanges).toBe(0);
    // Denominators must be positive — vacuous 0/0 is forbidden
    expect(EvidenceCriticThresholds.weakPacketCount).toBeGreaterThan(0);
    expect(EvidenceCriticThresholds.completeMinimalCount).toBeGreaterThan(0);
    expect(EvidenceCriticThresholds.injectionCaseCount).toBeGreaterThan(0);

    const cases = await loadNamedEvidenceCriticFixtures(fixturesRoot);
    const measured = measureEvidenceCriticThresholds(cases);
    expect(measured.weakPacketCount).toBe(
      EvidenceCriticThresholds.weakPacketCount,
    );
    expect(measured.completeMinimalCount).toBe(
      EvidenceCriticThresholds.completeMinimalCount,
    );
    expect(measured.injectionCaseCount).toBe(
      EvidenceCriticThresholds.injectionCaseCount,
    );
    expect(measured.weakPacketAcceptance).toBe(0);
    expect(measured.completeMinimalAcceptance).toBe(1);
    expect(measured.injectionRoleChanges).toBe(0);
  });
});

describe("fake proposer registry", () => {
  it("unregistered fixture case fails closed (plan RED language)", async () => {
    const propose = createEvidenceCriticFixtureProposer({
      // empty registry on purpose
    });
    await expect(
      propose({
        questionId: "q-01ARZ3NDEKTSV4RRFFQ69G5FAV",
        question: "How?",
        facets: ["facet-definition"],
        packet: { id: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV" },
        caseId: "not-a-registered-case",
      }),
    ).rejects.toThrow(/unregistered/i);
  });
});

describe("schema goldens honesty (001-003)", () => {
  it("fixtures README documents that 001-003 are schema-only by pin", async () => {
    const readme = await readFile(join(fixturesRoot, "README.md"), "utf8");
    expect(readme).toMatch(/no behavioural guarantee/i);
    expect(readme).toMatch(/validateAgentFixtures/);
    expect(readme).toMatch(/001/);
    expect(readme).toMatch(/deliberate corruption/i);
  });

  it("executes 001-003 expected proposals through validateEvidenceCriticProposal", async () => {
    // REQUIRED 1: goldens executed against contract-correct verdict pins.
    // Asserting only result.verdict === file.verdict would still pass after corruption.
    const cases = await loadNamedEvidenceCriticFixtures(fixturesRoot);
    const complete = cases.find((c) => c.caseId === "complete-minimal");
    expect(complete).toBeDefined();
    const packet = complete!.packet;
    const facets = complete!.requiredFacetIds;

    const contractVerdict: Record<string, string> = {
      "001": "accepted",
      "002": "needs_more_evidence",
      "003": "conflicting_or_deprecated",
    };
    for (const n of ["001", "002", "003"] as const) {
      const proposal = JSON.parse(
        await readFile(join(fixturesRoot, `${n}-expected.json`), "utf8"),
      ) as { verdict: string };
      expect(proposal.verdict).toBe(contractVerdict[n]);
      const result = executeSchemaGoldenProposal(proposal, packet, facets);
      expect(result.ok, `${n}-expected should validate`).toBe(true);
      expect(result.verdict).toBe(contractVerdict[n]);
    }
  });

});