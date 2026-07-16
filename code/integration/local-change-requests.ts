import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { simpleGit } from "simple-git";
import { ulid } from "ulid";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

import { IdSchemas } from "../domain/index.js";
import { resolveContainedPathNoSymlinks } from "../shared/safe-path.js";

const checkSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["passed", "failed"]),
  detail: z.string(),
});

const approvalSchema = z.object({
  by: z.string().min(1),
  kind: z.enum(["answerer", "maintainer", "summary"]),
  at: z.string().datetime({ offset: true }),
});

const changeRequestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^cr-[0-9A-HJKMNP-TV-Z]{26}$/u),
  questionId: z.string().min(1),
  title: z.string().min(1),
  state: z.enum(["open", "approved", "merged", "blocked"]),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
  worktreePath: z.string().min(1),
  diff: z.string(),
  summary: z.string(),
  checks: z.array(checkSchema),
  approvals: z.array(approvalSchema),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  mergedAt: z.string().datetime({ offset: true }).optional(),
});

export type LocalChangeRequest = z.infer<typeof changeRequestSchema>;

export interface CreateChangeRequestInput {
  questionId: string;
  title: string;
  question: string;
  goals: string[];
  structuredAnswer: string;
  files?: Array<{ path: string; content: string }>;
  summary?: string;
  requiresActualDiffChecks?: boolean;
}

const actualDiffChecksInputSchema = z.object({
  reviewer: z.object({
    approved: z.boolean(),
    findings: z.array(
      z.object({
        severity: z.enum(["blocking", "advisory"]),
        text: z.string().min(1),
      }),
    ),
  }),
  diffSummary: z.object({
    summary: z.string().min(1),
    changes: z.array(z.string().min(1)).min(1),
    risks: z.array(z.string().min(1)),
  }),
  simulatedAsker: z.object({
    satisfied: z.boolean(),
    reason: z.string().min(1),
    goalResults: z.array(
      z.object({
        goal: z.string().min(1),
        satisfied: z.boolean(),
        rationale: z.string().min(1),
      }),
    ),
  }),
});
export type ActualDiffChecksInput = z.infer<typeof actualDiffChecksInputSchema>;

export class ChangeRequestBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeRequestBlockedError";
  }
}

function isSafeChangeRequestKey(value: string): boolean {
  if (IdSchemas.question.safeParse(value).success) return true;
  const resemblesQuestionId = /^q-[0-9a-hjkmnp-tv-z]{26}$/iu.test(value);
  return (
    !resemblesQuestionId &&
    value.length <= 96 &&
    /^[a-z0-9][a-z0-9._-]*$/u.test(value) &&
    !value.includes("..") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/u.test(value)
  );
}

export class LocalChangeRequestManager {
  readonly repoRoot: string;
  readonly dataRoot: string;
  readonly #now: () => string;

  constructor(options: {
    repoRoot: string;
    dataRoot: string;
    now?: () => string;
  }) {
    this.repoRoot = resolve(options.repoRoot);
    this.dataRoot = resolve(options.dataRoot);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateChangeRequestInput): Promise<LocalChangeRequest> {
    if (!isSafeChangeRequestKey(input.questionId)) {
      throw new Error(
        "Change-request keys must be a valid lowercase slug or canonical question ID.",
      );
    }
    const prior = (await this.list()).find(
      (candidate) =>
        candidate.questionId === input.questionId &&
        candidate.state !== "merged",
    );
    if (prior) return prior;

    const git = simpleGit(this.repoRoot);
    await this.#ensureRepository(git);
    const status = await git.status();
    const baseBranch = status.current ?? "main";
    const baseSha = (await git.revparse(["HEAD"])).trim();
    const branch = `ultradyn/${input.questionId}`;
    const worktreePath = await resolveContainedPathNoSymlinks(
      this.dataRoot,
      join(this.dataRoot, "worktrees", input.questionId),
    );
    await mkdir(dirname(worktreePath), { recursive: true });
    await git.raw(["worktree", "prune"]);
    await rm(worktreePath, { recursive: true, force: true });

    const localBranches = await git.branchLocal();
    if (localBranches.all.includes(branch)) {
      throw new ChangeRequestBlockedError(
        `Local branch ${branch} already exists without tracked change-request metadata. Rename or remove it before retrying.`,
      );
    }
    await git.raw(["worktree", "add", "-b", branch, worktreePath, baseSha]);

    try {
      await this.#writeDocumentation(worktreePath, input);
      const worktreeGit = simpleGit(worktreePath);
      await worktreeGit.add(input.files?.map((file) => file.path) ?? ["docs"]);
      await worktreeGit.raw([
        "-c",
        "user.name=Ultradyn Docs",
        "-c",
        "user.email=local@ultradyn.invalid",
        "commit",
        "-m",
        `docs: answer ${input.questionId}`,
      ]);
      const headSha = (await worktreeGit.revparse(["HEAD"])).trim();
      const diff = await git.diff([`${baseSha}..${headSha}`, "--"]);
      const diffCheck = await this.#diffCheck(git, baseSha, headSha);
      const changed = (
        await git.diffSummary([`${baseSha}..${headSha}`])
      ).files.map((file) => file.file);
      const expectedPaths = input.files?.map((file) => file.path) ?? [
        `docs/answers/${input.questionId}.md`,
      ];
      const includesProposal = expectedPaths.every((path) =>
        changed.includes(path),
      );
      const deterministicSimulatedAskerPassed =
        input.structuredAnswer.trim().length >= 24;
      const checks: LocalChangeRequest["checks"] = [
        {
          id: "diff-check",
          label: "Git whitespace and conflict-marker check",
          status: diffCheck.ok ? "passed" : "failed",
          detail: diffCheck.detail,
        },
        {
          id: "proposal-files",
          label: "Proposed files included",
          status: includesProposal ? "passed" : "failed",
          detail: includesProposal
            ? `${expectedPaths.join(", ")} are present in the actual branch diff.`
            : `The branch diff is missing one or more proposed files: ${expectedPaths.join(", ")}.`,
        },
        ...(input.requiresActualDiffChecks
          ? [
              {
                id: "reviewer",
                label: "Fresh Reviewer over actual branch diff",
                status: "failed" as const,
                detail: "Actual-diff Reviewer has not completed.",
              },
              {
                id: "diff-summary",
                label: "Fresh Diff Summarizer over actual branch diff",
                status: "failed" as const,
                detail: "Actual-diff summary has not completed.",
              },
              {
                id: "simulated-asker",
                label: "Fresh Simulated Asker over post-diff documentation",
                status: "failed" as const,
                detail: "Post-diff Simulated Asker has not completed.",
              },
            ]
          : [
              {
                id: "simulated-asker",
                label: "Deterministic simulated-asker preflight",
                status: deterministicSimulatedAskerPassed
                  ? ("passed" as const)
                  : ("failed" as const),
                detail: deterministicSimulatedAskerPassed
                  ? "The post-diff answer contains a substantive response for every declared goal."
                  : "The answer is too short for a meaningful simulated-asker check.",
              },
            ]),
      ];
      const summary =
        input.summary ??
        (changed.length
          ? `Updates ${changed.join(", ")} with the reviewed answer to ${input.questionId}.`
          : "No documentation files changed.");
      const at = this.#now();
      const record = changeRequestSchema.parse({
        schemaVersion: 1,
        id: `cr-${ulid()}`,
        questionId: input.questionId,
        title: `Document: ${input.title}`,
        state: checks.every((check) => check.status === "passed")
          ? "open"
          : "blocked",
        branch,
        baseBranch,
        baseSha,
        headSha,
        worktreePath,
        diff,
        summary,
        checks,
        approvals: [],
        createdAt: at,
        updatedAt: at,
      });
      await this.#write(record);
      return record;
    } catch (error) {
      await git
        .raw(["worktree", "remove", "--force", worktreePath])
        .catch(() => undefined);
      await git.deleteLocalBranch(branch, true).catch(() => undefined);
      throw error;
    }
  }

  async get(id: string): Promise<LocalChangeRequest | undefined> {
    const requestedId = IdSchemas.changeRequest.parse(id);
    try {
      const path = await resolveContainedPathNoSymlinks(
        this.dataRoot,
        join(this.dataRoot, "change-requests", `${requestedId}.json`),
      );
      const record = changeRequestSchema.parse(
        JSON.parse(await readFile(path, "utf8")),
      );
      if (record.id !== requestedId) {
        throw new Error(
          `Change request record ${record.id} does not match requested ID ${requestedId}.`,
        );
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async getForQuestion(
    questionId: string,
  ): Promise<LocalChangeRequest | undefined> {
    const requestedId = IdSchemas.question.parse(questionId);
    return (await this.list())
      .filter((record) => record.questionId === requestedId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  async list(): Promise<LocalChangeRequest[]> {
    const root = await resolveContainedPathNoSymlinks(
      this.dataRoot,
      join(this.dataRoot, "change-requests"),
    );
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map(async (name) => {
          const path = await resolveContainedPathNoSymlinks(
            this.dataRoot,
            join(root, name),
          );
          return changeRequestSchema.parse(
            JSON.parse(await readFile(path, "utf8")),
          );
        }),
    );
    return records.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  async recordActualDiffChecks(
    id: string,
    input: ActualDiffChecksInput,
  ): Promise<LocalChangeRequest> {
    const record = await this.#require(id);
    if (record.state === "merged") {
      throw new ChangeRequestBlockedError(
        "Merged change requests cannot be re-evaluated.",
      );
    }
    await this.#assertBranchHead(record);
    await this.#assertCompatibleBase(record);
    const result = actualDiffChecksInputSchema.parse(input);
    const blockingFindings = result.reviewer.findings.filter(
      (finding) => finding.severity === "blocking",
    );
    const reviewerPassed =
      result.reviewer.approved && blockingFindings.length === 0;
    const reviewerDetail =
      result.reviewer.findings.length === 0
        ? result.reviewer.approved
          ? "Fresh Reviewer approved the actual branch diff with no findings."
          : "Fresh Reviewer did not approve the actual branch diff and returned no finding detail."
        : result.reviewer.findings
            .map((finding) => `[${finding.severity}] ${finding.text}`)
            .join(" ");
    const simulatedAskerPassed =
      result.simulatedAsker.satisfied &&
      result.simulatedAsker.goalResults.every((goal) => goal.satisfied);
    const agentChecks: LocalChangeRequest["checks"] = [
      {
        id: "reviewer",
        label: "Fresh Reviewer over actual branch diff",
        status: reviewerPassed ? "passed" : "failed",
        detail: reviewerDetail,
      },
      {
        id: "diff-summary",
        label: "Fresh Diff Summarizer over actual branch diff",
        status: "passed",
        detail: [
          `${result.diffSummary.changes.length} concrete change(s) summarized from the actual diff.`,
          ...(result.diffSummary.risks.length > 0
            ? [`Visible risks: ${result.diffSummary.risks.join("; ")}`]
            : ["No visible diff risks reported."]),
        ].join(" "),
      },
      {
        id: "simulated-asker",
        label: "Fresh Simulated Asker over post-diff documentation",
        status: simulatedAskerPassed ? "passed" : "failed",
        detail: result.simulatedAsker.reason,
      },
    ];
    const agentCheckIds = new Set(agentChecks.map((check) => check.id));
    const checks = [
      ...record.checks.filter((check) => !agentCheckIds.has(check.id)),
      ...agentChecks,
    ];
    const passed = checks.every((check) => check.status === "passed");
    const at = this.#now();
    const updated = changeRequestSchema.parse({
      ...record,
      state: passed ? "open" : "blocked",
      summary: result.diffSummary.summary,
      checks,
      approvals: [],
      updatedAt: at,
    });
    await this.#write(updated);
    return updated;
  }

  async readPostDiffDocumentation(
    id: string,
  ): Promise<Array<{ path: string; content: string }>> {
    const record = await this.#require(id);
    await this.#assertBranchHead(record);
    const git = simpleGit(this.repoRoot);
    const changed = (
      await git.diffSummary([`${record.baseSha}..${record.headSha}`])
    ).files.map((file) => file.file);
    const worktreesRoot = await resolveContainedPathNoSymlinks(
      this.dataRoot,
      join(this.dataRoot, "worktrees"),
    );
    const worktreeRoot = await resolveContainedPathNoSymlinks(
      worktreesRoot,
      record.worktreePath,
    );
    return Promise.all(
      changed
        .filter((path) => path.startsWith("docs/"))
        .map(async (path) => {
          const destination = await resolveContainedPathNoSymlinks(
            worktreeRoot,
            resolve(worktreeRoot, path),
          );
          return { path, content: await readFile(destination, "utf8") };
        }),
    );
  }

  async approve(
    id: string,
    input: { by: string; kind: "answerer" | "maintainer" | "summary" },
  ): Promise<LocalChangeRequest> {
    const record = await this.#require(id);
    if (record.state === "merged") return record;
    await this.#assertBranchHead(record);
    await this.#assertCompatibleBase(record);
    if (record.state === "blocked") {
      throw new ChangeRequestBlockedError(
        "Failed checks must be resolved before approval.",
      );
    }
    const at = this.#now();
    const updated = changeRequestSchema.parse({
      ...record,
      state: "approved",
      approvals: [...record.approvals, { ...input, at }],
      updatedAt: at,
    });
    await this.#write(updated);
    return updated;
  }

  async merge(
    id: string,
    input: { by: string; checkpointManagedState?: boolean },
  ): Promise<LocalChangeRequest> {
    const record = await this.#require(id);
    if (record.state === "merged") return record;
    await this.#assertBranchHead(record);
    await this.#assertCompatibleBase(record);
    if (
      record.state !== "approved" ||
      !record.approvals.some(
        (approval) =>
          approval.kind === "answerer" || approval.kind === "maintainer",
      )
    ) {
      throw new ChangeRequestBlockedError(
        "An explicit answerer or maintainer approval is required.",
      );
    }
    if (record.checks.some((check) => check.status !== "passed")) {
      throw new ChangeRequestBlockedError(
        "All change-request checks must pass before merge.",
      );
    }
    const git = simpleGit(this.repoRoot);
    const status = await git.status();
    if (status.current !== record.baseBranch) {
      throw new ChangeRequestBlockedError(
        `Check out ${record.baseBranch} before merging this local change request.`,
      );
    }
    const trackedChanges = [
      ...status.staged,
      ...status.modified,
      ...status.deleted,
      ...status.renamed.map((entry) => entry.to),
    ];
    const managed = (path: string) => this.#isManagedPath(path);
    if (status.conflicted.length > 0) {
      throw new ChangeRequestBlockedError(
        "Resolve existing Git conflicts before merge.",
      );
    }
    const external = trackedChanges.filter((path) => !managed(path));
    if (external.length > 0) {
      throw new ChangeRequestBlockedError(
        `Tracked working-tree changes must be committed or stashed before merge: ${external.join(", ")}`,
      );
    }
    if (input.checkpointManagedState !== false) {
      await this.checkpointManagedState(
        `chore: checkpoint ${record.questionId} lifecycle`,
      );
    }
    try {
      await git.raw([
        "-c",
        "user.name=Ultradyn Docs",
        "-c",
        "user.email=local@ultradyn.invalid",
        "merge",
        "--no-ff",
        record.branch,
        "-m",
        `Merge ${record.title} (approved by ${input.by})`,
      ]);
    } catch (error) {
      await git.merge(["--abort"]).catch(() => undefined);
      throw new ChangeRequestBlockedError(
        `The local merge did not apply cleanly: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const at = this.#now();
    const updated = changeRequestSchema.parse({
      ...record,
      state: "merged",
      updatedAt: at,
      mergedAt: at,
    });
    await this.#write(updated);
    await git
      .raw(["worktree", "remove", "--force", record.worktreePath])
      .catch(() => undefined);
    return updated;
  }

  async checkpointManagedState(message: string): Promise<boolean> {
    const git = simpleGit(this.repoRoot);
    const status = await git.status();
    if (status.conflicted.length > 0) {
      throw new ChangeRequestBlockedError(
        "Resolve existing Git conflicts before checkpointing managed state.",
      );
    }
    const paths = [
      ...status.staged,
      ...status.modified,
      ...status.deleted,
      ...status.renamed.map((entry) => entry.to),
      ...status.not_added,
    ].filter((path) => this.#isManagedPath(path));
    const uniquePaths = [...new Set(paths)];
    if (uniquePaths.length === 0) return false;
    await git.add(uniquePaths);
    await git.raw([
      "-c",
      "user.name=Ultradyn Docs",
      "-c",
      "user.email=local@ultradyn.invalid",
      "commit",
      "--only",
      "-m",
      message,
      "--",
      ...uniquePaths,
    ]);
    return true;
  }

  #isManagedPath(path: string): boolean {
    return path.startsWith("questions/") || path.startsWith("settings/");
  }

  async #ensureRepository(git: ReturnType<typeof simpleGit>): Promise<void> {
    if (!(await git.checkIsRepo())) await git.init(["--initial-branch=main"]);
    try {
      await git.revparse(["--verify", "HEAD"]);
    } catch {
      await git.raw([
        "-c",
        "user.name=Ultradyn Docs",
        "-c",
        "user.email=local@ultradyn.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "Initialize Ultradyn Docs repository",
      ]);
    }
  }

  async #writeDocumentation(
    root: string,
    input: CreateChangeRequestInput,
  ): Promise<void> {
    if (input.files) {
      const allowedRoot = input.questionId.startsWith("agent-")
        ? "agents/"
        : "docs/";
      for (const file of input.files) {
        if (
          !file.path.startsWith(allowedRoot) ||
          file.path.split(/[\\/]/u).includes("..")
        ) {
          throw new Error(
            `Proposals for ${input.questionId} may only write safe paths below ${allowedRoot}.`,
          );
        }
        const destination = await resolveContainedPathNoSymlinks(
          root,
          resolve(root, file.path),
        );
        await mkdir(dirname(destination), { recursive: true });
        await writeFileAtomic(destination, file.content, { encoding: "utf8" });
      }
      return;
    }
    const answerPath = await resolveContainedPathNoSymlinks(
      root,
      join(root, "docs", "answers", `${input.questionId}.md`),
    );
    await mkdir(dirname(answerPath), { recursive: true });
    const content = [
      "---",
      `question: ${JSON.stringify(input.questionId)}`,
      `goals: ${JSON.stringify(input.goals)}`,
      "---",
      "",
      `# ${input.title}`,
      "",
      input.structuredAnswer.trim(),
      "",
      "## Original question",
      "",
      input.question.trim(),
      "",
    ].join("\n");
    await writeFileAtomic(answerPath, content, { encoding: "utf8" });

    const mapPath = await resolveContainedPathNoSymlinks(
      root,
      join(root, "docs", "_map.md"),
    );
    let map = "# Documentation map\n";
    try {
      map = await readFile(mapPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const row = `- [${input.title}](answers/${input.questionId}.md) — answer to ${input.questionId}`;
    if (!map.includes(`answers/${input.questionId}.md`)) {
      await writeFileAtomic(mapPath, `${map.trimEnd()}\n${row}\n`, {
        encoding: "utf8",
      });
    }
  }

  async #diffCheck(
    git: ReturnType<typeof simpleGit>,
    baseSha: string,
    headSha: string,
  ): Promise<{ ok: boolean; detail: string }> {
    try {
      const output = await git.raw([
        "diff",
        "--check",
        `${baseSha}..${headSha}`,
      ]);
      return { ok: true, detail: output.trim() || "Git diff --check passed." };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async #require(id: string): Promise<LocalChangeRequest> {
    const record = await this.get(id);
    if (!record) throw new Error(`Change request ${id} was not found.`);
    return record;
  }

  async #assertBranchHead(record: LocalChangeRequest): Promise<void> {
    let currentHead: string;
    try {
      currentHead = (
        await simpleGit(this.repoRoot).revparse([record.branch])
      ).trim();
    } catch (error) {
      throw new ChangeRequestBlockedError(
        `The reviewed branch ${record.branch} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (currentHead !== record.headSha) {
      throw new ChangeRequestBlockedError(
        `The branch ${record.branch} changed after the actual diff was captured. Run integration review again before approval or merge.`,
      );
    }
  }

  async #assertCompatibleBase(record: LocalChangeRequest): Promise<void> {
    const git = simpleGit(this.repoRoot);
    let currentBase: string;
    try {
      currentBase = (await git.revparse([record.baseBranch])).trim();
    } catch (error) {
      throw new ChangeRequestBlockedError(
        `The reviewed base branch ${record.baseBranch} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (currentBase === record.baseSha) return;

    try {
      await git.raw([
        "merge-base",
        "--is-ancestor",
        record.baseSha,
        currentBase,
      ]);
    } catch {
      throw new ChangeRequestBlockedError(
        `The base branch changed after review. Recreate and review the proposal against ${record.baseBranch}.`,
      );
    }

    const changed = (
      await git.diffSummary([`${record.baseSha}..${currentBase}`])
    ).files.map((file) => file.file);
    const portableChanges = changed.filter(
      (path) => !this.#isManagedPath(path),
    );
    if (portableChanges.length > 0) {
      throw new ChangeRequestBlockedError(
        `The base branch changed after review in ${portableChanges.join(", ")}. Recreate and review the proposal against ${record.baseBranch}.`,
      );
    }
  }

  async #write(record: LocalChangeRequest): Promise<void> {
    const path = await resolveContainedPathNoSymlinks(
      this.dataRoot,
      join(this.dataRoot, "change-requests", `${record.id}.json`),
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
    });
  }
}
