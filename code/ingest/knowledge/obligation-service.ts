import type { IdGenerator, QuestionRecord } from "../../domain/index.js";
import {
  CoverageObligationEventSchema,
  CoverageObligationRecordSchema,
  isTerminalObligationStatus,
  type CoverageObligation,
  type CoverageObligationEvent,
  type CoverageObligationEventWriter,
  type IngestResult,
  type ObligationStatus,
  type QuestionId,
  type TerminalObligationStatus,
} from "../../domain/ingest/index.js";

export type CoverageObligationError =
  | "INVALID_COMMAND"
  | "QUESTION_NOT_FOUND"
  | "OBLIGATION_NOT_FOUND"
  | "AUTOMATIC_OWNER_REQUIRED"
  | "ALREADY_OWNED"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_TRANSITION"
  | "CORRUPT_HISTORY";

export type CoverageObligationResult = IngestResult<
  CoverageObligation,
  CoverageObligationError
>;
export type CoverageObligationEventsResult = IngestResult<
  readonly CoverageObligationEvent[],
  "CORRUPT_HISTORY"
>;
export type CoverageObligationBooleanResult = IngestResult<
  boolean,
  "CORRUPT_HISTORY"
>;

export interface CoverageObligationQuestionReader {
  getQuestion(id: string): Promise<QuestionRecord | undefined>;
}

interface IdempotentCommand {
  idempotencyKey: string;
}

export interface CreateCoverageObligationCommand extends IdempotentCommand {
  questionId: string;
  trigger: string;
  ownerQuestionId?: string | null;
  expectedVersion: 0;
}

export interface AssignCoverageObligationCommand extends IdempotentCommand {
  obligationId: string;
  ownerQuestionId: string;
  expectedVersion: number;
}

export interface TransferCoverageObligationCommand extends IdempotentCommand {
  obligationId: string;
  ownerQuestionId: string;
  expectedVersion: number;
}

export type CoverageObligationResolution =
  TerminalObligationStatus | "budget_pause";

export interface ResolveCoverageObligationCommand extends IdempotentCommand {
  obligationId: string;
  resolution: CoverageObligationResolution;
  expectedVersion: number;
}

export interface CoverageObligationService {
  create(
    command: CreateCoverageObligationCommand,
  ): Promise<CoverageObligationResult>;
  assign(
    command: AssignCoverageObligationCommand,
  ): Promise<CoverageObligationResult>;
  transfer(
    command: TransferCoverageObligationCommand,
  ): Promise<CoverageObligationResult>;
  resolve(
    command: ResolveCoverageObligationCommand,
  ): Promise<CoverageObligationResult>;
  read(id: string): Promise<CoverageObligationResult>;
  events(id: string): Promise<CoverageObligationEventsResult>;
  requireOwnedUnresolved(questionId: string): Promise<CoverageObligationResult>;
  ownsUnresolved(questionId: string): Promise<CoverageObligationBooleanResult>;
  blocksClosure(questionId: string): Promise<CoverageObligationBooleanResult>;
}

function failure(
  code: CoverageObligationError,
  message: string,
): CoverageObligationResult {
  return { ok: false, code, message };
}

function corrupt(message: string): CoverageObligationEventsResult {
  return { ok: false, code: "CORRUPT_HISTORY", message };
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function createCommandDigest(command: CreateCoverageObligationCommand): string {
  return JSON.stringify({
    questionId: command.questionId,
    trigger: command.trigger.trim(),
    ownerQuestionId: command.ownerQuestionId ?? null,
    expectedVersion: command.expectedVersion,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function immutableRecord(value: unknown): CoverageObligation {
  return deepFreeze(CoverageObligationRecordSchema.parse(value));
}

function immutableEvent(value: unknown): CoverageObligationEvent {
  return deepFreeze(CoverageObligationEventSchema.parse(value));
}

function replay(raw: readonly unknown[]): CoverageObligationEventsResult {
  try {
    const parsed = raw.map(immutableEvent);
    const byObligation = new Map<string, CoverageObligationEvent[]>();
    const idempotency = new Set<string>();
    for (const event of parsed) {
      if (idempotency.has(event.idempotencyKey)) {
        return corrupt("Duplicate idempotency key in obligation history.");
      }
      idempotency.add(event.idempotencyKey);
      const history = byObligation.get(event.obligationId) ?? [];
      history.push(event);
      byObligation.set(event.obligationId, history);
    }
    for (const history of byObligation.values()) {
      let current: CoverageObligation | undefined;
      for (const event of history) {
        if (event.obligation.id !== event.obligationId) {
          return corrupt("Event and record obligation identities disagree.");
        }
        if (
          event.obligation.version !== event.version ||
          event.obligation.status !== event.status ||
          event.obligation.ownerQuestionId !== event.ownerQuestionId
        ) {
          return corrupt("Event envelope and reconstructed record disagree.");
        }
        if (!current) {
          if (
            event.type !== "created" ||
            event.version !== 1 ||
            event.previousStatus !== null ||
            !["open", "assigned"].includes(event.status) ||
            (event.status === "open") !== (event.ownerQuestionId === null)
          ) {
            return corrupt("Invalid coverage-obligation creation event.");
          }
        } else {
          if (
            event.version !== current.version + 1 ||
            event.previousStatus !== current.status ||
            event.obligation.id !== current.id ||
            event.obligation.questionId !== current.questionId ||
            event.obligation.trigger !== current.trigger
          ) {
            return corrupt("Noncontiguous or conflicting obligation history.");
          }
          const legal =
            !isTerminalObligationStatus(current.status) &&
            ((event.type === "assigned" &&
              current.status === "open" &&
              current.ownerQuestionId === null &&
              event.status === "assigned" &&
              event.ownerQuestionId !== null) ||
              (event.type === "transferred" &&
                current.ownerQuestionId !== null &&
                event.status === "transferred" &&
                event.ownerQuestionId !== null &&
                event.ownerQuestionId !== current.ownerQuestionId) ||
              (event.type === "resolved" &&
                (event.status === "blocked" ||
                  isTerminalObligationStatus(event.status)) &&
                event.ownerQuestionId === current.ownerQuestionId));
          if (!legal) return corrupt("Illegal coverage-obligation transition.");
        }
        current = immutableRecord(event.obligation);
      }
    }
    return { ok: true, value: deepFreeze(parsed.slice()) };
  } catch {
    return corrupt("Coverage-obligation history failed runtime validation.");
  }
}

export function createCoverageObligationService(options: {
  questions: CoverageObligationQuestionReader;
  ids: IdGenerator;
  events: CoverageObligationEventWriter;
}): CoverageObligationService {
  async function readHistory(
    id: string,
  ): Promise<CoverageObligationEventsResult> {
    const result = replay(
      await options.events.read(id as CoverageObligation["id"]),
    );
    if (!result.ok) return result;
    if (result.value.some((event) => event.obligationId !== id)) {
      return corrupt("Event writer returned a different obligation stream.");
    }
    return result;
  }

  async function readCurrent(id: string): Promise<CoverageObligationResult> {
    const history = await readHistory(id);
    if (!history.ok) return history;
    const current = history.value.at(-1)?.obligation;
    return current
      ? { ok: true, value: immutableRecord(current) }
      : failure("OBLIGATION_NOT_FOUND", `Unknown coverage obligation ${id}.`);
  }

  async function ownerExists(ownerQuestionId: string): Promise<boolean> {
    return (await options.questions.getQuestion(ownerQuestionId)) !== undefined;
  }

  async function acknowledgedRetry(
    obligationId: string,
    expectedVersion: number,
    idempotencyKey: string,
    matches: (event: CoverageObligationEvent) => boolean,
  ): Promise<CoverageObligationResult | undefined> {
    const history = await readHistory(obligationId);
    if (!history.ok) return history;
    const prior = history.value.find(
      (event) => event.idempotencyKey === idempotencyKey,
    );
    if (!prior) return undefined;
    if (prior.version !== expectedVersion + 1 || !matches(prior)) {
      return failure(
        "VERSION_CONFLICT",
        "The idempotency key was already used for a different command.",
      );
    }
    return { ok: true, value: immutableRecord(prior.obligation) };
  }

  async function append(
    expectedVersion: number,
    idempotencyKey: string,
    commandDigest: string,
    next: CoverageObligation,
    event: Omit<CoverageObligationEvent, "obligation" | "idempotencyKey">,
    claimUnresolvedOwnerQuestionId?: QuestionId,
  ): Promise<CoverageObligationResult> {
    const immutable = immutableRecord(next);
    const fullEvent = immutableEvent({
      ...event,
      idempotencyKey,
      obligation: immutable,
    });
    const result = await options.events.append({
      obligationId: immutable.id,
      expectedVersion,
      idempotencyKey,
      commandDigest,
      ...(claimUnresolvedOwnerQuestionId
        ? { claimUnresolvedOwnerQuestionId }
        : {}),
      event: fullEvent,
    });
    if (result.status === "idempotency_conflict") {
      return failure(
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for a different command.",
      );
    }
    if (result.status === "ownership_conflict") {
      return failure(
        "ALREADY_OWNED",
        `Question ${result.ownerQuestionId} already owns an unresolved obligation.`,
      );
    }
    if (result.status === "version_conflict") {
      return failure(
        "VERSION_CONFLICT",
        `Expected version ${expectedVersion}; current version is ${result.currentVersion}.`,
      );
    }
    return { ok: true, value: immutableRecord(result.event.obligation) };
  }

  async function current(command: {
    obligationId: string;
    expectedVersion: number;
  }): Promise<CoverageObligationResult> {
    const found = await readCurrent(command.obligationId);
    if (!found.ok) return found;
    if (found.value.version !== command.expectedVersion) {
      return failure(
        "VERSION_CONFLICT",
        `Expected version ${command.expectedVersion}; current version is ${found.value.version}.`,
      );
    }
    return found;
  }

  async function transition(
    obligation: CoverageObligation,
    idempotencyKey: string,
    commandDigest: string,
    type: CoverageObligationEvent["type"],
    status: ObligationStatus,
    ownerQuestionId: QuestionId | null,
  ): Promise<CoverageObligationResult> {
    const next = immutableRecord({
      ...obligation,
      ownerQuestionId,
      status,
      version: obligation.version + 1,
    });
    return append(
      obligation.version,
      idempotencyKey,
      commandDigest,
      next,
      {
        obligationId: obligation.id,
        type,
        version: next.version,
        previousStatus: obligation.status,
        status,
        ownerQuestionId,
      },
      ownerQuestionId !== null && !isTerminalObligationStatus(status)
        ? ownerQuestionId
        : undefined,
    );
  }

  async function allCurrent(): Promise<
    IngestResult<CoverageObligation[], "CORRUPT_HISTORY">
  > {
    const history = replay(await options.events.readAll());
    if (!history.ok) return history;
    const latest = new Map<string, CoverageObligation>();
    for (const event of history.value)
      latest.set(event.obligationId, event.obligation);
    return { ok: true, value: [...latest.values()].map(immutableRecord) };
  }

  const service: CoverageObligationService = {
    async create(command) {
      if (
        !validText(command.questionId) ||
        !validText(command.trigger) ||
        !validText(command.idempotencyKey) ||
        command.expectedVersion !== 0
      ) {
        return failure(
          "INVALID_COMMAND",
          "Creation requires questionId, trigger, idempotencyKey, and expectedVersion 0.",
        );
      }
      const history = replay(await options.events.readAll());
      if (!history.ok) return history;
      const priorEvent = history.value.find(
        (event) => event.idempotencyKey === command.idempotencyKey,
      );
      if (priorEvent) {
        const ownerQuestionId = command.ownerQuestionId ?? null;
        if (
          priorEvent.type === "created" &&
          priorEvent.version === 1 &&
          priorEvent.obligation.questionId === command.questionId &&
          priorEvent.obligation.trigger === command.trigger.trim() &&
          priorEvent.obligation.ownerQuestionId === ownerQuestionId
        ) {
          return {
            ok: true,
            value: immutableRecord(priorEvent.obligation),
          };
        }
        return failure(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key was already used for a different command.",
        );
      }
      const question = await options.questions.getQuestion(command.questionId);
      if (!question) {
        return failure(
          "QUESTION_NOT_FOUND",
          `Unknown question ${command.questionId}.`,
        );
      }
      const ownerQuestionId = command.ownerQuestionId ?? null;
      if (
        question.origin.kind === "generated" &&
        ownerQuestionId !== command.questionId
      ) {
        return failure(
          "AUTOMATIC_OWNER_REQUIRED",
          "An automatic question must own its coverage obligation.",
        );
      }
      if (ownerQuestionId !== null && !(await ownerExists(ownerQuestionId))) {
        return failure(
          "QUESTION_NOT_FOUND",
          `Unknown owner question ${ownerQuestionId}.`,
        );
      }
      const reservation = await options.events.reserveCreate({
        idempotencyKey: command.idempotencyKey,
        commandDigest: createCommandDigest(command),
        allocateObligationId: () =>
          options.ids.next("obligation") as CoverageObligation["id"],
      });
      if (reservation.status === "idempotency_conflict") {
        return failure(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key was already used for a different command.",
        );
      }
      const reservedHistory = await readHistory(reservation.obligationId);
      if (!reservedHistory.ok) return reservedHistory;
      const committed = reservedHistory.value.at(-1);
      if (committed) {
        if (reservation.status === "reserved") {
          return failure(
            "VERSION_CONFLICT",
            `Reserved obligation ID ${reservation.obligationId} already has history.`,
          );
        }
        return committed.type === "created" &&
          committed.idempotencyKey === command.idempotencyKey &&
          createCommandDigest({
            questionId: committed.obligation.questionId,
            trigger: committed.obligation.trigger,
            ownerQuestionId: committed.obligation.ownerQuestionId,
            expectedVersion: 0,
            idempotencyKey: committed.idempotencyKey,
          }) === createCommandDigest(command)
          ? { ok: true, value: immutableRecord(committed.obligation) }
          : failure(
              "CORRUPT_HISTORY",
              "Reserved create operation points to a conflicting obligation history.",
            );
      }
      const obligation = immutableRecord({
        schemaVersion: 1,
        id: reservation.obligationId,
        questionId: command.questionId,
        trigger: command.trigger,
        ownerQuestionId,
        status: ownerQuestionId === null ? "open" : "assigned",
        version: 1,
      });
      return append(
        0,
        command.idempotencyKey,
        createCommandDigest(command),
        obligation,
        {
          obligationId: obligation.id,
          type: "created",
          version: 1,
          previousStatus: null,
          status: obligation.status,
          ownerQuestionId: obligation.ownerQuestionId,
        },
        obligation.ownerQuestionId ?? undefined,
      );
    },

    async assign(command) {
      if (
        !validText(command.idempotencyKey) ||
        !Number.isInteger(command.expectedVersion) ||
        command.expectedVersion < 0
      ) {
        return failure(
          "INVALID_COMMAND",
          "Assignment requires an idempotency key.",
        );
      }
      const retry = await acknowledgedRetry(
        command.obligationId,
        command.expectedVersion,
        command.idempotencyKey,
        (event) =>
          event.type === "assigned" &&
          event.ownerQuestionId === command.ownerQuestionId,
      );
      if (retry) return retry;
      const found = await current(command);
      if (!found.ok) return found;
      if (found.value.ownerQuestionId !== null) {
        return failure(
          "ALREADY_OWNED",
          `Coverage obligation ${found.value.id} already has a canonical owner.`,
        );
      }
      if (found.value.status !== "open") {
        return failure(
          "INVALID_TRANSITION",
          `Cannot assign status ${found.value.status}.`,
        );
      }
      if (!validText(command.ownerQuestionId)) {
        return failure(
          "INVALID_COMMAND",
          "Assignment requires an owner question.",
        );
      }
      if (!(await ownerExists(command.ownerQuestionId))) {
        return failure(
          "QUESTION_NOT_FOUND",
          `Unknown owner ${command.ownerQuestionId}.`,
        );
      }
      return transition(
        found.value,
        command.idempotencyKey,
        JSON.stringify(command),
        "assigned",
        "assigned",
        command.ownerQuestionId as QuestionId,
      );
    },

    async transfer(command) {
      if (
        !validText(command.idempotencyKey) ||
        !Number.isInteger(command.expectedVersion) ||
        command.expectedVersion < 0
      ) {
        return failure(
          "INVALID_COMMAND",
          "Transfer requires an idempotency key.",
        );
      }
      const retry = await acknowledgedRetry(
        command.obligationId,
        command.expectedVersion,
        command.idempotencyKey,
        (event) =>
          event.type === "transferred" &&
          event.ownerQuestionId === command.ownerQuestionId,
      );
      if (retry) return retry;
      const found = await current(command);
      if (!found.ok) return found;
      if (
        found.value.ownerQuestionId === null ||
        isTerminalObligationStatus(found.value.status)
      ) {
        return failure(
          "INVALID_TRANSITION",
          `Cannot transfer status ${found.value.status}.`,
        );
      }
      if (
        !validText(command.ownerQuestionId) ||
        found.value.ownerQuestionId === command.ownerQuestionId
      ) {
        return failure(
          "INVALID_COMMAND",
          "Transfer requires a different owner.",
        );
      }
      if (!(await ownerExists(command.ownerQuestionId))) {
        return failure(
          "QUESTION_NOT_FOUND",
          `Unknown owner ${command.ownerQuestionId}.`,
        );
      }
      return transition(
        found.value,
        command.idempotencyKey,
        JSON.stringify(command),
        "transferred",
        "transferred",
        command.ownerQuestionId as QuestionId,
      );
    },

    async resolve(command) {
      if (
        !validText(command.idempotencyKey) ||
        !Number.isInteger(command.expectedVersion) ||
        command.expectedVersion < 0
      ) {
        return failure(
          "INVALID_COMMAND",
          "Resolution requires an idempotency key.",
        );
      }
      const requestedStatus: ObligationStatus =
        command.resolution === "budget_pause" ? "blocked" : command.resolution;
      const retry = await acknowledgedRetry(
        command.obligationId,
        command.expectedVersion,
        command.idempotencyKey,
        (event) =>
          event.type === "resolved" && event.status === requestedStatus,
      );
      if (retry) return retry;
      const found = await current(command);
      if (!found.ok) return found;
      if (isTerminalObligationStatus(found.value.status)) {
        return failure("INVALID_TRANSITION", `${found.value.id} is terminal.`);
      }
      if (
        requestedStatus !== "blocked" &&
        !isTerminalObligationStatus(requestedStatus)
      ) {
        return failure("INVALID_COMMAND", "Unknown obligation resolution.");
      }
      return transition(
        found.value,
        command.idempotencyKey,
        JSON.stringify(command),
        "resolved",
        requestedStatus,
        found.value.ownerQuestionId,
      );
    },

    read: readCurrent,
    events: readHistory,

    async requireOwnedUnresolved(questionId) {
      const question = await options.questions.getQuestion(questionId);
      const all = await allCurrent();
      if (!all.ok) return all;
      const owned = all.value.filter(
        (obligation) =>
          obligation.ownerQuestionId === questionId &&
          (question?.origin.kind !== "generated" ||
            obligation.questionId === questionId) &&
          !isTerminalObligationStatus(obligation.status),
      );
      if (owned.length === 0) {
        return failure(
          "AUTOMATIC_OWNER_REQUIRED",
          `Question ${questionId} has no owned unresolved obligation.`,
        );
      }
      if (owned.length > 1) {
        return failure(
          "ALREADY_OWNED",
          `Question ${questionId} owns more than one unresolved obligation.`,
        );
      }
      return { ok: true, value: immutableRecord(owned[0]) };
    },

    async ownsUnresolved(questionId) {
      const required = await service.requireOwnedUnresolved(questionId);
      if (required.ok) return { ok: true, value: true };
      if (required.code === "CORRUPT_HISTORY") {
        return {
          ok: false,
          code: "CORRUPT_HISTORY",
          message: required.message,
        };
      }
      return { ok: true, value: required.code === "ALREADY_OWNED" };
    },

    async blocksClosure(questionId) {
      return service.ownsUnresolved(questionId);
    },
  };

  return service;
}
