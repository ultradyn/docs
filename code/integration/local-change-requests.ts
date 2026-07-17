import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { simpleGit } from "simple-git";
import lockfile from "proper-lockfile";
import { ulid } from "ulid";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

import { IdSchemas, SafeSlugSchema } from "../domain/index.js";
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

const mergeIntentSchema = z.object({
  baseHeadSha: z.string().min(1),
  branchHeadSha: z.string().min(1),
  expectedResultTreeSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
  by: z.string().min(1),
  startedAt: z.string().datetime({ offset: true }),
  authorizationSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  mergedHeadSha: z.string().min(1).optional(),
});

const declaredGoalsSchema = z
  .array(SafeSlugSchema)
  .min(1)
  .refine((goals) => new Set(goals).size === goals.length, {
    message: "Declared goals must be unique.",
  });

const commonChangeRequestFields = {
  id: z.string().regex(/^cr-[0-9A-HJKMNP-TV-Z]{26}$/u),
  questionId: z.string().min(1),
  title: z.string().min(1),
  state: z.enum(["open", "approved", "merged", "blocked", "superseded"]),
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
  mergeIntent: mergeIntentSchema.optional(),
  supersededAt: z.string().datetime({ offset: true }).optional(),
  supersededBy: z
    .string()
    .regex(/^cr-[0-9A-HJKMNP-TV-Z]{26}$/u)
    .optional(),
};

const exactEvaluationInputFields = {
  verbatimQuestion: z.string().min(1),
  verbatimChat: z.string(),
  goals: declaredGoalsSchema,
  structuredAnswer: z.string(),
  proposedFiles: z
    .array(z.object({ path: z.string(), content: z.string() }))
    .nullable(),
  inputFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
};

const completeChangeRequestSchema = z.object({
  schemaVersion: z.literal(2),
  evaluationInputState: z.literal("complete"),
  ...commonChangeRequestFields,
  ...exactEvaluationInputFields,
});

const unavailableChangeRequestSchema = z.object({
  schemaVersion: z.literal(2),
  evaluationInputState: z.literal("legacy-unavailable"),
  ...commonChangeRequestFields,
  verbatimQuestion: z.null(),
  verbatimChat: z.null(),
  goals: z.null(),
  structuredAnswer: z.null(),
  proposedFiles: z.null(),
  inputFingerprint: z.null(),
});

const changeRequestSchema = z.discriminatedUnion("evaluationInputState", [
  completeChangeRequestSchema,
  unavailableChangeRequestSchema,
]);

const legacyChangeRequestSchema = z.object({
  schemaVersion: z.literal(1),
  ...commonChangeRequestFields,
  state: z.enum(["open", "approved", "merged", "blocked"]),
  mergeIntent: z.undefined().optional(),
  supersededAt: z.undefined().optional(),
  supersededBy: z.undefined().optional(),
});

export type LocalChangeRequest = z.infer<typeof changeRequestSchema>;
type EvaluableLocalChangeRequest = Extract<
  LocalChangeRequest,
  { evaluationInputState: "complete" }
>;

function parseChangeRequest(candidate: unknown): LocalChangeRequest {
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    (candidate as { schemaVersion?: unknown }).schemaVersion === 1
  ) {
    const legacy = legacyChangeRequestSchema.parse(candidate);
    return unavailableChangeRequestSchema.parse({
      ...legacy,
      schemaVersion: 2,
      evaluationInputState: "legacy-unavailable",
      verbatimQuestion: null,
      verbatimChat: null,
      goals: null,
      structuredAnswer: null,
      proposedFiles: null,
      inputFingerprint: null,
    });
  }
  try {
    return changeRequestSchema.parse(candidate);
  } catch (error) {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "mergeIntent" in candidate &&
      (candidate as { mergeIntent?: unknown }).mergeIntent !== undefined
    ) {
      throw new ChangeRequestBlockedError(
        `Change-request metadata contains a merge intent that is invalid or not bound to its exact approved authorization snapshot: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }
}

function requireHistoricEvaluationInput(
  record: LocalChangeRequest,
): EvaluableLocalChangeRequest {
  if (record.evaluationInputState !== "complete") {
    throw new ChangeRequestBlockedError(
      `Change request ${record.id} predates exact evaluator-input persistence; its historic evaluator input is unavailable, so it must be recreated before evaluation, approval, or merge.`,
    );
  }
  return record;
}

export interface CreateChangeRequestInput {
  questionId: string;
  title: string;
  question: string;
  verbatimChat: string;
  goals: string[];
  structuredAnswer: string;
  files?: Array<{ path: string; content: string }> | undefined;
  summary?: string | undefined;
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

const createChangeRequestInputSchema = z.object({
  questionId: z.string().min(1),
  title: z.string().min(1),
  question: z.string().min(1),
  verbatimChat: z.string(),
  goals: declaredGoalsSchema,
  structuredAnswer: z.string(),
  files: z
    .array(z.object({ path: z.string(), content: z.string() }))
    .optional(),
  summary: z.string().optional(),
});

const createJournalSchema = z.object({
  schemaVersion: z.literal(1),
  questionId: z.string().min(1),
  inputFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  requestId: IdSchemas.changeRequest,
  priorId: IdSchemas.changeRequest.optional(),
  baseBranch: z.string().min(1),
  baseSha: z.string().min(1),
  branch: z.string().min(1),
  worktreePath: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  input: createChangeRequestInputSchema,
  materializedResources: z
    .object({
      branch: z.string().min(1),
      worktreePath: z.string().min(1),
      baseSha: z.string().min(1),
    })
    .optional(),
  record: completeChangeRequestSchema.optional(),
});
type CreateJournal = z.infer<typeof createJournalSchema>;

export type ChangeRequestCreateCheckpoint =
  | "after-journal-persisted"
  | "after-worktree-created"
  | "after-proposal-committed"
  | "after-operation-recorded"
  | "after-new-record-persisted"
  | "after-prior-superseded"
  | "before-journal-cleanup";

export type ChangeRequestMetadataWriter = (
  path: string,
  contents: string,
) => Promise<void>;

const defaultMetadataWriter: ChangeRequestMetadataWriter = async (
  path,
  contents,
) => {
  await writeFileAtomic(path, contents, { encoding: "utf8" });
};

export class ChangeRequestBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeRequestBlockedError";
  }
}

function inputFingerprint(
  input: CreateChangeRequestInput,
  goals: string[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        questionId: input.questionId,
        question: input.question,
        verbatimChat: input.verbatimChat,
        goals,
        structuredAnswer: input.structuredAnswer,
        files: input.files ?? null,
      }),
      "utf8",
    )
    .digest("hex");
}

const mandatoryMergeCheckIds = [
  "reviewer",
  "diff-summary",
  "simulated-asker",
] as const;

function assertMergeAuthorization(
  record: EvaluableLocalChangeRequest,
  options: { allowMergedRecovery?: boolean } = {},
): void {
  const allowedState =
    record.state === "approved" ||
    (options.allowMergedRecovery === true && record.state === "merged");
  const hasRequiredApproval = record.approvals.some(
    (approval) =>
      approval.kind === "answerer" || approval.kind === "maintainer",
  );
  const hasExactMandatoryChecks = mandatoryMergeCheckIds.every((id) => {
    const matches = record.checks.filter((check) => check.id === id);
    return matches.length === 1 && matches[0]?.status === "passed";
  });
  if (
    !allowedState ||
    !hasRequiredApproval ||
    !hasExactMandatoryChecks ||
    record.checks.some((check) => check.status !== "passed")
  ) {
    throw new ChangeRequestBlockedError(
      `Change request ${record.id} is not backed by an approved authorization snapshot with one passed result from every mandatory evaluator and an answerer or maintainer approval.`,
    );
  }
}

function mergeAuthorizationSha256(
  record: EvaluableLocalChangeRequest,
  intent: Pick<
    z.infer<typeof mergeIntentSchema>,
    | "baseHeadSha"
    | "branchHeadSha"
    | "expectedResultTreeSha"
    | "by"
    | "startedAt"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 2,
        authorizedState: "approved",
        recordId: record.id,
        questionId: record.questionId,
        inputFingerprint: record.inputFingerprint,
        baseBranch: record.baseBranch,
        reviewedBaseSha: record.baseSha,
        branch: record.branch,
        branchHeadSha: record.headSha,
        diff: record.diff,
        checks: record.checks,
        approvals: record.approvals,
        mergeBaseHeadSha: intent.baseHeadSha,
        requestedBranchHeadSha: intent.branchHeadSha,
        expectedResultTreeSha: intent.expectedResultTreeSha,
        mergedBy: intent.by,
        startedAt: intent.startedAt,
      }),
      "utf8",
    )
    .digest("hex");
}

function assertMergeIntentIntegrity(record: EvaluableLocalChangeRequest): void {
  const intent = record.mergeIntent;
  if (!intent) return;
  assertMergeAuthorization(record, { allowMergedRecovery: true });
  if (
    intent.branchHeadSha !== record.headSha ||
    (record.state === "merged") !== (intent.mergedHeadSha !== undefined) ||
    intent.authorizationSha256 !== mergeAuthorizationSha256(record, intent)
  ) {
    throw new ChangeRequestBlockedError(
      `Change request ${record.id} has merge intent that is not bound to its exact approved authorization snapshot.`,
    );
  }
}

function assertChangeRequestIntegrity(
  record: LocalChangeRequest,
  metadataName?: string,
): void {
  if (metadataName !== undefined && metadataName !== `${record.id}.json`) {
    throw new ChangeRequestBlockedError(
      `Change-request metadata ${metadataName} does not match record identity ${record.id}.`,
    );
  }
  if (!isSafeChangeRequestKey(record.questionId)) {
    throw new ChangeRequestBlockedError(
      `Change request ${record.id} has an invalid question identity.`,
    );
  }
  const isMerged = record.state === "merged";
  const isSuperseded = record.state === "superseded";
  if (
    isMerged !== (record.mergedAt !== undefined) ||
    isSuperseded !==
      (record.supersededAt !== undefined &&
        record.supersededBy !== undefined) ||
    (record.supersededAt === undefined) !==
      (record.supersededBy === undefined) ||
    (isSuperseded && record.mergeIntent !== undefined)
  ) {
    throw new ChangeRequestBlockedError(
      `Change request ${record.id} has terminal metadata inconsistent with state ${record.state}.`,
    );
  }
  if (record.evaluationInputState === "complete") {
    const expectedFingerprint = inputFingerprint(
      {
        questionId: record.questionId,
        title: record.title,
        question: record.verbatimQuestion,
        verbatimChat: record.verbatimChat,
        goals: record.goals,
        structuredAnswer: record.structuredAnswer,
        ...(record.proposedFiles === null
          ? {}
          : { files: record.proposedFiles }),
      },
      record.goals,
    );
    if (record.inputFingerprint !== expectedFingerprint) {
      throw new ChangeRequestBlockedError(
        `Change request ${record.id} input fingerprint does not match its evaluator input.`,
      );
    }
    assertMergeIntentIntegrity(record);
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

function assertSafeProposalPaths(input: CreateChangeRequestInput): void {
  if (!input.files) return;
  const allowedRoot = input.questionId.startsWith("agent-")
    ? "agents/"
    : "docs/";
  const paths = input.files.map((file) => file.path);
  if (
    new Set(paths).size !== paths.length ||
    paths.some(
      (path) =>
        !path.startsWith(allowedRoot) || path.split(/[\\/]/u).includes(".."),
    )
  ) {
    throw new Error(
      `Proposals for ${input.questionId} may only write unique safe paths below ${allowedRoot}.`,
    );
  }
}

function generatedAnswerContent(input: CreateChangeRequestInput): string {
  return [
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
}

function mapWithQuestion(map: string, input: CreateChangeRequestInput): string {
  const row = `- [${input.title}](answers/${input.questionId}.md) — answer to ${input.questionId}`;
  return map.includes(`answers/${input.questionId}.md`)
    ? map
    : `${map.trimEnd()}\n${row}\n`;
}

function parseWorktreeRegistrations(
  raw: string,
): Array<Record<string, string>> {
  return raw
    .trim()
    .split(/\n\n+/u)
    .filter(Boolean)
    .map((block) =>
      Object.fromEntries(
        block.split("\n").map((line) => {
          const separator = line.indexOf(" ");
          return separator === -1
            ? [line, ""]
            : [line.slice(0, separator), line.slice(separator + 1)];
        }),
      ),
    );
}

export class LocalChangeRequestManager {
  readonly repoRoot: string;
  readonly dataRoot: string;
  readonly #now: () => string;
  readonly #metadataWriter: ChangeRequestMetadataWriter;
  readonly #worktreeRemover: (path: string) => Promise<void>;
  readonly #onCreateCheckpoint:
    | ((checkpoint: ChangeRequestCreateCheckpoint) => void | Promise<void>)
    | undefined;

  constructor(options: {
    repoRoot: string;
    dataRoot: string;
    metadataWriter?: ChangeRequestMetadataWriter;
    now?: () => string;
    onCreateCheckpoint?: (
      checkpoint: ChangeRequestCreateCheckpoint,
    ) => void | Promise<void>;
    worktreeRemover?: (path: string) => Promise<void>;
  }) {
    this.repoRoot = resolve(options.repoRoot);
    this.dataRoot = resolve(options.dataRoot);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#metadataWriter = options.metadataWriter ?? defaultMetadataWriter;
    this.#onCreateCheckpoint = options.onCreateCheckpoint;
    this.#worktreeRemover =
      options.worktreeRemover ??
      ((path) =>
        simpleGit(this.repoRoot)
          .raw(["worktree", "remove", path])
          .then(() => undefined));
  }

  async create(
    input: CreateChangeRequestInput,
  ): Promise<EvaluableLocalChangeRequest> {
    return this.#locked(() => this.#createUnlocked(input));
  }

  async ensureCurrent(
    input: CreateChangeRequestInput,
  ): Promise<EvaluableLocalChangeRequest> {
    return this.create(input);
  }

  async #createUnlocked(
    input: CreateChangeRequestInput,
  ): Promise<EvaluableLocalChangeRequest> {
    if (typeof input.verbatimChat !== "string") {
      throw new Error(
        "An explicit verbatim chat field is required; use an empty string when there is no chat context.",
      );
    }
    const validatedInput = createChangeRequestInputSchema.parse(input);
    assertSafeProposalPaths(validatedInput);
    const goals = validatedInput.goals;
    if (!isSafeChangeRequestKey(input.questionId)) {
      throw new Error(
        "Change-request keys must be a valid lowercase slug or canonical question ID.",
      );
    }
    const fingerprint = inputFingerprint(validatedInput, goals);
    const journalPath = await this.#createJournalPath(input.questionId);
    const pending = await this.#readCreateJournal(journalPath);
    if (pending) {
      const recovered = await this.#reconcileCreateJournal(
        journalPath,
        pending,
      );
      if (recovered.inputFingerprint === fingerprint) return recovered;
    }
    const prior = await this.#getActiveForQuestionUnlocked(input.questionId);
    if (prior?.inputFingerprint === fingerprint) return prior;
    if (prior?.mergeIntent) {
      throw new ChangeRequestBlockedError(
        `Change request ${prior.id} has a merge in progress; recover it before creating a replacement attempt.`,
      );
    }
    const requestId = `cr-${ulid()}`;
    const branch = `ultradyn-attempts/${requestId}`;
    const worktreePath = await resolveContainedPathNoSymlinks(
      this.dataRoot,
      join(this.dataRoot, "worktrees", requestId),
    );
    const metadataPath = await resolveContainedPathNoSymlinks(
      this.dataRoot,
      join(this.dataRoot, "change-requests", `${requestId}.json`),
    );
    await this.#preflightUnownedCreateTarget("worktree", worktreePath);
    await this.#preflightUnownedCreateTarget("metadata", metadataPath);

    const git = simpleGit(this.repoRoot);
    await this.#ensureRepository(git);
    const status = await git.status();
    const baseBranch = status.current ?? "main";
    const baseSha = (await git.revparse(["HEAD"])).trim();
    const journal = createJournalSchema.parse({
      schemaVersion: 1,
      questionId: input.questionId,
      inputFingerprint: fingerprint,
      requestId,
      ...(prior ? { priorId: prior.id } : {}),
      baseBranch,
      baseSha,
      branch,
      worktreePath,
      createdAt: this.#now(),
      input: validatedInput,
    });
    await this.#validateCreateJournal(journalPath, journal);
    await this.#writeCreateJournal(journalPath, journal);
    await this.#createCheckpoint("after-journal-persisted");
    return this.#reconcileCreateJournal(journalPath, journal);
  }

  async #preflightUnownedCreateTarget(
    label: "worktree" | "metadata",
    targetPath: string,
  ): Promise<void> {
    try {
      await lstat(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw new ChangeRequestBlockedError(
      `Change-request ${label} target ${targetPath} already exists without operation ownership.`,
    );
  }

  async #reconcileCreateJournal(
    journalPath: string,
    initialJournal: CreateJournal,
  ): Promise<EvaluableLocalChangeRequest> {
    const validatedPrior = await this.#validateCreateJournal(
      journalPath,
      initialJournal,
    );
    let journal = initialJournal;
    let record = journal.record;
    if (!record) {
      const materialized = await this.#materializeProposal(
        journalPath,
        journal,
      );
      journal = materialized.journal;
      record = materialized.record;
      journal = createJournalSchema.parse({ ...journal, record });
      await this.#writeCreateJournal(journalPath, journal);
      await this.#createCheckpoint("after-operation-recorded");
    }

    const existing = await this.#getUnlocked(record.id);
    if (existing) {
      if (
        existing.questionId !== record.questionId ||
        existing.inputFingerprint !== record.inputFingerprint ||
        JSON.stringify(existing) !== JSON.stringify(record)
      ) {
        throw new ChangeRequestBlockedError(
          `Change-request creation journal ${record.id} conflicts with existing metadata.`,
        );
      }
      record = requireHistoricEvaluationInput(existing);
    } else {
      await this.#write(record);
      await this.#createCheckpoint("after-new-record-persisted");
    }

    if (validatedPrior) {
      const prior = validatedPrior;
      if (prior.state !== "superseded") {
        await this.#write(
          changeRequestSchema.parse({
            ...prior,
            state: "superseded",
            approvals: [],
            updatedAt: record.createdAt,
            supersededAt: record.createdAt,
            supersededBy: record.id,
          }),
        );
      }
      await this.#createCheckpoint("after-prior-superseded");
    }

    await this.#createCheckpoint("before-journal-cleanup");
    await rm(journalPath, { force: true });
    return record;
  }

  async #expectedCreateJournalIdentity(journal: CreateJournal): Promise<{
    journalPath: string;
    branch: string;
    worktreePath: string;
    metadataPath: string;
  }> {
    const branch = `ultradyn-attempts/${journal.requestId}`;
    return {
      journalPath: await this.#createJournalPath(journal.questionId),
      branch,
      worktreePath: await resolveContainedPathNoSymlinks(
        this.dataRoot,
        join(this.dataRoot, "worktrees", journal.requestId),
      ),
      metadataPath: await resolveContainedPathNoSymlinks(
        this.dataRoot,
        join(this.dataRoot, "change-requests", `${journal.requestId}.json`),
      ),
    };
  }

  async #preflightCreateTargets(
    journal: CreateJournal,
    expected: {
      journalPath: string;
      branch: string;
      worktreePath: string;
      metadataPath: string;
    },
  ): Promise<void> {
    let metadataExists = false;
    try {
      const info = await lstat(expected.metadataPath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new ChangeRequestBlockedError(
          `Change-request metadata target ${expected.metadataPath} is not an owned regular file.`,
        );
      }
      metadataExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (metadataExists) {
      if (!journal.record) {
        throw new ChangeRequestBlockedError(
          `Change-request metadata target ${expected.metadataPath} already exists without a journal-owned record.`,
        );
      }
      const existing = parseChangeRequest(
        JSON.parse(await readFile(expected.metadataPath, "utf8")),
      );
      assertChangeRequestIntegrity(existing, `${journal.requestId}.json`);
      if (JSON.stringify(existing) !== JSON.stringify(journal.record)) {
        throw new ChangeRequestBlockedError(
          `Change-request metadata target ${expected.metadataPath} belongs to different content.`,
        );
      }
    }

    const git = simpleGit(this.repoRoot);
    const [localBranches, worktreeOutput] = await Promise.all([
      git.branchLocal(),
      git.raw(["worktree", "list", "--porcelain"]),
    ]);
    const registrations = parseWorktreeRegistrations(worktreeOutput);
    const expectedRef = `refs/heads/${expected.branch}`;
    const registeredAtPath = registrations.filter(
      (entry) => resolve(entry.worktree ?? "") === expected.worktreePath,
    );
    const registeredForBranch = registrations.filter(
      (entry) => entry.branch === expectedRef,
    );
    let worktreeExists = false;
    try {
      const info = await lstat(expected.worktreePath);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new ChangeRequestBlockedError(
          `Change-request worktree target ${expected.worktreePath} is not an owned directory.`,
        );
      }
      worktreeExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const ownership = journal.materializedResources;
    if (!ownership) {
      if (
        localBranches.all.includes(expected.branch) ||
        registeredAtPath.length > 0 ||
        registeredForBranch.length > 0 ||
        worktreeExists
      ) {
        throw new ChangeRequestBlockedError(
          `Change-request recovery targets for ${journal.requestId} already exist without journal ownership.`,
        );
      }
      return;
    }
    const exactRegistration =
      registeredAtPath.length === 1 &&
      registeredForBranch.length === 1 &&
      registeredAtPath[0] === registeredForBranch[0] &&
      registeredAtPath[0]?.branch === expectedRef;
    if (
      ownership.branch !== expected.branch ||
      ownership.worktreePath !== expected.worktreePath ||
      ownership.baseSha !== journal.baseSha ||
      !localBranches.all.includes(expected.branch) ||
      !worktreeExists ||
      !exactRegistration
    ) {
      throw new ChangeRequestBlockedError(
        `Change-request recovery targets for ${journal.requestId} do not match their journaled ownership.`,
      );
    }
  }

  async #validateCreateJournal(
    journalPath: string,
    journal: CreateJournal,
  ): Promise<LocalChangeRequest | undefined> {
    if (
      !isSafeChangeRequestKey(journal.questionId) ||
      journal.input.questionId !== journal.questionId
    ) {
      throw new ChangeRequestBlockedError(
        "Change-request creation journal question identity is invalid or mismatched.",
      );
    }
    assertSafeProposalPaths(journal.input);
    const expectedFingerprint = inputFingerprint(
      journal.input,
      journal.input.goals,
    );
    if (journal.inputFingerprint !== expectedFingerprint) {
      throw new ChangeRequestBlockedError(
        "Change-request creation journal input fingerprint does not match its embedded proposal.",
      );
    }
    const expected = await this.#expectedCreateJournalIdentity(journal);
    if (
      resolve(journalPath) !== expected.journalPath ||
      journal.branch !== expected.branch ||
      journal.worktreePath !== expected.worktreePath
    ) {
      throw new ChangeRequestBlockedError(
        "Change-request creation journal path, branch, or worktree identity is mismatched.",
      );
    }

    const git = simpleGit(this.repoRoot);
    if (!(await git.checkIsRepo())) {
      throw new ChangeRequestBlockedError(
        "Change-request creation recovery requires the original Git repository.",
      );
    }
    try {
      await git.raw(["check-ref-format", `refs/heads/${journal.baseBranch}`]);
    } catch {
      throw new ChangeRequestBlockedError(
        "Change-request creation journal base branch is invalid.",
      );
    }
    const status = await git.status();
    let baseSha: string;
    try {
      baseSha = (
        await git.revparse([`refs/heads/${journal.baseBranch}^{commit}`])
      ).trim();
    } catch (error) {
      throw new ChangeRequestBlockedError(
        `Change-request creation journal base is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (status.current !== journal.baseBranch || baseSha !== journal.baseSha) {
      throw new ChangeRequestBlockedError(
        "Change-request creation journal base branch or revision no longer matches the checked-out recovery base.",
      );
    }

    const records = await this.#listUnlocked();
    const prior = journal.priorId
      ? records.find((record) => record.id === journal.priorId)
      : undefined;
    const otherActive = records.filter(
      (record) =>
        record.id !== journal.requestId &&
        record.questionId === journal.questionId &&
        record.state !== "merged" &&
        record.state !== "superseded",
    );
    if (journal.priorId) {
      if (prior?.mergeIntent) {
        throw new ChangeRequestBlockedError(
          `Change request ${prior.id} has a merge in progress; recover it before superseding that attempt.`,
        );
      }
      const priorIsEligibleActive =
        prior?.questionId === journal.questionId &&
        (prior.state === "open" ||
          prior.state === "approved" ||
          prior.state === "blocked") &&
        prior.mergedAt === undefined &&
        prior.supersededAt === undefined &&
        prior.supersededBy === undefined &&
        otherActive.length === 1 &&
        otherActive[0]?.id === prior.id;
      const priorIsCompletedJournalSupersession =
        prior?.questionId === journal.questionId &&
        prior.state === "superseded" &&
        journal.record !== undefined &&
        prior.supersededBy === journal.requestId &&
        prior.supersededAt === journal.record.createdAt &&
        prior.updatedAt === journal.record.createdAt &&
        prior.approvals.length === 0 &&
        prior.mergedAt === undefined;
      const priorIsBound =
        priorIsEligibleActive || priorIsCompletedJournalSupersession;
      if (!priorIsBound) {
        throw new ChangeRequestBlockedError(
          "Change-request creation journal prior attempt is missing or belongs to a different recovery operation.",
        );
      }
    } else if (otherActive.length > 0) {
      throw new ChangeRequestBlockedError(
        "Change-request creation journal omits the active prior attempt it would supersede.",
      );
    }

    if (journal.record) {
      const embeddedMetadataPath = await resolveContainedPathNoSymlinks(
        this.dataRoot,
        join(this.dataRoot, "change-requests", `${journal.record.id}.json`),
      );
      if (
        embeddedMetadataPath !== expected.metadataPath ||
        journal.record.id !== journal.requestId ||
        journal.record.questionId !== journal.questionId ||
        journal.record.inputFingerprint !== journal.inputFingerprint ||
        journal.record.baseBranch !== journal.baseBranch ||
        journal.record.baseSha !== journal.baseSha ||
        journal.record.branch !== expected.branch ||
        journal.record.worktreePath !== expected.worktreePath
      ) {
        throw new ChangeRequestBlockedError(
          "Change-request creation journal embedded record identity is mismatched.",
        );
      }
      await this.#validateJournalRecord(journal, journal.record);
    }
    await this.#preflightCreateTargets(journal, expected);
    return prior;
  }

  async #validateJournalRecord(
    journal: CreateJournal,
    record: EvaluableLocalChangeRequest,
  ): Promise<void> {
    const git = simpleGit(this.repoRoot);
    const registeredWorktrees = await git.raw([
      "worktree",
      "list",
      "--porcelain",
    ]);
    const registered = parseWorktreeRegistrations(registeredWorktrees).find(
      (entry) => resolve(entry.worktree ?? "") === record.worktreePath,
    );
    if (registered?.branch !== `refs/heads/${record.branch}`) {
      throw new ChangeRequestBlockedError(
        "Change-request creation journal embedded record has no exact registered worktree and branch.",
      );
    }
    const branchHead = (
      await git.revparse([`refs/heads/${record.branch}^{commit}`])
    ).trim();
    const worktreeGit = simpleGit(record.worktreePath);
    const worktreeHead = (await worktreeGit.revparse(["HEAD"])).trim();
    const status = await worktreeGit.status();
    if (
      branchHead !== record.headSha ||
      worktreeHead !== record.headSha ||
      !status.isClean()
    ) {
      throw new ChangeRequestBlockedError(
        "Change-request creation journal embedded record does not match its clean branch and worktree.",
      );
    }
    const expected = await this.#buildProposalRecord(journal, record.headSha);
    if (JSON.stringify(record) !== JSON.stringify(expected)) {
      throw new ChangeRequestBlockedError(
        "Change-request creation journal embedded record fields do not match the immutable proposal commit.",
      );
    }
  }

  async #materializeProposal(
    journalPath: string,
    journal: CreateJournal,
  ): Promise<{
    journal: CreateJournal;
    record: EvaluableLocalChangeRequest;
  }> {
    const git = simpleGit(this.repoRoot);
    const expected = await this.#expectedCreateJournalIdentity(journal);
    const branch = expected.branch;
    const worktreePath = expected.worktreePath;
    const registeredWorktrees = await git.raw([
      "worktree",
      "list",
      "--porcelain",
    ]);
    const registered = parseWorktreeRegistrations(registeredWorktrees).find(
      (entry) => resolve(entry.worktree ?? "") === worktreePath,
    );

    if (registered) {
      if (registered.branch !== `refs/heads/${branch}`) {
        throw new ChangeRequestBlockedError(
          `Refusing to resume ${worktreePath} because it is not registered to ${branch}.`,
        );
      }
    } else {
      await mkdir(dirname(worktreePath), { recursive: true });
      await git.raw([
        "worktree",
        "add",
        "-b",
        branch,
        worktreePath,
        journal.baseSha,
      ]);
      journal = createJournalSchema.parse({
        ...journal,
        materializedResources: {
          branch,
          worktreePath,
          baseSha: journal.baseSha,
        },
      });
      await this.#writeCreateJournal(journalPath, journal);
      await this.#createCheckpoint("after-worktree-created");
    }

    const worktreeGit = simpleGit(worktreePath);
    let headSha = (await worktreeGit.revparse(["HEAD"])).trim();
    const status = await worktreeGit.status();
    if (headSha === journal.baseSha) {
      if (!status.isClean()) {
        throw new ChangeRequestBlockedError(
          `Refusing to overwrite dirty journaled worktree ${worktreePath}; preserve its tracked and untracked files for manual recovery.`,
        );
      }
      await this.#writeDocumentation(worktreePath, journal.input);
      await worktreeGit.add(
        journal.input.files?.map((file) => file.path) ?? ["docs"],
      );
      await worktreeGit.raw([
        "-c",
        "user.name=Ultradyn Docs",
        "-c",
        "user.email=local@ultradyn.invalid",
        "commit",
        "-m",
        `docs: answer ${journal.questionId}`,
      ]);
      headSha = (await worktreeGit.revparse(["HEAD"])).trim();
    } else if (!status.isClean()) {
      throw new ChangeRequestBlockedError(
        `Refusing to recover dirty journaled worktree ${worktreePath}; preserve its tracked and untracked files for manual recovery.`,
      );
    }
    await this.#createCheckpoint("after-proposal-committed");

    return {
      journal,
      record: await this.#buildProposalRecord(journal, headSha),
    };
  }

  async #buildProposalRecord(
    journal: CreateJournal,
    headSha: string,
  ): Promise<EvaluableLocalChangeRequest> {
    const git = simpleGit(this.repoRoot);
    const expected = await this.#expectedCreateJournalIdentity(journal);
    await this.#assertProposalCommitMatchesInput(git, journal, headSha);
    const diff = await git.diff([`${journal.baseSha}..${headSha}`, "--"]);
    const diffCheck = await this.#diffCheck(git, journal.baseSha, headSha);
    const changed = (
      await git.diffSummary([`${journal.baseSha}..${headSha}`])
    ).files.map((file) => file.file);
    const expectedPaths = journal.input.files?.map((file) => file.path) ?? [
      `docs/answers/${journal.questionId}.md`,
    ];
    const includesProposal = expectedPaths.every((path) =>
      changed.includes(path),
    );
    const checks: EvaluableLocalChangeRequest["checks"] = [
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
      {
        id: "reviewer",
        label: "Fresh Reviewer over actual branch diff",
        status: "failed",
        detail: "Actual-diff Reviewer has not completed.",
      },
      {
        id: "diff-summary",
        label: "Fresh Diff Summarizer over actual branch diff",
        status: "failed",
        detail: "Actual-diff summary has not completed.",
      },
      {
        id: "simulated-asker",
        label: "Fresh Simulated Asker over post-diff documentation",
        status: "failed",
        detail: "Post-diff Simulated Asker has not completed.",
      },
    ];
    const summary =
      journal.input.summary ??
      (changed.length
        ? `Updates ${changed.join(", ")} with the reviewed answer to ${journal.questionId}.`
        : "No documentation files changed.");
    return completeChangeRequestSchema.parse({
      schemaVersion: 2,
      evaluationInputState: "complete",
      id: journal.requestId,
      questionId: journal.questionId,
      title: `Document: ${journal.input.title}`,
      verbatimQuestion: journal.input.question,
      verbatimChat: journal.input.verbatimChat,
      goals: journal.input.goals,
      structuredAnswer: journal.input.structuredAnswer,
      proposedFiles: journal.input.files ?? null,
      inputFingerprint: journal.inputFingerprint,
      state: checks.every((check) => check.status === "passed")
        ? "open"
        : "blocked",
      branch: expected.branch,
      baseBranch: journal.baseBranch,
      baseSha: journal.baseSha,
      headSha,
      worktreePath: expected.worktreePath,
      diff,
      summary,
      checks,
      approvals: [],
      createdAt: journal.createdAt,
      updatedAt: journal.createdAt,
    });
  }

  async #assertProposalCommitMatchesInput(
    git: ReturnType<typeof simpleGit>,
    journal: CreateJournal,
    headSha: string,
  ): Promise<void> {
    const commitAndParents = (
      await git.raw(["rev-list", "--parents", "-n", "1", headSha])
    )
      .trim()
      .split(/\s+/u);
    const subject = (
      await git.raw(["show", "-s", "--format=%s", headSha])
    ).trim();
    if (
      commitAndParents.length !== 2 ||
      commitAndParents[1] !== journal.baseSha ||
      subject !== `docs: answer ${journal.questionId}`
    ) {
      throw new ChangeRequestBlockedError(
        "Recovered proposal commit is not the exact single-parent operation described by its creation journal.",
      );
    }

    const readTreeFile = async (
      revision: string,
      path: string,
    ): Promise<string | undefined> => {
      try {
        return await git.show([`${revision}:${path}`]);
      } catch {
        return undefined;
      }
    };
    const expectedContents = new Map<string, string>();
    if (journal.input.files) {
      for (const file of journal.input.files) {
        expectedContents.set(file.path, file.content);
      }
    } else {
      const answerPath = `docs/answers/${journal.questionId}.md`;
      expectedContents.set(answerPath, generatedAnswerContent(journal.input));
      const baseMap =
        (await readTreeFile(journal.baseSha, "docs/_map.md")) ??
        "# Documentation map\n";
      expectedContents.set(
        "docs/_map.md",
        mapWithQuestion(baseMap, journal.input),
      );
    }

    const expectedChanged: string[] = [];
    for (const [path, content] of expectedContents) {
      if ((await readTreeFile(headSha, path)) !== content) {
        throw new ChangeRequestBlockedError(
          `Recovered proposal commit content for ${path} does not match its creation journal.`,
        );
      }
      if ((await readTreeFile(journal.baseSha, path)) !== content) {
        expectedChanged.push(path);
      }
    }
    const changed = (
      await git.diffSummary([`${journal.baseSha}..${headSha}`])
    ).files
      .map((file) => file.file)
      .sort();
    if (JSON.stringify(changed) !== JSON.stringify(expectedChanged.sort())) {
      throw new ChangeRequestBlockedError(
        "Recovered proposal commit changed files outside its journal-bound proposal.",
      );
    }
  }

  async #createJournalPath(questionId: string): Promise<string> {
    const key = createHash("sha256").update(questionId, "utf8").digest("hex");
    return resolveContainedPathNoSymlinks(
      this.dataRoot,
      join(this.dataRoot, "operations", `change-request-create-${key}.json`),
    );
  }

  async #readCreateJournal(path: string): Promise<CreateJournal | undefined> {
    try {
      return createJournalSchema.parse(
        JSON.parse(await readFile(path, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #writeCreateJournal(
    path: string,
    journal: CreateJournal,
  ): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFileAtomic(path, `${JSON.stringify(journal, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async #createCheckpoint(
    checkpoint: ChangeRequestCreateCheckpoint,
  ): Promise<void> {
    await this.#onCreateCheckpoint?.(checkpoint);
  }

  async get(id: string): Promise<LocalChangeRequest | undefined> {
    return this.#locked(async () => {
      await this.#reconcilePendingCreateJournals();
      return this.#getUnlocked(id);
    });
  }

  async #getUnlocked(id: string): Promise<LocalChangeRequest | undefined> {
    const requestedId = IdSchemas.changeRequest.parse(id);
    try {
      const path = await resolveContainedPathNoSymlinks(
        this.dataRoot,
        join(this.dataRoot, "change-requests", `${requestedId}.json`),
      );
      const record = parseChangeRequest(
        JSON.parse(await readFile(path, "utf8")),
      );
      assertChangeRequestIntegrity(record, `${requestedId}.json`);
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
    return this.#locked(async () => {
      await this.#reconcilePendingCreateJournals();
      return this.#getForQuestionUnlocked(questionId);
    });
  }

  async #getForQuestionUnlocked(
    questionId: string,
  ): Promise<LocalChangeRequest | undefined> {
    if (!isSafeChangeRequestKey(questionId)) {
      throw new Error(
        "Change-request keys must be a valid lowercase slug or canonical question ID.",
      );
    }
    const requestedId = questionId;
    return (await this.#listUnlocked())
      .filter((record) => record.questionId === requestedId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  async getActiveForQuestion(
    questionId: string,
  ): Promise<LocalChangeRequest | undefined> {
    return this.#locked(async () => {
      await this.#reconcilePendingCreateJournals();
      return this.#getActiveForQuestionUnlocked(questionId);
    });
  }

  async #getActiveForQuestionUnlocked(
    questionId: string,
  ): Promise<LocalChangeRequest | undefined> {
    if (!isSafeChangeRequestKey(questionId)) {
      throw new Error(
        "Change-request keys must be a valid lowercase slug or canonical question ID.",
      );
    }
    const requestedId = questionId;
    const records = (await this.#listUnlocked()).filter(
      (record) => record.questionId === requestedId,
    );
    const merging = records.find((record) => record.mergeIntent !== undefined);
    if (merging) {
      throw new ChangeRequestBlockedError(
        `Change request ${merging.id} has a merge in progress; recover it before creating a replacement attempt.`,
      );
    }
    const active = records.filter(
      (record) => record.state !== "merged" && record.state !== "superseded",
    );
    if (active.length > 1) {
      throw new ChangeRequestBlockedError(
        `Question ${questionId} has multiple active prior attempts; repair their relationship before creating another attempt.`,
      );
    }
    return active[0];
  }

  async list(): Promise<LocalChangeRequest[]> {
    return this.#locked(async () => {
      await this.#reconcilePendingCreateJournals();
      return this.#listUnlocked();
    });
  }

  async #listUnlocked(): Promise<LocalChangeRequest[]> {
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
          const record = parseChangeRequest(
            JSON.parse(await readFile(path, "utf8")),
          );
          assertChangeRequestIntegrity(record, name);
          return record;
        }),
    );
    return records.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  async #reconcilePendingCreateJournals(): Promise<void> {
    const root = await resolveContainedPathNoSymlinks(
      this.dataRoot,
      join(this.dataRoot, "operations"),
    );
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names
      .filter(
        (candidate) =>
          candidate.startsWith("change-request-create-") &&
          candidate.endsWith(".json"),
      )
      .sort()) {
      const path = await resolveContainedPathNoSymlinks(
        this.dataRoot,
        join(root, name),
      );
      const journal = await this.#readCreateJournal(path);
      if (journal) await this.#reconcileCreateJournal(path, journal);
    }
  }

  async recordActualDiffChecks(
    id: string,
    input: ActualDiffChecksInput,
  ): Promise<EvaluableLocalChangeRequest> {
    return this.#locked(async () => {
      await this.#reconcilePendingCreateJournals();
      return this.#recordActualDiffChecksUnlocked(id, input);
    });
  }

  async #recordActualDiffChecksUnlocked(
    id: string,
    input: ActualDiffChecksInput,
  ): Promise<EvaluableLocalChangeRequest> {
    const record = requireHistoricEvaluationInput(await this.#require(id));
    this.#assertNotSuperseded(record);
    if (record.state === "merged") {
      throw new ChangeRequestBlockedError(
        "Merged change requests cannot be re-evaluated.",
      );
    }
    await this.#assertBranchHead(record);
    await this.#assertCompatibleBase(record);
    const result = actualDiffChecksInputSchema.parse(input);
    const expectedGoals = new Set(record.goals);
    const goalCoverageIsExact =
      result.simulatedAsker.goalResults.length === expectedGoals.size &&
      [...expectedGoals].every(
        (goal) =>
          result.simulatedAsker.goalResults.filter(
            (candidate) => candidate.goal === goal,
          ).length === 1,
      ) &&
      result.simulatedAsker.goalResults.every((candidate) =>
        expectedGoals.has(candidate.goal),
      );
    if (!goalCoverageIsExact) {
      throw new ChangeRequestBlockedError(
        "The Simulated Asker must return exactly one result for every declared goal, with no missing, duplicate, or foreign goals.",
      );
    }
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
    const updated = completeChangeRequestSchema.parse({
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
    return this.#locked(async () => {
      await this.#reconcilePendingCreateJournals();
      return this.#approveUnlocked(id, input);
    });
  }

  async #approveUnlocked(
    id: string,
    input: { by: string; kind: "answerer" | "maintainer" | "summary" },
  ): Promise<LocalChangeRequest> {
    const record = requireHistoricEvaluationInput(await this.#require(id));
    this.#assertNotSuperseded(record);
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
    return this.#locked(async () => {
      await this.#reconcilePendingCreateJournals();
      return this.#mergeUnlocked(id, input);
    });
  }

  async #mergeUnlocked(
    id: string,
    input: { by: string; checkpointManagedState?: boolean },
  ): Promise<LocalChangeRequest> {
    let record = requireHistoricEvaluationInput(await this.#require(id));
    this.#assertNotSuperseded(record);
    if (record.mergeIntent) {
      return this.#reconcileMerge(record);
    }
    if (record.state === "merged") return record;
    await this.#assertBranchHead(record);
    await this.#assertCompatibleBase(record);
    assertMergeAuthorization(record);
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
    const baseHeadSha = (await git.revparse(["HEAD"])).trim();
    let expectedResultTreeSha: string;
    try {
      expectedResultTreeSha = (
        await git.raw([
          "merge-tree",
          "--write-tree",
          baseHeadSha,
          record.headSha,
        ])
      ).trim();
    } catch (error) {
      throw new ChangeRequestBlockedError(
        `The reviewed commits do not produce a clean deterministic merge result: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!/^[0-9a-f]{40,64}$/u.test(expectedResultTreeSha)) {
      throw new ChangeRequestBlockedError(
        "Git did not return one canonical result tree for the reviewed merge.",
      );
    }
    const startedAt = this.#now();
    const intent = {
      baseHeadSha,
      branchHeadSha: record.headSha,
      expectedResultTreeSha,
      by: input.by,
      startedAt,
    };
    record = completeChangeRequestSchema.parse({
      ...record,
      updatedAt: startedAt,
      mergeIntent: {
        ...intent,
        authorizationSha256: mergeAuthorizationSha256(record, intent),
      },
    });
    await this.#write(record);
    return this.#reconcileMerge(record);
  }

  async #reconcileMerge(
    record: LocalChangeRequest,
  ): Promise<LocalChangeRequest> {
    const intent = record.mergeIntent;
    if (!intent) return record;
    assertMergeIntentIntegrity(requireHistoricEvaluationInput(record));
    const git = simpleGit(this.repoRoot);
    let currentHead = (await git.revparse(["HEAD"])).trim();
    if (currentHead !== intent.baseHeadSha) {
      await this.#assertExactMergeCommit(intent, currentHead);
    } else {
      const status = await git.status();
      if (status.current !== record.baseBranch) {
        throw new ChangeRequestBlockedError(
          `Check out ${record.baseBranch} before reconciling this local change request.`,
        );
      }
      const trackedChanges = [
        ...status.staged,
        ...status.modified,
        ...status.deleted,
        ...status.renamed.map((entry) => entry.to),
      ];
      const external = trackedChanges.filter(
        (path) => !this.#isManagedPath(path),
      );
      if (status.conflicted.length > 0 || external.length > 0) {
        throw new ChangeRequestBlockedError(
          "The prepared merge cannot continue while the base worktree has conflicts or external tracked changes.",
        );
      }
      await this.#assertBranchHead(record);
      if ((await git.revparse(["HEAD"])).trim() !== intent.baseHeadSha) {
        throw new ChangeRequestBlockedError(
          "The base branch moved after merge preparation; automatic reconciliation is unsafe.",
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
          intent.branchHeadSha,
          "-m",
          `Merge ${record.title} (approved by ${intent.by})`,
        ]);
      } catch (error) {
        try {
          await this.#restoreBaseAfterFailedMerge(git, intent);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "The local merge failed and its exact reviewed merge commit could not be restored to the authorized base HEAD.",
            { cause: rollbackError },
          );
        }
        throw new ChangeRequestBlockedError(
          `The local merge did not apply cleanly: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      currentHead = (await git.revparse(["HEAD"])).trim();
    }
    await this.#assertExactMergeCommit(intent, currentHead);
    const at = this.#now();
    const merged = changeRequestSchema.parse({
      ...record,
      state: "merged",
      updatedAt: at,
      mergedAt: record.mergedAt ?? at,
      mergeIntent: { ...intent, mergedHeadSha: currentHead },
    });
    await this.#write(merged);
    await this.#cleanupManagedWorktree(merged);
    const { mergeIntent: completedIntent, ...mergedRecord } = merged;
    void completedIntent;
    const completed = changeRequestSchema.parse({
      ...mergedRecord,
      updatedAt: this.#now(),
    });
    await this.#write(completed);
    return completed;
  }

  async #assertExactMergeCommit(
    intent: z.infer<typeof mergeIntentSchema>,
    headSha: string,
  ): Promise<void> {
    if (intent.mergedHeadSha && intent.mergedHeadSha !== headSha) {
      throw new ChangeRequestBlockedError(
        "The base branch moved after the reviewed merge was recorded; automatic reconciliation is unsafe.",
      );
    }
    const parents = (
      await simpleGit(this.repoRoot).raw([
        "rev-list",
        "--parents",
        "-n",
        "1",
        headSha,
      ])
    )
      .trim()
      .split(/\s+/u);
    if (
      parents.length !== 3 ||
      parents[1] !== intent.baseHeadSha ||
      parents[2] !== intent.branchHeadSha
    ) {
      throw new ChangeRequestBlockedError(
        "HEAD is not the exact reviewed merge described by the durable merge intent.",
      );
    }
    const resultTreeSha = (
      await simpleGit(this.repoRoot).raw(["show", "-s", "--format=%T", headSha])
    ).trim();
    if (resultTreeSha !== intent.expectedResultTreeSha) {
      throw new ChangeRequestBlockedError(
        "HEAD has the authorized merge parents but not the independently reviewed result tree.",
      );
    }
  }

  async #restoreBaseAfterFailedMerge(
    git: ReturnType<typeof simpleGit>,
    intent: z.infer<typeof mergeIntentSchema>,
  ): Promise<void> {
    await git.merge(["--abort"]).catch(() => undefined);
    const failedHead = (await git.revparse(["HEAD"])).trim();
    if (failedHead === intent.baseHeadSha) return;
    await this.#assertExactMergeCommit(intent, failedHead);
    await git.raw(["reset", "--merge", intent.baseHeadSha]);
    const restoredHead = (await git.revparse(["HEAD"])).trim();
    if (restoredHead !== intent.baseHeadSha) {
      throw new ChangeRequestBlockedError(
        "The failed reviewed merge did not restore the exact authorized base HEAD.",
      );
    }
  }

  async #cleanupManagedWorktree(record: LocalChangeRequest): Promise<void> {
    const expectedPath = await resolveContainedPathNoSymlinks(
      this.dataRoot,
      record.worktreePath,
    );
    const entries = (
      await simpleGit(this.repoRoot).raw(["worktree", "list", "--porcelain"])
    )
      .trim()
      .split(/\n\n+/u)
      .map((block) =>
        Object.fromEntries(
          block.split("\n").map((line) => {
            const separator = line.indexOf(" ");
            return separator === -1
              ? [line, ""]
              : [line.slice(0, separator), line.slice(separator + 1)];
          }),
        ),
      );
    const registered = entries.find(
      (entry) => resolve(entry.worktree ?? "") === expectedPath,
    );
    if (!registered) return;
    if (registered.branch !== `refs/heads/${record.branch}`) {
      throw new ChangeRequestBlockedError(
        `Refusing to remove ${expectedPath} because it is not registered to ${record.branch}.`,
      );
    }
    const status = await simpleGit(expectedPath).status();
    if (!status.isClean()) {
      throw new ChangeRequestBlockedError(
        `Refusing to remove dirty worktree ${expectedPath}; commit, stash, or explicitly discard its tracked and untracked changes before retrying cleanup.`,
      );
    }
    await this.#worktreeRemover(expectedPath);
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
      assertSafeProposalPaths(input);
      for (const file of input.files) {
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
    await writeFileAtomic(answerPath, generatedAnswerContent(input), {
      encoding: "utf8",
    });

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
    const updatedMap = mapWithQuestion(map, input);
    if (updatedMap !== map) {
      await writeFileAtomic(mapPath, updatedMap, {
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
    const record = await this.#getUnlocked(id);
    if (!record) throw new Error(`Change request ${id} was not found.`);
    return record;
  }

  #assertNotSuperseded(record: LocalChangeRequest): void {
    if (record.state === "superseded") {
      throw new ChangeRequestBlockedError(
        `Change request ${record.id} was superseded by ${record.supersededBy ?? "a newer attempt"} and cannot be reactivated.`,
      );
    }
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
    assertChangeRequestIntegrity(record);
    const path = await resolveContainedPathNoSymlinks(
      this.dataRoot,
      join(this.dataRoot, "change-requests", `${record.id}.json`),
    );
    await mkdir(dirname(path), { recursive: true });
    await this.#metadataWriter(path, `${JSON.stringify(record, null, 2)}\n`);
  }

  async #locked<T>(operation: () => Promise<T>): Promise<T> {
    await resolveContainedPathNoSymlinks(this.dataRoot, this.dataRoot);
    await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.dataRoot, {
      realpath: false,
      lockfilePath: join(this.dataRoot, ".change-request.lock"),
      stale: 30_000,
      retries: {
        retries: 40,
        factor: 1.2,
        minTimeout: 10,
        maxTimeout: 250,
      },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}
