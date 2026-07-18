import { describe, expect, it } from "vitest";

import {
  QuestionRecordSchema,
  type QuestionRecord,
} from "../../domain/index.js";
import {
  CoverageObligationEventSchema,
  isTerminalObligationStatus,
  type AppendCoverageObligationEventCommand,
  type AppendCoverageObligationEventResult,
  type CoverageObligationEvent,
  type CoverageObligationEventWriter,
  type QuestionId,
  type ReserveCoverageObligationCreateCommand,
  type ReserveCoverageObligationCreateResult,
} from "../../domain/ingest/index.js";
import { createCoverageObligationService } from "./index.js";

const PARENT_QUESTION_ID = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const GENERATED_QUESTION_ID = "q-01BX5ZZKBKACTAV9WEVGEMMVRZ";
const OTHER_QUESTION_ID = "q-01BX5ZZKBKACTAV9WEVGEMMVS0";
const FINDING_ID = "f-01BX5ZZKBKACTAV9WEVGEMMVS1";
const OBLIGATION_ID = "obl-01BX5ZZKBKACTAV9WEVGEMMVS2";

interface TestCoverageObligationEventWriter extends CoverageObligationEventWriter {
  serialize(): Uint8Array;
}

function immutableEvent(value: unknown): CoverageObligationEvent {
  const parsed = CoverageObligationEventSchema.parse(value);
  Object.freeze(parsed.obligation);
  return Object.freeze(parsed);
}

function createInMemoryCoverageObligationEventWriter(
  serialized?: Uint8Array,
): TestCoverageObligationEventWriter {
  const decoded: unknown = serialized
    ? JSON.parse(new TextDecoder().decode(serialized))
    : [];
  if (!Array.isArray(decoded)) throw new Error("Invalid event writer bytes.");
  const records = decoded.map(immutableEvent);
  const createReservations = new Map<
    string,
    { commandDigest: string; obligationId: string }
  >();
  for (const event of records) {
    if (event.type !== "created") continue;
    createReservations.set(event.idempotencyKey, {
      commandDigest: JSON.stringify({
        questionId: event.obligation.questionId,
        trigger: event.obligation.trigger,
        ownerQuestionId: event.obligation.ownerQuestionId,
        expectedVersion: 0,
      }),
      obligationId: event.obligationId,
    });
  }
  let queue: Promise<unknown> = Promise.resolve();

  function exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function currentVersion(obligationId: string): number {
    return Math.max(
      0,
      ...records
        .filter((event) => event.obligationId === obligationId)
        .map((event) => event.version),
    );
  }

  return {
    reserveCreate(command: ReserveCoverageObligationCreateCommand) {
      return exclusive((): ReserveCoverageObligationCreateResult => {
        const prior = createReservations.get(command.idempotencyKey);
        if (prior) {
          return prior.commandDigest === command.commandDigest
            ? {
                status: "idempotent",
                obligationId: prior.obligationId as never,
              }
            : { status: "idempotency_conflict" };
        }
        const obligationId = command.allocateObligationId();
        createReservations.set(command.idempotencyKey, {
          commandDigest: command.commandDigest,
          obligationId,
        });
        return { status: "reserved", obligationId };
      });
    },
    append(command: AppendCoverageObligationEventCommand) {
      return exclusive((): AppendCoverageObligationEventResult => {
        const expectedVersion = command.expectedVersion;
        if (
          command.obligationId !== command.event.obligationId ||
          command.obligationId !== command.event.obligation.id ||
          command.idempotencyKey !== command.event.idempotencyKey ||
          command.event.version !== expectedVersion + 1 ||
          command.event.obligation.version !== command.event.version ||
          command.event.obligation.status !== command.event.status ||
          command.event.obligation.ownerQuestionId !==
            command.event.ownerQuestionId
        ) {
          throw new Error(
            "Coverage-obligation append command and event disagree.",
          );
        }
        const prior = records.find(
          (event) => event.idempotencyKey === command.idempotencyKey,
        );
        if (prior) {
          const same =
            command.obligationId === prior.obligationId &&
            expectedVersion === prior.version - 1 &&
            JSON.stringify(command.event) === JSON.stringify(prior);
          return same
            ? { status: "idempotent", event: immutableEvent(prior) }
            : { status: "idempotency_conflict" };
        }
        const version = currentVersion(command.obligationId);
        if (version !== expectedVersion) {
          return { status: "version_conflict", currentVersion: version };
        }
        if (command.claimUnresolvedOwnerQuestionId) {
          const latest = new Map<string, CoverageObligationEvent>();
          for (const event of records) latest.set(event.obligationId, event);
          if (
            [...latest.values()].some(
              (event) =>
                event.obligationId !== command.obligationId &&
                event.ownerQuestionId ===
                  command.claimUnresolvedOwnerQuestionId &&
                !isTerminalObligationStatus(event.status),
            )
          ) {
            return {
              status: "ownership_conflict",
              ownerQuestionId:
                command.claimUnresolvedOwnerQuestionId as QuestionId,
            };
          }
        }
        const event = immutableEvent(command.event);
        records.push(event);
        return { status: "appended", event };
      });
    },
    read(obligationId) {
      return Promise.resolve(
        records
          .filter((event) => event.obligationId === obligationId)
          .map(immutableEvent),
      );
    },
    readAll() {
      return Promise.resolve(records.map(immutableEvent));
    },
    serialize() {
      return new TextEncoder().encode(JSON.stringify(records));
    },
  };
}

function question(
  id: string,
  origin: QuestionRecord["origin"],
): QuestionRecord {
  return QuestionRecordSchema.parse({
    schemaVersion: 1,
    id,
    title: "Which replay guarantee is still uncovered?",
    question: "Which replay guarantee is still uncovered?",
    state: "logged",
    tier: "P3",
    priorityRationale: "Automatic coverage branch.",
    prioritySource: "rule",
    goals: ["understand-replay"],
    tags: [],
    askers: [{ id: "ingest-system", acceptance: "pending" }],
    origin,
    depth: origin.kind === "generated" ? 1 : 0,
    createdAt: "2026-07-18T10:00:00.000Z",
    updatedAt: "2026-07-18T10:00:00.000Z",
    revision: 0,
    provenance: [],
  });
}

function fixture(
  events: CoverageObligationEventWriter = createInMemoryCoverageObligationEventWriter(),
) {
  const records = [
    question(PARENT_QUESTION_ID, { kind: "raw" }),
    question(GENERATED_QUESTION_ID, {
      kind: "generated",
      parentQuestionId: PARENT_QUESTION_ID,
      findingId: FINDING_ID,
      goal: "understand-replay",
    }),
    question(OTHER_QUESTION_ID, { kind: "raw" }),
  ];
  const byId = new Map(records.map((record) => [record.id, record]));
  let nextId = OBLIGATION_ID;
  let idCalls = 0;
  const makeService = () =>
    createCoverageObligationService({
      questions: {
        getQuestion: (id: string) => Promise.resolve(byId.get(id)),
      },
      ids: {
        next: () => {
          idCalls += 1;
          return nextId;
        },
      },
      events,
    });
  return {
    service: makeService(),
    makeService,
    events,
    records,
    idCalls: () => idCalls,
    useId(id: string) {
      nextId = id;
    },
  };
}

async function createAssigned(
  service: ReturnType<typeof createCoverageObligationService>,
  idempotencyKey = "create-generated",
) {
  return service.create({
    questionId: GENERATED_QUESTION_ID,
    trigger: "unit-replay-guarantee",
    ownerQuestionId: GENERATED_QUESTION_ID,
    expectedVersion: 0,
    idempotencyKey,
  });
}

describe("coverage-obligation public seam", () => {
  it("exports production schemas, writer contract, service, and finite statuses", async () => {
    const domain = await import("../../domain/ingest/index.js");
    const knowledge = await import("./index.js");

    expect(domain.COVERAGE_OBLIGATION_TERMINAL_STATUSES).toEqual([
      "satisfied",
      "terminal_gap",
      "excluded",
      "deferred",
      "revoked",
    ]);
    expect(domain.CoverageObligationRecordSchema.parse).toBeTypeOf("function");
    expect(domain.CoverageObligationEventSchema.parse).toBeTypeOf("function");
    expect(domain.ObligationStatusSchema.options).toEqual([
      "open",
      "assigned",
      "satisfied",
      "terminal_gap",
      "excluded",
      "deferred",
      "blocked",
      "transferred",
      "revoked",
    ]);
    expect(domain.CoverageObligationEventTypeSchema.options).toEqual([
      "created",
      "assigned",
      "transferred",
      "resolved",
    ]);
    expect("createInMemoryCoverageObligationEventWriter" in domain).toBe(false);
    expect("createFakeCoverageObligationEventWriter" in domain).toBe(false);
    expect(domain.ingestSchemaRegistry.names()).toContain("CoverageObligation");
    expect(knowledge.createCoverageObligationService).toBeTypeOf("function");
  });

  it("requires explicit expected versions without allocating an id", async () => {
    const { service, idCalls } = fixture();
    await expect(
      service.create({
        questionId: PARENT_QUESTION_ID,
        trigger: "missing-create-version",
        idempotencyKey: "missing-create-version",
      } as never),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_COMMAND" });
    expect(idCalls()).toBe(0);

    const opened = await service.create({
      questionId: PARENT_QUESTION_ID,
      trigger: "explicit-create-version",
      expectedVersion: 0,
      idempotencyKey: "explicit-create-version",
    });
    if (!opened.ok) throw new Error("open creation unexpectedly failed");
    expect(idCalls()).toBe(1);

    await expect(
      service.assign({
        obligationId: opened.value.id,
        ownerQuestionId: OTHER_QUESTION_ID,
        idempotencyKey: "missing-assign-version",
      } as never),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_COMMAND" });
    await expect(
      service.transfer({
        obligationId: opened.value.id,
        ownerQuestionId: OTHER_QUESTION_ID,
        idempotencyKey: "missing-transfer-version",
      } as never),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_COMMAND" });
    await expect(
      service.resolve({
        obligationId: opened.value.id,
        resolution: "satisfied",
        idempotencyKey: "missing-resolve-version",
      } as never),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_COMMAND" });
    await expect(
      service.resolve({
        obligationId: opened.value.id,
        resolution: "revoked",
        idempotencyKey: "missing-revoke-version",
      } as never),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_COMMAND" });
  });

  it("rejects stale create, assign, transfer, resolve, and revoke versions", async () => {
    const { service } = fixture();
    const opened = await service.create({
      questionId: PARENT_QUESTION_ID,
      trigger: "versioned-branch",
      expectedVersion: 0,
      idempotencyKey: "versioned-create",
    });
    if (!opened.ok) throw new Error("open creation unexpectedly failed");

    await expect(
      service.create({
        questionId: PARENT_QUESTION_ID,
        trigger: "stale-create",
        expectedVersion: 0,
        idempotencyKey: "stale-create",
      }),
    ).resolves.toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    const assigned = await service.assign({
      obligationId: opened.value.id,
      ownerQuestionId: OTHER_QUESTION_ID,
      expectedVersion: 1,
      idempotencyKey: "versioned-assign",
    });
    if (!assigned.ok) throw new Error("assignment unexpectedly failed");
    await expect(
      service.assign({
        obligationId: opened.value.id,
        ownerQuestionId: PARENT_QUESTION_ID,
        expectedVersion: 1,
        idempotencyKey: "stale-assign",
      }),
    ).resolves.toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    const transferred = await service.transfer({
      obligationId: opened.value.id,
      ownerQuestionId: PARENT_QUESTION_ID,
      expectedVersion: 2,
      idempotencyKey: "versioned-transfer",
    });
    if (!transferred.ok) throw new Error("transfer unexpectedly failed");
    await expect(
      service.transfer({
        obligationId: opened.value.id,
        ownerQuestionId: GENERATED_QUESTION_ID,
        expectedVersion: 2,
        idempotencyKey: "stale-transfer",
      }),
    ).resolves.toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    await expect(
      service.resolve({
        obligationId: opened.value.id,
        resolution: "satisfied",
        expectedVersion: 2,
        idempotencyKey: "stale-resolve",
      }),
    ).resolves.toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    await expect(
      service.resolve({
        obligationId: opened.value.id,
        resolution: "revoked",
        expectedVersion: 2,
        idempotencyKey: "stale-revoke",
      }),
    ).resolves.toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
  });

  it("reserves one generated ID for concurrent same-key creates and binds the key to its payload", async () => {
    const writer = createInMemoryCoverageObligationEventWriter();
    let sequence = 2;
    let allocations = 0;
    const makeService = () =>
      createCoverageObligationService({
        questions: {
          getQuestion: (id) =>
            Promise.resolve(
              id === GENERATED_QUESTION_ID
                ? question(GENERATED_QUESTION_ID, {
                    kind: "generated",
                    parentQuestionId: PARENT_QUESTION_ID,
                    findingId: FINDING_ID,
                    goal: "understand-replay",
                  })
                : undefined,
            ),
        },
        ids: {
          next: () => {
            allocations += 1;
            return `obl-01BX5ZZKBKACTAV9WEVGEMMVS${sequence++}`;
          },
        },
        events: writer,
      });
    const command = {
      questionId: GENERATED_QUESTION_ID,
      trigger: "unit-replay-guarantee",
      ownerQuestionId: GENERATED_QUESTION_ID,
      expectedVersion: 0 as const,
      idempotencyKey: "concurrent-global-create",
    };

    const [left, right] = await Promise.all([
      makeService().create(command),
      makeService().create(command),
    ]);

    expect(left).toEqual(right);
    expect(left).toMatchObject({ ok: true, value: { version: 1 } });
    expect(allocations).toBe(1);
    expect(await writer.readAll()).toHaveLength(1);
    await expect(
      makeService().create({ ...command, trigger: "different payload" }),
    ).resolves.toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
  });

  it("makes compare-and-append atomic across service instances", async () => {
    const { service, makeService } = fixture();
    const created = await createAssigned(service);
    if (!created.ok) throw new Error("creation unexpectedly failed");

    const otherService = makeService();
    const [transfer, resolve] = await Promise.all([
      service.transfer({
        obligationId: created.value.id,
        ownerQuestionId: OTHER_QUESTION_ID,
        expectedVersion: 1,
        idempotencyKey: "concurrent-transfer",
      }),
      otherService.resolve({
        obligationId: created.value.id,
        resolution: "satisfied",
        expectedVersion: 1,
        idempotencyKey: "concurrent-resolve",
      }),
    ]);

    expect([transfer, resolve].filter((result) => result.ok)).toHaveLength(1);
    expect([transfer, resolve].filter((result) => !result.ok)).toMatchObject([
      { code: "VERSION_CONFLICT" },
    ]);
    const history = await service.events(created.value.id);
    expect(history).toMatchObject({ ok: true });
    if (!history.ok) throw new Error("history unexpectedly corrupt");
    expect(history.value.map((event) => event.version)).toEqual([1, 2]);
    const current = await service.read(created.value.id);
    expect(current).toMatchObject({ ok: true, value: { version: 2 } });
  });

  it("fails closed when replay sees malformed, unordered, or conflicting history", async () => {
    const base = fixture();
    const created = await createAssigned(base.service);
    if (!created.ok) throw new Error("creation unexpectedly failed");
    const valid = await base.events.read(created.value.id);
    const createdEvent = structuredClone(valid[0]) as CoverageObligationEvent;

    const corruptions: unknown[][] = [
      [{ ...createdEvent, obligationId: "not-an-obligation-id" }],
      [createdEvent, { ...createdEvent, version: 3 }],
      [
        createdEvent,
        {
          ...createdEvent,
          type: "resolved",
          version: 2,
          previousStatus: "open",
          status: "satisfied",
          obligation: {
            ...createdEvent.obligation,
            status: "satisfied",
            version: 2,
          },
        },
      ],
      [
        createdEvent,
        {
          ...createdEvent,
          type: "resolved",
          version: 2,
          previousStatus: "assigned",
          status: "satisfied",
          idempotencyKey: createdEvent.idempotencyKey,
          obligation: {
            ...createdEvent.obligation,
            questionId: OTHER_QUESTION_ID,
            status: "satisfied",
            version: 2,
          },
        },
      ],
    ];

    for (const history of corruptions) {
      const writer: CoverageObligationEventWriter = {
        reserveCreate: () => Promise.reject(new Error("unused")),
        append: () => Promise.reject(new Error("unused")),
        read: () => Promise.resolve(history),
        readAll: () => Promise.resolve(history),
      };
      const { service } = fixture(writer);
      await expect(service.read(OBLIGATION_ID)).resolves.toMatchObject({
        ok: false,
        code: "CORRUPT_HISTORY",
      });
      await expect(service.events(OBLIGATION_ID)).resolves.toMatchObject({
        ok: false,
        code: "CORRUPT_HISTORY",
      });
    }
  });

  it("rejects cross-wired reads and mismatched atomic append commands", async () => {
    const base = fixture();
    const created = await createAssigned(base.service);
    if (!created.ok) throw new Error("creation unexpectedly failed");
    const raw = (await base.events.read(created.value.id))[0];

    const crossWired = fixture({
      reserveCreate: () => Promise.reject(new Error("unused")),
      append: () => Promise.reject(new Error("unused")),
      read: () => Promise.resolve([raw]),
      readAll: () => Promise.resolve([raw]),
    }).service;
    await expect(
      crossWired.read("obl-01BX5ZZKBKACTAV9WEVGEMMVS9"),
    ).resolves.toMatchObject({ ok: false, code: "CORRUPT_HISTORY" });

    const writer = createInMemoryCoverageObligationEventWriter();
    await expect(
      writer.append({
        obligationId: OBLIGATION_ID as never,
        idempotencyKey: "missing-writer-version",
        event: raw as CoverageObligationEvent,
      } as never),
    ).rejects.toThrow("append command");
    await expect(
      writer.append({
        obligationId: "obl-01BX5ZZKBKACTAV9WEVGEMMVS9" as never,
        expectedVersion: 0,
        idempotencyKey: "mismatched-envelope",
        commandDigest: "mismatched-envelope",
        event: raw as CoverageObligationEvent,
      }),
    ).rejects.toThrow("append command");
    await expect(
      writer.append({
        obligationId: OBLIGATION_ID as never,
        expectedVersion: 0,
        idempotencyKey: "poisoned-envelope",
        commandDigest: "poisoned-envelope",
        event: {
          ...(raw as CoverageObligationEvent),
          idempotencyKey: "poisoned-envelope",
          status: "satisfied",
        },
      }),
    ).rejects.toThrow("append command");
  });

  it("reconstructs defensive deep immutable records and events", async () => {
    const { service, events } = fixture();
    const created = await createAssigned(service);
    if (!created.ok) throw new Error("creation unexpectedly failed");

    const stored = (await events.read(created.value.id))[0] as {
      obligation: { status: string };
    };
    expect(Reflect.set(stored.obligation, "status", "satisfied")).toBe(false);

    const read = await service.read(created.value.id);
    if (!read.ok) throw new Error("read unexpectedly failed");
    expect(Reflect.set(read.value, "status", "satisfied")).toBe(false);
    const history = await service.events(created.value.id);
    if (!history.ok) throw new Error("events unexpectedly failed");
    expect(Reflect.set(history.value[0]!, "status", "satisfied")).toBe(false);
    expect(
      Reflect.set(history.value[0]!.obligation, "status", "satisfied"),
    ).toBe(false);
    await expect(service.read(created.value.id)).resolves.toEqual(created);
  });

  it("guards automatic branching with exactly one owned unresolved obligation", async () => {
    const { service, useId } = fixture();
    await expect(
      service.requireOwnedUnresolved(GENERATED_QUESTION_ID),
    ).resolves.toMatchObject({ ok: false, code: "AUTOMATIC_OWNER_REQUIRED" });
    await expect(
      service.create({
        questionId: GENERATED_QUESTION_ID,
        trigger: "wrong-owner",
        ownerQuestionId: OTHER_QUESTION_ID,
        expectedVersion: 0,
        idempotencyKey: "wrong-owner",
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "AUTOMATIC_OWNER_REQUIRED",
    });

    const created = await createAssigned(service);
    if (!created.ok) throw new Error("creation unexpectedly failed");
    await expect(
      service.requireOwnedUnresolved(GENERATED_QUESTION_ID),
    ).resolves.toMatchObject({
      ok: true,
      value: { status: "assigned" },
    });
    await expect(
      service.requireOwnedUnresolved(OTHER_QUESTION_ID),
    ).resolves.toMatchObject({ ok: false, code: "AUTOMATIC_OWNER_REQUIRED" });

    const paused = await service.resolve({
      obligationId: created.value.id,
      resolution: "budget_pause",
      expectedVersion: 1,
      idempotencyKey: "pause",
    });
    expect(paused).toMatchObject({ ok: true, value: { status: "blocked" } });
    await expect(
      service.requireOwnedUnresolved(GENERATED_QUESTION_ID),
    ).resolves.toMatchObject({ ok: true, value: { status: "blocked" } });

    const terminal = await service.resolve({
      obligationId: created.value.id,
      resolution: "deferred",
      expectedVersion: 2,
      idempotencyKey: "defer",
    });
    expect(terminal).toMatchObject({ ok: true, value: { status: "deferred" } });
    await expect(
      service.requireOwnedUnresolved(GENERATED_QUESTION_ID),
    ).resolves.toMatchObject({ ok: false, code: "AUTOMATIC_OWNER_REQUIRED" });

    useId("obl-01BX5ZZKBKACTAV9WEVGEMMVS3");
    const first = await service.create({
      questionId: PARENT_QUESTION_ID,
      trigger: "first",
      ownerQuestionId: OTHER_QUESTION_ID,
      expectedVersion: 0,
      idempotencyKey: "first-other",
    });
    expect(first).toMatchObject({ ok: true });
    useId("obl-01BX5ZZKBKACTAV9WEVGEMMVS4");
    await expect(
      service.create({
        questionId: PARENT_QUESTION_ID,
        trigger: "second",
        ownerQuestionId: OTHER_QUESTION_ID,
        expectedVersion: 0,
        idempotencyKey: "second-other",
      }),
    ).resolves.toMatchObject({ ok: false, code: "ALREADY_OWNED" });
  });

  it("does not satisfy an automatic branch guard through unrelated ownership", async () => {
    const { service } = fixture();
    await expect(
      service.create({
        questionId: PARENT_QUESTION_ID,
        trigger: "raw-question-obligation",
        ownerQuestionId: GENERATED_QUESTION_ID,
        expectedVersion: 0,
        idempotencyKey: "raw-question-generated-owner",
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      service.requireOwnedUnresolved(GENERATED_QUESTION_ID),
    ).resolves.toMatchObject({
      ok: false,
      code: "AUTOMATIC_OWNER_REQUIRED",
    });
    await expect(
      service.ownsUnresolved(GENERATED_QUESTION_ID),
    ).resolves.toEqual({ ok: true, value: false });
    await expect(service.blocksClosure(GENERATED_QUESTION_ID)).resolves.toEqual(
      { ok: true, value: false },
    );
  });

  it("fails closed when a generated owner has two unresolved obligations", async () => {
    const first = fixture();
    const created = await createAssigned(first.service);
    if (!created.ok) throw new Error("creation unexpectedly failed");
    const firstEvent = (
      await first.events.readAll()
    )[0] as CoverageObligationEvent;
    const secondEvent: CoverageObligationEvent = {
      ...structuredClone(firstEvent),
      obligationId: "obl-01BX5ZZKBKACTAV9WEVGEMMVS3" as never,
      idempotencyKey: "corrupt-second-generated",
      obligation: {
        ...structuredClone(firstEvent.obligation),
        id: "obl-01BX5ZZKBKACTAV9WEVGEMMVS3" as never,
        questionId: GENERATED_QUESTION_ID as never,
        trigger: "second-unresolved-branch",
      },
    };
    const corruptWriter: CoverageObligationEventWriter = {
      reserveCreate: () => Promise.reject(new Error("unused")),
      append: () => Promise.reject(new Error("unused")),
      read: (id) =>
        Promise.resolve(
          [firstEvent, secondEvent].filter(
            (event) => event.obligationId === id,
          ),
        ),
      readAll: () => Promise.resolve([firstEvent, secondEvent]),
    };
    const service = fixture(corruptWriter).service;

    await expect(
      service.requireOwnedUnresolved(GENERATED_QUESTION_ID),
    ).resolves.toMatchObject({ ok: false, code: "ALREADY_OWNED" });
    await expect(
      service.ownsUnresolved(GENERATED_QUESTION_ID),
    ).resolves.toEqual({ ok: true, value: true });
    await expect(service.blocksClosure(GENERATED_QUESTION_ID)).resolves.toEqual(
      { ok: true, value: true },
    );
  });

  it("atomically rejects concurrent unresolved ownership for one question", async () => {
    const { service, makeService, useId } = fixture();
    const first = await service.create({
      questionId: PARENT_QUESTION_ID,
      trigger: "first-concurrent-branch",
      ownerQuestionId: null,
      expectedVersion: 0,
      idempotencyKey: "create-first-open",
    });
    if (!first.ok) throw new Error("first open creation unexpectedly failed");
    useId("obl-01BX5ZZKBKACTAV9WEVGEMMVS3");
    const second = await service.create({
      questionId: PARENT_QUESTION_ID,
      trigger: "second-concurrent-branch",
      ownerQuestionId: null,
      expectedVersion: 0,
      idempotencyKey: "create-second-open",
    });
    if (!second.ok) throw new Error("second open creation unexpectedly failed");

    const results = await Promise.all([
      service.assign({
        obligationId: first.value.id,
        ownerQuestionId: OTHER_QUESTION_ID,
        expectedVersion: 1,
        idempotencyKey: "assign-first-concurrent-owner",
      }),
      makeService().assign({
        obligationId: second.value.id,
        ownerQuestionId: OTHER_QUESTION_ID,
        expectedVersion: 1,
        idempotencyKey: "assign-second-concurrent-owner",
      }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([
      { code: "ALREADY_OWNED" },
    ]);
  });

  it("recovers create acknowledgement loss without allocating a duplicate obligation", async () => {
    const records = [
      question(GENERATED_QUESTION_ID, {
        kind: "generated",
        parentQuestionId: PARENT_QUESTION_ID,
        findingId: FINDING_ID,
        goal: "understand-replay",
      }),
    ];
    const writer = createInMemoryCoverageObligationEventWriter();
    let loseAcknowledgement = true;
    const ackLossWriter: CoverageObligationEventWriter = {
      reserveCreate: (command) => writer.reserveCreate(command),
      append: async (command) => {
        const result = await writer.append(command);
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error("create acknowledgement lost");
        }
        return result;
      },
      read: (id) => writer.read(id),
      readAll: () => writer.readAll(),
    };
    let sequence = 2;
    const service = createCoverageObligationService({
      questions: {
        getQuestion: (id) =>
          Promise.resolve(records.find((record) => record.id === id)),
      },
      ids: {
        next: () => `obl-01BX5ZZKBKACTAV9WEVGEMMVS${sequence++}`,
      },
      events: ackLossWriter,
    });
    const command = {
      questionId: GENERATED_QUESTION_ID,
      trigger: "unit-replay-guarantee",
      ownerQuestionId: GENERATED_QUESTION_ID,
      expectedVersion: 0 as const,
      idempotencyKey: "create-ack-loss",
    };

    await expect(service.create(command)).rejects.toThrow(
      "create acknowledgement lost",
    );
    await expect(service.create(command)).resolves.toMatchObject({
      ok: true,
      value: { id: OBLIGATION_ID },
    });
    await expect(
      service.create({ ...command, trigger: "different-command" }),
    ).resolves.toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(await writer.readAll()).toHaveLength(1);
  });

  it("recovers serialized history and makes acknowledgement-loss retries idempotent", async () => {
    const initialWriter = createInMemoryCoverageObligationEventWriter();
    const initial = fixture(initialWriter);
    const created = await createAssigned(initial.service);
    if (!created.ok) throw new Error("creation unexpectedly failed");

    const recoveredWriter = createInMemoryCoverageObligationEventWriter(
      initialWriter.serialize(),
    );
    const recovered = fixture(recoveredWriter);
    await expect(recovered.service.read(created.value.id)).resolves.toEqual(
      created,
    );

    let loseAcknowledgement = true;
    const ackLossWriter: CoverageObligationEventWriter = {
      reserveCreate: (command) => recoveredWriter.reserveCreate(command),
      append: async (command) => {
        const result = await recoveredWriter.append(command);
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error("acknowledgement lost");
        }
        return result;
      },
      read: (id) => recoveredWriter.read(id),
      readAll: () => recoveredWriter.readAll(),
    };
    const afterRestart = fixture(ackLossWriter).service;
    const transition = {
      obligationId: created.value.id,
      resolution: "terminal_gap" as const,
      expectedVersion: 1,
      idempotencyKey: "resolve-after-restart",
    };
    await expect(afterRestart.resolve(transition)).rejects.toThrow(
      "acknowledgement lost",
    );
    await expect(afterRestart.resolve(transition)).resolves.toMatchObject({
      ok: true,
      value: { status: "terminal_gap", version: 2 },
    });
    await expect(
      afterRestart.resolve({
        ...transition,
        resolution: "satisfied",
        idempotencyKey: "different-stale-command",
      }),
    ).resolves.toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    const history = await afterRestart.events(created.value.id);
    expect(history).toMatchObject({ ok: true });
    if (history.ok) expect(history.value).toHaveLength(2);
  });

  it("keeps deferred question state independent and unrelated closure unblocked", async () => {
    const { service, records } = fixture();
    const originalQuestion = structuredClone(records[1]);
    const created = await createAssigned(service);
    if (!created.ok) throw new Error("creation unexpectedly failed");

    await expect(
      service.resolve({
        obligationId: created.value.id,
        resolution: "deferred",
        expectedVersion: 1,
        idempotencyKey: "deferred",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { status: "deferred", version: 2 },
    });
    expect(records[1]).toEqual(originalQuestion);
    expect(records[1]?.state).toBe("logged");
    await expect(service.blocksClosure(GENERATED_QUESTION_ID)).resolves.toEqual(
      {
        ok: true,
        value: false,
      },
    );
    await expect(service.blocksClosure(OTHER_QUESTION_ID)).resolves.toEqual({
      ok: true,
      value: false,
    });
  });
});
