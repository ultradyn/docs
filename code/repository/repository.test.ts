import { readdirSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createIdGenerator } from "../domain/index.js";
import {
  KnowledgeRepository,
  RawArtifactIntegrityError,
  RepositorySettingsStore,
} from "./index.js";

const times = [
  "2026-07-16T00:00:00.000Z",
  "2026-07-16T00:01:00.000Z",
  "2026-07-16T00:02:00.000Z",
  "2026-07-16T00:03:00.000Z",
];

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "ultradyn-repository-"));
  let tick = 0;
  const repo = new KnowledgeRepository(root, {
    ids: createIdGenerator({ now: () => 1_700_000_000_000, random: () => 0.2 }),
    now: () => times[tick++] ?? "2026-07-16T01:00:00.000Z",
  });
  await repo.initialize();
  return { root, repo };
}

describe("knowledge repository public seam", () => {
  it("rejects a symlinked questions root during initialization without writing outside", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-initialize-root-"));
    const externalRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-initialize-external-"),
    );
    await symlink(externalRoot, join(root, "questions"), "dir");

    await expect(new KnowledgeRepository(root).initialize()).rejects.toThrow(
      /symbolic link/i,
    );
    await expect(
      readFile(join(externalRoot, "index.jsonl"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates records, moves queue projections, and regenerates a byte-identical index", async () => {
    const { root, repo } = await repository();
    const created = await repo.createQuestion({
      title: "How is the index rebuilt?",
      verbatimQuestion: "How is the index rebuilt?",
      chatlog: "The asker needs an implementation-level answer.",
      goals: ["implementation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    expect(created.state).toBe("active");
    expect(created.tier).toBe("P3");
    expect(await repo.readRawArtifact(created.id, "raw/001-question.md")).toBe(
      "How is the index rebuilt?",
    );

    const moved = await repo.transition(created.id, {
      to: "in-answer",
      expectedRevision: 0,
      by: "answerer:max",
    });
    expect(moved.revision).toBe(1);
    expect((await repo.getQuestion(created.id)).state).toBe("in-answer");
    expect(
      (await repo.listRawArtifacts(created.id)).map(
        (artifact) => artifact.kind,
      ),
    ).toEqual(["question", "chatlog"]);
    const derived = await repo.writeDerived(
      created.id,
      "answers/structured.md",
      "# Structured answer\n",
      { expectedRevision: 1, by: "structurer" },
    );
    expect(
      await repo.readDerived(created.id, "answers/structured.md"),
    ).toContain("Structured answer");
    const overridden = await repo.overridePriority(created.id, {
      tier: "P2",
      rationale: "Needed for the current release.",
      expectedRevision: derived.revision,
      by: "maintainer:max",
    });
    const attached = await repo.attachAsker(created.id, {
      asker: { id: "alice", acceptance: "pending" },
      expectedRevision: overridden.revision,
      by: "matcher",
    });
    expect(attached.askers.map((asker) => asker.id)).toEqual(["max", "alice"]);
    expect(attached.tier).toBe("P2");

    const first = await repo.regenerateIndex();
    const second = await repo.regenerateIndex();
    expect(second).toBe(first);
    expect(await readFile(join(root, "questions", "index.jsonl"), "utf8")).toBe(
      first,
    );
    expect(JSON.parse(first.trim())).toMatchObject({
      id: created.id,
      state: "in-answer",
      tier: "P2",
    });
  });

  it("rejects duplicate declared goals before persisting a question", async () => {
    const { repo } = await repository();

    await expect(
      repo.createQuestion({
        title: "Can duplicate goals persist?",
        verbatimQuestion: "Can duplicate goals persist?",
        goals: ["implementation", "implementation"],
        asker: { id: "max", acceptance: "pending" },
        origin: { kind: "raw" },
      }),
    ).rejects.toThrow(/goal.*unique|same goal|duplicate/i);
    expect(await repo.listQuestions()).toEqual([]);
  });

  it("detects direct raw mutation and refuses deletion through the API", async () => {
    const { root, repo } = await repository();
    const created = await repo.createQuestion({
      title: "What is immutable?",
      verbatimQuestion: "What is immutable?",
      goals: ["documentation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const artifact = await repo.appendRawArtifact(created.id, {
      kind: "transcript",
      content: "These are the verbatim words.",
    });
    expect(artifact.path).toBe("answers/raw/001-transcript.md");
    await expect(
      repo.deleteRawArtifact(created.id, artifact.path),
    ).rejects.toThrow(/immutable/i);

    const artifactPath = join(
      root,
      "questions",
      "active",
      created.id,
      artifact.path,
    );
    await chmod(artifactPath, 0o600);
    await writeFile(artifactPath, "silently changed");
    await expect(repo.verifyRawArtifacts()).rejects.toBeInstanceOf(
      RawArtifactIntegrityError,
    );
  });

  it("validates a matched ask before appending any immutable artifacts", async () => {
    const { repo } = await repository();
    const created = await repo.createQuestion({
      title: "How is a journal recovered?",
      verbatimQuestion: "How is a journal recovered?",
      goals: ["implementation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const originalArtifacts = await repo.listRawArtifacts(created.id);

    await expect(
      repo.attachMatchedAsk(created.id, {
        verbatimQuestion: "How is the journal safely recovered?",
        chatlog: "Alice needs the threat boundary.",
        acceptanceGoals: ["not a safe goal"],
        requestedGoals: ["not a safe goal"],
        asker: { id: "alice", acceptance: "pending" },
        expectedRevision: created.revision,
        by: "matcher",
      }),
    ).rejects.toThrow();

    expect(await repo.listRawArtifacts(created.id)).toEqual(originalArtifacts);
    expect(await repo.getQuestion(created.id)).toEqual(created);
  });

  it.each([
    "after-question-artifact",
    "after-chat-artifact",
    "before-record-update",
    "after-record-update",
  ] as const)(
    "restarts a matched-ask composite mutation after %s without duplicates",
    async (crashAt) => {
      const root = await mkdtemp(join(tmpdir(), "ultradyn-matched-restart-"));
      const lockRoot = await mkdtemp(
        join(tmpdir(), "ultradyn-matched-runtime-"),
      );
      const initial = new KnowledgeRepository(root, {
        lockRoot,
        ids: createIdGenerator({
          now: () => 1_700_000_000_000,
          random: () => 0.2,
        }),
        now: () => "2026-07-16T00:00:00.000Z",
      });
      await initial.initialize();
      const created = await initial.createQuestion({
        title: "How does composite recovery work?",
        verbatimQuestion: "How does composite recovery work?",
        goals: ["implementation"],
        asker: { id: "max", acceptance: "pending" },
        origin: { kind: "raw" },
      });
      const input = {
        verbatimQuestion:
          "How does composite recovery preserve every raw artifact?",
        chatlog: "Alice also needs the security boundary.",
        acceptanceGoals: ["implementation", "security-review"],
        requestedGoals: ["security-review"],
        asker: { id: "alice", acceptance: "pending" as const },
        expectedRevision: created.revision,
        by: "matcher",
      };
      const crashing = new KnowledgeRepository(root, {
        lockRoot,
        now: () => "2026-07-16T00:01:00.000Z",
        onMatchedAskCheckpoint(checkpoint: string) {
          if (checkpoint === crashAt) {
            throw new Error(`simulated crash at ${checkpoint}`);
          }
        },
      });

      await expect(
        crashing.attachMatchedAsk(created.id, input),
      ).rejects.toThrow(`simulated crash at ${crashAt}`);

      const restarted = new KnowledgeRepository(root, {
        lockRoot,
        now: () => "2026-07-16T00:02:00.000Z",
      });
      const recovered = await restarted.attachMatchedAsk(created.id, input);
      const retriedAgain = await restarted.attachMatchedAsk(created.id, input);
      const artifacts = await restarted.listRawArtifacts(created.id);
      const matchedQuestions = artifacts.filter(
        (artifact) => artifact.kind === "question",
      );
      const chats = artifacts.filter((artifact) => artifact.kind === "chatlog");
      const matchedEvents = recovered.provenance.filter(
        (event) =>
          event.type === "raw-artifact-appended" &&
          event.details?.askerId === "alice",
      );
      const askerEvents = recovered.provenance.filter(
        (event) =>
          event.type === "asker-attached" && event.details?.askerId === "alice",
      );

      expect(retriedAgain).toEqual(recovered);
      expect(matchedQuestions).toHaveLength(2);
      expect(chats).toHaveLength(1);
      expect(
        await restarted.readRawArtifact(created.id, matchedQuestions[1]!.path),
      ).toBe(input.verbatimQuestion);
      expect(await restarted.readRawArtifact(created.id, chats[0]!.path)).toBe(
        input.chatlog,
      );
      expect(recovered.goals).toEqual(["implementation", "security-review"]);
      expect(recovered.askers.map((asker) => asker.id)).toEqual([
        "max",
        "alice",
      ]);
      expect(matchedEvents).toHaveLength(2);
      expect(askerEvents).toHaveLength(1);
      expect(recovered.revision).toBe(created.revision + 1);
      expect(
        JSON.parse(
          (
            await readFile(join(root, "questions", "index.jsonl"), "utf8")
          ).trim(),
        ),
      ).toMatchObject({ id: created.id, revision: recovered.revision });
    },
  );

  it("records an identical matched ask again when it starts at a later revision", async () => {
    const { repo } = await repository();
    const created = await repo.createQuestion({
      title: "Can the same ask recur later?",
      verbatimQuestion: "Can the same ask recur later?",
      goals: ["implementation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const input = {
      verbatimQuestion: "How is this recurring ask handled?",
      chatlog: "Alice is asking again after the record changed.",
      acceptanceGoals: ["implementation"],
      requestedGoals: ["implementation"],
      asker: { id: "alice", acceptance: "pending" as const },
      expectedRevision: created.revision,
      by: "matcher",
    };
    const first = await repo.attachMatchedAsk(created.id, input);
    const intervening = await repo.overridePriority(created.id, {
      tier: "P2",
      rationale: "The recurring question is now release-critical.",
      expectedRevision: first.revision,
      by: "maintainer:max",
    });

    const second = await repo.attachMatchedAsk(created.id, {
      ...input,
      expectedRevision: intervening.revision,
    });
    const artifacts = await repo.listRawArtifacts(created.id);
    const operationIds = second.provenance
      .filter(
        (event) =>
          event.type === "raw-artifact-appended" &&
          event.details?.askerId === "alice",
      )
      .map((event) => event.details?.operationId);

    expect(second.revision).toBe(intervening.revision + 1);
    expect(
      artifacts.filter((artifact) => artifact.kind === "question"),
    ).toHaveLength(3);
    expect(
      artifacts.filter((artifact) => artifact.kind === "chatlog"),
    ).toHaveLength(2);
    expect(new Set(operationIds).size).toBe(2);
  });

  it("fails closed when a crash retry changes the matched-ask payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-matched-mismatch-"));
    const lockRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-matched-mismatch-runtime-"),
    );
    const initial = new KnowledgeRepository(root, {
      lockRoot,
      ids: createIdGenerator({
        now: () => 1_700_000_000_000,
        random: () => 0.2,
      }),
      now: () => "2026-07-16T00:00:00.000Z",
    });
    await initial.initialize();
    const created = await initial.createQuestion({
      title: "Which retry payload is authoritative?",
      verbatimQuestion: "Which retry payload is authoritative?",
      goals: ["implementation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const original = {
      verbatimQuestion: "Preserve this exact retried question.",
      chatlog: "Preserve this exact retried context.",
      acceptanceGoals: ["implementation", "security-review"],
      requestedGoals: ["security-review"],
      asker: { id: "alice", acceptance: "pending" as const },
      expectedRevision: created.revision,
      by: "matcher",
    };
    const crashing = new KnowledgeRepository(root, {
      lockRoot,
      now: () => "2026-07-16T00:01:00.000Z",
      onMatchedAskCheckpoint(checkpoint) {
        if (checkpoint === "after-question-artifact") {
          throw new Error("simulated crash after question");
        }
      },
    });
    await expect(
      crashing.attachMatchedAsk(created.id, original),
    ).rejects.toThrow("simulated crash after question");

    const restarted = new KnowledgeRepository(root, {
      lockRoot,
      now: () => "2026-07-16T00:02:00.000Z",
    });
    await expect(
      restarted.attachMatchedAsk(created.id, {
        ...original,
        chatlog: "A different context must not hijack the pending operation.",
      }),
    ).rejects.toBeInstanceOf(RawArtifactIntegrityError);
    expect((await restarted.getQuestion(created.id)).revision).toBe(
      created.revision,
    );
    expect(await restarted.listRawArtifacts(created.id)).toHaveLength(2);

    const recovered = await restarted.attachMatchedAsk(created.id, original);
    expect(recovered.revision).toBe(created.revision + 1);
    expect(await restarted.listRawArtifacts(created.id)).toHaveLength(3);
  });

  it("recovers a matched ask atop an intervening record mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-matched-advanced-"));
    const lockRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-matched-advanced-runtime-"),
    );
    const initial = new KnowledgeRepository(root, {
      lockRoot,
      ids: createIdGenerator({
        now: () => 1_700_000_000_000,
        random: () => 0.2,
      }),
      now: () => "2026-07-16T00:00:00.000Z",
    });
    await initial.initialize();
    const created = await initial.createQuestion({
      title: "Can recovery preserve newer record state?",
      verbatimQuestion: "Can recovery preserve newer record state?",
      goals: ["implementation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const input = {
      verbatimQuestion: "Preserve my ask across an intervening mutation.",
      chatlog: "Alice needs both implementation and security context.",
      acceptanceGoals: ["implementation", "security-review"],
      requestedGoals: ["security-review"],
      asker: { id: "alice", acceptance: "pending" as const },
      expectedRevision: created.revision,
      by: "matcher",
    };
    const crashing = new KnowledgeRepository(root, {
      lockRoot,
      now: () => "2026-07-16T00:01:00.000Z",
      onMatchedAskCheckpoint(checkpoint) {
        if (checkpoint === "after-chat-artifact") {
          throw new Error("simulated crash after chat");
        }
      },
    });
    await expect(crashing.attachMatchedAsk(created.id, input)).rejects.toThrow(
      "simulated crash after chat",
    );

    const interveningRepository = new KnowledgeRepository(root, {
      lockRoot,
      now: () => "2026-07-16T00:02:00.000Z",
    });
    const intervening = await interveningRepository.overridePriority(
      created.id,
      {
        tier: "P2",
        rationale: "An intervening maintainer decision must survive recovery.",
        expectedRevision: created.revision,
        by: "maintainer:max",
      },
    );

    const restarted = new KnowledgeRepository(root, {
      lockRoot,
      now: () => "2026-07-16T00:03:00.000Z",
    });
    const recovered = await restarted.attachMatchedAsk(created.id, input);
    const retriedAgain = await restarted.attachMatchedAsk(created.id, input);
    const artifacts = await restarted.listRawArtifacts(created.id);

    expect(retriedAgain).toEqual(recovered);
    expect(recovered.revision).toBe(intervening.revision + 1);
    expect(recovered.tier).toBe("P2");
    expect(recovered.priorityRationale).toBe(
      "An intervening maintainer decision must survive recovery.",
    );
    expect(recovered.updatedAt).toBe(intervening.updatedAt);
    expect(recovered.goals).toEqual(["implementation", "security-review"]);
    expect(recovered.askers.map((asker) => asker.id)).toEqual(["max", "alice"]);
    expect(
      artifacts.filter((artifact) => artifact.kind === "question"),
    ).toHaveLength(2);
    expect(
      artifacts.filter((artifact) => artifact.kind === "chatlog"),
    ).toHaveLength(1);
    expect(
      recovered.provenance.filter(
        (event) =>
          event.type === "raw-artifact-appended" &&
          event.details?.askerId === "alice",
      ),
    ).toHaveLength(2);
    expect(artifacts.slice(1).map((artifact) => artifact.createdAt)).toEqual([
      "2026-07-16T00:01:00.000Z",
      "2026-07-16T00:01:00.000Z",
    ]);
    expect(
      recovered.provenance
        .filter(
          (event) =>
            event.type === "raw-artifact-appended" &&
            event.details?.askerId === "alice",
        )
        .map((event) => event.at),
    ).toEqual([intervening.updatedAt, intervening.updatedAt]);
    expect(
      recovered.provenance.every(
        (event, index, events) =>
          index === 0 ||
          Date.parse(event.at) >= Date.parse(events[index - 1]!.at),
      ),
    ).toBe(true);
  });

  it("recovers an atomically published raw artifact when a restart happens before its manifest commit", async () => {
    const { root, repo } = await repository();
    const created = await repo.createQuestion({
      title: "Can raw publication resume?",
      verbatimQuestion: "Can raw publication resume?",
      goals: ["implementation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const rawAnswers = join(
      root,
      "questions",
      "active",
      created.id,
      "answers",
      "raw",
    );
    await mkdir(rawAnswers, { recursive: true });
    const transcript = "Resume from this durable verbatim transcript.";

    // This is the deterministic filesystem state left by a process that
    // published the immutable file, then stopped before replacing the manifest.
    await writeFile(join(rawAnswers, "001-transcript.md"), transcript, {
      mode: 0o444,
    });

    const restarted = new KnowledgeRepository(root, {
      now: () => "2026-07-16T02:00:00.000Z",
      lockRetries: 0,
    });
    const recovered = await restarted.appendRawArtifact(created.id, {
      kind: "transcript",
      content: transcript,
    });

    expect(recovered).toMatchObject({
      path: "answers/raw/001-transcript.md",
      kind: "transcript",
      bytes: new TextEncoder().encode(transcript).byteLength,
      createdAt: "2026-07-16T02:00:00.000Z",
    });
    expect(await restarted.listRawArtifacts(created.id)).toContainEqual(
      recovered,
    );
    expect(await readdir(rawAnswers)).toEqual(["001-transcript.md"]);
  });

  it("fails closed when a retry differs from an unmanifested published artifact", async () => {
    const { root, repo } = await repository();
    const created = await repo.createQuestion({
      title: "Can retry bytes change?",
      verbatimQuestion: "Can retry bytes change?",
      goals: ["security-review"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const destination = join(
      root,
      "questions",
      "active",
      created.id,
      "answers",
      "raw",
      "001-transcript.md",
    );
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, "The originally published bytes.", {
      mode: 0o444,
    });

    await expect(
      repo.appendRawArtifact(created.id, {
        kind: "transcript",
        content: "Different retry bytes.",
      }),
    ).rejects.toBeInstanceOf(RawArtifactIntegrityError);
    expect(await readFile(destination, "utf8")).toBe(
      "The originally published bytes.",
    );
    expect(await repo.listRawArtifacts(created.id)).toHaveLength(1);
  });

  it("replaces an incomplete pre-publication file before atomically publishing the retry", async () => {
    const { root, repo } = await repository();
    const created = await repo.createQuestion({
      title: "Can an incomplete pending write leak?",
      verbatimQuestion: "Can an incomplete pending write leak?",
      goals: ["security-review"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const rawAnswers = join(
      root,
      "questions",
      "active",
      created.id,
      "answers",
      "raw",
    );
    await mkdir(rawAnswers, { recursive: true });
    await writeFile(
      join(rawAnswers, ".ultradyn-pending-001-transcript.md"),
      "incomplete",
    );
    const transcript = "The complete durable transcript.";

    const recovered = await repo.appendRawArtifact(created.id, {
      kind: "transcript",
      content: transcript,
    });

    expect(await repo.readRawArtifact(created.id, recovered.path)).toBe(
      transcript,
    );
    expect(await readdir(rawAnswers)).toEqual(["001-transcript.md"]);
  });

  it("rejects a symlinked raw artifact instead of reading outside the repository", async () => {
    const { root, repo } = await repository();
    const created = await repo.createQuestion({
      title: "Where is the raw question?",
      verbatimQuestion: "Where is the raw question?",
      goals: ["security-review"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const externalRoot = await mkdtemp(join(tmpdir(), "ultradyn-external-"));
    const externalArtifact = join(externalRoot, "question.md");
    await writeFile(externalArtifact, "Where is the raw question?", "utf8");
    const artifactPath = join(
      root,
      "questions",
      "active",
      created.id,
      "raw",
      "001-question.md",
    );
    await rm(artifactPath);
    await symlink(externalArtifact, artifactPath);

    await expect(repo.verifyRawArtifacts()).rejects.toThrow(/symbolic link/i);
  });

  it("rejects a symlinked raw manifest instead of reading outside the repository", async () => {
    const { root, repo } = await repository();
    const created = await repo.createQuestion({
      title: "Where is the raw manifest?",
      verbatimQuestion: "Where is the raw manifest?",
      goals: ["security-review"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const rawRoot = join(root, "questions", "active", created.id, "raw");
    const manifestPath = join(rawRoot, "manifest.json");
    const externalRoot = await mkdtemp(join(tmpdir(), "ultradyn-external-"));
    const externalManifest = join(externalRoot, "manifest.json");
    await writeFile(externalManifest, await readFile(manifestPath, "utf8"));
    await rm(manifestPath);
    await symlink(externalManifest, manifestPath);

    await expect(repo.listRawArtifacts(created.id)).rejects.toThrow(
      /symbolic link/i,
    );
  });

  it("rejects a symlinked raw directory instead of writing outside the repository", async () => {
    const { root, repo } = await repository();
    const created = await repo.createQuestion({
      title: "Where is the transcript stored?",
      verbatimQuestion: "Where is the transcript stored?",
      goals: ["security-review"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const externalRoot = await mkdtemp(join(tmpdir(), "ultradyn-external-"));
    const answersPath = join(
      root,
      "questions",
      "active",
      created.id,
      "answers",
    );
    await symlink(externalRoot, answersPath, "dir");

    await expect(
      repo.appendRawArtifact(created.id, {
        kind: "transcript",
        content: "This must stay in the repository.",
      }),
    ).rejects.toThrow(/symbolic link/i);
    await expect(
      readFile(join(externalRoot, "raw", "001-transcript.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked derived directory instead of writing outside the repository", async () => {
    const { root, repo } = await repository();
    const created = await repo.createQuestion({
      title: "Where is the structured answer?",
      verbatimQuestion: "Where is the structured answer?",
      goals: ["security-review"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const externalRoot = await mkdtemp(join(tmpdir(), "ultradyn-external-"));
    await symlink(
      externalRoot,
      join(root, "questions", "active", created.id, "answers"),
      "dir",
    );

    await expect(
      repo.writeDerived(
        created.id,
        "answers/structured.md",
        "# Must stay inside\n",
        { expectedRevision: created.revision, by: "structurer" },
      ),
    ).rejects.toThrow(/symbolic link/i);
    await expect(
      readFile(join(externalRoot, "structured.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked derived artifact instead of reading outside the repository", async () => {
    const { root, repo } = await repository();
    const created = await repo.createQuestion({
      title: "Can derived output escape?",
      verbatimQuestion: "Can derived output escape?",
      goals: ["security-review"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    await repo.writeDerived(
      created.id,
      "answers/structured.md",
      "# Safe answer\n",
      { expectedRevision: created.revision, by: "structurer" },
    );
    const externalRoot = await mkdtemp(join(tmpdir(), "ultradyn-external-"));
    const externalArtifact = join(externalRoot, "structured.md");
    await writeFile(externalArtifact, "# Outside answer\n", "utf8");
    const derivedPath = join(
      root,
      "questions",
      "active",
      created.id,
      "answers",
      "structured.md",
    );
    await rm(derivedPath);
    await symlink(externalArtifact, derivedPath);

    await expect(
      repo.readDerived(created.id, "answers/structured.md"),
    ).rejects.toThrow(/symbolic link/i);
  });

  it("rejects a symlinked question record before a derived operation reads it", async () => {
    const { root, repo } = await repository();
    const created = await repo.createQuestion({
      title: "Can the record escape?",
      verbatimQuestion: "Can the record escape?",
      goals: ["security-review"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const externalRoot = await mkdtemp(join(tmpdir(), "ultradyn-external-"));
    const externalRecord = join(externalRoot, "question.md");
    await writeFile(externalRecord, "outside the repository\n", "utf8");
    const recordPath = join(
      root,
      "questions",
      "active",
      created.id,
      "question.md",
    );
    await rm(recordPath);
    await symlink(externalRecord, recordPath);

    await expect(
      repo.readDerived(created.id, "answers/structured.md"),
    ).rejects.toThrow(/symbolic link/i);
  });

  it("rejects a symlinked queue bucket before raw verification traverses it", async () => {
    const { root, repo } = await repository();
    const externalRoot = await mkdtemp(join(tmpdir(), "ultradyn-external-"));
    const activePath = join(root, "questions", "active");
    await rm(activePath, { recursive: true });
    await symlink(externalRoot, activePath, "dir");

    await expect(repo.verifyRawArtifacts()).rejects.toThrow(/symbolic link/i);
  });

  it("does not use the portable repository tree for its runtime lock", async () => {
    const { root, repo } = await repository();
    const created = await repo.createQuestion({
      title: "Where does the runtime lock live?",
      verbatimQuestion: "Where does the runtime lock live?",
      goals: ["security-review"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const externalRoot = await mkdtemp(join(tmpdir(), "ultradyn-external-"));
    await rm(join(root, ".ultradyn"), { recursive: true });
    await symlink(externalRoot, join(root, ".ultradyn"), "dir");

    const artifact = await repo.appendRawArtifact(created.id, {
      kind: "transcript",
      content: "The runtime lock is machine-local.",
    });

    expect(artifact.path).toBe("answers/raw/001-transcript.md");
    await expect(
      readFile(join(externalRoot, "repository.lock"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")(
    "uses one safely keyed machine lock for canonical and aliased repository paths",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ultradyn-lock-root-"));
      const alias = `${root}-alias`;
      const lockRoot = await mkdtemp(join(tmpdir(), "ultradyn-locks-"));
      const observedLocks: string[] = [];
      const ids = [
        "q-01J00000000000000000000000",
        "q-01J00000000000000000000001",
      ];
      const repositoryAt = (path: string) =>
        new KnowledgeRepository(path, {
          lockRoot,
          lockRetries: 0,
          ids: {
            next() {
              observedLocks.push(readdirSync(lockRoot)[0] ?? "missing");
              return ids.shift() ?? "q-01J00000000000000000000002";
            },
          },
        });
      const canonical = repositoryAt(root);
      await canonical.initialize();
      await symlink(root, alias, "dir");

      for (const repo of [canonical, repositoryAt(alias)]) {
        await repo.createQuestion({
          title: "Which lock protects this repository?",
          verbatimQuestion: "Which lock protects this repository?",
          goals: ["implementation"],
          asker: { id: "max", acceptance: "pending" },
          origin: { kind: "raw" },
        });
      }

      expect(observedLocks).toHaveLength(2);
      expect(observedLocks[0]).toBe(observedLocks[1]);
      expect(observedLocks[0]).toMatch(/^[0-9a-f]{64}\.lock$/u);
    },
  );

  it("rejects a symlinked generated index instead of replacing outside content", async () => {
    const { root, repo } = await repository();
    const externalRoot = await mkdtemp(join(tmpdir(), "ultradyn-external-"));
    const externalIndex = join(externalRoot, "index.jsonl");
    await writeFile(externalIndex, "outside content\n", "utf8");
    const indexPath = join(root, "questions", "index.jsonl");
    await rm(indexPath);
    await symlink(externalIndex, indexPath);

    await expect(repo.regenerateIndex()).rejects.toThrow(/symbolic link/i);
    expect(await readFile(externalIndex, "utf8")).toBe("outside content\n");
  });

  it("rejects a symlinked staging directory before creating raw files outside the repository", async () => {
    const { root, repo } = await repository();
    const externalRoot = await mkdtemp(join(tmpdir(), "ultradyn-external-"));
    const externalStage = join(
      externalRoot,
      `q-01HF7YAT006666666666666666-${process.pid}`,
    );
    const sentinel = join(externalStage, "keep.txt");
    await mkdir(externalStage);
    await writeFile(sentinel, "must not be removed\n", "utf8");
    await symlink(externalRoot, join(root, ".ultradyn", "staging"), "dir");

    await expect(
      repo.createQuestion({
        title: "Can staging escape?",
        verbatimQuestion: "Can staging escape?",
        goals: ["security-review"],
        asker: { id: "max", acceptance: "pending" },
        origin: { kind: "raw" },
      }),
    ).rejects.toThrow(/symbolic link/i);
    expect(await readFile(sentinel, "utf8")).toBe("must not be removed\n");
  });

  it("rejects a symlinked queue destination before moving a raw question outside the repository", async () => {
    const { root, repo } = await repository();
    const externalRoot = await mkdtemp(join(tmpdir(), "ultradyn-external-"));
    const activePath = join(root, "questions", "active");
    await rm(activePath, { recursive: true });
    await symlink(externalRoot, activePath, "dir");

    await expect(
      repo.createQuestion({
        title: "Can the destination escape?",
        verbatimQuestion: "Can the destination escape?",
        goals: ["security-review"],
        asker: { id: "max", acceptance: "pending" },
        origin: { kind: "raw" },
      }),
    ).rejects.toThrow(/symbolic link/i);
    await expect(
      readFile(
        join(externalRoot, "q-01HF7YAT006666666666666666", "question.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked transition destination before mutating or moving the question", async () => {
    const { root, repo } = await repository();
    let record = await repo.createQuestion({
      title: "Can a transition escape?",
      verbatimQuestion: "Can a queue transition escape the repository?",
      goals: ["security-review"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    for (const to of ["in-answer", "integrating", "merged"] as const) {
      record = await repo.transition(record.id, {
        to,
        expectedRevision: record.revision,
        by: "security-test",
      });
    }
    const externalRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-transition-external-"),
    );
    await rm(join(root, "questions", "answered"), { recursive: true });
    await symlink(externalRoot, join(root, "questions", "answered"), "dir");

    await expect(
      repo.transition(record.id, {
        to: "accepted",
        expectedRevision: record.revision,
        by: "security-test",
      }),
    ).rejects.toThrow(/symbolic link/i);
    await expect(
      readFile(join(externalRoot, record.id, "question.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await repo.getQuestion(record.id)).state).toBe("merged");
  });

  it("rejects non-canonical question lookup IDs and mismatched records", async () => {
    const { root, repo } = await repository();
    const created = await repo.createQuestion({
      title: "Which record is canonical?",
      verbatimQuestion: "Which record is canonical?",
      goals: ["documentation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });

    await expect(
      repo.getQuestion(`${created.id}/../${created.id}`),
    ).rejects.toThrow();

    const path = join(root, "questions", "active", created.id, "question.md");
    const content = await readFile(path, "utf8");
    await writeFile(
      path,
      content.replace(created.id, "q-01J00000000000000000000001"),
    );
    await expect(repo.getQuestion(created.id)).rejects.toThrow(
      /does not match/i,
    );
  });

  it("repairs a misplaced queue directory from canonical record state", async () => {
    const { root, repo } = await repository();
    const created = await repo.createQuestion({
      title: "Deferred detail",
      verbatimQuestion: "Which optional codec tuning flags help?",
      goals: ["implementation"],
      asker: { id: "generated", acceptance: "pending" },
      origin: {
        kind: "generated",
        parentQuestionId: "q-01J00000000000000000000000",
        findingId: "f-01J00000000000000000000000",
        goal: "implementation",
      },
      depth: 1,
    });
    expect(created.state).toBe("deferred");
    await mkdir(join(root, "questions", "active"), { recursive: true });
    const { rename } = await import("node:fs/promises");
    await rename(
      join(root, "questions", "deferred", created.id),
      join(root, "questions", "active", created.id),
    );

    expect(await repo.repairQueueProjections()).toEqual([
      { id: created.id, from: "active", to: "deferred" },
    ]);
    expect((await repo.listQuestions()).map((record) => record.id)).toEqual([
      created.id,
    ]);
  });

  it("allows only pending merged askers to accept or time out and rejects the public rejection bypass", async () => {
    const { repo } = await repository();
    const created = await repo.createQuestion({
      title: "Does this answer every asker?",
      verbatimQuestion: "Does this answer every asker?",
      goals: ["documentation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const attached = await repo.attachAsker(created.id, {
      asker: { id: "alice", acceptance: "pending" },
      expectedRevision: created.revision,
      by: "matcher",
    });

    await expect(
      repo.decideAsker(created.id, {
        askerId: "max",
        decision: "accepted",
        expectedRevision: attached.revision,
        by: "asker:max",
      }),
    ).rejects.toThrow(/merged/i);
    await expect(repo.getQuestion(created.id)).resolves.toEqual(attached);

    const claimed = await repo.transition(created.id, {
      to: "in-answer",
      expectedRevision: attached.revision,
      by: "answerer:max",
    });
    const integrating = await repo.transition(created.id, {
      to: "integrating",
      expectedRevision: claimed.revision,
      by: "integrator",
    });
    const merged = await repo.transition(created.id, {
      to: "merged",
      expectedRevision: integrating.revision,
      by: "maintainer:max",
    });

    const accepted = await repo.decideAsker(created.id, {
      askerId: "max",
      decision: "accepted",
      expectedRevision: merged.revision,
      by: "asker:max",
    });
    expect(accepted.askers).toEqual([
      expect.objectContaining({
        id: "max",
        acceptance: "accepted",
        decidedAt: expect.any(String),
      }),
      expect.objectContaining({ id: "alice", acceptance: "pending" }),
    ]);
    expect(accepted.provenance.at(-1)).toMatchObject({
      type: "accepted",
      by: "asker:max",
    });

    await expect(
      repo.decideAsker(created.id, {
        askerId: "max",
        decision: "accepted",
        expectedRevision: accepted.revision,
        by: "asker:max",
      }),
    ).rejects.toThrow(/pending/i);
    await expect(repo.getQuestion(created.id)).resolves.toEqual(accepted);

    const rejection = await repo.appendRawArtifact(created.id, {
      kind: "rejection",
      content: "The answer omits the corrupted-checkpoint case.",
    });
    const beforeBypass = await repo.getQuestion(created.id);

    await expect(
      repo.decideAsker(created.id, {
        askerId: "alice",
        decision: "rejected",
        rawReason: rejection.path,
        expectedRevision: beforeBypass.revision,
        by: "asker:alice",
      } as never),
    ).rejects.toThrow(/rejectAsker/i);
    await expect(repo.getQuestion(created.id)).resolves.toEqual(beforeBypass);
  });

  it("recovers one rejection artifact and one canonical reopen after failure between publication and decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-rejection-journal-"));
    let failAfterPublication = true;
    const crashing = new KnowledgeRepository(root, {
      ids: createIdGenerator({
        now: () => 1_700_000_000_000,
        random: () => 0.3,
      }),
      now: () => "2026-07-16T02:00:00.000Z",
      onAskerRejectionCheckpoint: (checkpoint) => {
        if (checkpoint === "after-artifact" && failAfterPublication) {
          failAfterPublication = false;
          throw new Error("simulated rejection decision failure");
        }
      },
    });
    await crashing.initialize();
    const created = await crashing.createQuestion({
      title: "Can rejection recovery orphan raw input?",
      verbatimQuestion: "Can rejection recovery orphan raw input?",
      goals: ["implementation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    const claimed = await crashing.transition(created.id, {
      to: "in-answer",
      expectedRevision: created.revision,
      by: "answerer:max",
    });
    const integrating = await crashing.transition(created.id, {
      to: "integrating",
      expectedRevision: claimed.revision,
      by: "integrator",
    });
    const merged = await crashing.transition(created.id, {
      to: "merged",
      expectedRevision: integrating.revision,
      by: "maintainer:max",
    });
    const input = {
      askerId: "max",
      reason: "The answer omits the interrupted-publication recovery case.",
      by: "asker:max",
    };

    await expect(crashing.rejectAsker(created.id, input)).rejects.toThrow(
      /simulated rejection decision failure/i,
    );
    expect(
      (await crashing.listRawArtifacts(created.id)).filter(
        (artifact) => artifact.kind === "rejection",
      ),
    ).toHaveLength(1);
    await expect(crashing.getQuestion(created.id)).resolves.toEqual(merged);

    const restarted = new KnowledgeRepository(root, {
      now: () => "2026-07-16T02:01:00.000Z",
    });
    const recovered = await restarted.rejectAsker(created.id, input);
    expect(recovered).toMatchObject({
      state: "reopened",
      tier: "P1",
      revision: merged.revision + 1,
      askers: [
        expect.objectContaining({
          id: "max",
          acceptance: "rejected",
          rawReason: expect.stringMatching(/rejection\.md$/u),
        }),
      ],
    });
    const rejectionArtifacts = (
      await restarted.listRawArtifacts(created.id)
    ).filter((artifact) => artifact.kind === "rejection");
    expect(rejectionArtifacts).toHaveLength(1);
    expect(
      recovered.provenance.filter(
        (event) =>
          event.type === "rejected" && event.details?.askerId === "max",
      ),
    ).toHaveLength(1);
  });

  it("reconciles a recorded rejection before later mutations and removes its completed journal", async () => {
    async function crashAfterRejectionRecord() {
      const root = await mkdtemp(
        join(tmpdir(), "ultradyn-recorded-rejection-"),
      );
      const lockRoot = await mkdtemp(
        join(tmpdir(), "ultradyn-recorded-rejection-locks-"),
      );
      let crash = true;
      const repository = new KnowledgeRepository(root, {
        lockRoot,
        ids: createIdGenerator({
          now: () => 1_700_000_000_000,
          random: () => 0.305,
        }),
        now: () => "2026-07-16T02:30:00.000Z",
        onAskerRejectionCheckpoint: (checkpoint) => {
          if (checkpoint === "after-record-update" && crash) {
            crash = false;
            throw new Error("simulated crash after rejection record");
          }
        },
      });
      await repository.initialize();
      const created = await repository.createQuestion({
        title: "Can completed rejection recovery survive later revisions?",
        verbatimQuestion:
          "Can completed rejection recovery survive later revisions?",
        goals: ["implementation"],
        asker: { id: "max", acceptance: "pending" },
        origin: { kind: "raw" },
      });
      let current = await repository.transition(created.id, {
        to: "in-answer",
        expectedRevision: created.revision,
        by: "answerer:max",
      });
      current = await repository.transition(created.id, {
        to: "integrating",
        expectedRevision: current.revision,
        by: "integrator",
      });
      current = await repository.transition(created.id, {
        to: "merged",
        expectedRevision: current.revision,
        by: "maintainer:max",
      });
      const input = {
        askerId: "max",
        reason: "The answer omits restart after the canonical record write.",
        by: "asker:max",
      };
      await expect(repository.rejectAsker(created.id, input)).rejects.toThrow(
        /simulated crash after rejection record/i,
      );
      const reopened = await repository.getQuestion(created.id);
      expect(reopened).toMatchObject({
        state: "reopened",
        revision: current.revision + 1,
      });
      return { root, lockRoot, created, input, reopened };
    }

    const completed = await crashAfterRejectionRecord();
    const restarted = new KnowledgeRepository(completed.root, {
      lockRoot: completed.lockRoot,
      now: () => "2026-07-16T02:31:00.000Z",
    });
    const later = await restarted.transition(completed.created.id, {
      to: "in-answer",
      expectedRevision: completed.reopened.revision,
      by: "answerer:max",
    });
    const [repositoryOperations] = await readdir(
      join(completed.lockRoot, "operations"),
    );
    expect(repositoryOperations).toBeDefined();
    expect(
      await readdir(
        join(completed.lockRoot, "operations", repositoryOperations!),
      ),
    ).toEqual([]);
    await expect(
      new KnowledgeRepository(completed.root, {
        lockRoot: completed.lockRoot,
        now: () => "2026-07-16T02:32:00.000Z",
      }).rejectAsker(completed.created.id, completed.input),
    ).rejects.toThrow(/merged/i);
    const retried = await restarted.getQuestion(completed.created.id);
    expect(retried).toEqual(later);
    expect(
      retried.provenance.filter(
        (event) =>
          event.type === "rejected" && event.details?.askerId === "max",
      ),
    ).toHaveLength(1);
    expect(
      (await restarted.listRawArtifacts(completed.created.id)).filter(
        (artifact) => artifact.kind === "rejection",
      ),
    ).toHaveLength(1);
    const tamperedProvenance = await crashAfterRejectionRecord();
    const questionPath = join(
      tamperedProvenance.root,
      "questions",
      "active",
      tamperedProvenance.created.id,
      "question.md",
    );
    const questionFile = await readFile(questionPath, "utf8");
    expect(questionFile).toContain("type: rejected");
    await writeFile(
      questionPath,
      questionFile.replace("type: rejected", "type: accepted"),
    );
    await expect(
      new KnowledgeRepository(tamperedProvenance.root, {
        lockRoot: tamperedProvenance.lockRoot,
      }).rejectAsker(tamperedProvenance.created.id, tamperedProvenance.input),
    ).rejects.toThrow(/integrity|incomplete|provenance/i);

    const tamperedArtifact = await crashAfterRejectionRecord();
    const [rejectionArtifact] = (
      await new KnowledgeRepository(tamperedArtifact.root, {
        lockRoot: tamperedArtifact.lockRoot,
      }).listRawArtifacts(tamperedArtifact.created.id)
    ).filter((artifact) => artifact.kind === "rejection");
    expect(rejectionArtifact).toBeDefined();
    const rejectionPath = join(
      tamperedArtifact.root,
      "questions",
      "active",
      tamperedArtifact.created.id,
      rejectionArtifact!.path,
    );
    await chmod(rejectionPath, 0o600);
    await writeFile(rejectionPath, "forged rejection bytes\n");
    await expect(
      new KnowledgeRepository(tamperedArtifact.root, {
        lockRoot: tamperedArtifact.lockRoot,
      }).rejectAsker(tamperedArtifact.created.id, tamperedArtifact.input),
    ).rejects.toThrow(/integrity|hash|bytes|modified/i);

    const tamperedAuthors = await crashAfterRejectionRecord();
    const authorQuestionPath = join(
      tamperedAuthors.root,
      "questions",
      "active",
      tamperedAuthors.created.id,
      "question.md",
    );
    let authorQuestionFile = await readFile(authorQuestionPath, "utf8");
    for (const eventType of [
      "raw-artifact-appended",
      "rejected",
      "state-transitioned",
    ]) {
      const before = authorQuestionFile;
      authorQuestionFile = authorQuestionFile.replace(
        new RegExp(`(type: ${eventType}\\r?\\n\\s+by:) asker:max`, "u"),
        "$1 attacker:forged",
      );
      expect(authorQuestionFile).not.toBe(before);
    }
    await writeFile(authorQuestionPath, authorQuestionFile);
    await expect(
      new KnowledgeRepository(tamperedAuthors.root, {
        lockRoot: tamperedAuthors.lockRoot,
      }).transition(tamperedAuthors.created.id, {
        to: "in-answer",
        expectedRevision: tamperedAuthors.reopened.revision,
        by: "answerer:max",
      }),
    ).rejects.toThrow(/integrity|incomplete|provenance|author/i);
  });

  it("cleans a verified crash-after-record journal before a later transition and scopes an identical second rejection to its revision", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ultradyn-rejection-revision-scope-"),
    );
    const lockRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-rejection-revision-scope-locks-"),
    );
    let crash = true;
    const crashing = new KnowledgeRepository(root, {
      lockRoot,
      ids: createIdGenerator({
        now: () => 1_700_000_000_000,
        random: () => 0.307,
      }),
      now: () => "2026-07-16T02:45:00.000Z",
      onAskerRejectionCheckpoint: (checkpoint) => {
        if (checkpoint === "after-record-update" && crash) {
          crash = false;
          throw new Error("simulated crash after first rejection record");
        }
      },
    });
    await crashing.initialize();
    const created = await crashing.createQuestion({
      title: "Can the same rejection recur after another answer?",
      verbatimQuestion:
        "Does an identical later rejection get its own revision-scoped provenance?",
      goals: ["implementation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    let current = await crashing.transition(created.id, {
      to: "in-answer",
      expectedRevision: created.revision,
      by: "answerer:max",
    });
    current = await crashing.transition(created.id, {
      to: "integrating",
      expectedRevision: current.revision,
      by: "integrator",
    });
    const firstMerged = await crashing.transition(created.id, {
      to: "merged",
      expectedRevision: current.revision,
      by: "maintainer:max",
    });
    const input = {
      askerId: "max",
      reason: "The answer still omits the interrupted-publication case.",
      by: "asker:max",
    };

    await expect(crashing.rejectAsker(created.id, input)).rejects.toThrow(
      /simulated crash after first rejection record/i,
    );
    const firstReopened = await crashing.getQuestion(created.id);
    const [repositoryOperations] = await readdir(join(lockRoot, "operations"));
    expect(repositoryOperations).toBeDefined();
    expect(
      await readdir(join(lockRoot, "operations", repositoryOperations!)),
    ).toHaveLength(1);

    const restarted = new KnowledgeRepository(root, {
      lockRoot,
      now: () => "2026-07-16T02:46:00.000Z",
    });
    current = await restarted.transition(created.id, {
      to: "in-answer",
      expectedRevision: firstReopened.revision,
      by: "answerer:max",
    });
    expect(
      await readdir(join(lockRoot, "operations", repositoryOperations!)),
    ).toEqual([]);
    current = await restarted.transition(created.id, {
      to: "integrating",
      expectedRevision: current.revision,
      by: "integrator",
    });
    const secondMerged = await restarted.transition(created.id, {
      to: "merged",
      expectedRevision: current.revision,
      by: "maintainer:max",
    });
    const secondReopened = await restarted.rejectAsker(created.id, input);

    expect(secondReopened).toMatchObject({
      state: "reopened",
      revision: secondMerged.revision + 1,
    });
    const rejectionEvents = secondReopened.provenance.filter(
      (event) => event.type === "rejected" && event.details?.askerId === "max",
    );
    expect(rejectionEvents).toHaveLength(2);
    expect(rejectionEvents.map((event) => event.details?.baseRevision)).toEqual(
      [firstMerged.revision, secondMerged.revision],
    );
    expect(
      new Set(rejectionEvents.map((event) => event.details?.operationId)).size,
    ).toBe(2);
    expect(
      new Set(rejectionEvents.map((event) => event.details?.rawReason)).size,
    ).toBe(2);
    expect(
      (await restarted.listRawArtifacts(created.id)).filter(
        (artifact) => artifact.kind === "rejection",
      ),
    ).toHaveLength(2);
  });

  it("recovers an identical rejection exactly once on a later merged attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-rejection-attempt-"));
    const repository = new KnowledgeRepository(root, {
      ids: createIdGenerator({
        now: () => 1_700_000_000_000,
        random: () => 0.31,
      }),
      now: () => "2026-07-16T03:00:00.000Z",
    });
    await repository.initialize();
    const created = await repository.createQuestion({
      title: "Can the same concern recur?",
      verbatimQuestion: "Can the same concern recur on a later answer attempt?",
      goals: ["implementation"],
      asker: { id: "max", acceptance: "pending" },
      origin: { kind: "raw" },
    });
    let current = await repository.transition(created.id, {
      to: "in-answer",
      expectedRevision: created.revision,
      by: "answerer:max",
    });
    current = await repository.transition(created.id, {
      to: "integrating",
      expectedRevision: current.revision,
      by: "integrator",
    });
    await repository.transition(created.id, {
      to: "merged",
      expectedRevision: current.revision,
      by: "maintainer:max",
    });
    const input = {
      askerId: "max",
      reason: "The answer still omits the interrupted-publication case.",
      by: "asker:max",
    };
    current = await repository.rejectAsker(created.id, input);
    current = await repository.transition(created.id, {
      to: "in-answer",
      expectedRevision: current.revision,
      by: "answerer:max",
    });
    current = await repository.transition(created.id, {
      to: "integrating",
      expectedRevision: current.revision,
      by: "integrator",
    });
    const secondMerged = await repository.transition(created.id, {
      to: "merged",
      expectedRevision: current.revision,
      by: "maintainer:max",
    });

    let crash = true;
    const crashing = new KnowledgeRepository(root, {
      now: () => "2026-07-16T03:01:00.000Z",
      onAskerRejectionCheckpoint: (checkpoint) => {
        if (checkpoint === "after-artifact" && crash) {
          crash = false;
          throw new Error("simulated later rejection decision failure");
        }
      },
    });
    await expect(crashing.rejectAsker(created.id, input)).rejects.toThrow(
      /simulated later rejection decision failure/i,
    );
    await expect(crashing.getQuestion(created.id)).resolves.toEqual(
      secondMerged,
    );

    const restarted = new KnowledgeRepository(root, {
      now: () => "2026-07-16T03:02:00.000Z",
    });
    const recovered = await restarted.rejectAsker(created.id, input);
    const rejectionEvents = recovered.provenance.filter(
      (event) => event.type === "rejected" && event.details?.askerId === "max",
    );
    expect(rejectionEvents).toHaveLength(2);
    expect(
      new Set(rejectionEvents.map((event) => event.details?.operationId)).size,
    ).toBe(2);
    expect(
      (await restarted.listRawArtifacts(created.id)).filter(
        (artifact) => artifact.kind === "rejection",
      ),
    ).toHaveLength(2);
  });

  it("persists and merges portable project settings with machine-local personal settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-settings-"));
    const personalPath = join(root, "local", "settings.json");
    const store = new RepositorySettingsStore(root, personalPath);
    await store.writeProject({
      schemaVersion: 1,
      acceptanceTimeoutDays: 21,
      integrationMode: "manual",
      maintenance: { enabled: false, pollIntervalMinutes: 20 },
      providers: { llm: "fake-llm", stt: "fake-stt", codec: "fake-codec" },
    });
    await store.writePersonal({
      schemaVersion: 1,
      appearance: { theme: "dark", reducedMotion: false },
      audio: { preferredFormat: "ogg", keepConvertedAudio: true },
      providerPreferences: { llm: "codex-cli" },
      consent: {},
    });

    const settings = await store.readMerged();
    expect(settings.effective.acceptanceTimeoutDays).toBe(21);
    expect(settings.effective.providers.llm).toBe("codex-cli");
    expect(settings.effective.appearance.theme).toBe("dark");
  });

  it("rejects a symlinked project-settings directory without writing outside", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-settings-root-"));
    const externalRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-settings-external-"),
    );
    await symlink(externalRoot, join(root, "settings"), "dir");
    const store = new RepositorySettingsStore(
      root,
      join(root, "local", "settings.json"),
    );

    await expect(store.writeProject({ schemaVersion: 1 })).rejects.toThrow(
      /symbolic link/i,
    );
    await expect(
      readFile(join(externalRoot, "project.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
