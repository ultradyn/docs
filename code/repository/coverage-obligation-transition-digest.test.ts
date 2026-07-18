import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { QuestionRecordSchema, type QuestionRecord } from "../domain/index.js";
import { createCoverageObligationService } from "../ingest/knowledge/index.js";
import { createFileCoverageObligationEventWriter } from "./index.js";
import {
  createTestingFileCoverageObligationEventWriter,
  type TestingCoverageObligationEventWriterHooks,
} from "./testing.js";

const QUESTION_ID = "q-01BX5ZZKBKACTAV9WEVGEMMVRZ";
const OWNER_ID = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_OWNER_ID = "q-01BX5ZZKBKACTAV9WEVGEMMVS0";
const FINDING_ID = "f-01BX5ZZKBKACTAV9WEVGEMMVS1";
const OBLIGATION_ID = "obl-01BX5ZZKBKACTAV9WEVGEMMVS2";

function question(id: string, generated = false): QuestionRecord {
  return QuestionRecordSchema.parse({
    schemaVersion: 1,
    id,
    title: "Which replay guarantee remains uncovered?",
    question: "Which replay guarantee remains uncovered?",
    state: "logged",
    tier: "P3",
    priorityRationale: "Coverage branch.",
    prioritySource: "rule",
    goals: ["understand-replay"],
    tags: [],
    askers: [{ id: "ingest-system", acceptance: "pending" }],
    origin: generated
      ? {
          kind: "generated",
          parentQuestionId: OWNER_ID,
          findingId: FINDING_ID,
          goal: "understand-replay",
        }
      : { kind: "raw" },
    depth: generated ? 1 : 0,
    createdAt: "2026-07-18T10:00:00.000Z",
    updatedAt: "2026-07-18T10:00:00.000Z",
    revision: 0,
    provenance: [],
  });
}

function service(
  root: string,
  hooks?: TestingCoverageObligationEventWriterHooks,
) {
  const records = new Map(
    [
      question(QUESTION_ID, true),
      question(OWNER_ID),
      question(OTHER_OWNER_ID),
    ].map((record) => [record.id, record]),
  );
  return createCoverageObligationService({
    questions: { getQuestion: (id) => Promise.resolve(records.get(id)) },
    ids: { next: () => OBLIGATION_ID },
    events: hooks
      ? createTestingFileCoverageObligationEventWriter(root, hooks)
      : createFileCoverageObligationEventWriter(root),
  });
}

describe("durable transition command digests", () => {
  it("retries reordered semantic commands after reserved-before-event crash and rejects changed fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-transition-digest-"));
    try {
      const initial = service(root);
      const created = await initial.create({
        questionId: QUESTION_ID,
        trigger: "replay-integrity",
        ownerQuestionId: QUESTION_ID,
        expectedVersion: 0,
        idempotencyKey: "create-transition-fixture",
      });
      if (!created.ok) throw new Error("creation unexpectedly failed");

      let crash = true;
      const crashing = service(root, {
        afterOperationReserved: () => {
          if (!crash) return;
          crash = false;
          throw new Error("simulated crash after transition reservation");
        },
      });
      const command = {
        obligationId: OBLIGATION_ID,
        ownerQuestionId: OWNER_ID,
        expectedVersion: 1,
        idempotencyKey: "transfer-reordered",
      };
      await expect(crashing.transfer(command)).rejects.toThrow(
        "simulated crash after transition reservation",
      );

      const restarted = service(root);
      const reordered = {
        idempotencyKey: "transfer-reordered",
        expectedVersion: 1,
        ownerQuestionId: OWNER_ID,
        obligationId: OBLIGATION_ID,
      };
      await expect(restarted.transfer(reordered)).resolves.toMatchObject({
        ok: true,
        value: { status: "transferred", version: 2 },
      });
      await expect(
        service(root).transfer({
          ...reordered,
          ownerQuestionId: OTHER_OWNER_ID,
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: "IDEMPOTENCY_CONFLICT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
