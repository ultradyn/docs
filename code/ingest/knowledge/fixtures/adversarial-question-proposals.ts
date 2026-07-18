interface AdmissibilityFixture {
  readonly name: string;
  readonly input: unknown;
  readonly expected: unknown;
}

const CHILD_ID = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SIBLING_ID = "q-01BX5ZZKBKACTAV9WEVGEMMVRZ";
const OBLIGATION_ID = "obl-01BX5ZZKBKACTAV9WEVGEMMVS1";
const OTHER_OBLIGATION_ID = "obl-01BX5ZZKBKACTAV9WEVGEMMVS9";

function generatedInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    link: {
      schemaVersion: 1,
      questionId: CHILD_ID,
      snapshotId: "snap-1",
      origin: "ingestion-generated",
      systemActor: "curiosity-planner",
      rawArtifactId: "art-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      generation: 1,
      sourceUnitIds: ["unit-1"],
      createdRevision: 0,
    },
    wording: "Which checksum algorithm gates replay capsule verification?",
    obligationId: OBLIGATION_ID,
    obligations: [
      {
        schemaVersion: 1,
        id: OBLIGATION_ID,
        questionId: CHILD_ID,
        trigger: "replay-guarantee",
        ownerQuestionId: CHILD_ID,
        status: "open",
        version: 1,
      },
    ],
    admitted: [],
    lexicalCandidates: [],
    ...overrides,
  };
}

function expectedGenerated(overrides: Record<string, unknown> = {}): unknown {
  return {
    admitted: true,
    kind: "generated",
    reasons: [],
    triggerSourceUnitIds: ["unit-1"],
    duplicateOf: [],
    maxSimilarity: 0,
    routing: { candidateQuestionIds: [], authoritative: false },
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function createAdversarialQuestionProposalFixtures(): readonly AdmissibilityFixture[] {
  return deepFreeze([
    {
      name: "rejects generic generated missingness",
      input: generatedInput({ wording: "What other information is missing?" }),
      expected: expectedGenerated({
        admitted: false,
        reasons: ["GENERIC_WORDING"],
      }),
    },
    {
      name: "admits unsupported human demand",
      input: generatedInput({
        link: {
          schemaVersion: 1,
          questionId: CHILD_ID,
          snapshotId: "snap-1",
          origin: "human",
          rawArtifactId: "art-01ARZ3NDEKTSV4RRFFQ69G5FAV",
          generation: 0,
          sourceUnitIds: [],
          createdRevision: 0,
        },
        wording: "What else is missing?",
        obligationId: undefined,
        obligations: [],
      }),
      expected: {
        admitted: true,
        kind: "demand",
        reasons: [],
        triggerSourceUnitIds: [],
        duplicateOf: [],
        maxSimilarity: 0,
        routing: { candidateQuestionIds: [], authoritative: false },
      },
    },
    {
      name: "admits grounded generated child",
      input: generatedInput(),
      expected: expectedGenerated(),
    },
    {
      name: "rejects duplicate generated wording",
      input: generatedInput({
        admitted: [
          {
            link: {
              schemaVersion: 1,
              questionId: SIBLING_ID,
              snapshotId: "snap-1",
              origin: "ingestion-generated",
              systemActor: "curiosity-planner",
              rawArtifactId: "art-01ARZ3NDEKTSV4RRFFQ69G5FAV",
              generation: 1,
              sourceUnitIds: ["unit-9"],
              createdRevision: 0,
            },
            wording:
              "Which checksum algorithm gates replay capsule verification?",
            obligationId: OTHER_OBLIGATION_ID,
          },
        ],
      }),
      expected: expectedGenerated({
        admitted: false,
        reasons: ["DUPLICATE_WORDING"],
        duplicateOf: [SIBLING_ID],
        maxSimilarity: 1,
      }),
    },
    {
      name: "rejects obligationless generated child",
      input: generatedInput({ obligationId: undefined }),
      expected: expectedGenerated({
        admitted: false,
        reasons: ["OBLIGATION_NOT_FOUND"],
      }),
    },
    {
      name: "ignores malformed routing hints for admission",
      input: generatedInput({
        lexicalCandidates: [SIBLING_ID, "not-a-question-id", SIBLING_ID],
      }),
      expected: expectedGenerated({
        routing: {
          candidateQuestionIds: [SIBLING_ID],
          authoritative: false,
        },
      }),
    },
  ] as const satisfies readonly AdmissibilityFixture[]);
}
