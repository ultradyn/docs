import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";

import { simpleGit } from "simple-git";
import { describe, expect, it } from "vitest";

import { LocalChangeRequestManager } from "./index.js";

async function gitBinaryOnPath(): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(
      directory,
      process.platform === "win32" ? "git.exe" : "git",
    );
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next PATH entry.
    }
  }
  throw new Error("Git is not available on PATH.");
}

async function passActualDiffChecks(
  manager: LocalChangeRequestManager,
  id: string,
  goals: string[],
) {
  return manager.recordActualDiffChecks(id, {
    reviewer: { approved: true, findings: [] },
    diffSummary: {
      summary: "Summarizes the reviewed actual branch diff.",
      changes: ["Documents the reviewed answer."],
      risks: [],
    },
    simulatedAsker: {
      satisfied: true,
      reason: "The post-diff documentation satisfies every declared goal.",
      goalResults: goals.map((goal) => ({
        goal,
        satisfied: true,
        rationale: `The post-diff documentation satisfies ${goal}.`,
      })),
    },
  });
}

async function directoryNames(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readInventoryDirectory(
  directory: string,
): Promise<Array<[string, string]>> {
  return Promise.all(
    (await directoryNames(directory)).map(async (name) => [
      name,
      await readFile(join(directory, name), "utf8"),
    ]),
  );
}

async function creationInventoryData(dataRoot: string): Promise<{
  metadata: Array<[string, string]>;
  operations: Array<[string, string]>;
}> {
  return {
    metadata: await readInventoryDirectory(join(dataRoot, "change-requests")),
    operations: await readInventoryDirectory(join(dataRoot, "operations")),
  };
}

async function creationInventory(
  git: ReturnType<typeof simpleGit>,
  dataRoot: string,
): Promise<{
  refs: string;
  worktrees: string;
  metadata: Array<[string, string]>;
  operations: Array<[string, string]>;
}> {
  const data = await creationInventoryData(dataRoot);
  return {
    refs: await git.raw([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
    ]),
    worktrees: await git.raw(["worktree", "list", "--porcelain"]),
    ...data,
  };
}

describe("local change request public seam", () => {
  it("migrates every schema-version-1 record to unavailable even when forged transitional fields are present", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-legacy-requests-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-legacy-requests-state-"),
    );
    const recordsRoot = join(dataRoot, "change-requests");
    await mkdir(recordsRoot, { recursive: true });
    const fixtureRoot = new URL("./test/fixtures/", import.meta.url);
    for (const [name, id] of [
      ["change-request-v1-active.json", "cr-01J00000000000000000000030"],
      ["change-request-v1-merged.json", "cr-01J00000000000000000000031"],
    ] as const) {
      const legacy = JSON.parse(
        await readFile(new URL(name, fixtureRoot), "utf8"),
      ) as Record<string, unknown>;
      await writeFile(
        join(recordsRoot, `${id}.json`),
        `${JSON.stringify(
          {
            ...legacy,
            verbatimQuestion: "Forged historic question.",
            verbatimChat: "Forged historic chat.",
            goals: ["implementation"],
            structuredAnswer: "Forged historic answer.",
            proposedFiles: null,
            inputFingerprint: "0".repeat(64),
          },
          null,
          2,
        )}\n`,
      );
    }
    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });

    const records = await manager.list();
    expect(records).toHaveLength(2);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "cr-01J00000000000000000000030",
          schemaVersion: 2,
          state: "open",
          evaluationInputState: "legacy-unavailable",
          verbatimQuestion: null,
          verbatimChat: null,
          goals: null,
        }),
        expect.objectContaining({
          id: "cr-01J00000000000000000000031",
          schemaVersion: 2,
          state: "merged",
          evaluationInputState: "legacy-unavailable",
        }),
      ]),
    );
    await expect(
      manager.get("cr-01J00000000000000000000031"),
    ).resolves.toMatchObject({
      state: "merged",
      summary: "Legacy merged change request retained for history.",
    });
    for (const id of [
      "cr-01J00000000000000000000030",
      "cr-01J00000000000000000000031",
    ]) {
      await expect(
        manager.recordActualDiffChecks(id, {
          reviewer: { approved: true, findings: [] },
          diffSummary: {
            summary: "Must not authorize legacy input.",
            changes: ["No trusted input exists."],
            risks: [],
          },
          simulatedAsker: {
            satisfied: true,
            reason: "This result must be rejected.",
            goalResults: [],
          },
        }),
      ).rejects.toThrow(/historic evaluator input.*unavailable/i);
      await expect(
        manager.approve(id, {
          by: "max",
          kind: "maintainer",
        }),
      ).rejects.toThrow(/historic evaluator input.*unavailable/i);
      await expect(manager.merge(id, { by: "max" })).rejects.toThrow(
        /historic evaluator input.*unavailable/i,
      );
    }
  });

  it("creates a later attempt without conflicting with a legacy merged question ref", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-legacy-ref-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-legacy-ref-state-"),
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");
    const baseSha = (await git.revparse(["HEAD"])).trim();
    const questionId = "q-01J00000000000000000000032";
    const legacyBranch = `ultradyn/${questionId}`;
    await git.branch([legacyBranch, baseSha]);
    const recordsRoot = join(dataRoot, "change-requests");
    await mkdir(recordsRoot, { recursive: true });
    await writeFile(
      join(recordsRoot, "cr-01J00000000000000000000032.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: "cr-01J00000000000000000000032",
          questionId,
          title: "Document: Legacy merged attempt",
          state: "merged",
          branch: legacyBranch,
          baseBranch: "main",
          baseSha,
          headSha: baseSha,
          worktreePath: join(dataRoot, "worktrees", questionId),
          diff: "",
          summary: "Legacy merged attempt.",
          checks: [],
          approvals: [],
          createdAt: "2026-07-15T02:00:00.000Z",
          updatedAt: "2026-07-15T02:00:00.000Z",
          mergedAt: "2026-07-15T02:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );
    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });

    const created = await manager.create({
      questionId,
      title: "How can a later attempt coexist?",
      question: "How is a later attempt isolated from the legacy ref?",
      verbatimChat: "The first answer was already merged.",
      goals: ["implementation"],
      structuredAnswer:
        "New attempts use a namespace that is not a child of the legacy question ref.",
    });

    expect(created.branch).toMatch(
      /^ultradyn-attempts\/cr-[0-9A-HJKMNP-TV-Z]{26}$/u,
    );
    expect((await git.revparse([legacyBranch])).trim()).toBe(baseSha);
    expect(await manager.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "cr-01J00000000000000000000032",
          state: "merged",
          branch: legacyBranch,
        }),
        expect.objectContaining({ id: created.id, state: "blocked" }),
      ]),
    );
  });

  it("serializes concurrent identical and different attempt creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-concurrent-create-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-concurrent-create-state-"),
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");
    const firstManager = new LocalChangeRequestManager({
      repoRoot: root,
      dataRoot,
    });
    const secondManager = new LocalChangeRequestManager({
      repoRoot: root,
      dataRoot,
    });
    const input: Parameters<LocalChangeRequestManager["create"]>[0] = {
      questionId: "q-01J00000000000000000000033",
      title: "How are concurrent attempts serialized?",
      question: "Can two processes create the same attempt concurrently?",
      verbatimChat: "Both requests arrived together.",
      goals: ["implementation"],
      structuredAnswer:
        "Creation is serialized under one repository-specific local lock.",
      files: [
        {
          path: "docs/concurrent-create.md",
          content: "# Concurrent create\n\nOriginal input.\n",
        },
      ],
    };

    const identical = await Promise.all([
      firstManager.create(input),
      secondManager.create(input),
    ]);
    expect(new Set(identical.map((record) => record.id)).size).toBe(1);
    expect(
      (await firstManager.list()).filter(
        (record) => record.state !== "merged" && record.state !== "superseded",
      ),
    ).toHaveLength(1);

    const different = await Promise.all([
      firstManager.create({
        ...input,
        structuredAnswer: "The first changed answer wins its serialized turn.",
        files: [
          {
            path: "docs/concurrent-create.md",
            content: "# Concurrent create\n\nFirst changed input.\n",
          },
        ],
      }),
      secondManager.create({
        ...input,
        structuredAnswer: "The second changed answer wins its serialized turn.",
        files: [
          {
            path: "docs/concurrent-create.md",
            content: "# Concurrent create\n\nSecond changed input.\n",
          },
        ],
      }),
    ]);
    expect(new Set(different.map((record) => record.id)).size).toBe(2);
    const records = await firstManager.list();
    expect(
      records.filter(
        (record) => record.state !== "merged" && record.state !== "superseded",
      ),
    ).toHaveLength(1);
    expect(
      records.filter((record) => record.state === "superseded"),
    ).toHaveLength(2);
  });

  it.each([
    {
      name: "merge intent",
      mutate: (prior: Record<string, unknown>) => ({
        ...prior,
        mergeIntent: {
          baseHeadSha: prior.baseSha,
          branchHeadSha: prior.headSha,
          by: "maintainer",
          startedAt: "2026-07-17T00:00:00.000Z",
        },
      }),
    },
    {
      name: "merged terminal marker",
      mutate: (prior: Record<string, unknown>) => ({
        ...prior,
        mergedAt: "2026-07-17T00:00:00.000Z",
      }),
    },
    {
      name: "superseded terminal markers",
      mutate: (prior: Record<string, unknown>) => ({
        ...prior,
        supersededAt: "2026-07-17T00:00:00.000Z",
        supersededBy: "cr-01J00000000000000000000077",
      }),
    },
    {
      name: "inconsistent terminal state",
      mutate: (prior: Record<string, unknown>) => ({
        ...prior,
        state: "merged",
      }),
    },
    {
      name: "unbound input fingerprint",
      mutate: (prior: Record<string, unknown>) => ({
        ...prior,
        inputFingerprint: "0".repeat(64),
      }),
    },
    {
      name: "metadata identity mismatch",
      mutate: (prior: Record<string, unknown>) => ({
        ...prior,
        id: "cr-01J00000000000000000000078",
      }),
    },
  ])(
    "rejects a prior attempt carrying $name before persisting an operation",
    async ({ mutate }) => {
      const root = await mkdtemp(join(tmpdir(), "ultradyn-create-preflight-"));
      const dataRoot = await mkdtemp(
        join(tmpdir(), "ultradyn-create-preflight-state-"),
      );
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
      const git = simpleGit(root);
      await git.init(["--initial-branch=main"]);
      await git.addConfig("user.name", "Ultradyn Test");
      await git.addConfig("user.email", "test@ultradyn.invalid");
      await git.add("docs/_map.md");
      await git.commit("Initial documentation");
      const input: Parameters<LocalChangeRequestManager["create"]>[0] = {
        questionId: "q-01J00000000000000000000076",
        title: "When may a prior attempt be superseded?",
        question: "Can invalid prior metadata create a replacement operation?",
        verbatimChat: "Validate every prior relationship first.",
        goals: ["security-review"],
        structuredAnswer:
          "A replacement starts only after its complete prior relationship is valid.",
        files: [
          {
            path: "docs/create-preflight.md",
            content: "# Creation preflight\n\nOriginal proposal.\n",
          },
        ],
      };
      const initial = await new LocalChangeRequestManager({
        repoRoot: root,
        dataRoot,
      }).create(input);
      const metadataPath = join(
        dataRoot,
        "change-requests",
        `${initial.id}.json`,
      );
      const prior = JSON.parse(await readFile(metadataPath, "utf8")) as Record<
        string,
        unknown
      >;
      await writeFile(
        metadataPath,
        `${JSON.stringify(mutate(prior), null, 2)}\n`,
      );
      const before = await creationInventory(git, dataRoot);

      await expect(
        new LocalChangeRequestManager({ repoRoot: root, dataRoot }).create({
          ...input,
          structuredAnswer: "This replacement must never be journaled.",
          files: [
            {
              path: "docs/create-preflight.md",
              content: "# Creation preflight\n\nReplacement proposal.\n",
            },
          ],
        }),
      ).rejects.toThrow();

      expect(await creationInventory(git, dataRoot)).toEqual(before);
    },
  );

  it("rejects multiple active priors before initializing a missing repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-create-no-repo-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-create-no-repo-state-"),
    );
    const recordsRoot = join(dataRoot, "change-requests");
    await mkdir(recordsRoot, { recursive: true });
    const fixture = JSON.parse(
      await readFile(
        new URL(
          "./test/fixtures/change-request-v1-active.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const questionId = "q-01J00000000000000000000075";
    for (const id of [
      "cr-01J00000000000000000000075",
      "cr-01J00000000000000000000076",
    ]) {
      await writeFile(
        join(recordsRoot, `${id}.json`),
        `${JSON.stringify(
          {
            ...fixture,
            id,
            questionId,
            branch: `ultradyn-attempts/${id}`,
            worktreePath: join(dataRoot, "worktrees", id),
          },
          null,
          2,
        )}\n`,
      );
    }
    const metadataBefore = await creationInventoryData(dataRoot);

    await expect(
      new LocalChangeRequestManager({ repoRoot: root, dataRoot }).create({
        questionId,
        title: "Which prior is canonical?",
        question: "May creation choose between two active prior attempts?",
        verbatimChat: "The relationship is ambiguous.",
        goals: ["security-review"],
        structuredAnswer: "Ambiguous prior state must fail before Git exists.",
      }),
    ).rejects.toThrow(/active prior/i);

    expect(await directoryNames(root)).toEqual([]);
    expect(await creationInventoryData(dataRoot)).toEqual(metadataBefore);
  });

  it.each([
    {
      name: "valid target metadata owned by another operation",
      collide: async (context: {
        dataRoot: string;
        journal: {
          requestId: string;
          branch: string;
          worktreePath: string;
        };
        initialId: string;
      }) => {
        const prior = JSON.parse(
          await readFile(
            join(
              context.dataRoot,
              "change-requests",
              `${context.initialId}.json`,
            ),
            "utf8",
          ),
        ) as Record<string, unknown>;
        await writeFile(
          join(
            context.dataRoot,
            "change-requests",
            `${context.journal.requestId}.json`,
          ),
          `${JSON.stringify(
            {
              ...prior,
              id: context.journal.requestId,
              branch: context.journal.branch,
              worktreePath: context.journal.worktreePath,
            },
            null,
            2,
          )}\n`,
        );
      },
    },
    {
      name: "owner branch at the same base commit",
      collide: async (context: {
        git: ReturnType<typeof simpleGit>;
        journal: { branch: string; baseSha: string };
      }) => {
        await context.git.branch([
          context.journal.branch,
          context.journal.baseSha,
        ]);
      },
    },
    {
      name: "owner worktree registered at the expected path",
      collide: async (context: {
        git: ReturnType<typeof simpleGit>;
        dataRoot: string;
        journal: { branch: string; baseSha: string; worktreePath: string };
      }) => {
        await mkdir(join(context.dataRoot, "worktrees"), { recursive: true });
        await context.git.raw([
          "worktree",
          "add",
          "-b",
          context.journal.branch,
          context.journal.worktreePath,
          context.journal.baseSha,
        ]);
      },
    },
  ])(
    "rejects $name before recovery materializes a proposal",
    async ({ collide }) => {
      const root = await mkdtemp(
        join(tmpdir(), "ultradyn-create-target-preflight-"),
      );
      const dataRoot = await mkdtemp(
        join(tmpdir(), "ultradyn-create-target-preflight-state-"),
      );
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
      const git = simpleGit(root);
      await git.init(["--initial-branch=main"]);
      await git.addConfig("user.name", "Ultradyn Test");
      await git.addConfig("user.email", "test@ultradyn.invalid");
      await git.add("docs/_map.md");
      await git.commit("Initial documentation");
      const input: Parameters<LocalChangeRequestManager["create"]>[0] = {
        questionId: "q-01J00000000000000000000079",
        title: "Who owns recovery targets?",
        question: "May recovery adopt pre-existing target resources?",
        verbatimChat: "Every target must be proven to belong to the journal.",
        goals: ["security-review"],
        structuredAnswer:
          "Unowned target metadata, refs, and worktrees are collisions.",
        files: [
          {
            path: "docs/recovery-targets.md",
            content: "# Recovery targets\n\nOriginal proposal.\n",
          },
        ],
      };
      const initial = await new LocalChangeRequestManager({
        repoRoot: root,
        dataRoot,
      }).create(input);
      let fail = true;
      await expect(
        new LocalChangeRequestManager({
          repoRoot: root,
          dataRoot,
          onCreateCheckpoint: (checkpoint) => {
            if (checkpoint === "after-journal-persisted" && fail) {
              fail = false;
              throw new Error("stop before recovery target collision");
            }
          },
        }).create({
          ...input,
          structuredAnswer: "The replacement must not adopt owner resources.",
          files: [
            {
              path: "docs/recovery-targets.md",
              content: "# Recovery targets\n\nReplacement proposal.\n",
            },
          ],
        }),
      ).rejects.toThrow(/target collision/i);
      const [journalName] = await directoryNames(join(dataRoot, "operations"));
      const journal = JSON.parse(
        await readFile(join(dataRoot, "operations", journalName!), "utf8"),
      ) as {
        requestId: string;
        branch: string;
        baseSha: string;
        worktreePath: string;
      };
      await collide({ git, dataRoot, journal, initialId: initial.id });
      const before = await creationInventory(git, dataRoot);

      await expect(
        new LocalChangeRequestManager({ repoRoot: root, dataRoot }).list(),
      ).rejects.toThrow();

      expect(await creationInventory(git, dataRoot)).toEqual(before);
    },
  );

  it.each([
    "after-journal-persisted",
    "after-worktree-created",
    "after-proposal-committed",
    "after-operation-recorded",
    "after-new-record-persisted",
    "after-prior-superseded",
    "before-journal-cleanup",
  ] as const)(
    "reconciles attempt creation after restart at %s",
    async (failureCheckpoint) => {
      const root = await mkdtemp(join(tmpdir(), "ultradyn-create-recovery-"));
      const dataRoot = await mkdtemp(
        join(tmpdir(), "ultradyn-create-recovery-state-"),
      );
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
      const git = simpleGit(root);
      await git.init(["--initial-branch=main"]);
      await git.addConfig("user.name", "Ultradyn Test");
      await git.addConfig("user.email", "test@ultradyn.invalid");
      await git.add("docs/_map.md");
      await git.commit("Initial documentation");
      const input: Parameters<LocalChangeRequestManager["create"]>[0] = {
        questionId: "q-01J00000000000000000000034",
        title: "How does attempt recovery work?",
        question: "How is partially persisted attempt creation reconciled?",
        verbatimChat: "A process may stop at any durable boundary.",
        goals: ["implementation"],
        structuredAnswer:
          "The journal binds the proposal and completes metadata in one serialized recovery operation.",
        files: [
          {
            path: "docs/attempt-recovery.md",
            content: "# Attempt recovery\n\nOriginal proposal.\n",
          },
        ],
      };
      const initial = await new LocalChangeRequestManager({
        repoRoot: root,
        dataRoot,
      }).create(input);
      let fail = true;
      const crashing = new LocalChangeRequestManager({
        repoRoot: root,
        dataRoot,
        onCreateCheckpoint: (checkpoint) => {
          if (checkpoint === failureCheckpoint && fail) {
            fail = false;
            throw new Error(`simulated create failure at ${checkpoint}`);
          }
        },
      });
      const changedInput = {
        ...input,
        structuredAnswer:
          "The revised journal protocol reconciles every durable boundary exactly once.",
        files: [
          {
            path: "docs/attempt-recovery.md",
            content: "# Attempt recovery\n\nRevised proposal.\n",
          },
        ],
      };

      await expect(crashing.create(changedInput)).rejects.toThrow(
        new RegExp(failureCheckpoint, "i"),
      );
      const restarted = new LocalChangeRequestManager({
        repoRoot: root,
        dataRoot,
      });
      const records = await restarted.list();
      const active = records.filter(
        (record) => record.state !== "merged" && record.state !== "superseded",
      );
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({
        structuredAnswer: changedInput.structuredAnswer,
        proposedFiles: changedInput.files,
      });
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: initial.id,
            state: "superseded",
            supersededBy: active[0]!.id,
          }),
        ]),
      );
      expect(await readdir(join(dataRoot, "operations"))).toEqual([]);
    },
  );

  it.each(["worktrees", "change-requests"] as const)(
    "preflights a non-repository target's symlinked %s root without creating Git or durable state",
    async (invalidRoot) => {
      const root = await mkdtemp(
        join(tmpdir(), "ultradyn-non-repo-create-preflight-"),
      );
      const dataRoot = await mkdtemp(
        join(tmpdir(), "ultradyn-non-repo-create-preflight-state-"),
      );
      const externalRoot = await mkdtemp(
        join(tmpdir(), "ultradyn-non-repo-create-preflight-external-"),
      );
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
      await symlink(externalRoot, join(dataRoot, invalidRoot), "dir");
      const beforeRoot = await readdir(root, { recursive: true });
      const beforeData = await readdir(dataRoot, { recursive: true });

      await expect(
        new LocalChangeRequestManager({ repoRoot: root, dataRoot }).create({
          questionId: `q-non-repo-${invalidRoot}`,
          title: "Can invalid local state initialize Git?",
          question:
            "Must every intended local target be preflighted before repository initialization?",
          verbatimChat:
            "An invalid target must leave a non-repository unchanged.",
          goals: ["security-review"],
          structuredAnswer:
            "Worktree, journal, and metadata targets are checked before Git mutates the destination.",
          files: [
            {
              path: "docs/non-repo-preflight.md",
              content: "# Non-repository preflight\n",
            },
          ],
        }),
      ).rejects.toThrow(/symbolic link|symlink/i);

      await expect(simpleGit(root).checkIsRepo()).resolves.toBe(false);
      expect(await readdir(root, { recursive: true })).toEqual(beforeRoot);
      expect(await readdir(dataRoot, { recursive: true })).toEqual(beforeData);
      expect(await readdir(externalRoot)).toEqual([]);
    },
  );

  it("rejects a journal bound to a merging prior attempt before recovery creates anything", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ultradyn-create-prior-merge-intent-"),
    );
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-create-prior-merge-intent-state-"),
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");
    const input: Parameters<LocalChangeRequestManager["create"]>[0] = {
      questionId: "q-01J00000000000000000000083",
      title: "Can creation recover over a merging attempt?",
      question:
        "Can replacement recovery mutate Git before validating its prior attempt?",
      verbatimChat: "The prior merge transaction is still in progress.",
      goals: ["security-review"],
      structuredAnswer:
        "Recovery validates the complete prior relationship before creating replacement state.",
      files: [
        {
          path: "docs/prior-merge-recovery.md",
          content: "# Prior merge recovery\n\nOriginal proposal.\n",
        },
      ],
    };
    const initial = await new LocalChangeRequestManager({
      repoRoot: root,
      dataRoot,
    }).create(input);
    let fail = true;
    const crashing = new LocalChangeRequestManager({
      repoRoot: root,
      dataRoot,
      onCreateCheckpoint: (checkpoint) => {
        if (checkpoint === "after-journal-persisted" && fail) {
          fail = false;
          throw new Error("stop after replacement journal persistence");
        }
      },
    });
    await expect(
      crashing.create({
        ...input,
        structuredAnswer: "Replacement proposal must remain unmaterialized.",
        files: [
          {
            path: "docs/prior-merge-recovery.md",
            content: "# Prior merge recovery\n\nReplacement proposal.\n",
          },
        ],
      }),
    ).rejects.toThrow(/replacement journal persistence/i);
    const priorPath = join(dataRoot, "change-requests", `${initial.id}.json`);
    const prior = JSON.parse(await readFile(priorPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      priorPath,
      `${JSON.stringify(
        {
          ...prior,
          mergeIntent: {
            baseHeadSha: initial.baseSha,
            branchHeadSha: initial.headSha,
            by: "maintainer",
            startedAt: "2026-07-17T00:00:00.000Z",
            authorizationSha256: "0".repeat(64),
          },
        },
        null,
        2,
      )}\n`,
    );
    const refsBefore = await git.raw([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
    ]);
    const worktreesBefore = await git.raw(["worktree", "list", "--porcelain"]);
    const metadataBefore = await directoryNames(
      join(dataRoot, "change-requests"),
    );
    const worktreeFilesBefore = await directoryNames(
      join(dataRoot, "worktrees"),
    );

    const restarted = new LocalChangeRequestManager({
      repoRoot: root,
      dataRoot,
    });
    await expect(restarted.list()).rejects.toThrow(
      /merge intent|authorization snapshot/i,
    );
    expect(
      await git.raw([
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads",
      ]),
    ).toBe(refsBefore);
    expect(await git.raw(["worktree", "list", "--porcelain"])).toBe(
      worktreesBefore,
    );
    expect(await directoryNames(join(dataRoot, "change-requests"))).toEqual(
      metadataBefore,
    );
    expect(await directoryNames(join(dataRoot, "worktrees"))).toEqual(
      worktreeFilesBefore,
    );
  });

  it.each([
    {
      name: "an active prior carrying merged terminal metadata",
      mutate: (prior: Record<string, unknown>): Record<string, unknown> => ({
        ...prior,
        mergedAt: "2026-07-17T00:00:00.000Z",
      }),
    },
    {
      name: "an active prior carrying superseded terminal metadata",
      mutate: (prior: Record<string, unknown>): Record<string, unknown> => ({
        ...prior,
        supersededAt: "2026-07-17T00:00:00.000Z",
        supersededBy: "cr-01J00000000000000000000082",
      }),
    },
    {
      name: "a merged prior",
      mutate: (prior: Record<string, unknown>): Record<string, unknown> => ({
        ...prior,
        state: "merged",
        mergedAt: "2026-07-17T00:00:00.000Z",
      }),
    },
    {
      name: "a prematurely superseded prior",
      mutate: (
        prior: Record<string, unknown>,
        requestId: string,
      ): Record<string, unknown> => ({
        ...prior,
        state: "superseded",
        supersededAt: "2026-07-17T00:00:00.000Z",
        supersededBy: requestId,
      }),
    },
    {
      name: "a prior superseded by another operation",
      mutate: (prior: Record<string, unknown>): Record<string, unknown> => ({
        ...prior,
        state: "superseded",
        supersededAt: "2026-07-17T00:00:00.000Z",
        supersededBy: "cr-01J00000000000000000000081",
      }),
    },
  ])(
    "rejects a creation journal bound to $name before recovery creates anything",
    async ({ mutate }) => {
      const root = await mkdtemp(
        join(tmpdir(), "ultradyn-create-invalid-prior-"),
      );
      const dataRoot = await mkdtemp(
        join(tmpdir(), "ultradyn-create-invalid-prior-state-"),
      );
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
      const git = simpleGit(root);
      await git.init(["--initial-branch=main"]);
      await git.addConfig("user.name", "Ultradyn Test");
      await git.addConfig("user.email", "test@ultradyn.invalid");
      await git.add("docs/_map.md");
      await git.commit("Initial documentation");
      const input: Parameters<LocalChangeRequestManager["create"]>[0] = {
        questionId: "q-01J00000000000000000000084",
        title: "Which prior states are eligible for recovery?",
        question: "Can recovery replace an attempt in a terminal state?",
        verbatimChat: "The journal relationship must be complete.",
        goals: ["security-review"],
        structuredAnswer:
          "Only an internally consistent active attempt can be superseded.",
        files: [
          {
            path: "docs/prior-state-recovery.md",
            content: "# Prior state recovery\n\nOriginal proposal.\n",
          },
        ],
      };
      const initial = await new LocalChangeRequestManager({
        repoRoot: root,
        dataRoot,
      }).create(input);
      let fail = true;
      const crashing = new LocalChangeRequestManager({
        repoRoot: root,
        dataRoot,
        onCreateCheckpoint: (checkpoint) => {
          if (checkpoint === "after-journal-persisted" && fail) {
            fail = false;
            throw new Error("stop after replacement journal persistence");
          }
        },
      });
      await expect(
        crashing.create({
          ...input,
          structuredAnswer: "Replacement proposal must remain unmaterialized.",
          files: [
            {
              path: "docs/prior-state-recovery.md",
              content: "# Prior state recovery\n\nReplacement proposal.\n",
            },
          ],
        }),
      ).rejects.toThrow(/replacement journal persistence/i);
      const [journalName] = await directoryNames(join(dataRoot, "operations"));
      const journal = JSON.parse(
        await readFile(join(dataRoot, "operations", journalName!), "utf8"),
      ) as { requestId: string };
      const priorPath = join(dataRoot, "change-requests", `${initial.id}.json`);
      const prior = JSON.parse(await readFile(priorPath, "utf8")) as Record<
        string,
        unknown
      >;
      await writeFile(
        priorPath,
        `${JSON.stringify(mutate(prior, journal.requestId), null, 2)}\n`,
      );
      const refsBefore = await git.raw([
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads",
      ]);
      const worktreesBefore = await git.raw([
        "worktree",
        "list",
        "--porcelain",
      ]);
      const metadataBefore = await directoryNames(
        join(dataRoot, "change-requests"),
      );
      const worktreeFilesBefore = await directoryNames(
        join(dataRoot, "worktrees"),
      );

      const restarted = new LocalChangeRequestManager({
        repoRoot: root,
        dataRoot,
      });
      await expect(restarted.list()).rejects.toThrow();
      expect(
        await git.raw([
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          "refs/heads",
        ]),
      ).toBe(refsBefore);
      expect(await git.raw(["worktree", "list", "--porcelain"])).toBe(
        worktreesBefore,
      );
      expect(await directoryNames(join(dataRoot, "change-requests"))).toEqual(
        metadataBefore,
      );
      expect(await directoryNames(join(dataRoot, "worktrees"))).toEqual(
        worktreeFilesBefore,
      );
    },
  );

  it("treats every creation-journal identity and path as untrusted before recovery mutates anything", async () => {
    type Journal = {
      requestId: string;
      questionId: string;
      inputFingerprint: string;
      baseBranch: string;
      baseSha: string;
      branch: string;
      worktreePath: string;
      input: { questionId: string; structuredAnswer: string };
      record?: Record<string, unknown>;
    };
    const cases: Array<{
      name: string;
      checkpoint: "after-journal-persisted" | "after-operation-recorded";
      tamper: (context: {
        journal: Journal;
        dataRoot: string;
        externalRoot: string;
        priorBaseSha: string;
      }) => void | Promise<void>;
    }> = [
      {
        name: "traversal worktree path",
        checkpoint: "after-journal-persisted",
        tamper: ({ journal, dataRoot, externalRoot }) => {
          journal.worktreePath = `${dataRoot}/../${basename(externalRoot)}/traversal-worktree`;
        },
      },
      {
        name: "absolute worktree path",
        checkpoint: "after-journal-persisted",
        tamper: ({ journal, externalRoot }) => {
          journal.worktreePath = join(externalRoot, "absolute-worktree");
        },
      },
      {
        name: "symlinked worktree root",
        checkpoint: "after-journal-persisted",
        tamper: async ({ dataRoot, externalRoot }) => {
          await symlink(externalRoot, join(dataRoot, "worktrees"), "dir");
        },
      },
      {
        name: "mismatched request identity",
        checkpoint: "after-journal-persisted",
        tamper: ({ journal }) => {
          journal.requestId = "cr-01J00000000000000000000098";
        },
      },
      {
        name: "mismatched question identity",
        checkpoint: "after-journal-persisted",
        tamper: ({ journal }) => {
          journal.questionId = "q-01J00000000000000000000098";
        },
      },
      {
        name: "mismatched branch identity",
        checkpoint: "after-journal-persisted",
        tamper: ({ journal }) => {
          journal.branch = "ultradyn-attempts/cr-01J00000000000000000000097";
        },
      },
      {
        name: "mismatched proposal fingerprint",
        checkpoint: "after-journal-persisted",
        tamper: ({ journal }) => {
          journal.input.structuredAnswer = "Tampered after fingerprinting.";
        },
      },
      {
        name: "mismatched base revision",
        checkpoint: "after-journal-persisted",
        tamper: ({ journal, priorBaseSha }) => {
          journal.baseSha = priorBaseSha;
        },
      },
      {
        name: "mismatched base branch",
        checkpoint: "after-journal-persisted",
        tamper: ({ journal }) => {
          journal.baseBranch = "forged-base";
        },
      },
      {
        name: "embedded record path",
        checkpoint: "after-operation-recorded",
        tamper: ({ journal, externalRoot }) => {
          journal.record = {
            ...journal.record,
            worktreePath: join(externalRoot, "record-worktree"),
          };
        },
      },
      {
        name: "embedded record field",
        checkpoint: "after-operation-recorded",
        tamper: ({ journal }) => {
          journal.record = {
            ...journal.record,
            summary: "Forged recovery summary.",
          };
        },
      },
    ];

    for (const adversary of cases) {
      const root = await mkdtemp(join(tmpdir(), "ultradyn-journal-trust-"));
      const dataRoot = await mkdtemp(
        join(tmpdir(), "ultradyn-journal-trust-state-"),
      );
      const externalRoot = await mkdtemp(
        join(tmpdir(), "ultradyn-journal-trust-external-"),
      );
      const sentinelPath = join(externalRoot, "user-bytes.txt");
      await writeFile(sentinelPath, `preserve ${adversary.name}\n`);
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
      const git = simpleGit(root);
      await git.init(["--initial-branch=main"]);
      await git.addConfig("user.name", "Ultradyn Test");
      await git.addConfig("user.email", "test@ultradyn.invalid");
      await git.add("docs/_map.md");
      await git.commit("Initial documentation");
      const priorBaseSha = (await git.revparse(["HEAD"])).trim();
      await writeFile(join(root, "docs", "base.md"), "# Current base\n");
      await git.add("docs/base.md");
      await git.commit("Advance the trusted base");
      await git.branch(["forged-base", "HEAD"]);
      let fail = true;
      const crashing = new LocalChangeRequestManager({
        repoRoot: root,
        dataRoot,
        onCreateCheckpoint: (checkpoint) => {
          if (checkpoint === adversary.checkpoint && fail) {
            fail = false;
            throw new Error(`stop before ${adversary.name}`);
          }
        },
      });
      await expect(
        crashing.create({
          questionId: "q-01J00000000000000000000096",
          title: "Can a local journal escape its trust boundary?",
          question: "Can tampered recovery input mutate arbitrary paths?",
          verbatimChat: "Treat every machine-local byte as untrusted.",
          goals: ["security-review"],
          structuredAnswer:
            "Recovery derives identities and paths before any mutation.",
        }),
      ).rejects.toThrow(new RegExp(adversary.name, "i"));
      const [journalName] = await directoryNames(join(dataRoot, "operations"));
      expect(journalName).toBeDefined();
      const journalPath = join(dataRoot, "operations", journalName!);
      const journal = JSON.parse(
        await readFile(journalPath, "utf8"),
      ) as Journal;
      await adversary.tamper({
        journal,
        dataRoot,
        externalRoot,
        priorBaseSha,
      });
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      const branchesBefore = (await git.branchLocal()).all;
      const worktreesBefore = await git.raw([
        "worktree",
        "list",
        "--porcelain",
      ]);
      const metadataBefore = await directoryNames(
        join(dataRoot, "change-requests"),
      );

      const restarted = new LocalChangeRequestManager({
        repoRoot: root,
        dataRoot,
      });
      await expect(restarted.list(), adversary.name).rejects.toThrow();
      expect((await git.branchLocal()).all, adversary.name).toEqual(
        branchesBefore,
      );
      expect(
        await git.raw(["worktree", "list", "--porcelain"]),
        adversary.name,
      ).toBe(worktreesBefore);
      expect(
        await directoryNames(join(dataRoot, "change-requests")),
        adversary.name,
      ).toEqual(metadataBefore);
      expect(await directoryNames(externalRoot), adversary.name).toEqual([
        "user-bytes.txt",
      ]);
      await expect(readFile(sentinelPath, "utf8")).resolves.toBe(
        `preserve ${adversary.name}\n`,
      );
    }
  }, 30_000);

  it("fails closed without deleting user files added to a journaled worktree", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ultradyn-dirty-create-recovery-"),
    );
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-dirty-create-recovery-state-"),
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");
    let fail = true;
    const crashing = new LocalChangeRequestManager({
      repoRoot: root,
      dataRoot,
      onCreateCheckpoint: (checkpoint) => {
        if (checkpoint === "after-worktree-created" && fail) {
          fail = false;
          throw new Error("simulated stop after worktree creation");
        }
      },
    });
    await expect(
      crashing.create({
        questionId: "q-01J00000000000000000000035",
        title: "Are recovery worktrees disposable?",
        question: "Can restart recovery discard files added by a person?",
        verbatimChat: "Preserve every local byte.",
        goals: ["security-review"],
        structuredAnswer:
          "Recovery stops when the journaled worktree is dirty and leaves every file in place.",
      }),
    ).rejects.toThrow(/simulated stop/i);
    const [worktreeName] = await readdir(join(dataRoot, "worktrees"));
    expect(worktreeName).toBeDefined();
    const worktreePath = join(dataRoot, "worktrees", worktreeName!);
    const notePath = join(worktreePath, "user-recovery-notes.md");
    await writeFile(notePath, "do not delete this work\n");

    const restarted = new LocalChangeRequestManager({
      repoRoot: root,
      dataRoot,
    });
    await expect(restarted.list()).rejects.toThrow(/dirty|preserve/i);
    await expect(readFile(notePath, "utf8")).resolves.toBe(
      "do not delete this work\n",
    );
  });

  it.each([
    "a:b",
    "a..b",
    "trailing.",
    "mixed-Case",
    "reserved.lock",
    "con",
    "aux.md",
    "a".repeat(97),
  ])("rejects the Git-unsafe or case-ambiguous key %s", async (questionId) => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-invalid-key-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-invalid-key-state-"),
    );
    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });

    await expect(
      manager.create({
        questionId,
        title: "Unsafe key",
        question: "Can this key become a branch and worktree component?",
        verbatimChat: "",
        goals: ["security"],
        structuredAnswer:
          "Change-request keys must be valid, unambiguous Git and filesystem components.",
      }),
    ).rejects.toThrow(/valid lowercase slug or canonical question ID/i);
  });

  it("reuses only an active attempt bound to the exact ordered integration input", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-input-binding-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-input-binding-state-"),
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");
    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });
    const input: Parameters<LocalChangeRequestManager["create"]>[0] = {
      questionId: "q-01J00000000000000000000020",
      title: "What is bound to an integration attempt?",
      question: "Which exact input did the evaluators review?",
      verbatimChat: "The asker needs the full retry contract.",
      goals: ["implementation", "security-review"],
      structuredAnswer:
        "Each attempt is bound to its complete deterministic input.",
      files: [
        {
          path: "docs/input-binding.md",
          content: "# Input binding\n\nOriginal proposal.\n",
        },
      ],
    };

    let current = await manager.create(input);
    await expect(manager.create(input)).resolves.toEqual(current);
    const dirtyAttempt = current;
    await writeFile(
      join(dirtyAttempt.worktreePath, "user-notes.md"),
      "preserve this untracked user work\n",
    );

    const changedInputs: Array<
      Parameters<LocalChangeRequestManager["create"]>[0]
    > = [
      { ...input, question: "Which exact revised question was reviewed?" },
      { ...input, verbatimChat: "The asker added new chat context." },
      { ...input, goals: ["security-review", "implementation"] },
      {
        ...input,
        structuredAnswer: "The structured answer changed before integration.",
      },
      {
        ...input,
        files: [
          {
            path: "docs/input-binding.md",
            content: "# Input binding\n\nRevised proposal content.\n",
          },
        ],
      },
      {
        ...input,
        files: [
          {
            path: "docs/revised-input-binding.md",
            content: "# Input binding\n\nRevised proposal content.\n",
          },
        ],
      },
    ];

    for (const changed of changedInputs) {
      const previous = current;
      current = await manager.create(changed);
      expect(current.id).not.toBe(previous.id);
      expect(current.branch).not.toBe(previous.branch);
      expect(current.worktreePath).not.toBe(previous.worktreePath);
      await expect(manager.get(previous.id)).resolves.toMatchObject({
        state: "superseded",
      });
      await expect(manager.create(changed)).resolves.toEqual(current);
    }
    await expect(
      readFile(join(dirtyAttempt.worktreePath, "user-notes.md"), "utf8"),
    ).resolves.toBe("preserve this untracked user work\n");
    await expect(
      manager.approve(dirtyAttempt.id, { by: "max", kind: "answerer" }),
    ).rejects.toThrow(/superseded/i);
  });

  it("isolates a real documentation diff, persists checks, and merges only after approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-change-request-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-change-request-state-"),
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "docs", "_map.md"),
      "# Documentation map\n",
      "utf8",
    );
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");

    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });
    const created = await manager.create({
      questionId: "q-01J00000000000000000000000",
      title: "How does recovery work?",
      question: "How does the bridge recover after an interrupted write?",
      verbatimChat: "",
      goals: ["implementation"],
      structuredAnswer:
        "The bridge replays from the last verified checkpoint and discards the incomplete tail.",
    });

    expect(created.branch).toMatch(
      /^ultradyn-attempts\/cr-[0-9A-HJKMNP-TV-Z]{26}$/u,
    );
    expect(created.state).toBe("blocked");
    expect(created.diff).toContain(
      "docs/answers/q-01J00000000000000000000000.md",
    );
    expect(created.diff).toContain("last verified checkpoint");
    const reviewed = await passActualDiffChecks(
      manager,
      created.id,
      created.goals,
    );
    expect(reviewed.state).toBe("open");
    expect(created.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "diff-check", status: "passed" }),
      ]),
    );
    await expect(
      readFile(
        join(root, "docs", "answers", "q-01J00000000000000000000000.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect(
      await new LocalChangeRequestManager({ repoRoot: root, dataRoot }).get(
        created.id,
      ),
    ).toEqual(reviewed);
    await expect(
      manager.get(`${created.id}/../${created.id}`),
    ).rejects.toThrow();
    const questionRecord = join(
      root,
      "questions",
      "active",
      "q-01J00000000000000000000000",
      "record.json",
    );
    await mkdir(join(questionRecord, ".."), { recursive: true });
    await writeFile(questionRecord, '{"id":"q-01J00000000000000000000000"}\n');
    await manager.approve(created.id, {
      by: "diff-summarizer",
      kind: "summary",
    });
    await expect(manager.merge(created.id, { by: "max" })).rejects.toThrow(
      /answerer or maintainer approval/i,
    );
    await manager.approve(created.id, { by: "max", kind: "answerer" });
    const merged = await manager.merge(created.id, { by: "max" });

    expect(merged.state).toBe("merged");
    expect(
      await readFile(
        join(root, "docs", "answers", "q-01J00000000000000000000000.md"),
        "utf8",
      ),
    ).toContain("last verified checkpoint");
    expect((await git.raw(["ls-files", "questions"])).trim()).toContain(
      "questions/active/q-01J00000000000000000000000/record.json",
    );
  });

  it("requires a fresh review when portable documentation advances on the base branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-stale-base-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-stale-base-state-"),
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");
    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });
    const created = await manager.create({
      questionId: "q-01J00000000000000000000004",
      title: "What is the reviewed answer?",
      question: "Which answer was reviewed against the current documentation?",
      verbatimChat: "",
      goals: ["implementation"],
      structuredAnswer:
        "The isolated answer is valid only against the portable base content reviewed with its actual diff.",
    });
    await passActualDiffChecks(manager, created.id, created.goals);

    await writeFile(join(root, "docs", "concurrent.md"), "# Concurrent edit\n");
    await git.add("docs/concurrent.md");
    await git.commit("Concurrent documentation edit");

    await expect(
      manager.approve(created.id, { by: "max", kind: "answerer" }),
    ).rejects.toThrow(/base branch changed after review/i);
    await expect(manager.get(created.id)).resolves.toMatchObject({
      state: "open",
      approvals: [],
    });
  });

  it("rejects forged merge intent on every read before it can authorize reconciliation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-forged-merge-intent-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-forged-merge-intent-state-"),
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");
    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });
    const created = await manager.create({
      questionId: "q-01J00000000000000000000033",
      title: "Can merge recovery bypass authorization?",
      question:
        "Can attacker-authored merge intent authorize a blocked request?",
      verbatimChat: "No evaluator or human approved this proposal.",
      goals: ["security-review"],
      structuredAnswer:
        "Merge recovery must derive authority from the exact approved record, not from intent metadata alone.",
    });
    expect(created).toMatchObject({ state: "blocked", approvals: [] });
    expect(created.checks.some((check) => check.status === "failed")).toBe(
      true,
    );
    const metadataPath = join(
      dataRoot,
      "change-requests",
      `${created.id}.json`,
    );
    await writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          ...created,
          mergeIntent: {
            baseHeadSha: created.baseSha,
            branchHeadSha: created.headSha,
            by: "attacker",
            startedAt: "2026-07-17T00:00:00.000Z",
            authorizationSha256: "0".repeat(64),
          },
        },
        null,
        2,
      )}\n`,
    );
    const restarted = new LocalChangeRequestManager({
      repoRoot: root,
      dataRoot,
    });
    const observe = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
        return undefined;
      } catch (error) {
        return error;
      }
    };
    const outcomes = [
      await observe(() => manager.get(created.id)),
      await observe(() => manager.list()),
      await observe(() => restarted.get(created.id)),
      await observe(() => restarted.list()),
      await observe(() => restarted.merge(created.id, { by: "attacker" })),
    ];

    for (const outcome of outcomes) {
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(
        /merge intent|authorization|approved|checks/i,
      );
    }
    expect((await git.revparse(["HEAD"])).trim()).toBe(created.baseSha);
    await expect(
      readFile(
        join(root, "docs", "answers", "q-01J00000000000000000000033.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(metadataPath, `${JSON.stringify(created, null, 2)}\n`);
    await passActualDiffChecks(manager, created.id, created.goals);
    const approved = await manager.approve(created.id, {
      by: "max",
      kind: "maintainer",
    });
    await writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          ...approved,
          mergeIntent: {
            baseHeadSha: approved.baseSha,
            branchHeadSha: approved.headSha,
            by: "max",
            startedAt: "2026-07-17T00:01:00.000Z",
            authorizationSha256: "0".repeat(64),
          },
        },
        null,
        2,
      )}\n`,
    );
    const forgedApprovedOutcome = await observe(() =>
      restarted.merge(created.id, { by: "max" }),
    );
    expect(forgedApprovedOutcome).toBeInstanceOf(Error);
    expect((forgedApprovedOutcome as Error).message).toMatch(
      /exact approved authorization snapshot/i,
    );
    expect((await git.revparse(["HEAD"])).trim()).toBe(created.baseSha);
  });

  it("merges only the reviewed commit when the attempt ref moves after validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-merge-ref-race-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-merge-ref-race-state-"),
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");
    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });
    const questionId = "q-01J00000000000000000000013";
    const created = await manager.create({
      questionId,
      title: "Which reviewed commit may merge?",
      question: "Can a branch ref move after its reviewed head is validated?",
      verbatimChat: "Only immutable reviewed bytes are authorized.",
      goals: ["security-review"],
      structuredAnswer:
        "The merge names the exact reviewed commit instead of a mutable branch ref.",
    });
    await passActualDiffChecks(manager, created.id, created.goals);
    await manager.approve(created.id, { by: "max", kind: "maintainer" });

    const proposalPath = join(
      created.worktreePath,
      "docs",
      "answers",
      `${questionId}.md`,
    );
    const worktreeGit = simpleGit(created.worktreePath);
    await writeFile(proposalPath, "UNREVIEWED BYTES MUST NEVER MERGE\n");
    await worktreeGit.add(`docs/answers/${questionId}.md`);
    await worktreeGit.commit("Unreviewed replacement");
    const unreviewedHead = (await worktreeGit.revparse(["HEAD"])).trim();
    await worktreeGit.raw(["reset", "--hard", created.headSha]);

    const binRoot = await mkdtemp(join(tmpdir(), "ultradyn-interposed-git-"));
    const gitWrapperPath = join(
      binRoot,
      process.platform === "win32" ? "git.exe" : "git",
    );
    const realGit = await gitBinaryOnPath();
    await writeFile(
      gitWrapperPath,
      [
        "#!/bin/sh",
        "is_merge=false",
        "has_no_ff=false",
        "for argument do",
        "  [ \"$argument\" = 'merge' ] && is_merge=true",
        "  [ \"$argument\" = '--no-ff' ] && has_no_ff=true",
        "done",
        "if $is_merge && $has_no_ff; then",
        `  '${realGit}' -C '${root}' update-ref 'refs/heads/${created.branch}' '${unreviewedHead}' || exit 72`,
        "  for argument do",
        `    [ "$argument" = '${created.headSha}' ] && exit 73`,
        "  done",
        "fi",
        `exec '${realGit}' "$@"`,
        "",
      ].join("\n"),
    );
    await chmod(gitWrapperPath, 0o755);
    const baseHead = (await git.revparse(["HEAD"])).trim();

    const originalPath = process.env.PATH;
    process.env.PATH = `${binRoot}${delimiter}${originalPath ?? ""}`;
    try {
      await expect(
        manager.merge(created.id, {
          by: "max",
          checkpointManagedState: false,
        }),
      ).rejects.toThrow(/local merge|branch .*changed|reviewed|exact|unsafe/i);
    } finally {
      process.env.PATH = originalPath;
    }

    expect((await git.revparse(["HEAD"])).trim()).toBe(baseHead);
    await expect(readFile(join(root, "docs", "answers", `${questionId}.md`), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect((await git.revparse([created.branch])).trim()).toBe(unreviewedHead);
  });

  it("reconciles the exact merge commit after metadata persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-merge-reconcile-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-merge-reconcile-state-"),
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");
    let failMergedMetadata = true;
    const manager = new LocalChangeRequestManager({
      repoRoot: root,
      dataRoot,
      metadataWriter: async (path, contents) => {
        const snapshot = JSON.parse(contents) as { state: string };
        if (snapshot.state === "merged" && failMergedMetadata) {
          failMergedMetadata = false;
          throw new Error("simulated merged metadata failure");
        }
        await writeFile(path, contents, "utf8");
      },
    });
    const created = await manager.create({
      questionId: "q-01J00000000000000000000012",
      title: "How is merge recovery durable?",
      question: "How does retry recognize an already committed merge?",
      verbatimChat: "A restart can happen after Git advances HEAD.",
      goals: ["implementation"],
      structuredAnswer:
        "A durable merge intent binds the reviewed base and branch heads so retry can reconcile only their exact merge commit.",
    });
    await manager.recordActualDiffChecks(created.id, {
      reviewer: { approved: true, findings: [] },
      diffSummary: {
        summary: "Documents exact merge reconciliation.",
        changes: ["Adds the durable merge-intent protocol."],
        risks: [],
      },
      simulatedAsker: {
        satisfied: true,
        reason: "The restart behavior is explicit.",
        goalResults: [
          {
            goal: "implementation",
            satisfied: true,
            rationale: "The exact parent heads are persisted.",
          },
        ],
      },
    });
    await manager.approve(created.id, { by: "max", kind: "maintainer" });

    await expect(manager.merge(created.id, { by: "max" })).rejects.toThrow(
      /simulated merged metadata failure/i,
    );
    const advancedHead = (await git.revparse(["HEAD"])).trim();
    expect(advancedHead).not.toBe(created.baseSha);
    await expect(manager.get(created.id)).resolves.toMatchObject({
      state: "approved",
      mergeIntent: {
        baseHeadSha: created.baseSha,
        branchHeadSha: created.headSha,
        authorizationSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });

    const restarted = new LocalChangeRequestManager({
      repoRoot: root,
      dataRoot,
    });
    const recovered = await restarted.merge(created.id, { by: "max" });
    expect(recovered).toMatchObject({
      state: "merged",
      mergedAt: expect.any(String),
    });
    expect(recovered).not.toHaveProperty("mergeIntent");
    expect((await git.revparse(["HEAD"])).trim()).toBe(advancedHead);
    await expect(
      readFile(
        join(root, "docs", "answers", "q-01J00000000000000000000012.md"),
        "utf8",
      ),
    ).resolves.toContain("durable merge intent");
  });

  it("resumes verified worktree cleanup after merged metadata is durable", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-merge-cleanup-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-merge-cleanup-state-"),
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");
    let failCleanup = true;
    const manager = new LocalChangeRequestManager({
      repoRoot: root,
      dataRoot,
      worktreeRemover: async (path) => {
        if (failCleanup) {
          failCleanup = false;
          throw new Error("simulated worktree cleanup failure");
        }
        await git.raw(["worktree", "remove", path]);
      },
    });
    const created = await manager.create({
      questionId: "q-01J00000000000000000000013",
      title: "How is cleanup resumed?",
      question: "What happens if cleanup is interrupted after merge metadata?",
      verbatimChat: "Do not merge the branch a second time.",
      goals: ["implementation"],
      structuredAnswer:
        "Merged metadata retains its exact merge intent until the registered managed worktree is removed.",
    });
    await manager.recordActualDiffChecks(created.id, {
      reviewer: { approved: true, findings: [] },
      diffSummary: {
        summary: "Documents restartable merge cleanup.",
        changes: ["Retains cleanup intent until completion."],
        risks: [],
      },
      simulatedAsker: {
        satisfied: true,
        reason: "Cleanup retry is explicit.",
        goalResults: [
          {
            goal: "implementation",
            satisfied: true,
            rationale: "The merge is not replayed.",
          },
        ],
      },
    });
    await manager.approve(created.id, { by: "max", kind: "maintainer" });

    await expect(manager.merge(created.id, { by: "max" })).rejects.toThrow(
      /simulated worktree cleanup failure/i,
    );
    const mergedHead = (await git.revparse(["HEAD"])).trim();
    await expect(manager.get(created.id)).resolves.toMatchObject({
      state: "merged",
      mergeIntent: {
        mergedHeadSha: mergedHead,
        authorizationSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    await expect(
      readFile(join(created.worktreePath, ".git"), "utf8"),
    ).resolves.toContain("gitdir:");

    const proposalPath = join(
      created.worktreePath,
      "docs",
      "answers",
      "q-01J00000000000000000000013.md",
    );
    const latePath = join(created.worktreePath, "post-merge-notes.md");
    await writeFile(proposalPath, "tracked work after merged metadata\n");
    await writeFile(latePath, "untracked work after merged metadata\n");

    const restarted = new LocalChangeRequestManager({
      repoRoot: root,
      dataRoot,
    });
    await expect(restarted.merge(created.id, { by: "max" })).rejects.toThrow(
      /dirty|tracked|untracked|clean/i,
    );
    expect((await git.revparse(["HEAD"])).trim()).toBe(mergedHead);
    await expect(readFile(proposalPath, "utf8")).resolves.toBe(
      "tracked work after merged metadata\n",
    );
    await expect(readFile(latePath, "utf8")).resolves.toBe(
      "untracked work after merged metadata\n",
    );

    const worktreeGit = simpleGit(created.worktreePath);
    await worktreeGit.raw(["reset", "--hard", "HEAD"]);
    await worktreeGit.raw(["clean", "-fd"]);
    const recovered = await restarted.merge(created.id, { by: "max" });
    expect(recovered.state).toBe("merged");
    expect(recovered).not.toHaveProperty("mergeIntent");
    expect((await git.revparse(["HEAD"])).trim()).toBe(mergedHead);
    await expect(
      readFile(join(created.worktreePath, ".git"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves tracked and untracked worktree dirt added after review and resumes cleanup after cleaning", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-dirty-cleanup-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-dirty-cleanup-state-"),
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");
    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });
    const questionId = "q-01J00000000000000000000014";
    const created = await manager.create({
      questionId,
      title: "Can cleanup destroy late work?",
      question: "What happens to worktree edits made after review?",
      verbatimChat: "Preserve every local byte and make cleanup retryable.",
      goals: ["implementation"],
      structuredAnswer:
        "Cleanup checks the reviewed worktree for tracked and untracked dirt before removing it.",
    });
    await passActualDiffChecks(manager, created.id, created.goals);
    await manager.approve(created.id, { by: "max", kind: "maintainer" });
    const proposalPath = join(
      created.worktreePath,
      "docs",
      "answers",
      `${questionId}.md`,
    );
    const notesPath = join(created.worktreePath, "late-notes.md");
    const modifiedBytes = "locally refined after review\n";
    const untrackedBytes = "irreplaceable late notes\n";
    await writeFile(proposalPath, modifiedBytes);
    await writeFile(notesPath, untrackedBytes);

    await expect(manager.merge(created.id, { by: "max" })).rejects.toThrow(
      /dirty|tracked|untracked|clean/i,
    );
    const mergedHead = (await git.revparse(["HEAD"])).trim();
    await expect(manager.get(created.id)).resolves.toMatchObject({
      state: "merged",
      mergeIntent: { mergedHeadSha: mergedHead },
    });
    await expect(readFile(proposalPath, "utf8")).resolves.toBe(modifiedBytes);
    await expect(readFile(notesPath, "utf8")).resolves.toBe(untrackedBytes);

    const worktreeGit = simpleGit(created.worktreePath);
    await worktreeGit.raw(["reset", "--hard", "HEAD"]);
    await worktreeGit.raw(["clean", "-fd"]);
    const recovered = await manager.merge(created.id, { by: "max" });
    expect(recovered.state).toBe("merged");
    expect(recovered).not.toHaveProperty("mergeIntent");
    expect((await git.revparse(["HEAD"])).trim()).toBe(mergedHead);
    await expect(readFile(proposalPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("creates an empty initial commit without capturing unrelated user files", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-unborn-repository-"));
    const dataRoot = await mkdtemp(join(tmpdir(), "ultradyn-unborn-state-"));
    await writeFile(join(root, "private-notes.txt"), "must remain untracked\n");

    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });
    await manager.create({
      questionId: "q-01J00000000000000000000002",
      title: "How does initialization work?",
      question: "How does initialization avoid unrelated files?",
      verbatimChat: "",
      goals: ["implementation"],
      structuredAnswer:
        "Create an empty base commit, then commit only the isolated documentation proposal.",
    });

    const git = simpleGit(root);
    expect(
      await git.raw(["ls-tree", "-r", "--name-only", "HEAD"]),
    ).not.toContain("private-notes.txt");
    expect((await git.status()).not_added).toContain("private-notes.txt");
  });

  it("persists required actual-diff agent checks and allows a clean retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-actual-diff-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-actual-diff-state-"),
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "docs", "_map.md"),
      "# Documentation map\n",
      "utf8",
    );
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");

    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });
    const created = await manager.create({
      questionId: "q-01J00000000000000000000003",
      title: "How does recovery work?",
      question: "How is an interrupted write recovered?",
      verbatimChat: "",
      goals: ["implementation"],
      structuredAnswer:
        "Replay from the checksum-verified checkpoint and discard the incomplete tail.",
    });

    expect(created.state).toBe("blocked");
    expect(created.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "reviewer", status: "failed" }),
        expect.objectContaining({ id: "diff-summary", status: "failed" }),
        expect.objectContaining({ id: "simulated-asker", status: "failed" }),
      ]),
    );
    await expect(
      manager.approve(created.id, { by: "max", kind: "answerer" }),
    ).rejects.toThrow(/checks must be resolved/i);

    const failed = await manager.recordActualDiffChecks(created.id, {
      reviewer: {
        approved: false,
        findings: [
          { severity: "blocking", text: "The recovery trigger is missing." },
        ],
      },
      diffSummary: {
        summary: "Adds the checkpoint replay procedure.",
        changes: ["Documents checkpoint replay."],
        risks: ["The trigger is not stated."],
      },
      simulatedAsker: {
        satisfied: true,
        reason: "The recovery point is explicit.",
        goalResults: [
          {
            goal: "implementation",
            satisfied: true,
            rationale: "The replay point is named.",
          },
        ],
      },
    });
    expect(failed).toMatchObject({
      state: "blocked",
      summary: "Adds the checkpoint replay procedure.",
      checks: expect.arrayContaining([
        expect.objectContaining({
          id: "reviewer",
          status: "failed",
          detail: expect.stringContaining("recovery trigger"),
        }),
        expect.objectContaining({ id: "diff-summary", status: "passed" }),
        expect.objectContaining({ id: "simulated-asker", status: "passed" }),
      ]),
    });

    const restarted = new LocalChangeRequestManager({
      repoRoot: root,
      dataRoot,
    });
    const retried = await restarted.recordActualDiffChecks(created.id, {
      reviewer: { approved: true, findings: [] },
      diffSummary: {
        summary: "Adds a complete checkpoint replay procedure.",
        changes: ["Documents the trigger and replay point."],
        risks: [],
      },
      simulatedAsker: {
        satisfied: true,
        reason: "The procedure answers the question.",
        goalResults: [
          {
            goal: "implementation",
            satisfied: true,
            rationale: "The complete procedure is present.",
          },
        ],
      },
    });
    expect(retried).toMatchObject({
      state: "open",
      summary: "Adds a complete checkpoint replay procedure.",
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "reviewer", status: "passed" }),
      ]),
    });
    expect(await restarted.get(created.id)).toEqual(retried);

    await restarted.approve(created.id, { by: "max", kind: "answerer" });
    const worktreeGit = simpleGit(retried.worktreePath);
    const answerPath = join(
      retried.worktreePath,
      "docs",
      "answers",
      "q-01J00000000000000000000003.md",
    );
    await writeFile(
      answerPath,
      `${await readFile(answerPath, "utf8")}\nUnreviewed branch mutation.\n`,
      "utf8",
    );
    await worktreeGit.add("docs/answers/q-01J00000000000000000000003.md");
    await worktreeGit.commit("Unreviewed mutation");

    await expect(restarted.merge(created.id, { by: "max" })).rejects.toThrow(
      /changed after the actual diff was captured/i,
    );
  });

  it("cannot omit any mandatory fresh actual-diff evaluator", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ultradyn-mandatory-evaluators-"),
    );
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-mandatory-evaluators-state-"),
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");
    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });

    const created = await manager.create({
      questionId: "q-01J00000000000000000000009",
      title: "Can checks be omitted?",
      question: "Can a caller skip the mandatory evaluators?",
      verbatimChat: "",
      goals: ["security-review"],
      structuredAnswer:
        "Every production proposal must be checked by fresh isolated evaluator calls over its actual diff.",
    });

    expect(created).toMatchObject({
      state: "blocked",
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "reviewer", status: "failed" }),
        expect.objectContaining({ id: "diff-summary", status: "failed" }),
        expect.objectContaining({ id: "simulated-asker", status: "failed" }),
      ]),
    });
    await expect(
      manager.approve(created.id, { by: "max", kind: "maintainer" }),
    ).rejects.toThrow(/checks must be resolved/i);
  });

  it("persists declared goals and requires an explicit verbatim chat field, including empty chat", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-evaluator-context-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-evaluator-context-state-"),
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");
    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });
    const withoutChat = {
      questionId: "q-01J00000000000000000000010",
      title: "What context is reviewed?",
      question: "Which exact asker context reaches evaluation?",
      goals: ["implementation", "security-review"],
      structuredAnswer:
        "The proposal persists the verbatim ask, chat, and declared goals used by every isolated evaluator.",
    } as Parameters<typeof manager.create>[0];

    await expect(manager.create(withoutChat)).rejects.toThrow(/verbatim chat/i);
    await expect(
      manager.create({
        ...withoutChat,
        questionId: "q-01J00000000000000000000014",
        verbatimChat: "",
        goals: ["implementation", "implementation"],
      }),
    ).rejects.toThrow(/unique/i);

    const created = await manager.create({ ...withoutChat, verbatimChat: "" });
    expect(created).toMatchObject({
      verbatimQuestion: "Which exact asker context reaches evaluation?",
      verbatimChat: "",
      goals: ["implementation", "security-review"],
    });
    await expect(
      new LocalChangeRequestManager({ repoRoot: root, dataRoot }).get(
        created.id,
      ),
    ).resolves.toMatchObject({ verbatimChat: "" });

    const evaluatorResult = (
      goalResults: Array<{
        goal: string;
        satisfied: boolean;
        rationale: string;
      }>,
    ) => ({
      reviewer: { approved: true, findings: [] },
      diffSummary: {
        summary: "Binds evaluator output to the declared context.",
        changes: ["Persists exact evaluator context."],
        risks: [],
      },
      simulatedAsker: {
        satisfied: true,
        reason: "Every declared goal is explicitly checked.",
        goalResults,
      },
    });
    const result = (goal: string) => ({
      goal,
      satisfied: true,
      rationale: `${goal} is covered.`,
    });
    const invalidGoalResults = [
      [],
      [result("implementation")],
      [result("implementation"), result("implementation")],
      [
        result("implementation"),
        result("security-review"),
        result("foreign-goal"),
      ],
    ];
    for (const goalResults of invalidGoalResults) {
      await expect(
        manager.recordActualDiffChecks(
          created.id,
          evaluatorResult(goalResults),
        ),
      ).rejects.toThrow(/exactly one result for every declared goal/i);
    }
    await expect(manager.get(created.id)).resolves.toMatchObject({
      state: "blocked",
      approvals: [],
    });
  });

  it("rejects a proposal through a committed symlink instead of writing outside the worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-symlink-proposal-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-symlink-proposal-state-"),
    );
    const externalRoot = await mkdtemp(join(tmpdir(), "ultradyn-external-"));
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "docs", "_map.md"),
      "# Documentation map\n",
      "utf8",
    );
    await symlink(externalRoot, join(root, "docs", "linked"), "dir");
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add(["docs/_map.md", "docs/linked"]);
    await git.commit("Initial documentation with link");

    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });
    await expect(
      manager.create({
        questionId: "q-symlink-proposal",
        title: "Can proposals escape?",
        question: "Can a proposal write through a committed symlink?",
        verbatimChat: "",
        goals: ["security-review"],
        structuredAnswer:
          "Proposed documentation must remain within its isolated Git worktree.",
        files: [
          {
            path: "docs/linked/escaped.md",
            content: "# This must not escape\n",
          },
        ],
      }),
    ).rejects.toThrow(/symbolic link/i);
    await expect(
      readFile(join(externalRoot, "escaped.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a local worktrees symlink before creating a proposal outside the data root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-symlink-worktrees-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-symlink-worktrees-state-"),
    );
    const externalRoot = await mkdtemp(join(tmpdir(), "ultradyn-external-"));
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "docs", "_map.md"),
      "# Documentation map\n",
      "utf8",
    );
    await symlink(externalRoot, join(dataRoot, "worktrees"), "dir");
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");

    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });
    await expect(
      manager.create({
        questionId: "q-symlink-worktrees",
        title: "Can worktree creation escape?",
        question: "Can a local worktrees symlink redirect the proposal?",
        verbatimChat: "",
        goals: ["security-review"],
        structuredAnswer:
          "The isolated worktree must be created beneath the configured local data root.",
      }),
    ).rejects.toThrow(/symbolic link/i);
    await expect(
      readFile(
        join(
          externalRoot,
          "q-symlink-worktrees",
          "docs",
          "answers",
          "q-symlink-worktrees.md",
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("coexists with and preserves a legacy registered worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-colliding-worktree-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-colliding-worktree-state-"),
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "_map.md"), "# Documentation map\n");
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");
    const questionId = "q-01J00000000000000000000011";
    const worktreePath = join(dataRoot, "worktrees", questionId);
    await mkdir(join(dataRoot, "worktrees"), { recursive: true });
    await git.raw([
      "worktree",
      "add",
      "-b",
      `ultradyn/${questionId}`,
      worktreePath,
      "HEAD",
    ]);
    await writeFile(
      join(worktreePath, "docs", "_map.md"),
      "# Locally modified documentation map\n",
    );
    await writeFile(
      join(worktreePath, "untracked-notes.md"),
      "irreplaceable local notes\n",
    );
    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });

    await expect(
      manager.create({
        questionId,
        title: "Can recovery delete work?",
        question: "Can a create retry delete a registered worktree?",
        verbatimChat: "",
        goals: ["security-review"],
        structuredAnswer:
          "Collision recovery must refuse unknown worktrees and preserve every local byte.",
      }),
    ).resolves.toMatchObject({
      branch: expect.stringMatching(/^ultradyn-attempts\/cr-/u),
    });
    await expect(
      readFile(join(worktreePath, "docs", "_map.md"), "utf8"),
    ).resolves.toBe("# Locally modified documentation map\n");
    await expect(
      readFile(join(worktreePath, "untracked-notes.md"), "utf8"),
    ).resolves.toBe("irreplaceable local notes\n");
  });

  it("rejects a local change-request metadata symlink before persisting a proposal outside the data root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-symlink-metadata-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-symlink-metadata-state-"),
    );
    const externalRoot = await mkdtemp(join(tmpdir(), "ultradyn-external-"));
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "docs", "_map.md"),
      "# Documentation map\n",
      "utf8",
    );
    await symlink(externalRoot, join(dataRoot, "change-requests"), "dir");
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");

    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });
    await expect(
      manager.create({
        questionId: "q-symlink-metadata",
        title: "Can local metadata escape?",
        question: "Can proposal metadata follow a local symlink?",
        verbatimChat: "",
        goals: ["security-review"],
        structuredAnswer:
          "Change-request metadata must stay beneath the configured local data root.",
      }),
    ).rejects.toThrow(/symbolic link/i);
    expect(await readdir(externalRoot)).toEqual([]);
  });

  it("rejects the default proposal through a committed answers symlink", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ultradyn-symlink-default-proposal-"),
    );
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-symlink-default-proposal-state-"),
    );
    const externalRoot = await mkdtemp(join(tmpdir(), "ultradyn-external-"));
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "docs", "_map.md"),
      "# Documentation map\n",
      "utf8",
    );
    await symlink(externalRoot, join(root, "docs", "answers"), "dir");
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add(["docs/_map.md", "docs/answers"]);
    await git.commit("Initial documentation with answers link");

    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });
    await expect(
      manager.create({
        questionId: "q-symlink-default",
        title: "Can default proposals escape?",
        question: "Can the default proposal write through a symlink?",
        verbatimChat: "",
        goals: ["security-review"],
        structuredAnswer:
          "Default documentation proposals must stay in their isolated worktree.",
      }),
    ).rejects.toThrow(/symbolic link/i);
    await expect(
      readFile(join(externalRoot, "q-symlink-default.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a local symlink instead of reading post-diff documentation outside the worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-symlink-post-diff-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-symlink-post-diff-state-"),
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "docs", "_map.md"),
      "# Documentation map\n",
      "utf8",
    );
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");
    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });
    const created = await manager.create({
      questionId: "q-symlink-post-diff",
      title: "Can post-diff reads escape?",
      question: "Can a local symlink redirect a post-diff read?",
      verbatimChat: "",
      goals: ["security-review"],
      structuredAnswer:
        "Post-diff review must read only documentation inside the isolated worktree.",
      files: [
        {
          path: "docs/review.md",
          content: "# Reviewed content\n",
        },
      ],
    });
    const externalRoot = await mkdtemp(join(tmpdir(), "ultradyn-external-"));
    const externalDocument = join(externalRoot, "review.md");
    await writeFile(externalDocument, "# Untrusted outside content\n", "utf8");
    const worktreeDocument = join(created.worktreePath, "docs", "review.md");
    await rm(worktreeDocument);
    await symlink(externalDocument, worktreeDocument);

    await expect(manager.readPostDiffDocumentation(created.id)).rejects.toThrow(
      /symbolic link/i,
    );
  });

  it("rejects a replaced worktree root before reading post-diff documentation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-symlink-worktree-"));
    const dataRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-symlink-worktree-state-"),
    );
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "docs", "_map.md"),
      "# Documentation map\n",
      "utf8",
    );
    const git = simpleGit(root);
    await git.init(["--initial-branch=main"]);
    await git.addConfig("user.name", "Ultradyn Test");
    await git.addConfig("user.email", "test@ultradyn.invalid");
    await git.add("docs/_map.md");
    await git.commit("Initial documentation");
    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });
    const created = await manager.create({
      questionId: "q-replaced-worktree",
      title: "Can the worktree root be replaced?",
      question: "Can post-diff review follow a replaced worktree root?",
      verbatimChat: "",
      goals: ["security-review"],
      structuredAnswer:
        "Post-diff review must keep the recorded worktree beneath local state.",
      files: [{ path: "docs/review.md", content: "# Reviewed content\n" }],
    });
    const externalRoot = await mkdtemp(join(tmpdir(), "ultradyn-external-"));
    await mkdir(join(externalRoot, "docs"), { recursive: true });
    await writeFile(
      join(externalRoot, "docs", "review.md"),
      "# Untrusted outside content\n",
      "utf8",
    );
    await rm(created.worktreePath, { recursive: true });
    await symlink(externalRoot, created.worktreePath, "dir");

    await expect(manager.readPostDiffDocumentation(created.id)).rejects.toThrow(
      /symbolic link/i,
    );
  });
});
