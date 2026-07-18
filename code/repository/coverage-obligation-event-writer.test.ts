import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  QuestionRecordSchema,
  type IdGenerator,
  type QuestionRecord,
} from "../domain/index.js";
import {
  CoverageObligationEventSchema,
  type AppendCoverageObligationEventCommand,
} from "../domain/ingest/index.js";
import { createCoverageObligationService } from "../ingest/knowledge/index.js";
import { createFileCoverageObligationEventWriter } from "./index.js";
import { createTestingFileCoverageObligationEventWriter } from "./testing.js";

const QUESTION_ID = "q-01BX5ZZKBKACTAV9WEVGEMMVRZ";
const PARENT_ID = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FINDING_ID = "f-01BX5ZZKBKACTAV9WEVGEMMVS1";
const OBLIGATION_ID = "obl-01BX5ZZKBKACTAV9WEVGEMMVS2";

function generatedQuestion(): QuestionRecord {
  return QuestionRecordSchema.parse({
    schemaVersion: 1,
    id: QUESTION_ID,
    title: "Which replay guarantee remains uncovered?",
    question: "Which replay guarantee remains uncovered?",
    state: "logged",
    tier: "P3",
    priorityRationale: "Automatic coverage branch.",
    prioritySource: "rule",
    goals: ["understand-replay"],
    tags: [],
    askers: [{ id: "ingest-system", acceptance: "pending" }],
    origin: {
      kind: "generated",
      parentQuestionId: PARENT_ID,
      findingId: FINDING_ID,
      goal: "understand-replay",
    },
    depth: 1,
    createdAt: "2026-07-18T10:00:00.000Z",
    updatedAt: "2026-07-18T10:00:00.000Z",
    revision: 0,
    provenance: [],
  });
}

function command(trigger = "replay-integrity") {
  return {
    questionId: QUESTION_ID,
    trigger,
    ownerQuestionId: QUESTION_ID,
    expectedVersion: 0 as const,
    idempotencyKey: "durable-create",
  };
}

function createdAppend(
  commandDigest: string,
): AppendCoverageObligationEventCommand {
  const event = CoverageObligationEventSchema.parse({
    obligationId: OBLIGATION_ID,
    idempotencyKey: "durable-create",
    type: "created",
    version: 1,
    previousStatus: null,
    status: "assigned",
    ownerQuestionId: QUESTION_ID,
    obligation: {
      schemaVersion: 1,
      id: OBLIGATION_ID,
      questionId: QUESTION_ID,
      trigger: "replay-integrity",
      ownerQuestionId: QUESTION_ID,
      status: "assigned",
      version: 1,
    },
  });
  return {
    obligationId: event.obligationId,
    expectedVersion: 0,
    idempotencyKey: event.idempotencyKey,
    commandDigest,
    ...(event.ownerQuestionId
      ? { claimUnresolvedOwnerQuestionId: event.ownerQuestionId }
      : {}),
    event,
  };
}

function service(
  root: string,
  ids: IdGenerator,
  hooks?: Parameters<typeof createTestingFileCoverageObligationEventWriter>[1],
) {
  return createCoverageObligationService({
    questions: {
      getQuestion: (id) =>
        Promise.resolve(id === QUESTION_ID ? generatedQuestion() : undefined),
    },
    ids,
    events: hooks
      ? createTestingFileCoverageObligationEventWriter(root, hooks)
      : createFileCoverageObligationEventWriter(root),
  });
}

describe("filesystem CoverageObligationEventWriter", () => {
  it("keeps fault injection out of the production repository barrel", async () => {
    const repository = await import("./index.js");
    expect("createTestingFileCoverageObligationEventWriter" in repository).toBe(
      false,
    );
    expect("CoverageObligationEventWriterHooks" in repository).toBe(false);
    expect(repository.createFileCoverageObligationEventWriter).toBeTypeOf(
      "function",
    );
    expect(createTestingFileCoverageObligationEventWriter).toBeTypeOf(
      "function",
    );
  });

  it("restarts, replays, and invokes the allocator once for concurrent same-key creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-obligations-"));
    let allocations = 0;
    const ids: IdGenerator = {
      next: () => {
        allocations += 1;
        return OBLIGATION_ID;
      },
    };
    try {
      const [left, right] = await Promise.all([
        service(root, ids).create(command()),
        service(root, ids).create(command()),
      ]);
      expect(left).toEqual(right);
      expect(left).toMatchObject({ ok: true, value: { id: OBLIGATION_ID } });
      expect(allocations).toBe(1);

      await expect(service(root, ids).read(OBLIGATION_ID)).resolves.toEqual(
        left,
      );
      await expect(
        service(root, ids).create(command("different-payload")),
      ).resolves.toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
      expect(allocations).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a reserved create after event publication loses acknowledgement", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-obligation-ack-"));
    let allocations = 0;
    let crash = true;
    const ids: IdGenerator = {
      next: () => {
        allocations += 1;
        return OBLIGATION_ID;
      },
    };
    try {
      const crashing = service(root, ids, {
        afterEventPublished: () => {
          if (!crash) return;
          crash = false;
          throw new Error("simulated acknowledgement loss");
        },
      });
      await expect(crashing.create(command())).rejects.toThrow(
        "simulated acknowledgement loss",
      );

      const restarted = service(root, ids);
      await expect(restarted.create(command())).resolves.toMatchObject({
        ok: true,
        value: { id: OBLIGATION_ID, version: 1 },
      });
      expect(allocations).toBe(1);
      await expect(restarted.events(OBLIGATION_ID)).resolves.toMatchObject({
        ok: true,
        value: [{ version: 1 }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers an ID-less claimed create after a crash before allocation persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-obligation-claim-"));
    let initialAllocations = 0;
    let recoveryAllocations = 0;
    try {
      const crashing = service(
        root,
        {
          next: () => {
            initialAllocations += 1;
            return "obl-01BX5ZZKBKACTAV9WEVGEMMVS9";
          },
        },
        {
          afterClaimPublished: () => {
            throw new Error("simulated crash after claim publication");
          },
        },
      );
      await expect(crashing.create(command())).rejects.toThrow(
        "simulated crash after claim publication",
      );
      expect(initialAllocations).toBe(0);

      const operationDirectory = join(
        root,
        "ingest",
        "coverage-obligation-operations",
      );
      const [operationName] = await readdir(operationDirectory);
      if (!operationName) throw new Error("missing claimed operation");
      await expect(
        readFile(join(operationDirectory, operationName), "utf8").then(
          JSON.parse,
        ),
      ).resolves.toMatchObject({
        idempotencyKey: "durable-create",
        state: "claimed",
        obligationId: null,
      });

      const restarted = service(root, {
        next: () => {
          recoveryAllocations += 1;
          return OBLIGATION_ID;
        },
      });
      const reordered = {
        idempotencyKey: "durable-create",
        expectedVersion: 0 as const,
        ownerQuestionId: QUESTION_ID,
        trigger: "replay-integrity",
        questionId: QUESTION_ID,
      };
      await expect(restarted.create(reordered)).resolves.toMatchObject({
        ok: true,
        value: { id: OBLIGATION_ID, version: 1 },
      });
      expect(recoveryAllocations).toBe(1);
      await expect(restarted.events(OBLIGATION_ID)).resolves.toMatchObject({
        ok: true,
        value: [{ version: 1 }],
      });
      await expect(
        restarted.create(command("different-payload")),
      ).resolves.toMatchObject({
        ok: false,
        code: "IDEMPOTENCY_CONFLICT",
      });
      expect(recoveryAllocations).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed ID-less claims without allocating", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ultradyn-obligation-bad-claim-"),
    );
    let allocations = 0;
    try {
      const writer = createTestingFileCoverageObligationEventWriter(root, {
        afterClaimPublished: () => {
          throw new Error("stop after claim");
        },
      });
      await expect(
        writer.reserveCreate({
          idempotencyKey: "bad-claim",
          commandDigest: "payload-a",
          allocateObligationId: () => {
            allocations += 1;
            return OBLIGATION_ID as never;
          },
        }),
      ).rejects.toThrow("stop after claim");
      const operationDirectory = join(
        root,
        "ingest",
        "coverage-obligation-operations",
      );
      const [operationName] = await readdir(operationDirectory);
      if (!operationName) throw new Error("missing claimed operation");
      const operationPath = join(operationDirectory, operationName);
      await chmod(operationPath, 0o644);
      const malformed = JSON.parse(await readFile(operationPath, "utf8"));
      malformed.eventDigest = "0".repeat(64);
      await writeFile(operationPath, `${JSON.stringify(malformed)}\n`);

      await expect(
        createFileCoverageObligationEventWriter(root).reserveCreate({
          idempotencyKey: "bad-claim",
          commandDigest: "payload-a",
          allocateObligationId: () => {
            allocations += 1;
            return OBLIGATION_ID as never;
          },
        }),
      ).rejects.toThrow();
      expect(allocations).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds a created append to the exact reserved command digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-obligation-digest-"));
    const writer = createFileCoverageObligationEventWriter(root);
    try {
      await expect(writer.append(createdAppend("payload-a"))).resolves.toEqual({
        status: "idempotency_conflict",
      });
      await expect(writer.read(OBLIGATION_ID as never)).resolves.toEqual([]);

      await expect(
        writer.reserveCreate({
          idempotencyKey: "durable-create",
          commandDigest: "payload-a",
          allocateObligationId: () => OBLIGATION_ID as never,
        }),
      ).resolves.toEqual({ status: "reserved", obligationId: OBLIGATION_ID });
      const operationPath = join(
        root,
        "ingest",
        "coverage-obligation-operations",
        `${createHash("sha256").update("durable-create").digest("hex")}.json`,
      );
      const before = await readFile(operationPath);

      await expect(writer.append(createdAppend("payload-b"))).resolves.toEqual({
        status: "idempotency_conflict",
      });
      await expect(writer.read(OBLIGATION_ID as never)).resolves.toEqual([]);
      await expect(readFile(operationPath)).resolves.toEqual(before);

      await expect(
        writer.append(createdAppend("payload-a")),
      ).resolves.toMatchObject({
        status: "appended",
        event: { obligationId: OBLIGATION_ID },
      });
      await expect(writer.read(OBLIGATION_ID as never)).resolves.toHaveLength(
        1,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists reserved intent before append and returns no phantom success", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-obligation-intent-"));
    let allocations = 0;
    const writer = createFileCoverageObligationEventWriter(root);
    const idempotencyKey = "reserved-before-append";
    try {
      const reserved = await writer.reserveCreate({
        idempotencyKey,
        commandDigest: "canonical-command",
        allocateObligationId: () => {
          allocations += 1;
          return OBLIGATION_ID as never;
        },
      });
      expect(reserved).toEqual({
        status: "reserved",
        obligationId: OBLIGATION_ID,
      });
      const operationPath = join(
        root,
        "ingest",
        "coverage-obligation-operations",
        `${createHash("sha256").update(idempotencyKey).digest("hex")}.json`,
      );
      await expect(
        readFile(operationPath, "utf8").then(JSON.parse),
      ).resolves.toMatchObject({
        state: "reserved",
        obligationId: OBLIGATION_ID,
      });
      await expect(writer.read(OBLIGATION_ID as never)).resolves.toEqual([]);

      const restarted = createFileCoverageObligationEventWriter(root);
      await expect(
        restarted.reserveCreate({
          idempotencyKey,
          commandDigest: "canonical-command",
          allocateObligationId: () => {
            allocations += 1;
            return "obl-01BX5ZZKBKACTAV9WEVGEMMVS9" as never;
          },
        }),
      ).resolves.toEqual({
        status: "idempotent",
        obligationId: OBLIGATION_ID,
      });
      expect(allocations).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects valid events planted under the wrong stream across adapter and service reads", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ultradyn-obligation-cross-stream-"),
    );
    const ids: IdGenerator = { next: () => OBLIGATION_ID };
    const wrongStreamId = "obl-01BX5ZZKBKACTAV9WEVGEMMVS3";
    try {
      const created = await service(root, ids).create(command());
      expect(created.ok).toBe(true);
      const sourcePath = join(
        root,
        "ingest",
        "coverage-obligations",
        OBLIGATION_ID,
        "00000001.json",
      );
      const wrongDirectory = join(
        root,
        "ingest",
        "coverage-obligations",
        wrongStreamId,
      );
      await mkdir(wrongDirectory);
      await writeFile(
        join(wrongDirectory, "00000001.json"),
        await readFile(sourcePath),
      );

      const writer = createFileCoverageObligationEventWriter(root);
      await expect(writer.read(wrongStreamId as never)).rejects.toThrow(
        /stream/i,
      );
      await expect(writer.readAll()).rejects.toThrow(/stream/i);
      await expect(
        service(root, ids).create({
          ...command(),
          idempotencyKey: "second-create",
        }),
      ).rejects.toThrow(/stream/i);
      await expect(
        service(root, ids).requireOwnedUnresolved(QUESTION_ID),
      ).rejects.toThrow(/stream/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed event bytes and cross-stream history", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-obligation-corrupt-"));
    const ids: IdGenerator = { next: () => OBLIGATION_ID };
    try {
      const created = await service(root, ids).create(command());
      expect(created.ok).toBe(true);
      const eventPath = join(
        root,
        "ingest",
        "coverage-obligations",
        OBLIGATION_ID,
        "00000001.json",
      );
      await chmod(eventPath, 0o644);
      await writeFile(eventPath, "{not json");
      await expect(service(root, ids).read(OBLIGATION_ID)).rejects.toThrow();

      const operationDirectory = join(
        root,
        "ingest",
        "coverage-obligation-operations",
      );
      const [operationName] = await readdir(operationDirectory);
      if (!operationName) throw new Error("missing operation record");
      const operationPath = join(operationDirectory, operationName);
      await chmod(operationPath, 0o644);
      await writeFile(operationPath, "{not json");
      await expect(service(root, ids).create(command())).rejects.toThrow();

      await rm(root, { recursive: true, force: true });
      await mkdir(join(root, "ingest", "coverage-obligations", OBLIGATION_ID), {
        recursive: true,
      });
      const wrongId = "obl-01BX5ZZKBKACTAV9WEVGEMMVS3";
      const valid = {
        schemaVersion: 1,
        id: wrongId,
        questionId: QUESTION_ID,
        trigger: "replay-integrity",
        ownerQuestionId: QUESTION_ID,
        status: "assigned",
        version: 1,
      };
      await writeFile(
        eventPath,
        `${JSON.stringify({
          obligationId: wrongId,
          idempotencyKey: "cross-stream",
          type: "created",
          version: 1,
          previousStatus: null,
          status: "assigned",
          ownerQuestionId: QUESTION_ID,
          obligation: valid,
        })}\n`,
      );
      await expect(service(root, ids).read(OBLIGATION_ID)).rejects.toThrow(
        /directory stream/i,
      );
      expect(await readFile(eventPath, "utf8")).toContain(wrongId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
