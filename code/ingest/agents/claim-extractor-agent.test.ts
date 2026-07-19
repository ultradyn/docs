/**
 * T-32-01 — Claim Extractor (validate-only, Tier A).
 *
 * Schema goldens 001-003 are EXECUTED through validateClaimExtractorProposal
 * (same class as T-31-02 evidence-critic goldens) — not shape-only.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { EvidencePacket } from "../../domain/ingest/evidence-packet.js";
import type { SourceUnitId } from "../../domain/ingest/types.js";

import {
  CLAIM_EXTRACTOR_LIMITS,
  ClaimExtractorOutputSchema,
  ClaimProposalSchema,
  createClaimExtractorAgent,
  loadClaimExtractorOutputSchema,
  validateClaimExtractorProposal,
} from "./claim-extractor-agent.js";

const scaffoldRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../scaffold/agents/claim-extractor",
);
const fixturesRoot = join(scaffoldRoot, "fixtures");

const QUESTION = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PACKET = "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UNIT_A = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAA" as SourceUnitId;
const UNIT_B = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAB" as SourceUnitId;
const UNIT_OUT = "unit-01ARZ3NDEKTSV4RRFFQ69G5FZZ" as SourceUnitId;
const SNAP = `snap-${"b".repeat(64)}`;
const FILE = `file-${"c".repeat(64)}`;
const SHA = "a".repeat(64);
const RCPT = "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV";

function packet(
  unitIds: readonly SourceUnitId[] = [UNIT_A, UNIT_B],
): EvidencePacket {
  return {
    schemaVersion: 1,
    id: PACKET as EvidencePacket["id"],
    questionId: QUESTION as EvidencePacket["questionId"],
    version: 1,
    references: unitIds.map((unitId) => ({
      snapshotId: SNAP as EvidencePacket["references"][0]["snapshotId"],
      fileId: FILE as EvidencePacket["references"][0]["fileId"],
      unitId,
      fileSha256: SHA as EvidencePacket["references"][0]["fileSha256"],
      unitSha256: SHA as EvidencePacket["references"][0]["unitSha256"],
      role: "primary" as const,
      facetIds: ["facet-definition"],
    })),
    receiptId: RCPT as EvidencePacket["receiptId"],
    receiptDigest: SHA as EvidencePacket["receiptDigest"],
    limits: { maxReferences: 256, maxFacetsPerReference: 32 },
  };
}

function validClaim(overrides: Record<string, unknown> = {}) {
  return {
    text: "Atlas stores portable project knowledge in the Git repository.",
    type: "definition",
    scope: { product: "atlas" },
    authority: "source-doc",
    lifecycle: "current",
    evidenceReferenceIds: [UNIT_A],
    candidateRelationships: {},
    ...overrides,
  };
}

function validOutput(claims: unknown[] = [validClaim()]) {
  return { claims };
}

describe("schema surface", () => {
  it("exports limits and strict proposal schema", () => {
    expect(CLAIM_EXTRACTOR_LIMITS.maxClaims).toBeGreaterThan(0);
    expect(ClaimProposalSchema.safeParse(validClaim()).success).toBe(true);
    expect(
      ClaimProposalSchema.safeParse({
        ...validClaim(),
        state: "accepted",
      }).success,
    ).toBe(false);
    expect(
      ClaimProposalSchema.safeParse({
        ...validClaim(),
        id: "clm-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }).success,
    ).toBe(false);
    expect(
      ClaimProposalSchema.safeParse({
        ...validClaim(),
        childQuestions: ["x"],
      }).success,
    ).toBe(false);
  });
});

describe("fabrication / packet membership (whole-batch fail-closed)", () => {
  it("accepts claims whose unitIds are all in the packet", () => {
    const result = validateClaimExtractorProposal(validOutput(), {
      packet: packet(),
      verdictAccepted: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.evidenceReferenceIds).toEqual([UNIT_A]);
  });

  it("UNSUPPORTED_EVIDENCE when any claim cites a unit outside the packet", () => {
    const result = validateClaimExtractorProposal(
      validOutput([
        validClaim(),
        validClaim({
          text: "Invented claim.",
          evidenceReferenceIds: [UNIT_OUT],
        }),
      ]),
      { packet: packet([UNIT_A]), verdictAccepted: true },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNSUPPORTED_EVIDENCE");
  });

  it("does not silently drop unsupported claims (whole batch refused)", () => {
    const result = validateClaimExtractorProposal(
      validOutput([
        validClaim({ evidenceReferenceIds: [UNIT_A] }),
        validClaim({
          text: "Second claim with forged ref.",
          evidenceReferenceIds: [UNIT_OUT],
        }),
      ]),
      { packet: packet([UNIT_A]), verdictAccepted: true },
    );
    expect(result.ok).toBe(false);
    // No partial value
    expect("value" in result && result.ok).toBe(false);
  });
});

describe("verdict gate", () => {
  it("VERDICT_NOT_ACCEPTED when verdictAccepted is false", () => {
    const result = validateClaimExtractorProposal(validOutput(), {
      packet: packet(),
      verdictAccepted: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VERDICT_NOT_ACCEPTED");
  });
});

describe("overgeneralisation fixture", () => {
  it("rejects universal language on a strong type with a single evidence unit", () => {
    const result = validateClaimExtractorProposal(
      validOutput([
        validClaim({
          text: "All Atlas deployments always store knowledge only in memory.",
          type: "requirement",
          evidenceReferenceIds: [UNIT_A],
        }),
      ]),
      { packet: packet(), verdictAccepted: true },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_PROPOSAL");
  });

  it("rejects inferred intent prose as documented rationale", () => {
    const result = validateClaimExtractorProposal(
      validOutput([
        validClaim({
          text: "We believe the authors intended offline-first forever.",
          type: "rationale_documented",
          evidenceReferenceIds: [UNIT_A],
        }),
      ]),
      { packet: packet(), verdictAccepted: true },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_PROPOSAL");
  });
});

describe("agent runtime", () => {
  it("runClaimExtractor validates proposer output against packet", async () => {
    const agent = createClaimExtractorAgent({
      propose: async () => validOutput(),
    });
    const result = await agent.runClaimExtractor({
      questionId: QUESTION,
      packet: packet(),
      verdictAccepted: true,
    });
    expect(result.ok).toBe(true);
  });

  it("PROPOSER_FAILED when propose throws", async () => {
    const agent = createClaimExtractorAgent({
      propose: async () => {
        throw new Error("boom");
      },
    });
    const result = await agent.runClaimExtractor({
      questionId: QUESTION,
      packet: packet(),
      verdictAccepted: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PROPOSER_FAILED");
  });
});

describe("scaffold", () => {
  it("loads claim-extractor JSON schema", async () => {
    const schema = await loadClaimExtractorOutputSchema(scaffoldRoot);
    expect(schema).toBeTypeOf("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("valid fixture parses under ClaimExtractorOutputSchema", async () => {
    const raw = JSON.parse(
      await readFile(join(fixturesRoot, "valid.json"), "utf8"),
    );
    expect(ClaimExtractorOutputSchema.safeParse(raw).success).toBe(true);
    const result = validateClaimExtractorProposal(raw, {
      packet: packet([UNIT_A]),
      verdictAccepted: true,
    });
    expect(result.ok).toBe(true);
  });

  it("invalid-generalisation fixture is refused", async () => {
    const raw = JSON.parse(
      await readFile(
        join(fixturesRoot, "invalid-generalisation.json"),
        "utf8",
      ),
    );
    const result = validateClaimExtractorProposal(raw, {
      packet: packet([UNIT_A]),
      verdictAccepted: true,
    });
    expect(result.ok).toBe(false);
  });
});

describe("schema goldens 001-003 executed (not shape-only)", () => {
  /**
   * Contract: each N-expected proposal must validate against its N-input
   * packet with ok:true. Shape-only registry pins (validateAgentFixtures)
   * do not cover this — corruption of unitId stays schema-legal.
   */
  it("executes 001-003 through validateClaimExtractorProposal against contract packets", async () => {
    for (const n of ["001", "002", "003"] as const) {
      const input = JSON.parse(
        await readFile(join(fixturesRoot, `${n}-input.json`), "utf8"),
      ) as {
        packet: unknown;
        verdictAccepted: boolean;
      };
      const expected = JSON.parse(
        await readFile(join(fixturesRoot, `${n}-expected.json`), "utf8"),
      ) as { claims: unknown[] };

      expect(ClaimExtractorOutputSchema.safeParse(expected).success).toBe(
        true,
      );
      expect(input.verdictAccepted).toBe(true);

      const result = validateClaimExtractorProposal(expected, {
        packet: input.packet,
        verdictAccepted: input.verdictAccepted,
      });
      expect(result.ok, `${n}-expected must pass fabrication gate`).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(expected.claims.length);
      // Pin unitIds from the golden, not merely non-empty.
      const allowed = new Set(
        (input.packet as EvidencePacket).references.map((r) => r.unitId),
      );
      for (const claim of result.value) {
        for (const unitId of claim.evidenceReferenceIds) {
          expect(allowed.has(unitId), `${n} unit ${unitId} in packet`).toBe(
            true,
          );
        }
      }
    }
  });

  it("schema-legal corruption fails behavioural gate while shape pin still passes", async () => {
    const input = JSON.parse(
      await readFile(join(fixturesRoot, "001-input.json"), "utf8"),
    ) as { packet: unknown; verdictAccepted: boolean };
    const expected = JSON.parse(
      await readFile(join(fixturesRoot, "001-expected.json"), "utf8"),
    ) as {
      claims: Array<Record<string, unknown>>;
    };

    // Schema-legal wrong value: different text + unit outside the packet.
    const corrupted = {
      claims: [
        {
          ...expected.claims[0],
          text: "Schema-legal fabricated claim that cites a missing unit.",
          evidenceReferenceIds: [UNIT_OUT],
        },
      ],
    };

    // Shape pin (registry / ClaimExtractorOutputSchema) still passes.
    expect(ClaimExtractorOutputSchema.safeParse(corrupted).success).toBe(true);

    // Behavioural execution fails closed on fabrication.
    const result = validateClaimExtractorProposal(corrupted, {
      packet: input.packet,
      verdictAccepted: input.verdictAccepted,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNSUPPORTED_EVIDENCE");
  });
});

describe("barrel", () => {
  it("agents index exports claim extractor surface", async () => {
    const barrel = await import("./index.js");
    expect(typeof barrel.createClaimExtractorAgent).toBe("function");
    expect(typeof barrel.validateClaimExtractorProposal).toBe("function");
  });
});
