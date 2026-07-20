import { createHash } from "node:crypto";
import { access, readFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import { simpleGit } from "simple-git";
import { ulid } from "ulid";
import writeFileAtomic from "write-file-atomic";

import {
  ActorHandleSchema,
  askerDecisionSummary,
  queueForState,
  type QuestionRecord,
} from "../domain/index.js";
import {
  AgentRuntime,
  loadAgentDefinition,
  validateAgentFixtures,
} from "../agents/index.js";
import {
  ChangeRequestBlockedError,
  LocalChangeRequestManager,
} from "../integration/index.js";
import {
  CredentialSourceRegistry,
  ConsentRequiredError,
  CredentialUnavailableError,
  FakeGitHostProvider,
  FfmpegCodecProvider,
  FileOAuthTokenStore,
  GhCliGitHostProvider,
  OAUTH_FLOWS,
  OAuthError,
  OAuthTokenCredentialSource,
  OPENAI_OAUTH_FLOW,
  XAI_OAUTH_FLOW,
  createEnvironmentCredentialSources,
  createInstalledClientCredentialSources,
  getOAuthFlow,
  runOAuthFlow,
  startLoopbackListener,
  type CredentialSource,
  type CredentialSourceDescription,
  type GitHostProvider,
  type LlmProvider,
  type LoopbackListener,
  type OAuthTokenSet,
} from "../providers/index.js";
import {
  FileAudioSessionStore,
  KnowledgeRepository,
  QuestionNotFoundError,
  RepositorySettingsStore,
} from "../repository/index.js";
import type {
  AskResult,
  AgentDefinitionStatus,
  AgentFixtureResult,
  Citation,
  ChangeRequestInfo,
  GoalDefinition,
  MaintenanceTask,
  PriorityTier,
  QuestionDetail,
  QuestionSummary,
  SettingScope,
  SettingValue,
  ProviderStatus,
} from "../shared/index.js";
import { createDemoServices } from "./demo-services.js";
import {
  CriticOutputSchema,
  DiffSummarizerOutputSchema,
  IntegratorOutputSchema,
  LibrarianOutputSchema,
  ReviewerOutputSchema,
  SimulatedAskerOutputSchema,
  StructurerOutputSchema,
  criticEvaluation,
  renderStructuredAnswer,
} from "./agent-workflow.js";
import { MaintenanceCoordinator } from "./maintenance-coordinator.js";
import { createDefaultProviderRuntimeFactory } from "./provider-runtime.js";
import { bestQuestionMatch } from "./question-matcher.js";
import { DocumentationIndex } from "./retrieval.js";
import {
  ServiceError,
  type AskInput,
  type QuestionQuery,
  type UltradynServices,
} from "./services.js";

export interface CreateLocalServicesOptions {
  repoRoot: string;
  dataRoot: string;
  credentialSources?: CredentialSource[];
  gitHostProvider?: GitHostProvider;
  llmProvider?: LlmProvider;
  allowFakeMedia?: boolean;
  /** Injectable fetch for OAuth token exchange (tests). */
  fetch?: typeof globalThis.fetch;
  /** Injectable loopback factory for OAuth (tests). */
  startOAuthListener?: (options: {
    path: string;
    port?: number;
    timeoutMs?: number;
  }) => Promise<LoopbackListener>;
}

interface TranscriptMetadata {
  path: string;
  source: "typed" | "stt";
  confidence?: number;
}

function goalLabel(id: string): string {
  return id
    .split("-")
    .map((part) => `${part[0]?.toLocaleUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

async function repositoryGoals(
  repoRoot: string,
  fallback: GoalDefinition[],
): Promise<GoalDefinition[]> {
  let markdown: string;
  try {
    markdown = await readFile(join(repoRoot, "goals", "vocabulary.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
  const goals = [
    ...markdown.matchAll(
      /^##\s+([a-z0-9][a-z0-9-]*)\s*\n+([\s\S]*?)(?=^##\s|\s*$)/gmu,
    ),
  ]
    .map((match) => {
      const id = match[1];
      const description = match[2]?.trim().replace(/\s+/gu, " ");
      if (!id || !description) return undefined;
      return {
        id,
        label: goalLabel(id),
        description,
        criteria: description,
      } satisfies GoalDefinition;
    })
    .filter((goal): goal is GoalDefinition => goal !== undefined);
  return goals.length > 0 ? goals : fallback;
}

function normalizeGoalIdentifier(value: string): string {
  const id = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
  if (!id) {
    throw new ServiceError(
      "A stable identifier must contain at least one letter or number.",
      400,
      "invalid_identifier",
    );
  }
  return id;
}

function humanIdentity(value: string): { id: string; displayName?: string } {
  const displayName = value.trim();
  if (!/[\p{L}\p{N}]/u.test(displayName)) {
    throw new ServiceError(
      "A stable identifier must contain at least one letter or number.",
      400,
      "invalid_identifier",
    );
  }
  if (/^[a-z0-9][a-z0-9._:-]{0,95}$/u.test(displayName)) {
    return { id: displayName };
  }

  const digest = createHash("sha256")
    .update(displayName.normalize("NFC"))
    .digest("hex")
    .slice(0, 32);
  const maximumPrefixLength = 96 - digest.length - 1;
  const prefix =
    displayName
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, maximumPrefixLength) || "asker";
  return {
    id: `${prefix}-${digest}`,
    displayName,
  };
}

function currentAnswerer(record: QuestionRecord): string | undefined {
  const event = record.provenance.findLast(
    (candidate) =>
      candidate.type === "state-transitioned" &&
      candidate.details?.to === "in-answer" &&
      candidate.by.startsWith("answerer:"),
  );
  return event?.by.slice("answerer:".length);
}

function titleFor(question: string): string {
  const trimmed = question.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

function summary(record: QuestionRecord): QuestionSummary {
  return {
    id: record.id,
    title: record.title,
    state: record.state,
    bucket: queueForState(record.state),
    tier: record.tier,
    goals: [...record.goals],
    tags: [...record.tags],
    askers: record.askers.map((asker) => asker.displayName ?? asker.id),
    askerDetails: record.askers.map((asker) => ({
      id: asker.id,
      name: asker.displayName ?? asker.id,
      acceptance: asker.acceptance,
      ...(asker.decidedAt ? { decidedAt: asker.decidedAt } : {}),
    })),
    created: record.createdAt,
    updated: record.updatedAt,
    rationale: record.priorityRationale,
  };
}

function changeRequestInfo(
  changeRequest: Awaited<
    ReturnType<LocalChangeRequestManager["getForQuestion"]>
  >,
): ChangeRequestInfo | undefined {
  if (!changeRequest) return undefined;
  return {
    id: changeRequest.id,
    state: changeRequest.state,
    branch: changeRequest.branch,
    summary: changeRequest.summary,
    diff: changeRequest.diff,
    checks: changeRequest.checks.map((check) => ({ ...check })),
    approvals: changeRequest.approvals.map((approval) => ({ ...approval })),
    createdAt: changeRequest.createdAt,
    updatedAt: changeRequest.updatedAt,
  };
}

async function optionalDerived(
  repository: KnowledgeRepository,
  id: string,
  path: string,
) {
  try {
    return await repository.readDerived(id, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function transcriptMetadata(
  repository: KnowledgeRepository,
  id: string,
): Promise<TranscriptMetadata[]> {
  const content = await optionalDerived(
    repository,
    id,
    "answers/transcripts.json",
  );
  if (!content) return [];
  const parsed = JSON.parse(content) as unknown;
  return Array.isArray(parsed) ? (parsed as TranscriptMetadata[]) : [];
}

async function detail(
  repository: KnowledgeRepository,
  record: QuestionRecord,
  changeRequests?: LocalChangeRequestManager,
): Promise<QuestionDetail> {
  const artifacts = await repository.listRawArtifacts(record.id);
  const metadata = await transcriptMetadata(repository, record.id);
  const questionArtifact = artifacts.find(
    (artifact) => artifact.kind === "question",
  );
  const chatArtifact = artifacts.find(
    (artifact) => artifact.kind === "chatlog",
  );
  const transcriptArtifacts = artifacts.filter(
    (artifact) =>
      artifact.kind === "transcript" || artifact.kind === "correction",
  );
  const structuredAnswer = await optionalDerived(
    repository,
    record.id,
    "answers/structured.md",
  );
  const evaluationText = await optionalDerived(
    repository,
    record.id,
    "answers/evaluation.json",
  );
  const evaluation = evaluationText
    ? (JSON.parse(evaluationText) as QuestionDetail["evaluation"])
    : undefined;
  const activeChangeRequest = await changeRequests?.getActiveForQuestion(
    record.id,
  );
  const changeRequest =
    activeChangeRequest ??
    (changeRequests &&
    (record.state === "merged" || record.state === "accepted")
      ? await changeRequests.getForQuestion(record.id)
      : undefined);
  const mappedChangeRequest = changeRequestInfo(changeRequest);
  return {
    ...summary(record),
    rawQuestion: questionArtifact
      ? await repository.readRawArtifact(record.id, questionArtifact.path)
      : record.question,
    chat: chatArtifact
      ? await repository.readRawArtifact(record.id, chatArtifact.path)
      : "",
    provenance: record.provenance.map((event) => ({ ...event })),
    transcripts: await Promise.all(
      transcriptArtifacts.map(async (artifact) => {
        const attributes = metadata.find(
          (entry) => entry.path === artifact.path,
        );
        return {
          id: artifact.path,
          text: await repository.readRawArtifact(record.id, artifact.path),
          source: attributes?.source ?? "typed",
          ...(attributes?.confidence === undefined
            ? {}
            : { confidence: attributes.confidence }),
          created: artifact.createdAt,
        };
      }),
    ),
    ...(structuredAnswer === undefined
      ? {}
      : { structuredAnswer: structuredAnswer.trim() }),
    ...(evaluation === undefined ? {} : { evaluation }),
    ...(mappedChangeRequest ? { changeRequest: mappedChangeRequest } : {}),
  };
}

function serviceError(error: unknown): never {
  if (error instanceof ServiceError) throw error;
  if (error instanceof QuestionNotFoundError) {
    throw new ServiceError(error.message, 404, "question_not_found");
  }
  if (error instanceof ChangeRequestBlockedError) {
    throw new ServiceError(error.message, 409, "change_request_blocked");
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/transition|revision conflict/iu.test(message)) {
    throw new ServiceError(message, 409, "invalid_transition");
  }
  throw error;
}

function providerKind(
  description: CredentialSourceDescription,
): ProviderStatus["kind"] {
  if (
    description.scopes.length === 1 &&
    description.scopes[0] === "transcription"
  )
    return "stt";
  if (description.scopes.length === 1 && description.scopes[0] === "git-host")
    return "git";
  return "llm";
}

function activationChecklist(
  description: CredentialSourceDescription,
): string[] {
  if (description.id in OAUTH_FLOWS) {
    return [
      "Complete the browser sign-in from this page",
      "Grant scoped discovery consent here",
      "Run the provider capability test before selection",
    ];
  }
  if (description.id === "grok-auth-file") {
    return [
      "Run `grok login --device-auth` in a trusted terminal",
      "Grant scoped discovery consent here",
      "Run the provider capability test before selection",
    ];
  }
  if (description.kind === "delegated-client") {
    return [
      `Install and sign in to ${description.label}`,
      "Grant scoped discovery consent here",
      "Run the provider capability test before selection",
    ];
  }
  return [
    `Configure ${description.label} outside the repository`,
    "Grant scoped discovery consent here",
    "Run the provider capability test before selection",
  ];
}

type OAuthSessionPhase = "pending" | "complete" | "error";

interface OAuthSession {
  phase: OAuthSessionPhase;
  authorizeUrl?: string;
  state?: string;
  detail?: string;
  listener?: LoopbackListener | undefined;
  flowPromise: Promise<void>;
  /** Rejects oauthStart if cancel wins the race before presentUrl. */
  rejectStart?: ((error: unknown) => void) | undefined;
}

function githubRepositoryFromRemote(remote: string): string | undefined {
  const normalized = remote.trim().replace(/\.git$/u, "");
  const match = /(?:github\.com[/:])([^/\s:]+)\/([^/\s]+)$/iu.exec(normalized);
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : undefined;
}

/**
 * Creates the default local-first implementation used by `ultradyn-docs serve`.
 * Portable question state lives below repoRoot; machine-local locks, settings,
 * provider state, change requests, and audio live below dataRoot.
 */
export async function createLocalServices(
  options: CreateLocalServicesOptions,
): Promise<UltradynServices> {
  const repository = new KnowledgeRepository(options.repoRoot, {
    lockRoot: join(options.dataRoot, "repository-locks"),
  });
  await repository.initialize();
  const defaults = createDemoServices();
  const configuredGoals = await repositoryGoals(
    options.repoRoot,
    await defaults.goals.list(),
  );
  const settings = new RepositorySettingsStore(
    options.repoRoot,
    join(options.dataRoot, "settings.json"),
  );
  const audio = new FileAudioSessionStore(join(options.dataRoot, "audio"));
  const changeRequests = new LocalChangeRequestManager({
    repoRoot: options.repoRoot,
    dataRoot: options.dataRoot,
  });
  const agentsRoot = join(options.repoRoot, "agents");
  const ffmpeg = new FfmpegCodecProvider();
  const documentation = new DocumentationIndex(options.repoRoot);
  const oauthTokenStore = new FileOAuthTokenStore(
    join(options.dataRoot, "oauth"),
  );
  const oauthFetch = options.fetch;
  const defaultOAuthSources = [
    new OAuthTokenCredentialSource({
      store: oauthTokenStore,
      config: XAI_OAUTH_FLOW,
      ...(oauthFetch ? { fetch: oauthFetch } : {}),
    }),
    new OAuthTokenCredentialSource({
      store: oauthTokenStore,
      config: OPENAI_OAUTH_FLOW,
      ...(oauthFetch ? { fetch: oauthFetch } : {}),
    }),
  ];
  const credentialSources = options.credentialSources ?? [
    ...createEnvironmentCredentialSources(),
    ...createInstalledClientCredentialSources(),
    ...defaultOAuthSources,
  ];
  const providerRuntime = createDefaultProviderRuntimeFactory({
    repoRoot: options.repoRoot,
    dataRoot: options.dataRoot,
    credentialSources,
    ...(oauthFetch ? { fetch: oauthFetch } : {}),
  });
  const credentials: CredentialSourceRegistry = providerRuntime.credentials;
  const fakeGitHost = new FakeGitHostProvider();
  const oauthSessions = new Map<string, OAuthSession>();

  async function selectedGitHost(): Promise<GitHostProvider> {
    if (options.gitHostProvider) return options.gitHostProvider;
    const selected =
      (await settings.readMerged()).effective.providers.gitHost ??
      "fake-git-host";
    if (selected === "fake-git-host") return fakeGitHost;
    if (selected === "github-cli") {
      if (
        !credentials
          .descriptions()
          .some((description) => description.id === "github-cli")
      ) {
        throw new ServiceError(
          "The selected GitHub CLI credential source is not configured.",
          409,
          "git_host_unavailable",
        );
      }
      await credentials.resolve("github-cli", "git-host");
      return new GhCliGitHostProvider({ cwd: options.repoRoot });
    }
    throw new ServiceError(
      `Selected Git host ${selected} is unavailable.`,
      409,
      "git_host_unavailable",
    );
  }

  async function maintenanceRepository(
    provider: GitHostProvider,
  ): Promise<string> {
    if (provider.id === "fake-git-host")
      return `local/${basename(options.repoRoot)}`;
    const origin = (await simpleGit(options.repoRoot).getRemotes(true)).find(
      (remote) => remote.name === "origin",
    )?.refs.fetch;
    const repository = origin ? githubRepositoryFromRemote(origin) : undefined;
    if (repository) return repository;
    throw new ServiceError(
      "GitHub maintenance requires an origin remote pointing to github.com/owner/repository.",
      409,
      "github_repository_unavailable",
    );
  }

  async function maintenanceCoordinator(): Promise<{
    coordinator: MaintenanceCoordinator;
    repository: string;
  }> {
    const provider = await selectedGitHost();
    const status = await provider.status();
    const consentReady =
      status.consent === "granted" || status.consent === "not-applicable";
    if (status.availability !== "available" || !consentReady) {
      throw new ServiceError(
        status.reason ??
          (consentReady
            ? `${status.label} is not available.`
            : `${status.label} requires Git-host consent.`),
        409,
        "git_host_unavailable",
      );
    }
    return {
      coordinator: new MaintenanceCoordinator({
        dataRoot: options.dataRoot,
        provider,
      }),
      repository: await maintenanceRepository(provider),
    };
  }

  async function pendingCheckpointTask(): Promise<MaintenanceTask | undefined> {
    const merged = await settings.readMerged();
    if (merged.effective.checkpointCommits) return undefined;
    const status = await simpleGit(options.repoRoot).status();
    const paths = [
      ...status.staged,
      ...status.modified,
      ...status.deleted,
      ...status.renamed.flatMap((entry) => [entry.from, entry.to]),
      ...status.not_added,
    ]
      .filter(
        (path) => path.startsWith("questions/") || path.startsWith("settings/"),
      )
      .filter((path, index, all) => all.indexOf(path) === index)
      .sort((left, right) => left.localeCompare(right));
    if (paths.length === 0) return undefined;
    const roots = ["questions", "settings"].filter((root) =>
      paths.some((path) => path.startsWith(`${root}/`)),
    );
    return {
      id: "checkpoint:portable-state",
      kind: "checkpoint",
      title: "Checkpoint pending portable state",
      detail: `Automatic checkpoint commits are disabled; ${paths.length} uncommitted portable ${paths.length === 1 ? "path is" : "paths are"} waiting under ${roots.map((root) => `${root}/`).join(" and ")}. Commit them manually, or enable review.checkpointCommits before the next approved local merge.`,
      status: "open",
      updated: new Date().toISOString(),
    };
  }

  function gitHostProviderTask(error: unknown): MaintenanceTask | undefined {
    let title: string;
    let guidance: string;
    if (error instanceof ConsentRequiredError) {
      title = "Authorize Git host maintenance";
      guidance =
        "Grant the selected provider Git-host consent, then retry maintenance.";
    } else if (error instanceof CredentialUnavailableError) {
      title = "Activate Git host credentials";
      guidance =
        "Sign in to the selected Git-host client or configure its credential, then retry maintenance.";
    } else if (
      error instanceof ServiceError &&
      error.code === "github_repository_unavailable"
    ) {
      title = "Configure the GitHub origin";
      guidance =
        "Point the repository origin at github.com/owner/repository, then retry maintenance.";
    } else if (
      error instanceof ServiceError &&
      error.code === "git_host_unavailable"
    ) {
      title = "Select or activate a Git host";
      guidance =
        "Choose an available Git-host provider in Settings and complete its activation checklist.";
    } else {
      return undefined;
    }
    return {
      id: "provider:git-host",
      kind: "provider",
      title,
      detail: `${error instanceof Error ? error.message : String(error)} ${guidance}`,
      status: "open",
      updated: new Date().toISOString(),
    };
  }

  async function localMaintenanceTasks(): Promise<MaintenanceTask[]> {
    const checkpoint = await pendingCheckpointTask();
    const changeRequestTasks = (await changeRequests.list())
      .filter((request) => request.state !== "merged")
      .map((request) => ({
        id: request.id,
        kind: "review" as const,
        title: request.title,
        detail: request.summary,
        status: "open" as const,
        updated: request.updatedAt,
      }));
    return [...(checkpoint ? [checkpoint] : []), ...changeRequestTasks];
  }

  async function remoteMaintenanceTasks(
    action: "list" | "run",
  ): Promise<MaintenanceTask[]> {
    try {
      const { coordinator, repository: remote } =
        await maintenanceCoordinator();
      return action === "list"
        ? await coordinator.list(remote)
        : await coordinator.run(remote);
    } catch (error) {
      const providerTask = gitHostProviderTask(error);
      if (providerTask) return [providerTask];
      throw error;
    }
  }

  async function maintenanceTasks(
    action: "list" | "run",
  ): Promise<MaintenanceTask[]> {
    return [
      ...(await localMaintenanceTasks()),
      ...(await remoteMaintenanceTasks(action)),
    ];
  }

  async function getRecord(id: string): Promise<QuestionRecord> {
    try {
      return await repository.getQuestion(id);
    } catch (error) {
      return serviceError(error);
    }
  }

  async function getDetail(id: string): Promise<QuestionDetail> {
    return detail(repository, await getRecord(id), changeRequests);
  }

  async function timeoutSilentAskers(): Promise<void> {
    const mergedSettings = await settings.readMerged();
    const cutoff =
      Date.now() -
      mergedSettings.effective.acceptanceTimeoutDays * 24 * 60 * 60 * 1000;
    for (const record of await repository.listQuestions({
      states: ["merged"],
    })) {
      if (Date.parse(record.updatedAt) > cutoff) continue;
      let current = record;
      for (const asker of current.askers.filter(
        (candidate) => candidate.acceptance === "pending",
      )) {
        current = await repository.decideAsker(record.id, {
          askerId: asker.id,
          decision: "timed-out",
          expectedRevision: current.revision,
          by: "maintainer:acceptance-timeout",
        });
      }
      if (askerDecisionSummary(current.askers) === "accepted") {
        await repository.transition(record.id, {
          to: "accepted",
          expectedRevision: current.revision,
          by: "maintainer:acceptance-timeout",
        });
      }
    }
  }

  async function selectedAgentRuntime(): Promise<AgentRuntime | undefined> {
    if (options.llmProvider) {
      return new AgentRuntime({
        definitionsRoot: agentsRoot,
        provider: options.llmProvider,
      });
    }
    const selected = (await settings.readMerged()).effective.providers.llm;
    if (selected === "fake-llm") return undefined;
    const resolution = await providerRuntime.resolveLlm(selected);
    if (resolution.state === "blocked") {
      throw new ServiceError(resolution.message, 409, "llm_unavailable");
    }
    return new AgentRuntime({
      definitionsRoot: agentsRoot,
      provider: resolution.provider,
    });
  }

  async function ensureGeneratedChild(
    parent: QuestionRecord,
    input: {
      question: string;
      goal: string;
      contradiction?: boolean;
      extraDetail?: boolean;
    },
  ): Promise<QuestionRecord> {
    const normalized = input.question
      .trim()
      .replace(/\s+/gu, " ")
      .toLocaleLowerCase();
    const existing = (await repository.listQuestions()).find(
      (candidate) =>
        candidate.origin.kind === "generated" &&
        candidate.origin.parentQuestionId === parent.id &&
        candidate.question.trim().replace(/\s+/gu, " ").toLocaleLowerCase() ===
          normalized,
    );
    if (existing) return existing;
    const goal = normalizeGoalIdentifier(input.goal);
    return repository.createQuestion({
      title: titleFor(input.question),
      verbatimQuestion: input.question,
      goals: [goal],
      tags: [
        "generated",
        ...(input.extraDetail ? ["extra-detail"] : []),
        ...(input.contradiction ? ["contradiction"] : []),
      ],
      asker: { id: "critic", acceptance: "pending" },
      origin: {
        kind: "generated",
        parentQuestionId: parent.id,
        findingId: `f-${ulid()}`,
        goal,
      },
      depth: parent.depth + 1,
      ...(input.contradiction ? { initialState: "active" as const } : {}),
      priority: {
        ...(input.contradiction ? { contradiction: true } : {}),
        ...(input.extraDetail ? { extraDetail: true } : {}),
      },
    });
  }

  async function ask(input: AskInput): Promise<AskResult> {
    const requestedGoals =
      input.goals.length > 0 ? input.goals : ["documentation"];
    const documented = requestedGoals.every((goal) => goal === "documentation")
      ? await documentation.answer(input.question)
      : undefined;
    if (documented) {
      return {
        kind: "answer",
        answer: documented.answer,
        citations: documented.citations,
        goalResults: requestedGoals.map((goal) => ({
          goal,
          status: "satisfied",
          rationale:
            "The cited repository documentation directly matches the question terms.",
        })),
      };
    }
    let partialAnswer: string | undefined;
    let partialCitations: Citation[] = [];
    let remainingGoals = requestedGoals;
    const agentRuntime = await selectedAgentRuntime();
    if (agentRuntime) {
      const context = await documentation.context();
      const librarian = LibrarianOutputSchema.parse(
        await agentRuntime.invoke("librarian", {
          question: input.question,
          ...(input.chat === undefined ? {} : { chat: input.chat }),
          goals: requestedGoals,
          documentation: context,
        }),
      );
      const knownDocuments = new Map(
        context.map((entry) => [entry.path, entry.content]),
      );
      const citations = librarian.citations
        .filter((citation) =>
          knownDocuments.get(citation.path)?.includes(citation.claim.trim()),
        )
        .map((citation) => ({ path: citation.path, excerpt: citation.claim }));
      if (
        librarian.status === "answered" &&
        librarian.unsatisfiedGoals.length === 0 &&
        librarian.answer.trim() &&
        citations.length > 0
      ) {
        return {
          kind: "answer",
          answer: librarian.answer.trim(),
          citations,
          goalResults: requestedGoals.map((goal) => ({
            goal,
            status: "satisfied",
            rationale:
              "The Librarian returned a schema-valid answer grounded in repository paths.",
          })),
        };
      }
      partialAnswer = librarian.answer.trim() || undefined;
      partialCitations = citations;
      const reportedUnsatisfied = new Set(librarian.unsatisfiedGoals);
      const narrowedGoals = requestedGoals.filter((goal) =>
        reportedUnsatisfied.has(goal),
      );
      if (narrowedGoals.length > 0) remainingGoals = narrowedGoals;
    }
    const normalized = input.question
      .trim()
      .replace(/\s+/gu, " ")
      .toLocaleLowerCase();
    const candidates = await repository.listQuestions();
    const existing =
      candidates.find(
        (record) =>
          record.question.trim().replace(/\s+/gu, " ").toLocaleLowerCase() ===
          normalized,
      ) ?? bestQuestionMatch(input.question, candidates);
    if (existing) {
      if (existing.state === "accepted") {
        const structured = await optionalDerived(
          repository,
          existing.id,
          "answers/structured.md",
        );
        if (structured?.trim()) {
          return {
            kind: "answer",
            answer: structured.trim(),
            citations: [
              {
                path: `docs/answers/${existing.id}.md`,
                title: existing.title,
              },
            ],
            goalResults: (input.goals.length > 0
              ? input.goals
              : existing.goals
            ).map((goal) => ({
              goal,
              status: "satisfied",
              rationale:
                "An accepted answer already exists for this exact question.",
            })),
          };
        }
      }
      const asker = humanIdentity(input.asker);
      const attached = await repository.attachMatchedAsk(existing.id, {
        verbatimQuestion: input.question,
        ...(input.chat === undefined ? {} : { chatlog: input.chat }),
        acceptanceGoals: remainingGoals,
        requestedGoals,
        asker: { ...asker, acceptance: "pending" },
        expectedRevision: existing.revision,
        by: "matcher",
      });
      if (attached.state === "deferred") {
        const promoted = await repository.transition(existing.id, {
          to: "active",
          expectedRevision: attached.revision,
          by: "matcher",
          details: { reason: "demand-promoted" },
        });
        const prioritized = await repository.overridePriority(existing.id, {
          tier: "P2",
          rationale:
            "A new raw question matched this deferred question and promoted it by demand.",
          expectedRevision: promoted.revision,
          by: "prioritizer",
        });
        return {
          kind: "logged",
          question: await detail(repository, prioritized, changeRequests),
          ...(partialAnswer ? { partialAnswer } : {}),
          ...(partialCitations?.length ? { citations: partialCitations } : {}),
        };
      }
      return {
        kind: "logged",
        question: await detail(repository, attached, changeRequests),
        ...(partialAnswer ? { partialAnswer } : {}),
        ...(partialCitations?.length ? { citations: partialCitations } : {}),
      };
    }

    const asker = humanIdentity(input.asker);
    const record = await repository.createQuestion({
      title: titleFor(input.question),
      verbatimQuestion: input.question,
      ...(input.chat === undefined ? {} : { chatlog: input.chat }),
      goals: remainingGoals,
      asker: { ...asker, acceptance: "pending" },
      origin: { kind: "raw" },
    });
    return {
      kind: "logged",
      question: await detail(repository, record, changeRequests),
      ...(partialAnswer ? { partialAnswer } : {}),
      ...(partialCitations?.length ? { citations: partialCitations } : {}),
    };
  }

  async function credentialStatus(id: string): Promise<ProviderStatus> {
    const description = credentials
      .descriptions()
      .find((candidate) => candidate.id === id);
    if (!description)
      throw new ServiceError(
        `Unknown provider ${id}`,
        404,
        "provider_not_found",
      );
    const states = await Promise.all(
      description.scopes.map((scope) =>
        credentials.status(description.id, scope),
      ),
    );
    const consentScopes = states.map((state, index) => ({
      scope: description.scopes[index]!,
      consent: state.consent,
      availability: state.availability,
      ...(state.reason ? { reason: state.reason } : {}),
    }));
    const required = states.some((state) => state.consent === "required");
    const denied = states.some(
      (state) => state.consent === "denied" || state.consent === "revoked",
    );
    const unavailable = states.find(
      (state) => state.availability === "unavailable",
    );
    const ready =
      states.length > 0 &&
      states.every((state) => state.availability === "available");
    return {
      id: description.id,
      name: description.label,
      kind: providerKind(description),
      state:
        required || denied
          ? "consent_required"
          : ready
            ? "ready"
            : "activation_required",
      source: description.kind,
      detail: required
        ? "Explicit personal consent is required before this source is inspected."
        : denied
          ? "Credential discovery consent is denied or revoked."
          : (unavailable?.reason ?? "The credential source is ready."),
      fakeAvailable: true,
      capabilities: [...description.scopes],
      consentScopes,
      ...(description.id in OAUTH_FLOWS ? { oauth: true as const } : {}),
      ...(ready
        ? {}
        : { activationChecklist: activationChecklist(description) }),
    };
  }

  async function oauthStart(
    id: string,
  ): Promise<{ authorizeUrl: string; state: string }> {
    const description = credentials
      .descriptions()
      .find((candidate) => candidate.id === id);
    if (!description) {
      throw new ServiceError(
        `Unknown provider ${id}`,
        404,
        "provider_not_found",
      );
    }
    let config;
    try {
      config = getOAuthFlow(id);
    } catch {
      throw new ServiceError(
        `${description.label} does not support browser OAuth sign-in.`,
        400,
        "oauth_not_supported",
      );
    }

    const existing = oauthSessions.get(id);
    if (
      existing?.phase === "pending" &&
      existing.authorizeUrl &&
      existing.state
    ) {
      return { authorizeUrl: existing.authorizeUrl, state: existing.state };
    }

    let resolvePresented!: (value: {
      authorizeUrl: string;
      state: string;
    }) => void;
    let rejectPresented!: (error: unknown) => void;
    const presented = new Promise<{ authorizeUrl: string; state: string }>(
      (resolve, reject) => {
        resolvePresented = resolve;
        rejectPresented = reject;
      },
    );

    const session: OAuthSession = {
      phase: "pending",
      flowPromise: Promise.resolve(),
      rejectStart: rejectPresented,
    };
    oauthSessions.set(id, session);

    const flowPromise = (async () => {
      let ownedListener: LoopbackListener | undefined;
      try {
        // Always own the listener so cancel/complete can close the HTTP server.
        const startListener =
          options.startOAuthListener ?? startLoopbackListener;
        ownedListener = await startListener({
          path: config.redirectPath,
          ...(config.fixedPort !== undefined
            ? { port: config.fixedPort }
            : {}),
          timeoutMs: 3 * 60 * 1000,
        });
        session.listener = ownedListener;
        const tokens: OAuthTokenSet = await runOAuthFlow({
          config,
          listener: ownedListener,
          ...(oauthFetch ? { fetch: oauthFetch } : {}),
          presentUrl: (url) => {
            const authorizeUrl = url;
            const state =
              new URL(authorizeUrl).searchParams.get("state") ?? "";
            session.authorizeUrl = authorizeUrl;
            session.state = state;
            delete session.rejectStart;
            resolvePresented({ authorizeUrl, state });
          },
        });
        await oauthTokenStore.set(id, tokens);
        session.phase = "complete";
        delete session.detail;
      } catch (error) {
        // Cancel deletes the session before closing; don't overwrite that.
        if (!oauthSessions.has(id)) return;
        if (session.phase === "pending") {
          session.phase = "error";
          if (error instanceof OAuthError) {
            session.detail = error.errorDescription ?? error.message;
          } else if (error instanceof Error) {
            // Loopback close during cancel surfaces a closed-listener error;
            // only keep it if the session is still tracked as pending.
            session.detail = error.message;
          } else {
            session.detail = "OAuth sign-in failed.";
          }
        }
        rejectPresented(error);
      } finally {
        if (ownedListener) {
          await ownedListener.close().catch(() => undefined);
          delete session.listener;
        }
      }
    })();
    session.flowPromise = flowPromise;
    void flowPromise.catch(() => undefined);

    try {
      return await presented;
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(
        error instanceof Error
          ? error.message
          : "OAuth sign-in failed to start.",
        500,
        "oauth_start_failed",
      );
    }
  }

  async function oauthStatus(id: string): Promise<{
    state: "idle" | "pending" | "complete" | "error";
    detail?: string;
    authorizeUrl?: string;
  }> {
    const description = credentials
      .descriptions()
      .find((candidate) => candidate.id === id);
    if (!description) {
      throw new ServiceError(
        `Unknown provider ${id}`,
        404,
        "provider_not_found",
      );
    }
    if (!(id in OAUTH_FLOWS)) {
      throw new ServiceError(
        `${description.label} does not support browser OAuth sign-in.`,
        400,
        "oauth_not_supported",
      );
    }
    const session = oauthSessions.get(id);
    if (!session) return { state: "idle" };
    return {
      state: session.phase,
      ...(session.detail ? { detail: session.detail } : {}),
      ...(session.authorizeUrl ? { authorizeUrl: session.authorizeUrl } : {}),
    };
  }

  async function oauthCancel(id: string): Promise<{ ok: true }> {
    const description = credentials
      .descriptions()
      .find((candidate) => candidate.id === id);
    if (!description) {
      throw new ServiceError(
        `Unknown provider ${id}`,
        404,
        "provider_not_found",
      );
    }
    if (!(id in OAUTH_FLOWS)) {
      throw new ServiceError(
        `${description.label} does not support browser OAuth sign-in.`,
        400,
        "oauth_not_supported",
      );
    }
    const session = oauthSessions.get(id);
    if (session?.phase === "pending") {
      oauthSessions.delete(id);
      session.rejectStart?.(
        new ServiceError(
          "OAuth sign-in was cancelled.",
          409,
          "oauth_cancelled",
        ),
      );
      delete session.rejectStart;
      if (session.listener) {
        await session.listener.close().catch(() => undefined);
        delete session.listener;
      }
      await session.flowPromise.catch(() => undefined);
    }
    return { ok: true };
  }

  async function allProviderStatuses(): Promise<ProviderStatus[]> {
    const external = await Promise.all(
      credentials
        .descriptions()
        .map((description) => credentialStatus(description.id)),
    );
    return [
      {
        id: "fake-llm",
        name: "Deterministic fake model",
        kind: "llm",
        state: "ready",
        source: "built-in",
        detail:
          "Runs locally with deterministic fixtures; no data leaves this machine.",
        fakeAvailable: true,
        capabilities: ["model", "agents"],
      },
      {
        id: "fake-stt",
        name: "Deterministic fake transcription",
        kind: "stt",
        state: "ready",
        source: "built-in",
        detail:
          "Exercises the full transcript workflow without microphone or network access.",
        fakeAvailable: true,
        capabilities: ["transcription", "streaming"],
      },
      {
        id: "fake-codec",
        name: "Deterministic fake codec",
        kind: "codec",
        state: "ready",
        source: "built-in",
        detail: "Copies test audio through the verified codec contract.",
        fakeAvailable: true,
        capabilities: ["ogg", "mp3"],
      },
      {
        id: "ffmpeg",
        name: "FFmpeg audio codec",
        kind: "codec",
        state:
          (await ffmpeg.status()).availability === "available"
            ? "ready"
            : "activation_required",
        source: "installed-client",
        detail:
          "Converts browser recordings to verified Ogg/Opus or MP3 files.",
        fakeAvailable: true,
        capabilities: ["ogg", "mp3"],
        activationChecklist: [
          "Install FFmpeg for this operating system",
          "Ensure `ffmpeg` is on PATH",
          "Run the provider capability test",
        ],
      },
      ...external,
    ];
  }

  async function transcribeOutput(
    id: string,
    output: { path: string; mimeType: "audio/ogg" | "audio/mpeg" },
  ): Promise<string> {
    const transcriptPath = `${output.path}.transcript.txt`;
    try {
      return await readFile(transcriptPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const merged = await settings.readMerged();
    const resolution = await providerRuntime.resolveStt(
      merged.effective.providers.stt,
    );
    if (resolution.state === "blocked") {
      throw new ServiceError(resolution.message, 409, "stt_unavailable");
    }
    const provider = resolution.provider;
    const bytes = await readFile(output.path);
    let transcript: string | undefined;
    for await (const event of provider.transcribe({
      sessionId: id,
      chunks: (async function* () {
        yield { sequence: 0, bytes, mimeType: output.mimeType };
      })(),
    })) {
      if (event.type === "failed") {
        throw new ServiceError(
          event.message,
          event.retryable ? 503 : 422,
          event.code,
        );
      }
      if (event.type === "completed") transcript = event.transcript;
    }
    if (!transcript) {
      throw new ServiceError(
        "The transcription provider completed without text.",
        502,
        "stt_incomplete",
      );
    }
    await writeFileAtomic(transcriptPath, transcript, {
      encoding: "utf8",
      mode: 0o600,
    });
    return transcript;
  }

  async function assertRealMediaSelected(): Promise<void> {
    if (options.allowFakeMedia) return;
    const merged = await settings.readMerged();
    if (
      merged.effective.providers.codec === "fake-codec" ||
      merged.effective.providers.stt === "fake-stt"
    ) {
      throw new ServiceError(
        "Select real codec and transcription providers before recording. Fake media contracts are available only in tests and explicit demo simulation.",
        409,
        "fake_media_selected",
      );
    }
  }

  async function agentStatuses(): Promise<AgentDefinitionStatus[]> {
    let names: string[];
    try {
      names = (await readdir(agentsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const fixtures = new Map(
      (await validateAgentFixtures(agentsRoot)).map((result) => [
        result.name,
        result,
      ]),
    );
    return Promise.all(
      names.map(async (name) => {
        try {
          const definition = await loadAgentDefinition(agentsRoot, name);
          const fixture = fixtures.get(name);
          return {
            id: name,
            label: name
              .split("-")
              .map(
                (part) =>
                  `${part[0]?.toLocaleUpperCase() ?? ""}${part.slice(1)}`,
              )
              .join(" "),
            role: definition.description,
            sourcePath: `agents/${name}/agent.md`,
            dynamic: true,
            freshContext: true,
            fixtureStatus: fixture?.valid ? "passing" : "failing",
            fixtureCount: fixture?.cases ?? 0,
            lastFixtureRunAt: new Date().toISOString(),
            schemaStatus: "valid",
            capabilities: [
              definition.inputPolicy,
              "structured-output",
              "fresh-context",
            ],
          } satisfies AgentDefinitionStatus;
        } catch (error) {
          return {
            id: name,
            label: name,
            role:
              error instanceof Error
                ? error.message
                : "Invalid agent definition",
            sourcePath: `agents/${name}/agent.md`,
            dynamic: true,
            freshContext: true,
            fixtureStatus: "failing",
            fixtureCount: fixtures.get(name)?.cases ?? 0,
            lastFixtureRunAt: new Date().toISOString(),
            schemaStatus: "invalid",
            capabilities: [],
          } satisfies AgentDefinitionStatus;
        }
      }),
    );
  }

  async function validateAgent(id: string): Promise<AgentFixtureResult> {
    if (!/^[a-z][a-z0-9-]*$/u.test(id)) {
      throw new ServiceError(`Invalid agent name ${id}`, 400, "invalid_agent");
    }
    const result = (await validateAgentFixtures(agentsRoot)).find(
      (candidate) => candidate.name === id,
    );
    if (!result)
      throw new ServiceError(
        `Agent ${id} was not found`,
        404,
        "agent_not_found",
      );
    return result;
  }

  function proposedAgentName(request: string): string {
    const words = request
      .toLocaleLowerCase()
      .match(/[a-z][a-z0-9]+/gu)
      ?.filter(
        (word) =>
          !["agent", "create", "that", "the", "with", "from"].includes(word),
      )
      .slice(0, 4) ?? ["new", "capability"];
    return words.join("-").slice(0, 64) || "new-capability";
  }

  async function currentAgentFiles(
    name: string,
  ): Promise<Array<{ path: string; content: string }>> {
    const root = join(agentsRoot, name);
    const relativePaths = ["agent.md", "schema.json"];
    const fixtureNames = await readdir(join(root, "fixtures"));
    relativePaths.push(
      ...fixtureNames.sort().map((file) => `fixtures/${file}`),
    );
    return Promise.all(
      relativePaths.map(async (path) => ({
        path: `agents/${name}/${path}`,
        content: await readFile(join(root, path), "utf8"),
      })),
    );
  }

  async function agentSmith(input: {
    mode: "create" | "update";
    request: string;
    target?: string;
  }) {
    const name =
      input.mode === "update" ? input.target : proposedAgentName(input.request);
    if (!name || !/^[a-z][a-z0-9-]*$/u.test(name)) {
      throw new ServiceError(
        "Choose a valid agent to update.",
        400,
        "invalid_agent",
      );
    }
    let files: Array<{ path: string; content: string }>;
    if (input.mode === "update") {
      try {
        await access(join(agentsRoot, name, "agent.md"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ServiceError(
            `Agent ${name} was not found.`,
            404,
            "agent_not_found",
          );
        }
        throw error;
      }
      files = await currentAgentFiles(name);
      const definition = files.find((file) => file.path.endsWith("/agent.md"));
      if (definition) {
        definition.content = `${definition.content.trimEnd()}\n\n## Proposed capability\n\n${input.request.trim()}\n`;
      }
    } else {
      try {
        await access(join(agentsRoot, name));
        throw new ServiceError(
          `Agent ${name} already exists; choose update instead.`,
          409,
          "agent_exists",
        );
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const schema = {
        type: "object",
        additionalProperties: false,
        required: ["result"],
        properties: { result: { type: "string", minLength: 1 } },
      };
      files = [
        {
          path: `agents/${name}/agent.md`,
          content: `---\nname: ${name}\ndescription: ${JSON.stringify(input.request.trim())}\ninputPolicy: agent-smith\nmaxAttempts: 2\n---\n\n${input.request.trim()}\n\nReturn only the narrow, schema-valid result. Never receive or infer credentials.\n`,
        },
        {
          path: `agents/${name}/schema.json`,
          content: `${JSON.stringify(schema, null, 2)}\n`,
        },
      ];
      for (let fixture = 1; fixture <= 3; fixture += 1) {
        const ordinal = String(fixture).padStart(3, "0");
        files.push(
          {
            path: `agents/${name}/fixtures/${ordinal}-input.json`,
            content: `${JSON.stringify(
              {
                request: `Fixture ${fixture}: ${input.request.trim()}`,
                constraints: [
                  "deterministic",
                  "no secrets",
                  "structured output",
                ],
              },
              null,
              2,
            )}\n`,
          },
          {
            path: `agents/${name}/fixtures/${ordinal}-expected.json`,
            content: `${JSON.stringify({ result: `Fixture ${fixture} result` }, null, 2)}\n`,
          },
        );
      }
    }
    const key = `agent-${name}-${ulid().slice(-8).toLocaleLowerCase()}`;
    const changeRequest = await changeRequests.create({
      questionId: key,
      title: `Agent-Smith: ${name}`,
      question: input.request,
      verbatimChat: "",
      goals: ["agent-maintenance"],
      structuredAnswer: `Agent-Smith proposes ${files.length} reviewed files for ${name}.`,
      summary: `${input.mode === "create" ? "Creates" : "Updates"} ${name} with source, a strict schema, and golden fixtures.`,
      files,
    });
    return {
      agent: name,
      changeRequest: changeRequestInfo(changeRequest) as ChangeRequestInfo,
    };
  }

  return {
    goals: { list: async () => configuredGoals.map((goal) => ({ ...goal })) },
    ask,
    questions: {
      list: async (query: QuestionQuery) => {
        const needle = query.q?.trim().toLocaleLowerCase();
        const records = await repository.listQuestions({
          ...(query.bucket ? { bucket: query.bucket } : {}),
        });
        return records
          .filter((record) => !query.tier || record.tier === query.tier)
          .filter(
            (record) =>
              !needle ||
              `${record.title} ${record.question} ${record.goals.join(" ")} ${record.tags.join(" ")}`
                .toLocaleLowerCase()
                .includes(needle),
          )
          .map(summary);
      },
      get: async (id) => {
        try {
          return await getDetail(id);
        } catch (error) {
          if (error instanceof ServiceError && error.statusCode === 404)
            return undefined;
          throw error;
        }
      },
      claim: async (id, answerer) => {
        try {
          const record = await getRecord(id);
          const answererId = humanIdentity(answerer).id;
          if (record.state === "in-answer") {
            const claimedBy = currentAnswerer(record);
            if (claimedBy !== answererId) {
              throw new ServiceError(
                claimedBy
                  ? `Question ${id} is already claimed by ${claimedBy}.`
                  : `Question ${id} is already claimed.`,
                409,
                "question_already_claimed",
              );
            }
            return detail(repository, record, changeRequests);
          }
          const updated = await repository.transition(id, {
            to: "in-answer",
            expectedRevision: record.revision,
            by: `answerer:${answererId}`,
          });
          return detail(repository, updated, changeRequests);
        } catch (error) {
          return serviceError(error);
        }
      },
      setPriority: async (id, tier: PriorityTier, rationale, by) => {
        try {
          const record = await getRecord(id);
          return detail(
            repository,
            await repository.overridePriority(id, {
              tier,
              rationale,
              expectedRevision: record.revision,
              by: `maintainer:${humanIdentity(by).id}`,
            }),
            changeRequests,
          );
        } catch (error) {
          return serviceError(error);
        }
      },
      addTranscript: async (id, input) => {
        try {
          const record = await getRecord(id);
          if (record.state !== "in-answer") {
            throw new ServiceError(
              "Claim the question before adding a transcript.",
              409,
              "invalid_transition",
            );
          }
          const artifact = await repository.appendRawArtifact(id, {
            kind: input.kind ?? "transcript",
            content: input.text,
          });
          const prior = await transcriptMetadata(repository, id);
          const current = await getRecord(id);
          const updated = await repository.writeDerived(
            id,
            "answers/transcripts.json",
            `${JSON.stringify(
              [
                ...prior,
                {
                  path: artifact.path,
                  source: input.source,
                  ...(input.confidence === undefined
                    ? {}
                    : { confidence: input.confidence }),
                },
              ],
              null,
              2,
            )}\n`,
            { expectedRevision: current.revision, by: "transcript-store" },
          );
          return detail(repository, updated, changeRequests);
        } catch (error) {
          return serviceError(error);
        }
      },
      structure: async (id) => {
        try {
          const record = await getRecord(id);
          const artifacts = (await repository.listRawArtifacts(id)).filter(
            (artifact) =>
              artifact.kind === "transcript" || artifact.kind === "correction",
          );
          if (artifacts.length === 0) {
            throw new ServiceError(
              "At least one transcript is required.",
              409,
              "transcript_required",
            );
          }
          const rawInputs = await Promise.all(
            artifacts.map(async (artifact) => ({
              kind: artifact.kind,
              text: (
                await repository.readRawArtifact(id, artifact.path)
              ).trim(),
            })),
          );
          const runtime = await selectedAgentRuntime();
          const text = runtime
            ? renderStructuredAnswer(
                StructurerOutputSchema.parse(
                  await runtime.invoke("structurer", {
                    question: record.question,
                    goals: record.goals,
                    transcripts: rawInputs
                      .filter((input) => input.kind === "transcript")
                      .map((input) => input.text),
                    corrections: rawInputs
                      .filter((input) => input.kind === "correction")
                      .map((input) => input.text),
                  }),
                ),
              )
            : rawInputs
                .map((input) => input.text)
                .filter(Boolean)
                .join("\n\n");
          const updated = await repository.writeDerived(
            id,
            "answers/structured.md",
            `${text}\n`,
            {
              expectedRevision: record.revision,
              by: "structurer",
            },
          );
          return detail(repository, updated, changeRequests);
        } catch (error) {
          return serviceError(error);
        }
      },
      critic: async (id) => {
        try {
          const record = await getRecord(id);
          const structured = await optionalDerived(
            repository,
            id,
            "answers/structured.md",
          );
          if (!structured?.trim()) {
            throw new ServiceError(
              "Structure the answer before running the critic.",
              409,
              "answer_required",
            );
          }
          const runtime = await selectedAgentRuntime();
          if (!runtime) {
            throw new ServiceError(
              "The deterministic fake model is available for demos and tests, but cannot authorize a Critic evaluation. Select a production model provider.",
              409,
              "llm_unavailable",
            );
          }
          let evaluation: NonNullable<QuestionDetail["evaluation"]>;
          {
            const output = CriticOutputSchema.parse(
              await runtime.invoke("critic", {
                question: record.question,
                goals: record.goals,
                structuredAnswer: structured,
                documentation: await documentation.context(),
              }),
            );
            const deferredChildren = await Promise.all(
              output.deferredQuestions.map((child) =>
                ensureGeneratedChild(record, {
                  question: child.question,
                  goal: child.goal,
                  extraDetail: child.extraDetail,
                }),
              ),
            );
            await Promise.all(
              output.contradictions.map((contradiction) =>
                ensureGeneratedChild(record, {
                  question: `Resolve contradiction: ${contradiction}`,
                  goal: record.goals[0] ?? "documentation",
                  contradiction: true,
                }),
              ),
            );
            evaluation = criticEvaluation(
              output,
              deferredChildren.map(summary),
              record.goals,
            );
          }
          const updated = await repository.writeDerived(
            id,
            "answers/evaluation.json",
            `${JSON.stringify(evaluation, null, 2)}\n`,
            { expectedRevision: record.revision, by: "critic" },
          );
          return detail(repository, updated, changeRequests);
        } catch (error) {
          return serviceError(error);
        }
      },
      integrate: async (id) => {
        try {
          const record = await getRecord(id);
          const evaluation = await optionalDerived(
            repository,
            id,
            "answers/evaluation.json",
          );
          if (
            !evaluation ||
            !(JSON.parse(evaluation) as { done?: boolean }).done
          ) {
            throw new ServiceError(
              "A clean critic evaluation is required.",
              409,
              "evaluation_required",
            );
          }
          const structured = await optionalDerived(
            repository,
            id,
            "answers/structured.md",
          );
          if (!structured?.trim()) {
            throw new ServiceError(
              "A structured answer is required.",
              409,
              "answer_required",
            );
          }
          const runtime = await selectedAgentRuntime();
          const activeChangeRequest =
            await changeRequests.getActiveForQuestion(id);
          const artifacts = await repository.listRawArtifacts(id);
          const chatArtifacts = artifacts.filter(
            (artifact) => artifact.kind === "chatlog",
          );
          const verbatimChat = (
            await Promise.all(
              chatArtifacts.map((artifact) =>
                repository.readRawArtifact(id, artifact.path),
              ),
            )
          ).join("\n");
          let files =
            activeChangeRequest?.evaluationInputState === "complete"
              ? (activeChangeRequest.proposedFiles ?? undefined)
              : undefined;
          let integrationSummary = activeChangeRequest?.summary;
          if (
            !activeChangeRequest ||
            activeChangeRequest.evaluationInputState !== "complete"
          ) {
            if (runtime) {
              const plan = IntegratorOutputSchema.parse(
                await runtime.invoke("integrator", {
                  question: record.question,
                  goals: record.goals,
                  structuredAnswer: structured,
                  documentationIndex: await documentation.context(),
                }),
              );
              files = plan.edits.map((edit) => ({
                path: edit.path,
                content: edit.content,
              }));
              if (
                files.some(
                  (file) =>
                    !file.path.startsWith("docs/") ||
                    file.path.split(/[\\/]/u).includes(".."),
                )
              ) {
                throw new ServiceError(
                  "The Integrator proposed a path outside docs/.",
                  422,
                  "unsafe_integration_path",
                );
              }
              integrationSummary = plan.rationale;
            }
          }
          let changeRequest = await changeRequests.ensureCurrent({
            questionId: id,
            title: record.title,
            question: record.question,
            verbatimChat,
            goals: [...record.goals],
            structuredAnswer: structured,
            ...(files ? { files } : {}),
            ...(integrationSummary ? { summary: integrationSummary } : {}),
          });
          if (!changeRequest) {
            throw new ServiceError(
              "The change request was not created.",
              500,
              "change_request_missing",
            );
          }

          if (runtime) {
            const reviewTarget = changeRequest;
            const actualDiffCheckIds = [
              "reviewer",
              "diff-summary",
              "simulated-asker",
            ];
            const actualDiffChecksPassed = actualDiffCheckIds.every((checkId) =>
              reviewTarget.checks.some(
                (check) => check.id === checkId && check.status === "passed",
              ),
            );
            if (!actualDiffChecksPassed) {
              const reviewerRuntime = await selectedAgentRuntime();
              const diffSummarizerRuntime = await selectedAgentRuntime();
              const simulatedAskerRuntime = await selectedAgentRuntime();
              if (
                !reviewerRuntime ||
                !diffSummarizerRuntime ||
                !simulatedAskerRuntime
              ) {
                throw new ServiceError(
                  "The selected model became unavailable during actual-diff review.",
                  409,
                  "llm_unavailable",
                );
              }
              if (reviewTarget.structuredAnswer === undefined) {
                throw new ServiceError(
                  "The change request does not contain its stored structured-answer input; recreate it before review.",
                  409,
                  "change_request_input_missing",
                );
              }
              const reviewer = ReviewerOutputSchema.parse(
                await reviewerRuntime.invoke("reviewer", {
                  question: reviewTarget.verbatimQuestion,
                  goals: reviewTarget.goals,
                  structuredAnswer: reviewTarget.structuredAnswer,
                  diff: reviewTarget.diff,
                }),
              );
              const diffSummary = DiffSummarizerOutputSchema.parse(
                await diffSummarizerRuntime.invoke("diff-summarizer", {
                  diff: reviewTarget.diff,
                }),
              );
              const simulatedAsker = SimulatedAskerOutputSchema.parse(
                await simulatedAskerRuntime.invoke("simulated-asker", {
                  verbatimQuestion: reviewTarget.verbatimQuestion,
                  verbatimChat: reviewTarget.verbatimChat,
                  goals: reviewTarget.goals,
                  postDiffDocumentation:
                    await changeRequests.readPostDiffDocumentation(
                      reviewTarget.id,
                    ),
                }),
              );
              changeRequest = await changeRequests.recordActualDiffChecks(
                reviewTarget.id,
                {
                  reviewer,
                  diffSummary,
                  simulatedAsker,
                },
              );
            }
          }
          if (changeRequest.state === "blocked") {
            const failed = changeRequest.checks
              .filter((check) => check.status === "failed")
              .map((check) => check.detail)
              .join(" ");
            throw new ServiceError(
              failed || "Change-request checks did not pass.",
              409,
              "integration_review_failed",
            );
          }
          const updated = await repository.transition(id, {
            to: "integrating",
            expectedRevision: record.revision,
            by: "integrator",
          });
          return detail(repository, updated, changeRequests);
        } catch (error) {
          return serviceError(error);
        }
      },
      approveChangeRequest: async (id, input) => {
        try {
          const request = await changeRequests.getActiveForQuestion(id);
          if (!request) {
            throw new ServiceError(
              `Question ${id} has no change request.`,
              404,
              "change_request_not_found",
            );
          }
          await changeRequests.approve(request.id, {
            ...input,
            by: humanIdentity(input.by).id,
          });
          return getDetail(id);
        } catch (error) {
          return serviceError(error);
        }
      },
      mergeChangeRequest: async (id, by) => {
        try {
          const request = await changeRequests.getActiveForQuestion(id);
          if (!request) {
            throw new ServiceError(
              `Question ${id} has no change request.`,
              404,
              "change_request_not_found",
            );
          }
          const mergedSettings = await settings.readMerged();
          const byId = humanIdentity(by).id;
          await changeRequests.merge(request.id, {
            by: byId,
            checkpointManagedState: mergedSettings.effective.checkpointCommits,
          });
          const record = await getRecord(id);
          const updated = await repository.transition(id, {
            to: "merged",
            expectedRevision: record.revision,
            by: `maintainer:${byId}`,
          });
          if (mergedSettings.effective.checkpointCommits) {
            await changeRequests.checkpointManagedState(
              `chore: record ${id} merged lifecycle`,
            );
          }
          return detail(repository, updated, changeRequests);
        } catch (error) {
          return serviceError(error);
        }
      },
      accept: async (id, asker) => {
        try {
          const record = await getRecord(id);
          const askerId = humanIdentity(asker).id;
          const decided = await repository.decideAsker(id, {
            askerId,
            decision: "accepted",
            expectedRevision: record.revision,
            by: `asker:${askerId}`,
          });
          const updated =
            decided.state === "merged" &&
            askerDecisionSummary(decided.askers) === "accepted"
              ? await repository.transition(id, {
                  to: "accepted",
                  expectedRevision: decided.revision,
                  by: `asker:${askerId}`,
                })
              : decided;
          return detail(repository, updated, changeRequests);
        } catch (error) {
          return serviceError(error);
        }
      },
      reject: async (id, asker, reason) => {
        try {
          const askerId = humanIdentity(asker).id;
          const updated = await repository.rejectAsker(id, {
            askerId,
            reason,
            by: `asker:${askerId}`,
          });
          return detail(repository, updated, changeRequests);
        } catch (error) {
          if (
            error instanceof Error &&
            (/only an attached asker may reject a merged answer/i.test(
              error.message,
            ) ||
              /only pending askers may decide/i.test(error.message))
          ) {
            throw new ServiceError(
              error.message,
              409,
              "asker_decision_unavailable",
            );
          }
          return serviceError(error);
        }
      },
    },
    settings: {
      schema: defaults.settings.schema,
      values: async () => {
        const merged = await settings.readMerged();
        const values: SettingValue[] = [
          {
            key: "identity.actorHandle",
            value: merged.personal.identity.actorHandle,
            scope: "personal",
            source: "personal",
          },
          {
            key: "server.maintenance",
            value: merged.effective.maintenance.enabled,
            scope: "repo",
            source: "repo",
          },
          {
            key: "server.pollIntervalMinutes",
            value: merged.effective.maintenance.pollIntervalMinutes,
            scope: "repo",
            source: "repo",
          },
          {
            key: "review.mode",
            value: merged.effective.integrationMode,
            scope: "repo",
            source: "repo",
          },
          {
            key: "review.acceptTimeoutDays",
            value: merged.effective.acceptanceTimeoutDays,
            scope: "repo",
            source: "repo",
          },
          {
            key: "review.checkpointCommits",
            value: merged.effective.checkpointCommits,
            scope: "repo",
            source: "repo",
          },
          {
            key: "appearance.theme",
            value: merged.personal.appearance.theme,
            scope: "personal",
            source: "personal",
          },
          {
            key: "appearance.reducedMotion",
            value: merged.personal.appearance.reducedMotion,
            scope: "personal",
            source: "personal",
          },
          {
            key: "audio.preferredFormat",
            value: merged.personal.audio.preferredFormat,
            scope: "personal",
            source: "personal",
          },
          {
            key: "audio.keepConvertedAudio",
            value: merged.personal.audio.keepConvertedAudio,
            scope: "personal",
            source: "personal",
          },
          ...(["llm", "stt", "codec", "gitHost"] as const).map((kind) => ({
            key: `providers.${kind}`,
            value: merged.effective.providers[kind] ?? "fake-git-host",
            scope: "repo" as const,
            source: "repo" as const,
          })),
        ];
        return values;
      },
      set: async (key, value, scope: SettingScope) => {
        const descriptor = (await defaults.settings.schema()).find(
          (item) => item.key === key,
        );
        if (!descriptor)
          throw new ServiceError(
            `Unknown setting ${key}`,
            404,
            "setting_not_found",
          );
        if (descriptor.scope !== scope) {
          throw new ServiceError(
            `${key} belongs to ${descriptor.scope} scope`,
            400,
            "invalid_scope",
          );
        }
        if (scope === "repo") {
          const project = await settings.readProject();
          if (key === "server.maintenance") {
            await settings.writeProject({
              ...project,
              maintenance: { ...project.maintenance, enabled: Boolean(value) },
            });
          } else if (key === "server.pollIntervalMinutes") {
            await settings.writeProject({
              ...project,
              maintenance: {
                ...project.maintenance,
                pollIntervalMinutes: value,
              },
            });
          } else if (key === "review.mode") {
            await settings.writeProject({ ...project, integrationMode: value });
          } else if (key === "review.acceptTimeoutDays") {
            await settings.writeProject({
              ...project,
              acceptanceTimeoutDays: value,
            });
          } else if (key === "review.checkpointCommits") {
            await settings.writeProject({
              ...project,
              checkpointCommits: value,
            });
          } else if (key.startsWith("providers.")) {
            const kind = key.slice("providers.".length) as
              "llm" | "stt" | "codec" | "gitHost";
            await settings.writeProject({
              ...project,
              providers: { ...project.providers, [kind]: value },
            });
          }
        } else {
          const personal = await settings.readPersonal();
          if (key === "identity.actorHandle") {
            await settings.writePersonal({
              ...personal,
              identity: {
                ...personal.identity,
                actorHandle: ActorHandleSchema.parse(value),
              },
            });
          } else if (key === "appearance.theme") {
            await settings.writePersonal({
              ...personal,
              appearance: { ...personal.appearance, theme: value },
            });
          } else if (key === "appearance.reducedMotion") {
            await settings.writePersonal({
              ...personal,
              appearance: { ...personal.appearance, reducedMotion: value },
            });
          } else if (key === "audio.preferredFormat") {
            await settings.writePersonal({
              ...personal,
              audio: { ...personal.audio, preferredFormat: value },
            });
          } else if (key === "audio.keepConvertedAudio") {
            await settings.writePersonal({
              ...personal,
              audio: { ...personal.audio, keepConvertedAudio: value },
            });
          }
        }
        return { key, value, scope, source: scope };
      },
    },
    providers: {
      list: allProviderStatuses,
      consent: async (id, scope, granted) => {
        const description = credentials
          .descriptions()
          .find((candidate) => candidate.id === id);
        if (!description) {
          if (id.startsWith("fake-")) {
            const provider = (await allProviderStatuses()).find(
              (provider) => provider.id === id,
            );
            if (!provider)
              throw new ServiceError(
                `Unknown provider ${id}`,
                404,
                "provider_not_found",
              );
            if (!provider.capabilities.includes(scope))
              throw new ServiceError(
                `${provider.name} does not advertise the ${scope} scope.`,
                400,
                "unsupported_provider_scope",
              );
            return provider;
          }
          throw new ServiceError(
            `Unknown provider ${id}`,
            404,
            "provider_not_found",
          );
        }
        if (!description.scopes.includes(scope))
          throw new ServiceError(
            `${description.label} does not advertise the ${scope} scope.`,
            400,
            "unsupported_provider_scope",
          );
        await credentials.setConsent(
          id,
          scope,
          granted ? "granted" : "revoked",
        );
        return credentialStatus(id);
      },
      connect: credentialStatus,
      disconnect: async (id, scope) => {
        const description = credentials
          .descriptions()
          .find((candidate) => candidate.id === id);
        if (!description)
          throw new ServiceError(
            `Unknown provider ${id}`,
            404,
            "provider_not_found",
          );
        if (!description.scopes.includes(scope))
          throw new ServiceError(
            `${description.label} does not advertise the ${scope} scope.`,
            400,
            "unsupported_provider_scope",
          );
        await credentials.setConsent(id, scope, "revoked");
        return credentialStatus(id);
      },
      test: async (id) => {
        const provider = id.startsWith("fake-")
          ? (await allProviderStatuses()).find(
              (candidate) => candidate.id === id,
            )
          : await credentialStatus(id);
        if (!provider)
          throw new ServiceError(
            `Unknown provider ${id}`,
            404,
            "provider_not_found",
          );
        return provider.state === "ready"
          ? {
              ok: true,
              detail: `${provider.name} passed its consent and availability check.`,
            }
          : { ok: false, detail: `${provider.name} is ${provider.state}.` };
      },
      oauthStart,
      oauthStatus,
      oauthCancel,
    },
    agents: {
      list: agentStatuses,
      validate: validateAgent,
      propose: agentSmith,
    },
    changeRequests: {
      list: async () =>
        (await changeRequests.list()).map(
          (record) => changeRequestInfo(record) as ChangeRequestInfo,
        ),
      get: async (id) => changeRequestInfo(await changeRequests.get(id)),
      approve: async (id, input) => {
        try {
          return changeRequestInfo(
            await changeRequests.approve(id, {
              ...input,
              by: humanIdentity(input.by).id,
            }),
          ) as ChangeRequestInfo;
        } catch (error) {
          return serviceError(error);
        }
      },
      merge: async (id, by) => {
        try {
          return changeRequestInfo(
            await changeRequests.merge(id, { by: humanIdentity(by).id }),
          ) as ChangeRequestInfo;
        } catch (error) {
          return serviceError(error);
        }
      },
    },
    audio: {
      create: async ({ questionId }) => {
        const question = await getRecord(questionId);
        if (question.state !== "in-answer") {
          throw new ServiceError(
            "Claim the question before starting an audio session.",
            409,
            "claim_required",
          );
        }
        await assertRealMediaSelected();
        const id = `aud-${ulid()}`;
        const session = await audio.start({ sessionId: id, questionId });
        return { id: session.id, state: session.state };
      },
      append: async (id, sequence, bytes) => {
        try {
          const result = await audio.appendChunk(id, {
            sequence,
            bytes,
            mimeType: "application/octet-stream",
          });
          return { sequence: result.sequence, durableBytes: result.bytes };
        } catch (error) {
          return serviceError(error);
        }
      },
      finalize: async (id) => {
        try {
          const merged = await settings.readMerged();
          await assertRealMediaSelected();
          const codecResolution = await providerRuntime.resolveCodec(
            merged.effective.providers.codec,
          );
          if (codecResolution.state === "blocked") {
            throw new ServiceError(
              codecResolution.message,
              409,
              "codec_unavailable",
            );
          }
          const session = await audio.finalize(id, {
            codec: codecResolution.provider,
            targetFormat: merged.effective.audio.preferredFormat,
          });
          const transcript = session.output
            ? await transcribeOutput(id, session.output)
            : undefined;
          if (session.output && !merged.effective.audio.keepConvertedAudio) {
            await rm(session.output.path, { force: true });
          }
          return {
            id: session.id,
            state: session.state === "complete" ? "ready" : session.state,
            chunks: session.chunks.length,
            ...(session.output && merged.effective.audio.keepConvertedAudio
              ? { path: session.output.path }
              : {}),
            ...(transcript ? { transcript } : {}),
          };
        } catch (error) {
          return serviceError(error);
        }
      },
    },
    maintenance: {
      list: async () => maintenanceTasks("list"),
      run: async () => {
        await timeoutSilentAskers();
        return maintenanceTasks("run");
      },
    },
  };
}
