/**
 * T-60-02 — Answer Composer RED-first.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Claim } from "../../domain/ingest/claim.js";
import type { SealedClaimPack } from "../../domain/ingest/sealed-claim-pack.js";
import type { ClaimId, GraphRevision, Sha256 } from "../../domain/ingest/types.js";
import { INGEST_ROLE_TOOL_ALLOWLIST } from "../../agents/ingest-manifest.js";
import { validateIngestManifests } from "../../agents/ingest-manifest.js";

import {
  StructuredAnswerCompatibility,
  composeAnswerFromPack,
  validateAnswerComposition,
} from "./answer-composer-agent.js";

const QUESTION = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CLM_A = "clm-01ARZ3NDEKTSV4RRFFQ69G5FAA" as ClaimId;
const CLM_B = "clm-01ARZ3NDEKTSV4RRFFQ69G5FAB" as ClaimId;
const CLM_OUT = "clm-01ARZ3NDEKTSV4RRFFQ69G5FZZ" as ClaimId;
const PACK_HASH = "a".repeat(64) as Sha256;

function sha(s: string): Sha256 {
  return createHash("sha256").update(s).digest("hex") as Sha256;
}

function claim(id: ClaimId, statement: string): Claim {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    statement,
    claimType: "behavior",
    scope: { product: "atlas" },
    authority: "source-doc",
    lifecycle: "current",
    state: "accepted",
    evidenceRefs: [
      {
        snapshotId: `snap-${"b".repeat(64)}`,
        fileId: `file-${"c".repeat(64)}`,
        unitId: "unit-01ARZ3NDEKTSV4RRFFQ69G5FAA",
        fileSha256: sha("f"),
        unitSha256: sha("u"),
      },
    ],
    relationships: {
      qualifierClaimIds: [],
      contradictsClaimIds: [],
      supersedesClaimIds: [],
    },
    createdFrom: { questionId: QUESTION, packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV" },
  };
}

function pack(
  claims: Claim[] = [
    claim(CLM_A, "Atlas stores portable project knowledge in Git."),
    claim(CLM_B, "Settings apply through the documented procedure."),
  ],
  hash: Sha256 = PACK_HASH,
): SealedClaimPack {
  return {
    schemaVersion: 1,
    hash,
    questionId: QUESTION,
    graphRevision: 1 as GraphRevision,
    claimIds: claims.map((c) => c.id),
    claims,
    qualifierEdges: [],
    citations: claims.map((c) => ({
      claimId: c.id,
      unitId: c.evidenceRefs[0]!.unitId,
      unitSha256: c.evidenceRefs[0]!.unitSha256,
      fileSha256: c.evidenceRefs[0]!.fileSha256,
      snapshotId: c.evidenceRefs[0]!.snapshotId,
    })),
    gaps: [],
  };
}

describe("structural pack-only (no tools)", () => {
  it("answer-composer tool allowlist is empty", () => {
    expect(INGEST_ROLE_TOOL_ALLOWLIST["answer-composer"]).toEqual([]);
  });

  it("manifest granting a retrieval tool is TOOL_DENIED", () => {
    const result = validateIngestManifests([
      {
        role: "answer-composer",
        outputSchema: "AnswerComposition",
        tools: ["web.search"],
        freshContext: true,
        next: [],
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("TOOL_DENIED");
  });
});

describe("composeAnswerFromPack (deterministic)", () => {
  it("selects and orders pack statements for covered goals", async () => {
    const p = pack();
    const result = composeAnswerFromPack({
      questionId: QUESTION,
      pack: p,
      goals: [
        { goalId: "g-storage", text: "Where is knowledge stored?" },
        { goalId: "g-settings", text: "How are settings applied?" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("proposed");
    expect(result.value.claimPackHash).toBe(p.hash);
    expect(result.value.answer.length).toBeGreaterThan(0);
    // Answer text is only pack statements (no invented prose).
    expect(result.value.answer).toContain(p.claims[0]!.statement);
    expect(result.value.sentenceClaims.every((s) => s.claimIds.length >= 1)).toBe(
      true,
    );
    for (const s of result.value.sentenceClaims) {
      for (const id of s.claimIds) {
        expect(p.claimIds).toContain(id);
      }
    }
  });

  it("same pack, different goals → different composition ids", () => {
    const p = pack();
    const a = composeAnswerFromPack({
      questionId: QUESTION,
      pack: p,
      goals: [{ goalId: "g1", text: "storage" }],
    });
    const b = composeAnswerFromPack({
      questionId: QUESTION,
      pack: p,
      goals: [{ goalId: "g2", text: "settings" }],
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.id).not.toBe(b.value.id);
    expect(a.value.claimPackHash).toBe(b.value.claimPackHash);
  });

  it("insufficient_pack: empty answer, zero sentenceClaims, limitations list", () => {
    const p = pack([claim(CLM_A, "Only about storage in Git.")]);
    const result = composeAnswerFromPack({
      questionId: QUESTION,
      pack: p,
      goals: [
        {
          goalId: "g-unrelated",
          text: "What is the quantum entanglement protocol for payments?",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("insufficient_pack");
    expect(result.value.answer).toBe("");
    expect(result.value.sentenceClaims).toHaveLength(0);
    expect(result.value.limitations.length).toBeGreaterThan(0);
    expect(result.value.limitations.some((l) => /g-unrelated|quantum|support/i.test(l))).toBe(
      true,
    );
  });
});

describe("validateAnswerComposition (independent boundary)", () => {
  it("UNMAPPED_ASSERTION when sentence cites claim not in pack", () => {
    const p = pack();
    const bad = {
      schemaVersion: 1,
      id: "cmp-test",
      questionId: QUESTION,
      claimPackHash: p.hash,
      graphRevision: 1,
      answer: "Invented claim text.",
      claimOrder: [CLM_OUT],
      sentenceClaims: [{ sentenceIndex: 0, claimIds: [CLM_OUT] }],
      citations: [],
      goalCoverage: [{ goalId: "g1", covered: true, claimIds: [CLM_OUT] }],
      limitations: [],
      state: "proposed",
    };
    const result = validateAnswerComposition(bad, {
      pack: p,
      goals: [{ goalId: "g1", text: "x" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNMAPPED_ASSERTION");
  });

  it("PACK_HASH_MISMATCH when claimPackHash differs from pack.hash", () => {
    const p = pack();
    const bad = {
      schemaVersion: 1,
      id: "cmp-hash",
      questionId: QUESTION,
      claimPackHash: "b".repeat(64),
      graphRevision: 1,
      answer: p.claims[0]!.statement,
      claimOrder: [CLM_A],
      sentenceClaims: [{ sentenceIndex: 0, claimIds: [CLM_A] }],
      citations: [],
      goalCoverage: [{ goalId: "g1", covered: true, claimIds: [CLM_A] }],
      limitations: [],
      state: "proposed",
    };
    const result = validateAnswerComposition(bad, {
      pack: p,
      goals: [{ goalId: "g1", text: "x" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PACK_HASH_MISMATCH");
  });

  it("INVENTED_PROSE when insufficient_pack has non-empty answer", () => {
    const p = pack();
    const bad = {
      schemaVersion: 1,
      id: "cmp-invent",
      questionId: QUESTION,
      claimPackHash: p.hash,
      graphRevision: 1,
      answer: "I made this up when evidence was thin.",
      claimOrder: [],
      sentenceClaims: [],
      citations: [],
      goalCoverage: [{ goalId: "g1", covered: false, claimIds: [] }],
      limitations: ["g1 unsupported"],
      state: "insufficient_pack",
    };
    const result = validateAnswerComposition(bad, {
      pack: p,
      goals: [{ goalId: "g1", text: "unsupported goal" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVENTED_PROSE");
  });

  it("accepts a valid composition from composeAnswerFromPack", () => {
    const p = pack();
    const composed = composeAnswerFromPack({
      questionId: QUESTION,
      pack: p,
      goals: [{ goalId: "g-storage", text: "Where is knowledge stored?" }],
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    const validated = validateAnswerComposition(composed.value, {
      pack: p,
      goals: [{ goalId: "g-storage", text: "Where is knowledge stored?" }],
    });
    expect(validated.ok).toBe(true);
  });
});

describe("StructuredAnswerCompatibility", () => {
  it("never confuses labelled context with AnswerComposition writes", async () => {
    const ctx = await StructuredAnswerCompatibility.readQuestionContext(
      QUESTION,
    );
    // null or labelled context only — no AnswerComposition fields
    if (ctx !== null) {
      expect(ctx.structuredAnswerLabel).toBe("transcript_context");
      expect(typeof ctx.text).toBe("string");
      expect("claimPackHash" in ctx).toBe(false);
    }
  });
});
