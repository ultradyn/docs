import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyQuestionTransition,
  QuestionRecordSchema,
  type QuestionRecord,
} from "../../domain/index.js";
import {
  createFileQuestionLinkStore,
  KnowledgeRepository,
} from "../../repository/index.js";
import {
  createInMemoryQuestionLinkStore,
  createQuestionLinkService,
  type QuestionLinkService,
} from "./index.js";

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

const storedHumanLink = {
  schemaVersion: 1,
  ...humanLinkInput,
  createdRevision: 0,
} as const;

describe("public seams", () => {
  it("exposes link services and stores through directory barrels", async () => {
    const domainIngest = await import("../../domain/ingest/index.js");
    const repository = await import("../../repository/index.js");
    const knowledge = await import("./index.js");
    expect(typeof repository.createFileQuestionLinkStore).toBe("function");
    expect(typeof repository.QuestionNotFoundError).toBe("function");
    expect(typeof repository.withRepositoryLock).toBe("function");
    expect(typeof knowledge.createQuestionLinkService).toBe("function");
    expect(typeof knowledge.createInMemoryQuestionLinkStore).toBe("function");
    expect(domainIngest.IngestionQuestionLinkSchema).toBeDefined();
    expect(domainIngest.QuestionLinkInputSchema).toBeDefined();
  });
});

describe("filesystem QuestionLinkStore", () => {
  it("reloads a Git-portable link after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-question-links-"));
    try {
      const initial = createFileQuestionLinkStore(root);
      await initial.create(storedHumanLink);

      const restarted = createFileQuestionLinkStore(root);
      await expect(restarted.get(HUMAN_QUESTION_ID)).resolves.toEqual(
        storedHumanLink,
      );
      await expect(
        restarted.create({ ...storedHumanLink, snapshotId: "snap-rewritten" }),
      ).resolves.toBe(false);
      await expect(
        readFile(
          join(
            root,
            "ingest",
            "question-links",
            `${HUMAN_QUESTION_ID}.json`,
          ),
          "utf8",
        ).then(JSON.parse),
      ).resolves.toEqual(storedHumanLink);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers an interrupted temporary write before creating a link", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-question-links-"));
    const directory = join(root, "ingest", "question-links");
    const temporaryPath = join(directory, `.${HUMAN_QUESTION_ID}.json.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, '{"schemaVersion":1');

      const initial = createFileQuestionLinkStore(root);
      await expect(initial.get(HUMAN_QUESTION_ID)).resolves.toBeUndefined();
      await expect(initial.create(storedHumanLink)).resolves.toBe(true);

      const restarted = createFileQuestionLinkStore(root);
      await expect(restarted.get(HUMAN_QUESTION_ID)).resolves.toEqual(
        storedHumanLink,
      );
      await expect(readFile(temporaryPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid portable records at the public create boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-question-links-"));
    try {
      const store = createFileQuestionLinkStore(root);
      await expect(
        store.create({ ...storedHumanLink, generation: -1 } as never),
      ).rejects.toThrow();
      await expect(
        store.create({
          ...storedHumanLink,
          state: "accepted",
        } as never),
      ).rejects.toThrow();
      await expect(store.get(HUMAN_QUESTION_ID)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never follows a symlink planted at the destination or temp path", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-question-links-"));
    const directory = join(root, "ingest", "question-links");
    const victimPath = join(root, "victim.json");
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(victimPath, '"victim-bytes"');
      await symlink(victimPath, join(directory, `${HUMAN_QUESTION_ID}.json`));

      const store = createFileQuestionLinkStore(root);
      await expect(store.get(HUMAN_QUESTION_ID)).rejects.toThrow(/symbolic/i);
      await expect(store.create(storedHumanLink)).rejects.toThrow(/symbolic/i);
      await expect(readFile(victimPath, "utf8")).resolves.toBe(
        '"victim-bytes"',
      );

      await rm(join(directory, `${HUMAN_QUESTION_ID}.json`));
      await symlink(victimPath, join(directory, `.${HUMAN_QUESTION_ID}.json.tmp`));
      await expect(store.create(storedHumanLink)).resolves.toBe(true);
      await expect(readFile(victimPath, "utf8")).resolves.toBe(
        '"victim-bytes"',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes with no-replace semantics under competing writers", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-question-links-"));
    try {
      const store = createFileQuestionLinkStore(root);
      const rival = {
        ...storedHumanLink,
        snapshotId: "snap-rival",
      } as const;
      const outcomes = await Promise.all([
        store.create(storedHumanLink),
        store.create(rival),
      ]);
      expect(outcomes.filter(Boolean)).toHaveLength(1);

      const persisted = await store.get(HUMAN_QUESTION_ID);
      const winner = outcomes[0] ? storedHumanLink : rival;
      expect(persisted).toEqual(winner);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")(
    "keeps reading from the verified directory when an ancestor is swapped mid-operation",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ultradyn-question-links-"));
      const lockRoot = await mkdtemp(join(tmpdir(), "ultradyn-lock-root-"));
      const attacker = join(root, "attacker-target");
      let swap: (() => Promise<void>) | undefined;
      try {
        const store = createFileQuestionLinkStore(root, {
          lockRoot,
          hooks: {
            afterDirectoryResolved: async () => {
              await swap?.();
              swap = undefined;
            },
          },
        });
        await store.create(storedHumanLink);

        const attackerLink = { ...storedHumanLink, snapshotId: "snap-attacker" };
        swap = async () => {
          await mkdir(join(attacker, "question-links"), { recursive: true });
          await writeFile(
            join(attacker, "question-links", `${HUMAN_QUESTION_ID}.json`),
            `${JSON.stringify(attackerLink, null, 2)}\n`,
          );
          await rename(join(root, "ingest"), join(root, "ingest-moved"));
          await symlink(attacker, join(root, "ingest"));
        };
        await expect(store.get(HUMAN_QUESTION_ID)).resolves.toEqual(
          storedHumanLink,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(lockRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "never publishes into an attacker-selected directory after an ancestor swap",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ultradyn-question-links-"));
      const lockRoot = await mkdtemp(join(tmpdir(), "ultradyn-lock-root-"));
      const attacker = join(root, "attacker-target");
      let swap: (() => Promise<void>) | undefined;
      try {
        const store = createFileQuestionLinkStore(root, {
          lockRoot,
          hooks: {
            afterDirectoryResolved: async () => {
              await swap?.();
              swap = undefined;
            },
          },
        });
        await store.create(storedHumanLink);

        swap = async () => {
          await mkdir(join(attacker, "question-links"), { recursive: true });
          await rename(join(root, "ingest"), join(root, "ingest-moved"));
          await symlink(attacker, join(root, "ingest"));
        };
        const generatedStoredLink = {
          schemaVersion: 1,
          ...generatedLinkInput,
          createdRevision: 0,
        } as const;
        await expect(store.create(generatedStoredLink)).resolves.toBe(true);

        await expect(
          readdir(join(attacker, "question-links")),
        ).resolves.toEqual([]);
        await expect(
          readFile(
            join(
              root,
              "ingest-moved",
              "question-links",
              `${GENERATED_QUESTION_ID}.json`,
            ),
            "utf8",
          ).then(JSON.parse),
        ).resolves.toEqual(generatedStoredLink);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(lockRoot, { recursive: true, force: true });
      }
    },
  );

  it("enforces OS no-replace publication independently of the advisory lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-question-links-"));
    const lockRoot = await mkdtemp(join(tmpdir(), "ultradyn-lock-root-"));
    const rival = { ...storedHumanLink, snapshotId: "snap-rival" } as const;
    try {
      // The rival writer publishes directly, without ever touching our
      // advisory lock, in the window between directory resolution and this
      // store's publication attempt — only link(2)'s no-replace semantics
      // stand between the two writers.
      let plantRival = false;
      const store = createFileQuestionLinkStore(root, {
        lockRoot,
        hooks: {
          afterDirectoryResolved: async () => {
            if (!plantRival) return;
            plantRival = false;
            await writeFile(
              join(
                root,
                "ingest",
                "question-links",
                `${HUMAN_QUESTION_ID}.json`,
              ),
              `${JSON.stringify(rival, null, 2)}\n`,
            );
          },
        },
      });
      plantRival = true;
      await expect(store.create(storedHumanLink)).resolves.toBe(false);
      await expect(store.get(HUMAN_QUESTION_ID)).resolves.toEqual(rival);
      const entries = await readdir(join(root, "ingest", "question-links"));
      expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it("fsyncs the destination directory before reporting success", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-question-links-"));
    const lockRoot = await mkdtemp(join(tmpdir(), "ultradyn-lock-root-"));
    try {
      let synced = 0;
      const store = createFileQuestionLinkStore(root, {
        lockRoot,
        hooks: { onDirectorySynced: () => (synced += 1) },
      });
      await expect(store.create(storedHumanLink)).resolves.toBe(true);
      expect(synced).toBe(1);
      await expect(
        store.create({ ...storedHumanLink, snapshotId: "snap-dup" }),
      ).resolves.toBe(false);
      expect(synced).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it("locks via the canonical machine-local lock root, not the portable tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-question-links-"));
    const lockRoot = await mkdtemp(join(tmpdir(), "ultradyn-lock-root-"));
    try {
      const store = createFileQuestionLinkStore(root, { lockRoot });
      await store.locked(async () => {
        await store.create(storedHumanLink);
      });
      await expect(lstat(join(root, ".ultradyn"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        lstat(lockRoot).then((metadata) => metadata.isDirectory()),
      ).resolves.toBe(true);
      await expect(store.get(HUMAN_QUESTION_ID)).resolves.toEqual(
        storedHumanLink,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it("refuses stored records whose questionId does not match the requested ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-question-links-"));
    const directory = join(root, "ingest", "question-links");
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `${HUMAN_QUESTION_ID}.json`),
        `${JSON.stringify(
          {
            ...storedHumanLink,
            questionId: GENERATED_QUESTION_ID,
            origin: "ingestion-generated",
            systemActor: "curiosity-planner",
            generation: 1,
            sourceUnitIds: ["unit-1"],
          },
          null,
          2,
        )}\n`,
      );
      const store = createFileQuestionLinkStore(root);
      await expect(store.get(HUMAN_QUESTION_ID)).rejects.toThrow(
        /questionId/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

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

  it("forbids source-unit provenance on human links", async () => {
    const service = serviceWith([humanQuestion()]);
    const result = await service.link({
      ...humanLinkInput,
      sourceUnitIds: ["unit-1"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_LINK");
  });

  it("maps reverse links to canonical raw records only", async () => {
    const service = serviceWith([humanQuestion(), generatedQuestion()]);
    const reverseLinkInput = {
      questionId: HUMAN_QUESTION_ID,
      snapshotId: "snap-1",
      origin: "reverse",
      systemActor: "reverse-ingestor",
      rawArtifactId: "art-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      generation: 1,
      sourceUnitIds: ["unit-1"],
    } as const;

    expect((await service.link(reverseLinkInput)).ok).toBe(true);

    const reverseOnGenerated = await service.link({
      ...reverseLinkInput,
      questionId: GENERATED_QUESTION_ID,
    });
    expect(reverseOnGenerated.ok).toBe(false);
    if (!reverseOnGenerated.ok) {
      expect(reverseOnGenerated.code).toBe("ORIGIN_MISMATCH");
    }
  });

  it("captures createdRevision inside the store's exclusive section", async () => {
    const record = humanQuestion();
    let lockHeld = false;
    let readWhileLocked: boolean | undefined;
    let createdWhileLocked: boolean | undefined;
    const links = createInMemoryQuestionLinkStore();
    const service = createQuestionLinkService({
      questions: {
        getQuestion: (id) => {
          readWhileLocked = lockHeld;
          return Promise.resolve(id === record.id ? record : undefined);
        },
      },
      links: {
        get: (questionId) => links.get(questionId),
        create: (link) => {
          createdWhileLocked = lockHeld;
          return links.create(link);
        },
        locked: async (operation) => {
          lockHeld = true;
          try {
            return await operation();
          } finally {
            lockHeld = false;
          }
        },
      },
    });

    const result = await service.link(humanLinkInput);
    expect(result.ok).toBe(true);
    expect(readWhileLocked).toBe(true);
    expect(createdWhileLocked).toBe(true);
  });

  it("rejects malformed question and raw-artifact identifiers", async () => {
    const service = serviceWith([humanQuestion()]);

    const badQuestion = await service.link({
      ...humanLinkInput,
      questionId: "not-a-question-id",
    });
    expect(badQuestion.ok).toBe(false);
    if (!badQuestion.ok) expect(badQuestion.code).toBe("INVALID_LINK");

    const badArtifact = await service.link({
      ...humanLinkInput,
      rawArtifactId: "artifact-1",
    });
    expect(badArtifact.ok).toBe(false);
    if (!badArtifact.ok) expect(badArtifact.code).toBe("INVALID_LINK");
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

  it("adapts canonical repository misses to QUESTION_NOT_FOUND", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-question-reader-"));
    try {
      const questions = new KnowledgeRepository(root);
      await questions.initialize();
      const service = createQuestionLinkService({
        questions,
        links: createInMemoryQuestionLinkStore(),
      });

      await expect(
        service.link({
          ...humanLinkInput,
          questionId: "q-01BX5ZZKBKACTAV9WEVGEMMVS2",
        }),
      ).resolves.toEqual({
        ok: false,
        code: "QUESTION_NOT_FOUND",
        message: "Unknown question q-01BX5ZZKBKACTAV9WEVGEMMVS2.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
