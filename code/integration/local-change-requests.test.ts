import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { describe, expect, it } from "vitest";

import { LocalChangeRequestManager } from "./index.js";

describe("local change request public seam", () => {
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
        goals: ["security"],
        structuredAnswer:
          "Change-request keys must be valid, unambiguous Git and filesystem components.",
      }),
    ).rejects.toThrow(/valid lowercase slug or canonical question ID/i);
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
      goals: ["implementation"],
      structuredAnswer:
        "The bridge replays from the last verified checkpoint and discards the incomplete tail.",
    });

    expect(created.branch).toBe("ultradyn/q-01J00000000000000000000000");
    expect(created.state).toBe("open");
    expect(created.diff).toContain(
      "docs/answers/q-01J00000000000000000000000.md",
    );
    expect(created.diff).toContain("last verified checkpoint");
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
    ).toEqual(created);
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
      goals: ["implementation"],
      structuredAnswer:
        "The isolated answer is valid only against the portable base content reviewed with its actual diff.",
    });

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

  it("creates an empty initial commit without capturing unrelated user files", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-unborn-repository-"));
    const dataRoot = await mkdtemp(join(tmpdir(), "ultradyn-unborn-state-"));
    await writeFile(join(root, "private-notes.txt"), "must remain untracked\n");

    const manager = new LocalChangeRequestManager({ repoRoot: root, dataRoot });
    await manager.create({
      questionId: "q-01J00000000000000000000002",
      title: "How does initialization work?",
      question: "How does initialization avoid unrelated files?",
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
      goals: ["implementation"],
      structuredAnswer:
        "Replay from the checksum-verified checkpoint and discard the incomplete tail.",
      requiresActualDiffChecks: true,
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
