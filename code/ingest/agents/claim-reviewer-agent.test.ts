/**
 * T-32-02 — Claim Reviewer (fresh-context, proposal-only).
 *
 * RED checkpoint: behavioral expectations before GREEN implementation.
 */
import { createHash } from "node:crypto";
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
  it("exports positive limits and validate/create helpers", () => {
    expect(CLAIM_REVIEWER_LIMITS.maxReviews).toBeGreaterThan(0);
    expect(typeof validateClaimReviewerProposal).toBe("function");
    expect(typeof createClaimReviewerAgent).toBe("function");
  });

  it("public agents barrel exports createClaimReviewerAgent", () => {
    expect(typeof agentsBarrel.createClaimReviewerAgent).toBe("function");
  });
});

describe("scaffold schema", () => {
  it("loads claim-reviewer output schema from scaffold", async () => {
    const schema = await loadClaimReviewerOutputSchema(scaffoldRoot);
    expect(schema).toMatchObject({ type: "object" });
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
    const result = validateClaimReviewerProposal(
      validOutput([reviewRow(CLAIM_A)]),
      validateOpts([proposedClaim(CLAIM_A), proposedClaim(CLAIM_B)]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNEVALUATED_CLAIM");
  });

  it("mutation certifying: defaulting missing claims to accept must not pass", () => {
    // If GREEN accidentally treats missing reviews as accept, this batch of two
    // claims with one review must still fail closed.
    const result = validateClaimReviewerProposal(
      validOutput([reviewRow(CLAIM_A)]),
      validateOpts([proposedClaim(CLAIM_A), proposedClaim(CLAIM_B)]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).not.toBeUndefined();
    expect(result.code).toBe("UNEVALUATED_CLAIM");
  });
});

describe("overgeneralisation / reject", () => {
  it("cannot accept universal-behavior wording (overgeneralisation)", () => {
    const claim = proposedClaim(CLAIM_A, {
      statement: "All systems always retry forever under every condition.",
      claimType: "behavior",
    });
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
    expect(["INVALID_PROPOSAL", "UNEVALUATED_CLAIM"]).not.toContain(
      "accept",
    );
    // Accept of overgeneralisation is refused
    expect(result.code).toMatch(/INVALID_PROPOSAL|UNSUPPORTED|UNEVALUATED/);
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
    const row = result.value.reviews[0] as {
      decision: string;
      claimId: string;
      splits: unknown[];
    };
    expect(row.decision).toBe("split");
    expect(row.claimId).toBe(CLAIM_A);
    expect(row.splits.length).toBeGreaterThanOrEqual(2);
  });

  it("split without splits array is INVALID_PROPOSAL", () => {
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
    // @ts-expect-error propose context must not accept extractor transcript
    const bad: ClaimReviewerProposeContext = {
      ...context,
      extractorMessages: [{ role: "assistant", content: "extractor private" }],
    };
    void bad;
  });

  it("runClaimReviewer propose spy never receives extractor message keys", async () => {
    const seen: unknown[] = [];
    const agent = createClaimReviewerAgent({
      propose: async (ctx) => {
        seen.push(ctx);
        return validOutput();
      },
    });
    await agent.runClaimReviewer({
      packet: packet(),
      claims: [proposedClaim(CLAIM_A)],
      reviewerRunId: REVIEWER,
      extractorRunId: EXTRACTOR,
    });
    // After GREEN, propose is called and must not include extractor messages.
    // RED stub may not call propose — either way, no extractor message key.
    for (const ctx of seen) {
      expect(ctx).not.toHaveProperty("extractorMessages");
      expect(ctx).not.toHaveProperty("transcript");
    }
  });
});

describe("schema forbids child / accept-path smuggling", () => {
  it("rejects unknown keys and childQuestions on output", () => {
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
