import { describe, expect, it } from "vitest";

import {
  COVERAGE_OBLIGATION_TERMINAL_STATUSES,
  type CoverageObligation,
  type IngestionQuestionLink,
} from "../../domain/ingest/index.js";
import {
  ADMISSION_REASON_ORDER,
  assessQuestionProposal,
  DUPLICATE_SIMILARITY,
  MIN_CONCRETE_TOKENS,
  type QuestionProposalInput,
} from "./index.js";

const CHILD_ID = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SIBLING_ID = "q-01BX5ZZKBKACTAV9WEVGEMMVRZ";
const PARENT_ID = "q-01BX5ZZKBKACTAV9WEVGEMMVS0";
const OBLIGATION_ID = "obl-01BX5ZZKBKACTAV9WEVGEMMVS1";

function obligation(
  overrides: Partial<CoverageObligation> = {},
): CoverageObligation {
  return {
    schemaVersion: 1,
    id: OBLIGATION_ID,
    questionId: CHILD_ID,
    trigger: "replay-guarantee",
    ownerQuestionId: CHILD_ID,
    status: "open",
    version: 1,
    ...overrides,
  };
}

const CONCRETE_WORDING =
  "Which checksum algorithm gates replay capsule verification?";
const ARTIFACT_ID = "art-01ARZ3NDEKTSV4RRFFQ69G5FAV";

function link(
  overrides: Partial<IngestionQuestionLink> = {},
): IngestionQuestionLink {
  return {
    schemaVersion: 1,
    questionId: CHILD_ID,
    snapshotId: "snap-1",
    origin: "ingestion-generated",
    systemActor: "curiosity-planner",
    rawArtifactId: ARTIFACT_ID,
    generation: 1,
    sourceUnitIds: ["unit-1"],
    createdRevision: 0,
    ...overrides,
  };
}

/** An admitted generated question, carried as link + canonical wording. */
function admittedFact(
  overrides: {
    questionId?: string;
    wording?: string;
    obligationId?: string;
  } = {},
) {
  return {
    link: link({
      questionId: overrides.questionId ?? SIBLING_ID,
      sourceUnitIds: ["unit-9"],
    }),
    wording:
      overrides.wording ?? "A different concrete enquiry about manifests",
    obligationId: overrides.obligationId ?? "obl-01BX5ZZKBKACTAV9WEVGEMMVS9",
  };
}

function generated(
  overrides: Partial<QuestionProposalInput> = {},
): QuestionProposalInput {
  return {
    link: link(),
    wording: CONCRETE_WORDING,
    obligationId: OBLIGATION_ID,
    obligations: [obligation()],
    admitted: [],
    lexicalCandidates: [],
    ...overrides,
  } as QuestionProposalInput;
}

describe("human demand is never gated", () => {
  it.each([
    ["generic wording", { wording: "What else is missing?" }],
    ["no trigger", { link: link({ sourceUnitIds: [] }) }],
    ["no obligation", { obligationId: undefined, obligations: [] }],
    [
      "wording identical to an existing question",
      { admitted: [admittedFact({ wording: CONCRETE_WORDING })] },
    ],
  ])("admits an unsupported human question with %s", (_label, overrides) => {
    const decision = assessQuestionProposal({
      ...generated(),
      link: link({
        origin: "human",
        systemActor: undefined,
        generation: 0,
        sourceUnitIds: [],
      }),
      ...overrides,
    } as QuestionProposalInput);

    expect(decision).toMatchObject({ admitted: true, kind: "demand" });
    expect(decision.reasons).toEqual([]);
  });
});

describe("generated admissibility", () => {
  it("admits a grounded, novel, self-owned generated child", () => {
    const decision = assessQuestionProposal(generated());
    expect(decision.admitted).toBe(true);
    expect(decision.kind).toBe("generated");
    expect(decision.reasons).toEqual([]);
  });

  it("rejects generic missingness wording", () => {
    const decision = assessQuestionProposal(
      generated({ wording: "What other information is missing or unclear?" }),
    );
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toContain("GENERIC_WORDING");
  });

  it("pins the concrete-token boundary exactly", () => {
    // Two concrete tokens is below MIN_CONCRETE_TOKENS and must be rejected.
    const below = assessQuestionProposal(
      generated({ wording: "what is missing from checksum verification" }),
    );
    expect(below.reasons).toContain("GENERIC_WORDING");

    // Three concrete tokens reaches the threshold and must be admitted.
    const atThreshold = assessQuestionProposal(
      generated({
        wording: "what is missing from checksum replay verification",
      }),
    );
    expect(atThreshold.reasons).not.toContain("GENERIC_WORDING");
    expect(MIN_CONCRETE_TOKENS).toBe(3);
  });

  it("rejects a triggerless proposal", () => {
    const decision = assessQuestionProposal(
      generated({ link: link({ sourceUnitIds: [] }) }),
    );
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toContain("MISSING_TRIGGER");
  });

  it("rejects an obligationless proposal", () => {
    const decision = assessQuestionProposal(
      generated({ obligationId: undefined }),
    );
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toContain("OBLIGATION_NOT_FOUND");
  });

  it("rejects an obligation that is not among the supplied facts", () => {
    const decision = assessQuestionProposal(generated({ obligations: [] }));
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toContain("OBLIGATION_NOT_FOUND");
  });

  it.each(COVERAGE_OBLIGATION_TERMINAL_STATUSES)(
    "rejects a terminal obligation in %s",
    (status) => {
      const decision = assessQuestionProposal(
        generated({ obligations: [obligation({ status })] }),
      );
      expect(decision.admitted).toBe(false);
      expect(decision.reasons).toContain("OBLIGATION_RESOLVED");
    },
  );

  it.each(["open", "assigned", "blocked", "transferred"] as const)(
    "treats non-terminal status %s as unresolved",
    (status) => {
      const decision = assessQuestionProposal(
        generated({ obligations: [obligation({ status })] }),
      );
      expect(decision.reasons).not.toContain("OBLIGATION_RESOLVED");
      // Transferred TO this question is still this question's obligation.
      expect(decision.admitted).toBe(true);
    },
  );

  it("rejects an obligation transferred AWAY from this question", () => {
    const decision = assessQuestionProposal(
      generated({
        obligations: [
          obligation({ status: "transferred", ownerQuestionId: SIBLING_ID }),
        ],
      }),
    );
    expect(decision.admitted).toBe(false);
    // Self-ownership fails naturally; the status itself is not the reason.
    expect(decision.reasons).toContain("OBLIGATION_NOT_SELF_OWNED");
    expect(decision.reasons).not.toContain("OBLIGATION_RESOLVED");
  });

  it("rejects an obligation raised for a different question", () => {
    const decision = assessQuestionProposal(
      generated({ obligations: [obligation({ questionId: SIBLING_ID })] }),
    );
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toContain("OBLIGATION_NOT_FOR_QUESTION");
  });

  it("rejects a sibling's obligation that merely names this question as owner", () => {
    // Coherent-looking but not ours: raised for a sibling, owner forged to us.
    const decision = assessQuestionProposal(
      generated({
        obligations: [
          obligation({ questionId: SIBLING_ID, ownerQuestionId: CHILD_ID }),
        ],
      }),
    );
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toContain("OBLIGATION_NOT_FOR_QUESTION");
    expect(decision.reasons).not.toContain("OBLIGATION_NOT_SELF_OWNED");
  });

  it.each([
    ["a sibling question", SIBLING_ID],
    ["nobody", null],
  ])("rejects an obligation owned by %s", (_label, ownerQuestionId) => {
    const decision = assessQuestionProposal(
      generated({ obligations: [obligation({ ownerQuestionId })] }),
    );
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toContain("OBLIGATION_NOT_SELF_OWNED");
  });

  it("rejects an obligation already cited by an admitted generated question", () => {
    const decision = assessQuestionProposal(
      generated({
        admitted: [
          admittedFact({
            questionId: SIBLING_ID,
            wording: "An entirely different concrete enquiry about manifests",
            obligationId: OBLIGATION_ID,
          }),
        ],
      }),
    );
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toContain("OBLIGATION_NOT_NOVEL");
  });

  it("reports reasons in the documented precedence order", () => {
    const decision = assessQuestionProposal(
      generated({
        wording: "What else is missing?",
        triggerSourceUnitIds: [],
        obligations: [],
        admitted: [
          admittedFact({
            questionId: SIBLING_ID,
            wording: "What else is missing?",
            obligationId: "obl-01BX5ZZKBKACTAV9WEVGEMMVS9",
          }),
        ],
      }),
    );
    // Exact array equality, in ADMISSION_REASON_ORDER, so neither Set
    // iteration nor input order can leak nondeterminism into the result.
    const expected = ADMISSION_REASON_ORDER.filter((reason) =>
      decision.reasons.includes(reason),
    );
    expect(decision.reasons).toEqual(expected);
    expect(decision.reasons.length).toBeGreaterThan(2);
  });

  it("deduplicates trigger ids deterministically", () => {
    const decision = assessQuestionProposal(
      generated({
        link: link({ sourceUnitIds: ["unit-2", "unit-1", "unit-2"] }),
      }),
    );
    expect(decision.admitted).toBe(true);
    // First-occurrence order preserved, duplicates removed.
    expect(decision.triggerSourceUnitIds).toEqual(["unit-2", "unit-1"]);
  });

  it("rejects malformed input with a typed reason instead of throwing", () => {
    for (const malformed of [
      { link: link({ origin: "telepathy" as never }) },
      { link: link({ questionId: "not-a-question-id" }) },
      { link: link({ sourceUnitIds: ["   "] }) },
      { wording: "   " },
    ]) {
      const decision = assessQuestionProposal({
        ...generated(),
        ...malformed,
      } as unknown as QuestionProposalInput);
      expect(decision.admitted).toBe(false);
      expect(decision.reasons).toContain("INVALID_PROPOSAL");
    }
  });

  it("reports every applicable reason, not just the first", () => {
    const decision = assessQuestionProposal(
      generated({
        wording: "What else is missing?",
        triggerSourceUnitIds: [],
        obligations: [],
      }),
    );
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "GENERIC_WORDING",
        "MISSING_TRIGGER",
        "OBLIGATION_NOT_FOUND",
      ]),
    );
  });
});

describe("duplicate detection is deterministic and bounded", () => {
  it("rejects an exact normalized duplicate regardless of case and punctuation", () => {
    const decision = assessQuestionProposal(
      generated({
        admitted: [
          admittedFact({
            questionId: SIBLING_ID,
            wording:
              "  WHICH checksum algorithm gates replay capsule verification!!  ",
            obligationId: "obl-01BX5ZZKBKACTAV9WEVGEMMVS9",
          }),
        ],
      }),
    );
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toContain("DUPLICATE_WORDING");
  });

  it("pins the similarity threshold at, just below, and just above", () => {
    expect(DUPLICATE_SIMILARITY).toBe(0.8);

    // Token sets chosen so similarity is computable by hand.
    const existing = (wording: string) => admittedFact({ wording });

    // 4 of 5 union tokens shared = 0.8 exactly -> duplicate (>= is inclusive).
    const atThreshold = assessQuestionProposal(
      generated({
        wording: "alpha beta gamma delta",
        admitted: [existing("alpha beta gamma delta epsilon")],
      }),
    );
    expect(atThreshold.reasons).toContain("DUPLICATE_WORDING");

    // 4 of 6 union tokens shared = 0.667 -> distinct.
    const belowThreshold = assessQuestionProposal(
      generated({
        wording: "alpha beta gamma delta",
        admitted: [existing("alpha beta gamma delta epsilon zeta")],
      }),
    );
    expect(belowThreshold.reasons).not.toContain("DUPLICATE_WORDING");
  });

  it("scores empty wordings without producing NaN", () => {
    // Empty normalised wording is generic first; similarity is 1 only for
    // exact normalised equality, never an undefined 0/0.
    const decision = assessQuestionProposal(
      generated({
        wording: "!!!",
        admitted: [
          admittedFact({
            questionId: SIBLING_ID,
            wording: "???",
            obligationId: "obl-01BX5ZZKBKACTAV9WEVGEMMVS9",
          }),
        ],
      }),
    );
    expect(decision.reasons).toContain("GENERIC_WORDING");
    expect(decision.reasons).toContain("DUPLICATE_WORDING");
    expect(Number.isNaN(decision.maxSimilarity)).toBe(false);
    expect(decision.maxSimilarity).toBe(1);

    const distinct = assessQuestionProposal(
      generated({
        wording: "!!!",
        admitted: [
          admittedFact({
            questionId: SIBLING_ID,
            wording: "a concrete enquiry about checksum manifests",
            obligationId: "obl-01BX5ZZKBKACTAV9WEVGEMMVS9",
          }),
        ],
      }),
    );
    expect(distinct.maxSimilarity).toBe(0);
  });

  it("resolves ties deterministically across equally similar candidates", () => {
    const decision = assessQuestionProposal(
      generated({
        wording: "alpha beta gamma delta",
        admitted: [
          admittedFact({
            questionId: SIBLING_ID,
            wording: "alpha beta gamma delta epsilon",
          }),
          admittedFact({
            questionId: PARENT_ID,
            wording: "alpha beta gamma delta omega",
            obligationId: "obl-01BX5ZZKBKACTAV9WEVGEMMVSA",
          }),
        ],
      }),
    );
    // Both score identically; the decision must be stable and name the tie.
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toContain("DUPLICATE_WORDING");
    expect(decision.duplicateOf).toEqual([SIBLING_ID, PARENT_ID]);
  });
});

describe("lexical candidates carry no authority", () => {
  it("returns them as routing evidence only", () => {
    const decision = assessQuestionProposal(
      generated({ lexicalCandidates: [SIBLING_ID, PARENT_ID] }),
    );
    expect(decision.admitted).toBe(true);
    expect(decision.routing).toEqual({
      candidateQuestionIds: [SIBLING_ID, PARENT_ID],
      authoritative: false,
    });
  });

  it("cannot change an admitted decision", () => {
    const without = assessQuestionProposal(generated());
    const withCandidates = assessQuestionProposal(
      generated({ lexicalCandidates: [SIBLING_ID, PARENT_ID] }),
    );
    expect(withCandidates.admitted).toBe(without.admitted);
    expect(withCandidates.reasons).toEqual(without.reasons);
  });

  it("cannot rescue a rejected decision", () => {
    const rejected = assessQuestionProposal(
      generated({ link: link({ sourceUnitIds: [] }) }),
    );
    const rejectedWithCandidates = assessQuestionProposal(
      generated({
        triggerSourceUnitIds: [],
        lexicalCandidates: [SIBLING_ID, PARENT_ID],
      }),
    );
    expect(rejectedWithCandidates.admitted).toBe(false);
    expect(rejectedWithCandidates.reasons).toEqual(rejected.reasons);
  });
});

describe("assessment is pure", () => {
  it("does not mutate any supplied fact", () => {
    const input = generated({
      lexicalCandidates: [SIBLING_ID],
      admitted: [
        admittedFact({
          questionId: SIBLING_ID,
          wording: "A different concrete enquiry entirely",
          obligationId: "obl-01BX5ZZKBKACTAV9WEVGEMMVS9",
        }),
      ],
    });
    const before = structuredClone(input);

    assessQuestionProposal(input);

    expect(input).toEqual(before);
  });

  it("is deterministic across repeated calls", () => {
    const input = generated();
    expect(assessQuestionProposal(input)).toEqual(
      assessQuestionProposal(input),
    );
  });
});
