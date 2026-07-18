import { describe, expect, it } from "vitest";

import {
  QuestionRecordSchema,
  type QuestionRecord,
} from "../../domain/schemas.js";
import { applyQuestionTransition } from "../../domain/lifecycle.js";
import {
  createInMemoryQuestionLinkStore,
  createQuestionLinkService,
  type QuestionLinkService,
} from "./question-link-service.js";

const HUMAN_QUESTION_ID = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const GENERATED_QUESTION_ID = "q-01BX5ZZKBKACTAV9WEVGEMMVRZ";
const PARENT_QUESTION_ID = "q-01BX5ZZKBKACTAV9WEVGEMMVS0";
const FINDING_ID = "f-01BX5ZZKBKACTAV9WEVGEMMVS1";

function humanQuestion(overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return QuestionRecordSchema.parse({
    schemaVersion: 1,
    id: HUMAN_QUESTION_ID,
    title: "How does replay verification work?",
    question: "How does replay verification work end to end?",
    state: "logged",
    tier: "P2",
    priorityRationale: "Core comprehension question.",
    prioritySource: "rule",
    goals: ["understand-replay"],
    tags: [],
    askers: [{ id: "max", acceptance: "pending" }],
    origin: { kind: "raw" },
    depth: 0,
    createdAt: "2026-07-18T10:00:00.000Z",
    updatedAt: "2026-07-18T10:00:00.000Z",
    revision: 0,
    provenance: [],
    ...overrides,
  });
}

function generatedQuestion(
  overrides: Partial<QuestionRecord> = {},
): QuestionRecord {
  return QuestionRecordSchema.parse({
    schemaVersion: 1,
    id: GENERATED_QUESTION_ID,
    title: "Which checksum algorithm gates replay?",
    question: "Which checksum algorithm gates replay capsule verification?",
    state: "logged",
    tier: "P3",
    priorityRationale: "Follow-up from coverage gap.",
    prioritySource: "rule",
    goals: ["understand-replay"],
    tags: [],
    askers: [{ id: "ingest-system", acceptance: "pending" }],
    origin: {
      kind: "generated",
      parentQuestionId: PARENT_QUESTION_ID,
      findingId: FINDING_ID,
      goal: "understand-replay",
    },
    depth: 1,
    createdAt: "2026-07-18T10:00:00.000Z",
    updatedAt: "2026-07-18T10:00:00.000Z",
    revision: 0,
    provenance: [],
    ...overrides,
  });
}

function serviceWith(records: QuestionRecord[]): QuestionLinkService {
  const byId = new Map(records.map((record) => [record.id, record]));
  return createQuestionLinkService({
    questions: {
      getQuestion: (id) => Promise.resolve(byId.get(id)),
    },
    links: createInMemoryQuestionLinkStore(),
  });
}

const humanLinkInput = {
  questionId: HUMAN_QUESTION_ID,
  snapshotId: "snap-1",
  origin: "human",
  rawArtifactId: "art-01ARZ3NDEKTSV4RRFFQ69G5FAV",
  generation: 0,
  sourceUnitIds: [],
} as const;

const generatedLinkInput = {
  questionId: GENERATED_QUESTION_ID,
  snapshotId: "snap-1",
  origin: "ingestion-generated",
  systemActor: "curiosity-planner",
  rawArtifactId: "art-01BX5ZZKBKACTAV9WEVGEMMVRZ",
  generation: 1,
  sourceUnitIds: ["unit-1", "unit-2"],
} as const;

describe("QuestionLinkService", () => {
  it("rejects link input carrying wording, origin, or lifecycle fields", async () => {
    const service = serviceWith([humanQuestion()]);
    for (const contraband of [
      { question: "rewritten wording" },
      { title: "rewritten title" },
      { state: "accepted" },
      { to: "accepted" },
      { origin: "human", questionOrigin: { kind: "generated" } },
    ]) {
      const result = await service.link({ ...humanLinkInput, ...contraband });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("INVALID_LINK");
    }
  });

  it("requires systemActor and source-unit provenance for generated links", async () => {
    const service = serviceWith([generatedQuestion()]);

    const withoutActor: Record<string, unknown> = { ...generatedLinkInput };
    delete withoutActor.systemActor;
    const missingActor = await service.link(withoutActor);
    expect(missingActor.ok).toBe(false);
    if (!missingActor.ok) expect(missingActor.code).toBe("INVALID_LINK");

    const missingProvenance = await service.link({
      ...generatedLinkInput,
      sourceUnitIds: [],
    });
    expect(missingProvenance.ok).toBe(false);
    if (!missingProvenance.ok) expect(missingProvenance.code).toBe("INVALID_LINK");

    const accepted = await service.link(generatedLinkInput);
    expect(accepted.ok).toBe(true);
  });

  it("forbids systemActor on human links", async () => {
    const service = serviceWith([humanQuestion()]);
    const result = await service.link({
      ...humanLinkInput,
      systemActor: "curiosity-planner",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_LINK");
  });

  it("never mutates the canonical question record", async () => {
    const record = humanQuestion();
    const before = structuredClone(record);
    const service = serviceWith([record]);

    const result = await service.link(humanLinkInput);
    expect(result.ok).toBe(true);
    expect(record).toEqual(before);
    if (result.ok) {
      expect(result.value.createdRevision).toBe(before.revision);
    }
  });

  it("refuses origins that contradict the canonical record", async () => {
    const service = serviceWith([humanQuestion(), generatedQuestion()]);

    const generatedOnHuman = await service.link({
      ...generatedLinkInput,
      questionId: HUMAN_QUESTION_ID,
    });
    expect(generatedOnHuman.ok).toBe(false);
    if (!generatedOnHuman.ok) expect(generatedOnHuman.code).toBe("ORIGIN_MISMATCH");

    const humanOnGenerated = await service.link({
      ...humanLinkInput,
      questionId: GENERATED_QUESTION_ID,
    });
    expect(humanOnGenerated.ok).toBe(false);
    if (!humanOnGenerated.ok) expect(humanOnGenerated.code).toBe("ORIGIN_MISMATCH");
  });

  it("fails for unknown questions and duplicate links", async () => {
    const service = serviceWith([humanQuestion()]);

    const unknown = await service.link({
      ...humanLinkInput,
      questionId: "q-01BX5ZZKBKACTAV9WEVGEMMVS2",
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("QUESTION_NOT_FOUND");

    expect((await service.link(humanLinkInput)).ok).toBe(true);
    const duplicate = await service.link(humanLinkInput);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.code).toBe("LINK_EXISTS");
  });

  it("keeps human and generated origins distinguishable after lifecycle convergence", async () => {
    let human = humanQuestion();
    let generated = generatedQuestion();
    const converge = (record: QuestionRecord): QuestionRecord =>
      ["active", "in-answer", "integrating", "merged", "accepted"].reduce(
        (current, to, index) =>
          applyQuestionTransition(current, {
            to: to as QuestionRecord["state"],
            expectedRevision: current.revision,
            at: `2026-07-18T10:0${index + 1}:00.000Z`,
            by: "structurer",
          }),
        record,
      );
    human = converge(human);
    generated = converge(generated);
    expect(human.state).toBe("accepted");
    expect(generated.state).toBe("accepted");

    const service = serviceWith([human, generated]);
    expect((await service.link(humanLinkInput)).ok).toBe(true);
    expect((await service.link(generatedLinkInput)).ok).toBe(true);

    const humanLink = await service.read(HUMAN_QUESTION_ID);
    const generatedLink = await service.read(GENERATED_QUESTION_ID);
    expect(humanLink.ok && humanLink.value.origin).toBe("human");
    expect(generatedLink.ok && generatedLink.value.origin).toBe(
      "ingestion-generated",
    );
    expect(human.origin.kind).toBe("raw");
    expect(generated.origin.kind).toBe("generated");
  });

  it("read reports missing links explicitly", async () => {
    const service = serviceWith([humanQuestion()]);
    const missing = await service.read(HUMAN_QUESTION_ID);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("LINK_NOT_FOUND");
  });
});
