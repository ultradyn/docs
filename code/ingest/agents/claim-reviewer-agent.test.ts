/**
 * T-32-02 — Claim Reviewer (fresh-context, proposal-only).
 *
 * Negative tests include a positive control (near-identical valid proposal
 * accepted) so refuse-everything stubs cannot vacuous-pass.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Claim } from "../../domain/ingest/claim.js";
import type { EvidencePacket } from "../../domain/ingest/evidence-packet.js";
import type { ClaimId, Sha256, SourceUnitId } from "../../domain/ingest/types.js";
import {
  deliberatelyExposeUntrustedProseToModel,
  isUntrustedProse,
  type UntrustedProse,
} from "../../domain/ingest/untrusted-prose.js";
import { normaliseRunIdentity } from "../knowledge/claim-review-service.js";

import {
  CLAIM_REVIEWER_LIMITS,
  ClaimReviewerOutputSchema,
  createClaimReviewerAgent,
  loadClaimReviewerOutputSchema,
  validateClaimReviewerProposal,
  type ClaimReviewerProposeContext,
} from "./claim-reviewer-agent.js";
import * as agentsBarrel from "./index.js";

const scaffoldRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../scaffold/agents/claim-reviewer",
);
const fixturesRoot = join(scaffoldRoot, "fixtures");

const QUESTION = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PACKET = "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UNIT_A = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAA" as SourceUnitId;
const UNIT_B = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAB" as SourceUnitId;
const UNIT_OUT = "unit-01ARZ3NDEKTSV4RRFFQ69G5FZZ" as SourceUnitId;
const CLAIM_A = "clm-01ARZ3NDEKTSV4RRFFQ69G5FAV" as ClaimId;
const CLAIM_B = "clm-01ARZ3NDEKTSV4RRFFQ69G5FB0" as ClaimId;
const SNAP = `snap-${"b".repeat(64)}`;
const FILE = `file-${"c".repeat(64)}`;
const SHA = "a".repeat(64) as Sha256;
const EXTRACTOR = "run-extractor-01ARZ3NDEKTSV4RRFFQ69G5F";
const REVIEWER = "run-reviewer-01ARZ3NDEKTSV4RRFFQ69G5F";

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
    receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV" as EvidencePacket["receiptId"],
    receiptDigest: SHA as EvidencePacket["receiptDigest"],
    limits: { maxReferences: 256, maxFacetsPerReference: 32 },
  };
}

function sha(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}

function proposedClaim(
  id: ClaimId,
  overrides: Partial<Claim> & Record<string, unknown> = {},
): Claim {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    statement:
      "Atlas stores portable project knowledge in the Git repository.",
    claimType: "definition",
    scope: { product: "atlas" },
    authority: "source-doc",
    lifecycle: "current",
    state: "proposed",
    evidenceRefs: [
      {
        snapshotId: SNAP,
        fileId: FILE,
        unitId: UNIT_A,
        fileSha256: sha("file"),
        unitSha256: sha("unit"),
        verified: true,
      },
    ],
    relationships: {
      qualifierClaimIds: [],
      contradictsClaimIds: [],
      supersedesClaimIds: [],
    },
    createdFrom: { questionId: QUESTION, packetId: PACKET },
    ...overrides,
  } as Claim;
}

function acceptAxes(overrides: Record<string, unknown> = {}) {
  return {
    entailment: "entailed",
    atomicity: "atomic",
    scope: "compatible",
    qualifiers: "complete",
    authorityEligible: true,
    ...overrides,
  };
}

function reviewRow(
  claimId: ClaimId,
  overrides: Record<string, unknown> = {},
) {
  return {
    claimId,
    expectedVersion: 1,
    decision: "accept",
    ...acceptAxes(),
    reason: "Entailed by unit text.",
    evidenceUnitIds: [UNIT_A],
    ...overrides,
  };
}

function validOutput(
  reviews: unknown[] = [reviewRow(CLAIM_A)],
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1,
    packetId: PACKET,
    reviewerRunId: REVIEWER,
    extractorRunId: EXTRACTOR,
    reviews,
    ...overrides,
  };
}

function validateOpts(
  claims: readonly Claim[] = [proposedClaim(CLAIM_A)],
  pkt: EvidencePacket = packet(),
) {
  return {
    packet: pkt,
    claims,
    reviewerRunId: REVIEWER,
    extractorRunId: EXTRACTOR,
  };
}

describe("claim reviewer surface + limits", () => {
  it("validates a trivial fixture end-to-end (limits + schema + UntrustedProse)", () => {
    expect(CLAIM_REVIEWER_LIMITS.maxReviews).toBeGreaterThan(0);
    expect(ClaimReviewerOutputSchema.safeParse(validOutput()).success).toBe(
      true,
    );
    const result = validateClaimReviewerProposal(
      validOutput(),
      validateOpts(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reviews).toHaveLength(1);
    const reason = (result.value.reviews[0] as { reason?: UntrustedProse })
      .reason;
    expect(reason).toBeDefined();
    expect(isUntrustedProse(reason!)).toBe(true);
  });

  it("public agents barrel createClaimReviewerAgent runs validate path", async () => {
    expect(typeof agentsBarrel.createClaimReviewerAgent).toBe("function");
    const agent = agentsBarrel.createClaimReviewerAgent({
      propose: async () => validOutput(),
    });
    const result = await agent.runClaimReviewer({
      packet: packet(),
      claims: [proposedClaim(CLAIM_A)],
      reviewerRunId: REVIEWER,
      extractorRunId: EXTRACTOR,
    });
    expect(result.ok).toBe(true);
  });
});

describe("scaffold schema", () => {
  it("loads claim-reviewer output schema from scaffold", async () => {
    const schema = await loadClaimReviewerOutputSchema(scaffoldRoot);
    expect(schema).toMatchObject({ type: "object" });
  });

  it("scaffold valid / reject-overbroad / split fixtures are schema-shaped", async () => {
    for (const name of ["valid.json", "reject-overbroad.json", "split.json"]) {
      const raw = JSON.parse(
        await readFile(join(fixturesRoot, name), "utf8"),
      ) as unknown;
      expect(ClaimReviewerOutputSchema.safeParse(raw).success).toBe(true);
    }
  });
});

describe("executed goldens 001-003 (behavioural, not shape-only)", () => {
  async function loadGolden(caseId: string): Promise<{
    input: {
      packet: unknown;
      claims: readonly unknown[];
      reviewerRunId: string;
      extractorRunId: string;
    };
    expected: unknown;
  }> {
    const input = JSON.parse(
      await readFile(join(fixturesRoot, `${caseId}-input.json`), "utf8"),
    ) as {
      packet: unknown;
      claims: readonly unknown[];
      reviewerRunId: string;
      extractorRunId: string;
    };
    const expected = JSON.parse(
      await readFile(join(fixturesRoot, `${caseId}-expected.json`), "utf8"),
    ) as unknown;
    return { input, expected };
  }

  it("001 accept golden executes through validateClaimReviewerProposal", async () => {
    const { input, expected } = await loadGolden("001");
    const result = validateClaimReviewerProposal(expected, {
      packet: input.packet,
      claims: input.claims,
      reviewerRunId: input.reviewerRunId,
      extractorRunId: input.extractorRunId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reviews[0]?.decision).toBe("accept");
    expect(result.value.packetId).toBe(PACKET);
  });

  it("002 reject-overbroad golden executes (reject, not accept)", async () => {
    const { input, expected } = await loadGolden("002");
    const result = validateClaimReviewerProposal(expected, {
      packet: input.packet,
      claims: input.claims,
      reviewerRunId: input.reviewerRunId,
      extractorRunId: input.extractorRunId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reviews[0]?.decision).toBe("reject");
    // Same claim must not validate as accept-ready axes
    const forcedAccept = validateClaimReviewerProposal(
      {
        ...(expected as object),
        reviews: [
          {
            ...((expected as { reviews: unknown[] }).reviews[0] as object),
            decision: "accept",
            entailment: "entailed",
            atomicity: "atomic",
            scope: "compatible",
            qualifiers: "complete",
            authorityEligible: true,
          },
        ],
      },
      {
        packet: input.packet,
        claims: input.claims,
        reviewerRunId: input.reviewerRunId,
        extractorRunId: input.extractorRunId,
      },
    );
    expect(forcedAccept.ok).toBe(false);
  });

  it("003 split golden executes with splits retained on subject claimId", async () => {
    const { input, expected } = await loadGolden("003");
    const result = validateClaimReviewerProposal(expected, {
      packet: input.packet,
      claims: input.claims,
      reviewerRunId: input.reviewerRunId,
      extractorRunId: input.extractorRunId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.value.reviews[0]!;
    expect(row.decision).toBe("split");
    expect(row.claimId).toBe(CLAIM_A);
    expect(row.splits?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("happy path accept", () => {
  it("accepts a fully evaluated batch with accept-ready axes", () => {
    const result = validateClaimReviewerProposal(
      validOutput(),
      validateOpts(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reviews).toHaveLength(1);
    const row = result.value.reviews[0] as {
      decision: string;
      reason: UntrustedProse;
    };
    expect(row.decision).toBe("accept");
    expect(isUntrustedProse(row.reason)).toBe(true);
    expect(deliberatelyExposeUntrustedProseToModel(row.reason)).toBe(
      "Entailed by unit text.",
    );
  });
});

describe("UNEVALUATED_CLAIM fail closed", () => {
  it("refuses when a subject claim has no review row (silence ≠ approve)", () => {
    // Positive control: same two claims with both rows accepted
    const bothOk = validateClaimReviewerProposal(
      validOutput([reviewRow(CLAIM_A), reviewRow(CLAIM_B)]),
      validateOpts([proposedClaim(CLAIM_A), proposedClaim(CLAIM_B)]),
    );
    expect(bothOk.ok).toBe(true);

    const result = validateClaimReviewerProposal(
      validOutput([reviewRow(CLAIM_A)]),
      validateOpts([proposedClaim(CLAIM_A), proposedClaim(CLAIM_B)]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNEVALUATED_CLAIM");
  });

  it("mutation certifying: defaulting missing claims to accept must not pass", () => {
    const result = validateClaimReviewerProposal(
      validOutput([reviewRow(CLAIM_A)]),
      validateOpts([proposedClaim(CLAIM_A), proposedClaim(CLAIM_B)]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNEVALUATED_CLAIM");
  });
});

describe("overgeneralisation / reject", () => {
  it("cannot accept universal-behavior wording (overgeneralisation)", () => {
    const claim = proposedClaim(CLAIM_A, {
      statement: "All systems always retry forever under every condition.",
      claimType: "behavior",
    });
    // Positive control: non-universal statement accepts
    const ok = validateClaimReviewerProposal(
      validOutput([reviewRow(CLAIM_A)]),
      validateOpts([proposedClaim(CLAIM_A)]),
    );
    expect(ok.ok).toBe(true);

    const result = validateClaimReviewerProposal(
      validOutput([
        reviewRow(CLAIM_A, {
          decision: "accept",
          ...acceptAxes(),
        }),
      ]),
      validateOpts([claim]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_PROPOSAL");
  });

  it("reject-overbroad path: decision reject with adverse axes is valid", () => {
    const result = validateClaimReviewerProposal(
      validOutput([
        reviewRow(CLAIM_A, {
          decision: "reject",
          entailment: "not_entailed",
          atomicity: "overbroad",
          scope: "compatible",
          qualifiers: "complete",
          authorityEligible: false,
          reason: "Unsupported generalization.",
        }),
      ]),
      validateOpts(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value.reviews[0] as { decision: string }).decision).toBe(
      "reject",
    );
  });
});

describe("split with provenance", () => {
  it("accepts split decision with splits and subject claimId retained", () => {
    const result = validateClaimReviewerProposal(
      validOutput([
        reviewRow(CLAIM_A, {
          decision: "split",
          atomicity: "overbroad",
          entailment: "entailed",
          authorityEligible: true,
          splits: [
            {
              statement: "Atlas stores knowledge in Git.",
              claimType: "definition",
              scope: { product: "atlas" },
            },
            {
              statement: "Portable project state is repository-backed.",
              claimType: "definition",
              scope: { product: "atlas" },
            },
          ],
        }),
      ]),
      validateOpts(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.value.reviews[0]!;
    expect(row.decision).toBe("split");
    expect(row.claimId).toBe(CLAIM_A);
    expect(row.splits?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("split without splits array is INVALID_PROPOSAL", () => {
    // Positive control: same split with splits present
    const withSplits = validateClaimReviewerProposal(
      validOutput([
        reviewRow(CLAIM_A, {
          decision: "split",
          atomicity: "overbroad",
          splits: [
            {
              statement: "A",
              claimType: "definition",
              scope: {},
            },
          ],
        }),
      ]),
      validateOpts(),
    );
    expect(withSplits.ok).toBe(true);

    const result = validateClaimReviewerProposal(
      validOutput([
        reviewRow(CLAIM_A, {
          decision: "split",
          atomicity: "overbroad",
          splits: undefined,
        }),
      ]),
      validateOpts(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_PROPOSAL");
  });
});

describe("evidence fabrication gate", () => {
  it("UNSUPPORTED_EVIDENCE when evidenceUnitIds not in packet (whole batch)", () => {
    // Positive control: in-packet unit accepts both claims
    const ok = validateClaimReviewerProposal(
      validOutput([
        reviewRow(CLAIM_A, { evidenceUnitIds: [UNIT_A] }),
        reviewRow(CLAIM_B, { evidenceUnitIds: [UNIT_A] }),
      ]),
      validateOpts([proposedClaim(CLAIM_A), proposedClaim(CLAIM_B)]),
    );
    expect(ok.ok).toBe(true);

    const result = validateClaimReviewerProposal(
      validOutput([
        reviewRow(CLAIM_A, { evidenceUnitIds: [UNIT_OUT] }),
        reviewRow(CLAIM_B),
      ]),
      validateOpts([proposedClaim(CLAIM_A), proposedClaim(CLAIM_B)]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNSUPPORTED_EVIDENCE");
  });
});

describe("agent-layer SoD pin (caller-trusted)", () => {
  it("SEPARATION_OF_DUTIES when reviewerRunId ≡ extractorRunId after normalise", () => {
    // Positive control: distinct runs accept
    expect(
      validateClaimReviewerProposal(validOutput(), validateOpts()).ok,
    ).toBe(true);

    const same = "run-same-01ARZ3NDEKTSV4RRFFQ69G5F";
    const result = validateClaimReviewerProposal(
      validOutput([reviewRow(CLAIM_A)], {
        reviewerRunId: same,
        extractorRunId: same,
      }),
      {
        ...validateOpts(),
        reviewerRunId: same,
        extractorRunId: same,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SEPARATION_OF_DUTIES");
  });

  it("catches zero-width / NFKC collision via shared normaliseRunIdentity", () => {
    const base = "run-sod-01ARZ3NDEKTSV4RRFFQ69G5F";
    const sneaky = `\u200b${base}`;
    expect(normaliseRunIdentity(sneaky)).toBe(normaliseRunIdentity(base));
    const result = validateClaimReviewerProposal(
      validOutput([reviewRow(CLAIM_A)], {
        reviewerRunId: sneaky,
        extractorRunId: base,
      }),
      {
        ...validateOpts(),
        reviewerRunId: sneaky,
        extractorRunId: base,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SEPARATION_OF_DUTIES");
  });
});

describe("axis / decision consistency", () => {
  it("accept without entailed/atomic/compatible/authorityEligible is INVALID_PROPOSAL", () => {
    // Positive control: accept-ready axes
    expect(
      validateClaimReviewerProposal(validOutput(), validateOpts()).ok,
    ).toBe(true);

    const result = validateClaimReviewerProposal(
      validOutput([
        reviewRow(CLAIM_A, {
          decision: "accept",
          entailment: "not_entailed",
          authorityEligible: false,
        }),
      ]),
      validateOpts(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_PROPOSAL");
  });
});

describe("fresh context is structural", () => {
  it("propose context type has no extractorMessages / chat / transcript slot", () => {
    const context: ClaimReviewerProposeContext = {
      packet: packet(),
      claims: [proposedClaim(CLAIM_A)],
      reviewerRunId: REVIEWER,
      extractorRunId: EXTRACTOR,
    };
    expect("extractorMessages" in context).toBe(false);
    expect("chat" in context).toBe(false);
    expect("transcript" in context).toBe(false);
    function requireContext(c: ClaimReviewerProposeContext): void {
      void c;
    }
    // Object-literal excess property check: extractorMessages is not allowed.
    requireContext({
      packet: context.packet,
      claims: context.claims,
      reviewerRunId: context.reviewerRunId,
      extractorRunId: context.extractorRunId,
      // @ts-expect-error extractorMessages is not on ClaimReviewerProposeContext
      extractorMessages: [{ role: "assistant", content: "extractor private" }],
    });
  });

  it("runClaimReviewer propose spy never receives extractor message keys", async () => {
    const seen: unknown[] = [];
    const agent = createClaimReviewerAgent({
      propose: async (ctx) => {
        seen.push(ctx);
        return validOutput();
      },
    });
    const result = await agent.runClaimReviewer({
      packet: packet(),
      claims: [proposedClaim(CLAIM_A)],
      reviewerRunId: REVIEWER,
      extractorRunId: EXTRACTOR,
    });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    for (const ctx of seen) {
      expect(ctx).not.toHaveProperty("extractorMessages");
      expect(ctx).not.toHaveProperty("transcript");
    }
  });
});

describe("schema forbids child / accept-path smuggling", () => {
  it("rejects unknown keys and childQuestions on output", () => {
    // Positive control
    expect(
      validateClaimReviewerProposal(validOutput(), validateOpts()).ok,
    ).toBe(true);

    const result = validateClaimReviewerProposal(
      {
        ...validOutput(),
        childQuestions: ["should not"],
      },
      validateOpts(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_PROPOSAL");
  });
});
