import { ulid } from "ulid";
import type {
  AskResult,
  ChangeRequestInfo,
  GoalDefinition,
  GoalResult,
  MaintenanceTask,
  PriorityTier,
  ProviderStatus,
  QuestionDetail,
  QuestionSummary,
  SettingDescriptor,
  SettingScope,
  SettingValue,
} from "../shared/index.js";
import {
  ServiceError,
  type AskInput,
  type QuestionQuery,
  type UltradynServices,
} from "./services.js";

const goals: GoalDefinition[] = [
  {
    id: "implementation",
    label: "Implementation",
    description:
      "Enough concrete behavior and constraints to build the system.",
    criteria:
      "Names inputs, outputs, invariants, failure behavior, and verification steps.",
  },
  {
    id: "api-integration",
    label: "API integration",
    description: "Enough contract detail to integrate another system.",
    criteria:
      "Names authentication, request/response shapes, errors, limits, and a test path.",
  },
  {
    id: "security-review",
    label: "Security review",
    description: "Enough trust-boundary and threat detail to review risk.",
    criteria:
      "Names assets, actors, boundaries, abuse cases, mitigations, and residual risk.",
  },
  {
    id: "complexity-analysis",
    label: "Complexity analysis",
    description: "Enough detail to reason about resource growth.",
    criteria:
      "States the relevant variables and time, space, network, and operational costs.",
  },
  {
    id: "documentation",
    label: "Documentation",
    description: "A clear, cited explanation for a reader.",
    criteria:
      "Answers the exact question, defines project terms, and cites authoritative repository sources.",
  },
  {
    id: "onboarding",
    label: "Onboarding",
    description: "Enough context for a new contributor to act safely.",
    criteria:
      "Provides prerequisites, a happy path, verification, and recovery from common errors.",
  },
];

const settingSchema: SettingDescriptor[] = [
  {
    key: "identity.actorHandle",
    category: "Identity & attribution",
    label: "Actor handle",
    description:
      "Stable personal handle recorded on local claims and approvals for attribution, not authentication.",
    type: "string",
    scope: "personal",
    default: "",
  },
  {
    key: "server.maintenance",
    category: "Server",
    label: "Maintenance mode",
    description:
      "Poll configured Git hosts and expose the maintenance work queue.",
    type: "boolean",
    scope: "repo",
    default: false,
  },
  {
    key: "server.pollIntervalMinutes",
    category: "Server",
    label: "Maintenance poll interval",
    description:
      "Minutes between Git-host checks while maintainer mode is enabled.",
    type: "number",
    scope: "repo",
    default: 15,
    restartRequired: true,
  },
  {
    key: "review.mode",
    category: "Review",
    label: "Merge mode",
    description:
      "Require a full change-request review or permit explicit summary approval after clean checks.",
    type: "select",
    scope: "repo",
    default: "manual",
    options: [
      { value: "manual", label: "Manual" },
      { value: "auto", label: "Clean checks + summary approval" },
    ],
  },
  {
    key: "review.acceptTimeoutDays",
    category: "Review",
    label: "Asker timeout",
    description:
      "Days before an unanswered acceptance request becomes a recorded timeout acceptance.",
    type: "number",
    scope: "repo",
    default: 14,
  },
  {
    key: "review.checkpointCommits",
    category: "Review",
    label: "Checkpoint lifecycle state",
    description:
      "Commit managed question state before merging a local documentation change.",
    type: "boolean",
    scope: "repo",
    default: true,
  },
  {
    key: "appearance.theme",
    category: "Appearance",
    label: "Color theme",
    description:
      "Use the operating-system theme or force a light or dark interface.",
    type: "select",
    scope: "personal",
    default: "system",
    options: [
      { value: "system", label: "System" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
  },
  {
    key: "appearance.reducedMotion",
    category: "Appearance",
    label: "Reduce motion",
    description:
      "Minimize decorative animation in addition to operating-system preferences.",
    type: "boolean",
    scope: "personal",
    default: false,
  },
  {
    key: "audio.preferredFormat",
    category: "Audio",
    label: "Converted audio format",
    description:
      "Format used after browser chunks are durably joined and verified.",
    type: "select",
    scope: "personal",
    default: "ogg",
    options: [
      { value: "ogg", label: "Ogg / Opus" },
      { value: "mp3", label: "MP3" },
    ],
  },
  {
    key: "audio.keepConvertedAudio",
    category: "Audio",
    label: "Keep converted audio",
    description:
      "Retain the verified compressed recording beside its local transcript.",
    type: "boolean",
    scope: "personal",
    default: true,
  },
  {
    key: "providers.llm",
    category: "Providers",
    label: "Agent model source",
    description:
      "Credential/delegation source used for generative agents; fake remains fully functional offline.",
    type: "select",
    scope: "repo",
    default: "fake-llm",
    options: [
      { value: "fake-llm", label: "Deterministic fake" },
      { value: "codex-cli", label: "Codex / ChatGPT sign-in" },
      { value: "grok-auth-file", label: "Grok client sign-in" },
      { value: "xai-oauth", label: "xAI OAuth sign-in" },
      { value: "openai-oauth", label: "ChatGPT OAuth sign-in" },
      { value: "xai-env", label: "XAI_API_KEY" },
      { value: "openai-env", label: "OPENAI_API_KEY" },
      { value: "claude-cli", label: "Claude CLI sign-in" },
      { value: "opencode-cli", label: "OpenCode CLI sign-in" },
    ],
  },
  {
    key: "providers.stt",
    category: "Providers",
    label: "Speech-to-text source",
    description:
      "Source used after audio conversion. Consent is managed separately and never committed.",
    type: "select",
    scope: "repo",
    default: "fake-stt",
    options: [
      { value: "fake-stt", label: "Deterministic fake" },
      { value: "grok-auth-file", label: "Grok client sign-in" },
      { value: "xai-oauth", label: "xAI OAuth sign-in" },
      { value: "xai-env", label: "XAI_API_KEY" },
      { value: "openai-env", label: "OPENAI_API_KEY" },
    ],
  },
  {
    key: "providers.codec",
    category: "Providers",
    label: "Audio codec",
    description:
      "Use FFmpeg for real browser audio or the deterministic fake in tests.",
    type: "select",
    scope: "repo",
    default: "fake-codec",
    options: [
      { value: "fake-codec", label: "Deterministic fake" },
      { value: "ffmpeg", label: "FFmpeg" },
    ],
  },
  {
    key: "providers.gitHost",
    category: "Providers",
    label: "Remote Git host",
    description:
      "Optional publication and maintenance polling source; local change requests remain complete.",
    type: "select",
    scope: "repo",
    default: "fake-git-host",
    options: [
      { value: "fake-git-host", label: "Local only" },
      { value: "github-cli", label: "GitHub CLI delegation" },
    ],
  },
];

function copy<T>(value: T): T {
  return structuredClone(value);
}

function markDemoOAuthComplete(provider: ProviderStatus): void {
  provider.state = "consent_required";
  provider.detail =
    "Simulated OAuth sign-in completed; grant scoped consent next.";
  if (provider.consentScopes) {
    provider.consentScopes = provider.consentScopes.map((scope) => ({
      scope: scope.scope,
      consent: scope.consent,
      availability: "available" as const,
    }));
  }
  delete provider.activationChecklist;
}

export function createDemoServices(): UltradynServices {
  const questions = new Map<string, QuestionDetail>();
  const settings = new Map<string, SettingValue>();
  const oauthSessions = new Map<
    string,
    {
      state: "pending" | "complete" | "error";
      authorizeUrl?: string;
      detail?: string;
      completeAt?: number;
    }
  >();
  const demoOAuthIds = new Set(["xai-oauth", "openai-oauth"]);

  const providers = new Map<string, ProviderStatus>([
    [
      "fake",
      {
        id: "fake",
        name: "Deterministic demo",
        kind: "llm",
        state: "ready",
        detail: "Local deterministic provider. No data leaves this machine.",
        fakeAvailable: true,
        capabilities: ["chat", "agents", "streaming-stt"],
      },
    ],
    [
      "xai-oauth",
      {
        id: "xai-oauth",
        name: "xAI OAuth (simulated)",
        kind: "llm",
        state: "activation_required",
        detail:
          "Simulated browser OAuth sign-in for demo mode; no network calls are made.",
        fakeAvailable: true,
        oauth: true,
        capabilities: ["model", "transcription"],
        consentScopes: [
          {
            scope: "model",
            consent: "required",
            availability: "unavailable",
            reason: "Simulated OAuth sign-in has not completed.",
          },
          {
            scope: "transcription",
            consent: "required",
            availability: "unavailable",
            reason: "Simulated OAuth sign-in has not completed.",
          },
        ],
        activationChecklist: [
          "Complete the browser sign-in from this page",
          "Grant scoped discovery consent here",
          "Run the provider capability test before selection",
        ],
      },
    ],
    [
      "openai-oauth",
      {
        id: "openai-oauth",
        name: "ChatGPT OAuth (simulated)",
        kind: "llm",
        state: "activation_required",
        detail:
          "Simulated ChatGPT OAuth sign-in for demo mode; model scope only.",
        fakeAvailable: true,
        oauth: true,
        capabilities: ["model"],
        consentScopes: [
          {
            scope: "model",
            consent: "required",
            availability: "unavailable",
            reason: "Simulated OAuth sign-in has not completed.",
          },
        ],
        activationChecklist: [
          "Complete the browser sign-in from this page",
          "Grant scoped discovery consent here",
          "Run the provider capability test before selection",
        ],
      },
    ],
    [
      "codex",
      {
        id: "codex",
        name: "Codex CLI",
        kind: "llm",
        state: "consent_required",
        detail:
          "Delegates to the installed Codex client; its credential store is never read.",
        fakeAvailable: true,
        capabilities: ["chat", "agents"],
        consentScopes: [
          {
            scope: "model",
            consent: "required",
            availability: "unknown",
          },
        ],
      },
    ],
    [
      "openai-stt",
      {
        id: "openai-stt",
        name: "OpenAI transcription",
        kind: "stt",
        state: "activation_required",
        detail:
          "Requires a supported Platform API key; a ChatGPT subscription credential is not a general API key.",
        fakeAvailable: true,
        capabilities: ["transcription"],
        consentScopes: [
          {
            scope: "transcription",
            consent: "required",
            availability: "unknown",
          },
        ],
        activationChecklist: [
          "Configure OPENAI_API_KEY",
          "Grant personal consent",
          "Run a sample transcription",
        ],
      },
    ],
    [
      "grok-stt",
      {
        id: "grok-stt",
        name: "Grok transcription",
        kind: "stt",
        state: "activation_required",
        detail:
          "Waiting for configured xAI OAuth/API access and a verified streaming speech contract.",
        fakeAvailable: true,
        capabilities: ["streaming-transcription"],
        consentScopes: [
          {
            scope: "transcription",
            consent: "required",
            availability: "unknown",
          },
        ],
        activationChecklist: [
          "Register OAuth client",
          "Confirm speech scopes",
          "Validate refresh and interruption",
        ],
      },
    ],
  ]);
  const audio = new Map<
    string,
    { chunks: Map<number, Uint8Array>; finalized: boolean }
  >();
  const maintenance = new Map<string, MaintenanceTask>();
  const changeRequests = new Map<string, ChangeRequestInfo>();

  function requireQuestion(id: string): QuestionDetail {
    const question = questions.get(id);
    if (!question)
      throw new ServiceError(
        `Question ${id} was not found`,
        404,
        "question_not_found",
      );
    return question;
  }

  function touch(question: QuestionDetail): QuestionDetail {
    question.updated = new Date().toISOString();
    questions.set(question.id, question);
    return copy(question);
  }

  function summary(question: QuestionDetail): QuestionSummary {
    return copy({
      id: question.id,
      title: question.title,
      state: question.state,
      bucket: question.bucket,
      tier: question.tier,
      goals: question.goals,
      tags: question.tags,
      askers: question.askers,
      created: question.created,
      updated: question.updated,
      rationale: question.rationale,
    });
  }

  async function ask(input: AskInput): Promise<AskResult> {
    const isKnown = /already documented|what is ultradyn docs/i.test(
      input.question,
    );
    if (isKnown) {
      return {
        kind: "answer",
        answer: "The repository documents this behavior in its overview.",
        citations: [{ path: "docs/overview.md", title: "Overview", line: 1 }],
        goalResults: input.goals.map((goal) => ({
          goal,
          status: "satisfied",
          rationale: "The cited overview answers this goal.",
        })),
      };
    }

    const now = new Date().toISOString();
    const id = `q-${ulid()}`;
    const question: QuestionDetail = {
      id,
      title:
        input.question.length > 72
          ? `${input.question.slice(0, 69)}…`
          : input.question,
      state: "active",
      bucket: "active",
      tier: "P3",
      goals: input.goals.length > 0 ? [...input.goals] : ["documentation"],
      tags: ["raw"],
      askers: [input.asker],
      created: now,
      updated: now,
      rationale: "Raw question, default priority.",
      rawQuestion: input.question,
      chat: input.chat ?? "",
      provenance: [
        { t: now, e: "logged", by: "registrar" },
        {
          t: now,
          e: "prioritized",
          tier: "P3",
          rationale: "Raw question, default priority.",
        },
      ],
      transcripts: [],
    };
    questions.set(id, question);
    return { kind: "logged", question: copy(question) };
  }

  return {
    goals: { list: async () => copy(goals) },
    ask,
    questions: {
      list: async (query: QuestionQuery) => {
        const needle = query.q?.toLocaleLowerCase();
        return [...questions.values()]
          .filter(
            (question) => !query.bucket || question.bucket === query.bucket,
          )
          .filter((question) => !query.tier || question.tier === query.tier)
          .filter(
            (question) =>
              !needle ||
              `${question.title} ${question.rawQuestion} ${question.goals.join(" ")}`
                .toLocaleLowerCase()
                .includes(needle),
          )
          .sort(
            (a, b) =>
              a.tier.localeCompare(b.tier) ||
              a.created.localeCompare(b.created),
          )
          .map(summary);
      },
      get: async (id) => {
        const question = questions.get(id);
        return question ? copy(question) : undefined;
      },
      claim: async (id, answerer) => {
        const question = requireQuestion(id);
        if (!["active", "reopened"].includes(question.state))
          throw new ServiceError(
            "Question is not claimable",
            409,
            "invalid_transition",
          );
        question.state = "in-answer";
        question.provenance.push({
          t: new Date().toISOString(),
          e: "claimed",
          by: answerer,
        });
        return touch(question);
      },
      setPriority: async (id, tier: PriorityTier, rationale, by) => {
        const question = requireQuestion(id);
        question.tier = tier;
        question.rationale = rationale;
        question.provenance.push({
          t: new Date().toISOString(),
          e: "priority-overridden",
          by,
          tier,
          rationale,
        });
        return touch(question);
      },
      addTranscript: async (id, input) => {
        const question = requireQuestion(id);
        if (question.state !== "in-answer")
          throw new ServiceError(
            "Claim the question before adding a transcript",
            409,
            "invalid_transition",
          );
        question.transcripts.push({
          id: `tx-${ulid()}`,
          text: input.text,
          source: input.source,
          ...(input.confidence === undefined
            ? {}
            : { confidence: input.confidence }),
          created: new Date().toISOString(),
        });
        return touch(question);
      },
      structure: async (id) => {
        const question = requireQuestion(id);
        if (question.transcripts.length === 0)
          throw new ServiceError(
            "At least one transcript is required",
            409,
            "transcript_required",
          );
        question.structuredAnswer = question.transcripts
          .map((transcript) => transcript.text.trim())
          .filter(Boolean)
          .join("\n\n");
        return touch(question);
      },
      critic: async (id) => {
        const question = requireQuestion(id);
        if (!question.structuredAnswer)
          throw new ServiceError(
            "Structure the answer before running the critic",
            409,
            "answer_required",
          );
        const goalResults: GoalResult[] = question.goals.map((goal) => ({
          goal,
          status: "satisfied",
          rationale:
            "The deterministic demo critic found a direct answer in the supplied transcript.",
        }));
        question.evaluation = {
          done: true,
          goalResults,
          contradictions: [],
          deferredChildren: [],
        };
        return touch(question);
      },
      integrate: async (id) => {
        const question = requireQuestion(id);
        if (!question.evaluation?.done)
          throw new ServiceError(
            "A clean critic evaluation is required",
            409,
            "evaluation_required",
          );
        question.state = "integrating";
        question.changeRequest = {
          id: `cr-${ulid()}`,
          state: "open",
          branch: `ultradyn/${id}`,
          summary: "Adds the structured answer to the documentation map.",
          diff: `diff --git a/docs/answers/${id}.md b/docs/answers/${id}.md\n+${question.structuredAnswer}`,
          checks: [
            {
              id: "diff-check",
              label: "Git diff check",
              status: "passed",
              detail: "The deterministic demo diff is clean.",
            },
          ],
          approvals: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        question.provenance.push({
          t: new Date().toISOString(),
          e: "integration-started",
        });
        return touch(question);
      },
      approveChangeRequest: async (id, input) => {
        const question = requireQuestion(id);
        if (!question.changeRequest)
          throw new ServiceError(
            "No change request exists",
            404,
            "change_request_not_found",
          );
        const at = new Date().toISOString();
        question.changeRequest.state = "approved";
        question.changeRequest.approvals.push({ ...input, at });
        question.changeRequest.updatedAt = at;
        return touch(question);
      },
      mergeChangeRequest: async (id) => {
        const question = requireQuestion(id);
        if (question.changeRequest?.state !== "approved")
          throw new ServiceError(
            "Approve the change request first",
            409,
            "change_request_blocked",
          );
        question.changeRequest.state = "merged";
        question.changeRequest.updatedAt = new Date().toISOString();
        question.state = "merged";
        return touch(question);
      },
      accept: async (id, asker) => {
        const question = requireQuestion(id);
        question.state = "accepted";
        question.bucket = "answered";
        question.provenance.push({
          t: new Date().toISOString(),
          e: "accepted",
          by: asker,
        });
        return touch(question);
      },
      reject: async (id, asker, reason) => {
        const question = requireQuestion(id);
        question.state = "reopened";
        question.bucket = "active";
        question.tier = "P1";
        question.rationale = "Reopened after asker rejection.";
        question.provenance.push({
          t: new Date().toISOString(),
          e: "rejected",
          by: asker,
          reason,
        });
        return touch(question);
      },
    },
    settings: {
      schema: async () => copy(settingSchema),
      values: async () =>
        settingSchema.map((descriptor) =>
          copy(
            settings.get(descriptor.key) ?? {
              key: descriptor.key,
              value: descriptor.default,
              scope: descriptor.scope,
              source: "default",
            },
          ),
        ),
      set: async (key, value, scope: SettingScope) => {
        const descriptor = settingSchema.find(
          (candidate) => candidate.key === key,
        );
        if (!descriptor)
          throw new ServiceError(
            `Unknown setting ${key}`,
            404,
            "setting_not_found",
          );
        if (descriptor.scope !== scope)
          throw new ServiceError(
            `${key} belongs to ${descriptor.scope} scope`,
            400,
            "invalid_scope",
          );
        if (
          key === "identity.actorHandle" &&
          (typeof value !== "string" ||
            (value !== "" && !/^[a-z0-9][a-z0-9._:-]*$/u.test(value)))
        )
          throw new ServiceError(
            "Actor handle must be a lowercase stable handle.",
            400,
            "invalid_actor_handle",
          );
        const setting: SettingValue = { key, value, scope, source: scope };
        settings.set(key, setting);
        return copy(setting);
      },
    },
    providers: {
      list: async () => copy([...providers.values()]),
      consent: async (id, scope, granted) => {
        const provider = providers.get(id);
        if (!provider)
          throw new ServiceError(
            `Unknown provider ${id}`,
            404,
            "provider_not_found",
          );
        const consentScope = provider.consentScopes?.find(
          (candidate) => candidate.scope === scope,
        );
        if (!consentScope)
          throw new ServiceError(
            `${provider.name} does not advertise the ${scope} scope.`,
            400,
            "unsupported_provider_scope",
          );
        consentScope.consent = granted ? "granted" : "revoked";
        consentScope.availability = granted ? "available" : "unknown";
        provider.state = granted
          ? id === "codex"
            ? "ready"
            : provider.state
          : "consent_required";
        provider.detail = granted
          ? `${provider.detail} Consent recorded for this machine.`
          : "Consent was not granted.";
        return copy(provider);
      },
      connect: async (id) => {
        const provider = providers.get(id);
        if (!provider)
          throw new ServiceError(
            `Unknown provider ${id}`,
            404,
            "provider_not_found",
          );
        if (provider.state === "activation_required")
          throw new ServiceError(
            "Complete the activation checklist first",
            409,
            "activation_required",
          );
        provider.state = "ready";
        return copy(provider);
      },
      disconnect: async (id, scope) => {
        const provider = providers.get(id);
        if (!provider)
          throw new ServiceError(
            `Unknown provider ${id}`,
            404,
            "provider_not_found",
          );
        const consentScope = provider.consentScopes?.find(
          (candidate) => candidate.scope === scope,
        );
        if (!consentScope)
          throw new ServiceError(
            `${provider.name} does not advertise the ${scope} scope.`,
            400,
            "unsupported_provider_scope",
          );
        consentScope.consent = "revoked";
        consentScope.availability = "unknown";
        provider.state = "consent_required";
        return copy(provider);
      },
      test: async (id) => {
        const provider = providers.get(id);
        if (!provider)
          throw new ServiceError(
            `Unknown provider ${id}`,
            404,
            "provider_not_found",
          );
        return provider.state === "ready"
          ? {
              ok: true,
              detail: `${provider.name} passed its capability check.`,
            }
          : { ok: false, detail: `${provider.name} is ${provider.state}.` };
      },
      oauthStart: async (id) => {
        if (!demoOAuthIds.has(id)) {
          if (!providers.has(id)) {
            throw new ServiceError(
              `Unknown provider ${id}`,
              404,
              "provider_not_found",
            );
          }
          throw new ServiceError(
            `${id} does not support browser OAuth sign-in.`,
            400,
            "oauth_not_supported",
          );
        }
        const existing = oauthSessions.get(id);
        if (existing?.state === "pending" && existing.authorizeUrl) {
          return { authorizeUrl: existing.authorizeUrl, state: "demo" };
        }
        const authorizeUrl = "#/settings";
        oauthSessions.set(id, {
          state: "pending",
          authorizeUrl,
          completeAt: Date.now() + 1_000,
        });
        // Simulate a completed browser flow after 1s without network.
        setTimeout(() => {
          const session = oauthSessions.get(id);
          if (!session || session.state !== "pending") return;
          session.state = "complete";
          const provider = providers.get(id);
          if (provider) {
            markDemoOAuthComplete(provider);
          }
        }, 1_000).unref?.();
        return { authorizeUrl, state: "demo" };
      },
      oauthStatus: async (id) => {
        if (!demoOAuthIds.has(id)) {
          if (!providers.has(id)) {
            throw new ServiceError(
              `Unknown provider ${id}`,
              404,
              "provider_not_found",
            );
          }
          throw new ServiceError(
            `${id} does not support browser OAuth sign-in.`,
            400,
            "oauth_not_supported",
          );
        }
        const session = oauthSessions.get(id);
        if (!session) return { state: "idle" as const };
        if (
          session.state === "pending" &&
          session.completeAt !== undefined &&
          Date.now() >= session.completeAt
        ) {
          session.state = "complete";
          const provider = providers.get(id);
          if (provider) {
            markDemoOAuthComplete(provider);
          }
        }
        return {
          state: session.state,
          ...(session.detail ? { detail: session.detail } : {}),
          ...(session.authorizeUrl
            ? { authorizeUrl: session.authorizeUrl }
            : {}),
        };
      },
      oauthCancel: async (id) => {
        if (!demoOAuthIds.has(id)) {
          if (!providers.has(id)) {
            throw new ServiceError(
              `Unknown provider ${id}`,
              404,
              "provider_not_found",
            );
          }
          throw new ServiceError(
            `${id} does not support browser OAuth sign-in.`,
            400,
            "oauth_not_supported",
          );
        }
        oauthSessions.delete(id);
        return { ok: true as const };
      },
    },
    agents: {
      list: async () =>
        [
          "agent-smith",
          "critic",
          "diff-summarizer",
          "goal-clerk",
          "integrator",
          "librarian",
          "matcher",
          "prioritizer",
          "registrar",
          "reviewer",
          "simulated-asker",
          "structurer",
        ].map((id) => ({
          id,
          label: id
            .split("-")
            .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
            .join(" "),
          role: `Deterministic demo status for ${id}.`,
          sourcePath: `agents/${id}/agent.md`,
          dynamic: true,
          freshContext: true,
          fixtureStatus: "passing" as const,
          fixtureCount: 3,
          lastFixtureRunAt: new Date().toISOString(),
          schemaStatus: "valid" as const,
          capabilities: ["structured-output", "fresh-context"],
        })),
      validate: async (id) => ({ name: id, cases: 3, valid: true, errors: [] }),
      propose: async (input) => {
        const agent = input.target ?? "proposed-agent";
        const at = new Date().toISOString();
        const changeRequest: ChangeRequestInfo = {
          id: `cr-${ulid()}`,
          state: "open",
          branch: `ultradyn/agent-${agent}`,
          summary: `${input.mode === "create" ? "Creates" : "Updates"} ${agent} with source, schema, and fixtures.`,
          diff: `diff --git a/agents/${agent}/agent.md b/agents/${agent}/agent.md`,
          checks: [
            {
              id: "fixtures",
              label: "Golden fixtures",
              status: "passed",
              detail: "Three deterministic demo fixtures pass.",
            },
          ],
          approvals: [],
          createdAt: at,
          updatedAt: at,
        };
        changeRequests.set(changeRequest.id, changeRequest);
        return {
          agent,
          changeRequest,
        };
      },
    },
    changeRequests: {
      list: async () => copy([...changeRequests.values()]),
      get: async (id) => {
        const value = changeRequests.get(id);
        return value ? copy(value) : undefined;
      },
      approve: async (id, input) => {
        const value = changeRequests.get(id);
        if (!value)
          throw new ServiceError(
            `Change request ${id} was not found`,
            404,
            "change_request_not_found",
          );
        const at = new Date().toISOString();
        value.state = "approved";
        value.approvals.push({ ...input, at });
        value.updatedAt = at;
        return copy(value);
      },
      merge: async (id) => {
        const value = changeRequests.get(id);
        if (!value)
          throw new ServiceError(
            `Change request ${id} was not found`,
            404,
            "change_request_not_found",
          );
        if (value.state !== "approved")
          throw new ServiceError(
            "Approve the change request first",
            409,
            "change_request_blocked",
          );
        value.state = "merged";
        value.updatedAt = new Date().toISOString();
        return copy(value);
      },
    },
    audio: {
      create: async () => {
        const id = `aud-${ulid()}`;
        audio.set(id, { chunks: new Map(), finalized: false });
        return { id, state: "recording" };
      },
      append: async (id, sequence, bytes) => {
        const session = audio.get(id);
        if (!session)
          throw new ServiceError(
            `Unknown audio session ${id}`,
            404,
            "audio_not_found",
          );
        if (session.finalized)
          throw new ServiceError(
            "Audio session is already finalized",
            409,
            "audio_finalized",
          );
        const expected = session.chunks.size;
        if (sequence !== expected)
          throw new ServiceError(
            `Expected chunk ${expected}, received ${sequence}`,
            409,
            "audio_sequence",
          );
        session.chunks.set(sequence, Uint8Array.from(bytes));
        return { sequence, durableBytes: bytes.byteLength };
      },
      finalize: async (id) => {
        const session = audio.get(id);
        if (!session)
          throw new ServiceError(
            `Unknown audio session ${id}`,
            404,
            "audio_not_found",
          );
        if (session.finalized)
          return { id, state: "ready", chunks: session.chunks.size };
        if (session.chunks.size === 0)
          throw new ServiceError(
            "Audio session contains no chunks",
            409,
            "audio_empty",
          );
        session.finalized = true;
        return { id, state: "ready", chunks: session.chunks.size };
      },
    },
    maintenance: {
      list: async () => copy([...maintenance.values()]),
      run: async () => {
        if (maintenance.size === 0) {
          const now = new Date().toISOString();
          maintenance.set("demo-checkpoint", {
            id: "demo-checkpoint",
            kind: "checkpoint",
            title: "Checkpoint local repository changes",
            detail:
              "The fake poller found portable state that has not been checkpointed.",
            status: "open",
            updated: now,
          });
        }
        return copy([...maintenance.values()]);
      },
    },
  };
}
