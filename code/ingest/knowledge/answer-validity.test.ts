/**
 * T-60-03 RED — answer citation/validity review.
 *
 * NAIL 1: promotable is POSITIVE WHITELIST conjunction (default false):
 *   promotable = packSupported && revisionMatch && packHashMatch && depsCurrent
 *                && !insufficient_pack
 * Isolated pin per conjunct: fixture violates EXACTLY ONE; deleting that
 * conjunct alone must fail that pin (no co-location mask).
 *
 * NAIL 3: getClaim LIVE re-read — claim accepted in pack snapshot but
 * getClaim returns state!==accepted (post-seal invalidation) → staleDependencies.
 *
 * Not an agent — no B008 scaffold.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Claim } from "../../domain/ingest/claim.js";
import type { AnswerComposition } from "../../domain/ingest/answer-composition.js";
import type { SealedClaimPack } from "../../domain/ingest/sealed-claim-pack.js";
import type {
  ClaimId,
  GraphRevision,
  Sha256,
} from "../../domain/ingest/types.js";
import {
  composeAnswerFromPack,
  deriveAnswerCompositionId,
  validateAnswerComposition,
} from "../agents/answer-composer-agent.js";

import { reviewAnswerComposition } from "./answer-validity.js";

const QUESTION = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CLM_A = "clm-01ARZ3NDEKTSV4RRFFQ69G5FAA" as ClaimId;
const CLM_B = "clm-01ARZ3NDEKTSV4RRFFQ69G5FAB" as ClaimId;
const CLM_OUT = "clm-01ARZ3NDEKTSV4RRFFQ69G5FZZ" as ClaimId;
const UNIT = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAA";
const PACK_HASH = "a".repeat(64) as Sha256;
const REVISION = 1 as GraphRevision;

function sha(s: string): Sha256 {
  return createHash("sha256").update(s).digest("hex") as Sha256;
}

function claim(
  id: ClaimId,
  statement: string,
  state: Claim["state"] = "accepted",
): Claim {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    statement,
    claimType: "behavior",
    scope: { product: "atlas" },
    authority: "source-doc",
    lifecycle: "current",
    state,
    evidenceRefs: [
      {
        snapshotId: `snap-${"b".repeat(64)}`,
        fileId: `file-${"c".repeat(64)}`,
        unitId: UNIT,
        fileSha256: sha("f"),
        unitSha256: sha("u"),
      },
    ],
    relationships: {
      qualifierClaimIds: [],
      contradictsClaimIds: [],
      supersedesClaimIds: [],
    },
    createdFrom: {
      questionId: QUESTION,
      packetId: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    },
  };
}

function pack(
  claims: Claim[] = [
    claim(CLM_A, "Atlas stores portable project knowledge in Git."),
    claim(CLM_B, "Settings apply through the documented procedure."),
  ],
  hash: Sha256 = PACK_HASH,
  graphRevision: GraphRevision = REVISION,
): SealedClaimPack {
  return {
    schemaVersion: 1,
    hash,
    questionId: QUESTION,
    graphRevision,
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

function acceptedGetClaim(claims: Claim[]) {
  const map = new Map(claims.map((c) => [c.id as string, c] as const));
  return (id: ClaimId) => map.get(id as string) ?? null;
}

function happyComposition(): {
  composition: AnswerComposition;
  pack: SealedClaimPack;
  goals: { goalId: string; text: string }[];
} {
  const p = pack();
  const goals = [
    {
      goalId: "g-storage",
      text: "Where is portable project knowledge stored in Git?",
    },
  ];
  const composed = composeAnswerFromPack({
    questionId: QUESTION,
    pack: p,
    goals,
  });
  if (!composed.ok) throw new Error(composed.code);
  return { composition: composed.value, pack: p, goals };
}

describe("reviewAnswerComposition (T-60-03) — whitelist conjunction", () => {
  it("happy: all conjuncts true → promotable true", () => {
    const { composition, pack: p } = happyComposition();
    expect(
      validateAnswerComposition(composition, {
        pack: p,
        goals: [
          {
            goalId: "g-storage",
            text: "Where is portable project knowledge stored in Git?",
          },
        ],
      }).ok,
    ).toBe(true);

    const validity = reviewAnswerComposition({
      composition,
      pack: p,
      currentGraphRevision: REVISION,
      getClaim: acceptedGetClaim([...p.claims]),
    });
    expect(validity.promotable).toBe(true);
    expect(validity.revisionMatch).toBe(true);
    expect(validity.packHashMatch).toBe(true);
    expect(validity.packSupported).toBe(true);
    expect(validity.depsCurrent).toBe(true);
    expect(validity.unsupportedSentenceIds).toEqual([]);
    expect(validity.staleDependencies).toEqual([]);
  });

  /** Isolated pin: packSupported false alone (CLM_OUT in sentenceClaims only). */
  it("isolated: !packSupported → promotable false; unsupportedSentenceIds", () => {
    const p = pack();
    const goals = [{ goalId: "g1", text: "knowledge" }];
    const unit = p.citations[0]!.unitId;
    const bad = {
      schemaVersion: 1 as const,
      id: deriveAnswerCompositionId(QUESTION, p.hash, goals),
      questionId: QUESTION,
      claimPackHash: p.hash,
      graphRevision: 1,
      answer: p.claims[0]!.statement,
      claimOrder: [CLM_A],
      sentenceClaims: [{ sentenceIndex: 0, claimIds: [CLM_OUT] }],
      citations: [{ claimId: CLM_A, unitId: unit }],
      goalCoverage: [{ goalId: "g1", covered: true, claimIds: [CLM_A] }],
      limitations: [],
      state: "proposed" as const,
    };
    const validity = reviewAnswerComposition({
      composition: bad as never,
      pack: p,
      currentGraphRevision: REVISION,
      getClaim: acceptedGetClaim([...p.claims]),
    });
    expect(validity.packSupported).toBe(false);
    expect(validity.revisionMatch).toBe(true);
    expect(validity.packHashMatch).toBe(true);
    expect(validity.depsCurrent).toBe(true);
    expect(validity.promotable).toBe(false);
    expect(validity.unsupportedSentenceIds).toContain(0);
  });

  /** Isolated pin: revisionMatch false alone. */
  it("isolated: !revisionMatch → promotable false", () => {
    const { composition, pack: p } = happyComposition();
    const validity = reviewAnswerComposition({
      composition,
      pack: p,
      currentGraphRevision: 99 as GraphRevision,
      getClaim: acceptedGetClaim([...p.claims]),
    });
    expect(validity.revisionMatch).toBe(false);
    expect(validity.packHashMatch).toBe(true);
    expect(validity.depsCurrent).toBe(true);
    expect(validity.packSupported).toBe(true);
    expect(validity.promotable).toBe(false);
  });

  /** Isolated pin: packHashMatch false alone. */
  it("isolated: !packHashMatch → promotable false (not in staleDependencies)", () => {
    const { composition, pack: p, goals } = happyComposition();
    const mutated = {
      ...composition,
      claimPackHash: "b".repeat(64) as Sha256,
      id: deriveAnswerCompositionId(QUESTION, "b".repeat(64), goals),
    };
    const validity = reviewAnswerComposition({
      composition: mutated,
      pack: p,
      currentGraphRevision: REVISION,
      getClaim: acceptedGetClaim([...p.claims]),
    });
    expect(validity.packHashMatch).toBe(false);
    expect(validity.revisionMatch).toBe(true);
    expect(validity.depsCurrent).toBe(true);
    expect(validity.promotable).toBe(false);
    expect(validity.staleDependencies.every((d) => !/pack.?hash/i.test(d))).toBe(
      true,
    );
  });

  /**
   * NAIL 3 / isolated !depsCurrent:
   * Pack snapshot still holds accepted claim text; getClaim LIVE returns
   * state!==accepted (post-seal invalidation) → staleDependencies includes id.
   */
  it("isolated: !depsCurrent via live getClaim post-seal invalidation → staleDependencies", () => {
    const { composition, pack: p } = happyComposition();
    // Seal-time: claims in pack are accepted. LIVE re-read: CLM_A invalidated.
    const liveInvalidated = claim(CLM_A, p.claims[0]!.statement, "superseded");
    const stillAccepted = claim(CLM_B, p.claims[1]!.statement, "accepted");
    const validity = reviewAnswerComposition({
      composition,
      pack: p,
      currentGraphRevision: REVISION,
      getClaim: acceptedGetClaim([liveInvalidated, stillAccepted]),
    });
    expect(validity.depsCurrent).toBe(false);
    expect(validity.revisionMatch).toBe(true);
    expect(validity.packHashMatch).toBe(true);
    expect(validity.packSupported).toBe(true);
    expect(validity.promotable).toBe(false);
    expect(
      validity.staleDependencies.some((d) => d.includes(CLM_A as string)),
    ).toBe(true);
  });

  it("isolated: getClaim null → !depsCurrent + staleDependencies", () => {
    const { composition, pack: p } = happyComposition();
    const validity = reviewAnswerComposition({
      composition,
      pack: p,
      currentGraphRevision: REVISION,
      getClaim: () => null,
    });
    expect(validity.depsCurrent).toBe(false);
    expect(validity.promotable).toBe(false);
    expect(validity.staleDependencies.length).toBeGreaterThan(0);
  });

  /** Isolated pin: insufficient_pack alone never promotable. */
  it("isolated: insufficient_pack → promotable false even if other fields look ok", () => {
    const p = pack([claim(CLM_A, "Only about storage in Git.")]);
    const goals = [
      {
        goalId: "g-quantum",
        text: "What is the quantum entanglement protocol for payments?",
      },
    ];
    const composed = composeAnswerFromPack({
      questionId: QUESTION,
      pack: p,
      goals,
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.value.state).toBe("insufficient_pack");
    const validity = reviewAnswerComposition({
      composition: composed.value,
      pack: p,
      currentGraphRevision: REVISION,
      getClaim: acceptedGetClaim([...p.claims]),
    });
    expect(validity.promotable).toBe(false);
  });

  it("revisionMatch requires composition === pack === current (triple)", () => {
    const p = pack(undefined, PACK_HASH, 1 as GraphRevision);
    const goals = [
      {
        goalId: "g-storage",
        text: "Where is portable project knowledge stored in Git?",
      },
    ];
    const composed = composeAnswerFromPack({
      questionId: QUESTION,
      pack: p,
      goals,
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    // composition.graphRevision matches pack (1) but current is 2
    const v = reviewAnswerComposition({
      composition: composed.value,
      pack: p,
      currentGraphRevision: 2 as GraphRevision,
      getClaim: acceptedGetClaim([...p.claims]),
    });
    expect(v.revisionMatch).toBe(false);
    expect(v.promotable).toBe(false);
  });
});
