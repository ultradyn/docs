import {
  QuestionRecordSchema,
  type Asker,
  type QuestionRecord,
  type QuestionState,
  type QueueBucket,
} from "./schemas.js";

const transitions: Record<QuestionState, ReadonlySet<QuestionState>> = {
  asked: new Set(["logged"]),
  logged: new Set(["active", "deferred"]),
  active: new Set(["in-answer", "deferred"]),
  deferred: new Set(["active"]),
  "in-answer": new Set(["active", "integrating"]),
  integrating: new Set(["in-answer", "merged"]),
  merged: new Set(["accepted", "reopened"]),
  accepted: new Set(["reopened"]),
  reopened: new Set(["active", "in-answer"]),
};

export class InvalidQuestionTransitionError extends Error {
  constructor(from: QuestionState, to: QuestionState) {
    super(`Question state cannot transition from ${from} to ${to}.`);
    this.name = "InvalidQuestionTransitionError";
  }
}

export class QuestionRevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`Question revision conflict: expected ${expected}, found ${actual}.`);
    this.name = "QuestionRevisionConflictError";
  }
}

export function queueForState(state: QuestionState): QueueBucket {
  if (state === "accepted") return "answered";
  if (state === "deferred") return "deferred";
  return "active";
}

export interface QuestionTransition {
  to: QuestionState;
  expectedRevision: number;
  at: string;
  by: string;
  details?: Record<string, unknown>;
}

export function applyQuestionTransition(
  record: QuestionRecord,
  transition: QuestionTransition,
): QuestionRecord {
  if (record.revision !== transition.expectedRevision) {
    throw new QuestionRevisionConflictError(
      transition.expectedRevision,
      record.revision,
    );
  }
  if (!transitions[record.state].has(transition.to)) {
    throw new InvalidQuestionTransitionError(record.state, transition.to);
  }
  const askers =
    record.state === "reopened" && transition.to === "in-answer"
      ? record.askers.map((asker) =>
          asker.acceptance === "rejected"
            ? {
                id: asker.id,
                ...(asker.displayName
                  ? { displayName: asker.displayName }
                  : {}),
                acceptance: "pending" as const,
              }
            : asker,
        )
      : record.askers;
  return QuestionRecordSchema.parse({
    ...record,
    askers,
    state: transition.to,
    revision: record.revision + 1,
    updatedAt: transition.at,
    provenance: [
      ...record.provenance,
      {
        at: transition.at,
        type: "state-transitioned",
        by: transition.by,
        details: {
          from: record.state,
          to: transition.to,
          ...transition.details,
        },
      },
    ],
  });
}

export function askerDecisionSummary(
  askers: readonly Asker[],
): "pending" | "accepted" | "rejected" {
  if (askers.some((asker) => asker.acceptance === "rejected"))
    return "rejected";
  if (
    askers.every(
      (asker) =>
        asker.acceptance === "accepted" || asker.acceptance === "timed-out",
    )
  ) {
    return "accepted";
  }
  return "pending";
}
