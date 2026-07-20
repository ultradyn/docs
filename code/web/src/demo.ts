import type {
  AgentDefinitionStatus,
  AskResponse,
  GoalDefinition,
  MaintenanceState,
  ProviderStatus,
  Question,
  SettingDefinition,
  SettingsPayload,
  SettingValue,
} from "./types.js";

export const demoGoals: GoalDefinition[] = [
  {
    id: "implementation",
    label: "Implementation",
    description: "Enough detail to build or change the system.",
  },
  {
    id: "api-integration",
    label: "API integration",
    description: "Contracts, inputs, outputs, and failure behavior.",
  },
  {
    id: "security-review",
    label: "Security review",
    description: "Threats, trust boundaries, and decisive mitigations.",
  },
  {
    id: "complexity-analysis",
    label: "Complexity",
    description: "Operational and computational cost.",
  },
  {
    id: "documentation",
    label: "Documentation",
    description: "A clear and complete explanation for readers.",
  },
  {
    id: "onboarding",
    label: "Onboarding",
    description: "Enough context for a new contributor to proceed.",
  },
];

export const demoQuestions: Question[] = [
  {
    id: "q-01K0DEMOSECURITY",
    title: "How are credential sources kept out of the repository?",
    question:
      "How are credential sources kept out of the repository, and what proves consent was given?",
    rawQuestion:
      "How are credential sources kept out of the repository, and what proves consent was given?",
    state: "active",
    tier: "P1",
    goals: ["security-review", "implementation"],
    tags: ["raw", "credential-boundary"],
    createdAt: "2026-07-16T00:22:00.000Z",
    updatedAt: "2026-07-16T03:01:00.000Z",
    revision: 3,
    rationale:
      "A contradiction was found between the provider guide and portable-state policy.",
    chat: "The asker needs to audit a workstation setup where Codex and Grok are already installed.",
    askers: [{ name: "Max", status: "waiting" }],
    provenance: { kind: "raw" },
    transcript:
      "The capability adapter must never return the key. It returns an opaque handle, or delegates the request to the installed client after consent.",
    structuredAnswer:
      "Credential sources are machine-local, consent-gated adapters. Portable settings record provider choice but never a path, token, or consent receipt that reveals credential locations.",
    findings: [
      {
        id: "f-01K0DEMO01",
        goal: "security-review",
        status: "contradiction",
        rationale:
          "The old provider guide still says auth.json may be imported.",
        question: "Which legacy credential instructions must be removed?",
        childQuestionId: "q-01K0DEMOBLOCKER",
      },
      {
        id: "f-01K0DEMO02",
        goal: "implementation",
        status: "satisfied",
        rationale:
          "The adapter and consent receipt boundaries are implementable as specified.",
      },
    ],
  },
  {
    id: "q-01K0DEMOAUDIO",
    title: "What happens to audio after transcription?",
    question:
      "What happens to raw answer audio after the STT provider returns a final transcript?",
    state: "in-answer",
    tier: "P2",
    goals: ["documentation", "security-review"],
    tags: ["raw", "audio"],
    createdAt: "2026-07-15T22:15:00.000Z",
    updatedAt: "2026-07-16T02:47:00.000Z",
    revision: 5,
    rationale: "Active answer session with an unsatisfied security goal.",
    askers: [
      { name: "Ari", status: "waiting" },
      { name: "Sam", status: "waiting" },
    ],
    provenance: { kind: "raw" },
    transcript:
      "Audio chunks are written durably while recording. Finalize verifies ordering, converts the complete session to Ogg or MP3, then removes raw chunks only after the converted artifact has been verified.",
    findings: [
      {
        goal: "documentation",
        status: "satisfied",
        rationale: "The lifecycle and recovery point are described.",
      },
      {
        goal: "security-review",
        status: "uncertain",
        rationale:
          "Retention and backup responsibility still need an explicit statement.",
      },
    ],
  },
  {
    id: "q-01K0DEMOGITHUB",
    title: "Can reviews run without GitHub write access?",
    question:
      "Can a reviewer complete a change request locally if their GitHub role cannot submit a review?",
    state: "active",
    tier: "P3",
    goals: ["onboarding", "implementation"],
    tags: ["raw", "git"],
    createdAt: "2026-07-15T17:44:00.000Z",
    rationale: "Raw question, default priority.",
    askers: [{ name: "Morgan", status: "waiting" }],
    provenance: { kind: "raw" },
  },
  {
    id: "q-01K0DEMODEFER",
    title: "How should three-way source upgrades resolve renamed files?",
    question:
      "How should a future source-template upgrader detect user-renamed files?",
    state: "deferred",
    tier: "P5",
    goals: ["implementation"],
    tags: ["generated", "extra-detail"],
    createdAt: "2026-07-14T14:09:00.000Z",
    rationale:
      "Generated depth-2 detail; source-template upgrades are outside v1.",
    provenance: {
      kind: "generated",
      parent: "q-01K0DEMOGITHUB",
      finding: "f-01K0DEMOUPGRADE",
      goal: "implementation",
    },
  },
];

export const demoSettingDefinitions: SettingDefinition[] = [
  {
    key: "identity.actorHandle",
    label: "Actor handle",
    description:
      "Stable personal handle recorded on local claims and approvals for attribution, not authentication.",
    category: "Identity & attribution",
    scope: "personal",
    type: "string",
    defaultValue: "",
  },
  {
    key: "answer.autoStructure",
    label: "Structure after dictation",
    description:
      "Run the Structurer when a transcript segment is saved. Raw transcripts remain unchanged.",
    category: "Answering",
    scope: "repo",
    type: "boolean",
    defaultValue: true,
  },
  {
    key: "answer.mergeMode",
    label: "Change request approval",
    description:
      "Auto still requires answerer approval of the isolated diff summary.",
    category: "Answering",
    scope: "repo",
    type: "select",
    defaultValue: "manual",
    options: [
      { value: "manual", label: "Review full change request" },
      { value: "auto", label: "Approve isolated summary" },
    ],
  },
  {
    key: "ask.defaultGoals",
    label: "Default goals",
    description:
      "Goals preselected on the Ask page. Askers can change them before sending.",
    category: "Asking",
    scope: "personal",
    type: "multiselect",
    defaultValue: ["documentation"],
    options: demoGoals.map((goal) => ({ value: goal.id, label: goal.label })),
  },
  {
    key: "audio.preferredCodec",
    label: "Saved audio format",
    description:
      "Raw chunks are removed only after the converted artifact verifies successfully.",
    category: "Audio & transcription",
    scope: "personal",
    type: "select",
    defaultValue: "ogg",
    options: [
      { value: "ogg", label: "Ogg Opus" },
      { value: "mp3", label: "MP3" },
    ],
  },
  {
    key: "audio.keepConvertedDays",
    label: "Converted audio retention",
    description:
      "Days to keep machine-local converted audio. Audio is never committed to Git.",
    category: "Audio & transcription",
    scope: "personal",
    type: "number",
    defaultValue: 30,
  },
  {
    key: "maintenance.enabled",
    label: "Maintainer mode",
    description:
      "Show the maintenance queue and run idempotent background polling jobs.",
    category: "Maintenance",
    scope: "repo",
    type: "boolean",
    defaultValue: true,
  },
  {
    key: "maintenance.pollMinutes",
    label: "Git host polling interval",
    description:
      "How often to check for new or invalidated reviews when maintainer mode is enabled.",
    category: "Maintenance",
    scope: "repo",
    type: "number",
    defaultValue: 15,
  },
  {
    key: "appearance.reducedDensity",
    label: "Compact queue",
    description:
      "Use denser rows in the queue without reducing control target sizes.",
    category: "Appearance",
    scope: "personal",
    type: "boolean",
    defaultValue: false,
  },
];

const demoSettings: SettingsPayload = {
  definitions: demoSettingDefinitions,
  values: Object.fromEntries(
    demoSettingDefinitions.map((definition) => [
      definition.key,
      definition.defaultValue,
    ]),
  ),
};

export const demoProviders: ProviderStatus[] = [
  {
    id: "codex",
    kind: "model",
    label: "Codex / ChatGPT",
    description:
      "Delegates model work to the installed Codex client. The cached token is never copied.",
    availability: "available",
    connection: "connected",
    consent: "granted",
    consentScopes: [
      {
        scope: "model",
        consent: "granted",
        availability: "available",
      },
    ],
    capabilities: ["Librarian", "Structurer", "isolated evaluations"],
    credentialSources: ["Installed Codex client", "OpenAI Platform key"],
    selectedSource: "Installed Codex client",
    fake: true,
  },
  {
    id: "openai-stt",
    kind: "stt",
    label: "OpenAI transcription",
    description: "Streaming audio transcription through the OpenAI audio API.",
    availability: "activation_required",
    connection: "disconnected",
    consent: "required",
    consentScopes: [
      {
        scope: "transcription",
        consent: "required",
        availability: "unknown",
      },
    ],
    reason:
      "A ChatGPT subscription token is not a general OpenAI audio API credential.",
    credentialSources: ["OPENAI_API_KEY"],
    activationChecklist: [
      "Configure an OpenAI Platform API key or confirm an official subscription-scoped audio API.",
      "Grant consent for the selected credential source.",
      "Run the provider contract test with a non-sensitive sample.",
      "Verify interruption, retry, retention, and final-transcript behavior.",
    ],
    fake: true,
  },
  {
    id: "grok",
    kind: "stt",
    label: "Grok / xAI",
    description:
      "Model and speech provider through browser OAuth sign-in or installed-client delegation.",
    availability: "activation_required",
    connection: "disconnected",
    consent: "required",
    consentScopes: [
      {
        scope: "model",
        consent: "required",
        availability: "unknown",
      },
      {
        scope: "transcription",
        consent: "required",
        availability: "unknown",
      },
    ],
    reason:
      "Browser sign-in and scoped consent are still required before this source can be selected.",
    credentialSources: ["Browser OAuth sign-in", "Installed Grok client"],
    activationChecklist: [
      "Complete the browser sign-in from this page",
      "Grant scoped discovery consent here",
      "Run the provider capability test before selection",
    ],
    fake: true,
    oauth: true,
  },
  {
    id: "claude",
    kind: "model",
    label: "Claude",
    description:
      "Optional model provider through documented CLI delegation or an Anthropic API key.",
    availability: "activation_required",
    connection: "disconnected",
    consent: "required",
    consentScopes: [
      {
        scope: "model",
        consent: "required",
        availability: "unknown",
      },
    ],
    reason:
      "A Claude consumer subscription is not assumed to be a general Anthropic API credential.",
    credentialSources: ["Claude CLI delegation", "ANTHROPIC_API_KEY"],
    activationChecklist: [
      "Choose a documented Claude CLI delegation path or configure ANTHROPIC_API_KEY.",
      "Grant consent and verify logout, revocation, model discovery, and streaming.",
    ],
    fake: true,
  },
  {
    id: "ollama",
    kind: "model",
    label: "Ollama",
    description:
      "Local model and transcription-compatible endpoints with no cloud credential required.",
    availability: "available",
    connection: "disconnected",
    consent: "required",
    consentScopes: [
      {
        scope: "model",
        consent: "required",
        availability: "unknown",
      },
    ],
    reason: "Consent is still required before probing a machine-local service.",
    credentialSources: ["Local Ollama service"],
    capabilities: [
      "Model discovery",
      "chat completion",
      "custom OpenAI-compatible endpoints",
    ],
    fake: true,
  },
  {
    id: "github",
    kind: "git",
    label: "GitHub",
    description:
      "Publishes optional remote change requests and polls for locally claimable review work.",
    availability: "blocked",
    connection: "disconnected",
    consent: "required",
    consentScopes: [
      {
        scope: "git-host",
        consent: "required",
        availability: "unknown",
      },
    ],
    reason:
      "Local change requests are complete; remote actions require repository authorization.",
    activationChecklist: [
      "Authorize GitHub with least privilege for this repository.",
      "Validate rate-limit backoff and re-review invalidation on a disposable PR.",
      "Confirm branch protection and merge mode.",
    ],
    fake: true,
  },
];

export const demoMaintenance: MaintenanceState = {
  enabled: true,
  polling: true,
  lastRunAt: "2026-07-16T03:18:00.000Z",
  nextRunAt: "2026-07-16T03:33:00.000Z",
  intervalSeconds: 900,
  pendingCheckpoints: 1,
  cursors: [
    {
      source: "Local change requests",
      status: "healthy",
      updatedAt: "2026-07-16T03:18:00.000Z",
    },
    { source: "GitHub", status: "activation required" },
  ],
  tasks: [
    {
      id: "review-cr-17",
      kind: "review",
      title: "Review credential-boundary documentation diff",
      detail:
        "New commit invalidated the previous reviewer result. Run the review under your own identity.",
      status: "ready",
      repository: "ultradyn/docs",
      updatedAt: "2026-07-16T03:12:00.000Z",
    },
    {
      id: "checkpoint-02",
      kind: "checkpoint",
      title: "Inspect one pending state checkpoint",
      detail:
        "Question projection changed while automatic checkpoints were disabled.",
      status: "ready",
      repository: "ultradyn/docs",
      updatedAt: "2026-07-16T02:55:00.000Z",
    },
  ],
};

export const demoAgents: AgentDefinitionStatus[] = [
  {
    id: "librarian",
    label: "Librarian",
    role: "Retrieval and cited answers",
    sourcePath: "agents/librarian/agent.md",
    dynamic: true,
    freshContext: true,
    fixtureStatus: "passing",
    fixtureCount: 4,
    lastFixtureRunAt: "2026-07-16T03:10:00.000Z",
    schemaStatus: "valid",
    capabilities: ["Repository maps", "Text search", "Citations"],
  },
  {
    id: "critic",
    label: "Critic",
    role: "Per-goal evaluator and contradiction detector",
    sourcePath: "agents/critic/agent.md",
    dynamic: true,
    freshContext: true,
    fixtureStatus: "passing",
    fixtureCount: 5,
    lastFixtureRunAt: "2026-07-16T03:11:00.000Z",
    schemaStatus: "valid",
    capabilities: ["IGC matrix", "Deferred children", "P1 contradictions"],
  },
  {
    id: "integrator",
    label: "Integrator",
    role: "Documentation edit orchestrator",
    sourcePath: "agents/integrator/agent.md",
    dynamic: true,
    freshContext: true,
    fixtureStatus: "passing",
    fixtureCount: 3,
    lastFixtureRunAt: "2026-07-16T03:11:00.000Z",
    schemaStatus: "valid",
    capabilities: ["Edit plan", "Isolated worktree", "Committed maps"],
  },
  {
    id: "reviewer",
    label: "Reviewer",
    role: "Independent question, answer, and actual-diff review",
    sourcePath: "agents/reviewer/agent.md",
    dynamic: true,
    freshContext: true,
    fixtureStatus: "not_run",
    fixtureCount: 3,
    schemaStatus: "valid",
    capabilities: ["Actual diff", "Input isolation"],
  },
  {
    id: "agent-smith",
    label: "Agent-Smith",
    role: "Creates agent definitions, schemas, and fixtures through change requests",
    sourcePath: "agents/agent-smith/agent.md",
    dynamic: true,
    freshContext: true,
    fixtureStatus: "passing",
    fixtureCount: 3,
    lastFixtureRunAt: "2026-07-16T03:12:00.000Z",
    schemaStatus: "valid",
    capabilities: ["Agent definition", "JSON Schema", "Golden fixtures"],
  },
];

function response(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function demoRequest(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  await new Promise((resolve) =>
    setTimeout(resolve, init?.method === "GET" || !init?.method ? 120 : 380),
  );
  const url = new URL(path, "http://demo.local");
  const method = init?.method ?? "GET";

  if (url.pathname === "/api/runtime") {
    return response({
      maintenanceEnabled: true,
      demoMode: true,
      repoRoot: "~/network-docs",
      version: "0.1.0-demo",
    });
  }
  if (url.pathname === "/api/health")
    return response({ status: "ok", mode: "demo" });
  if (url.pathname === "/api/goals") return response({ goals: demoGoals });
  if (url.pathname === "/api/questions" && method === "GET") {
    const bucket = url.searchParams.get("bucket");
    const tier = url.searchParams.get("tier");
    const query = url.searchParams.get("q")?.toLocaleLowerCase();
    return response({
      items: demoQuestions.filter((question) => {
        if (
          bucket &&
          bucket !== "all" &&
          question.state !== bucket &&
          !(bucket === "active" && question.state === "in-answer")
        )
          return false;
        if (tier && tier !== "all" && question.tier !== tier) return false;
        return (
          !query ||
          [question.title, question.question, ...question.goals]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query)
        );
      }),
    });
  }
  const questionMatch = url.pathname.match(
    /^\/api\/questions\/([^/]+)(?:\/(.+))?$/,
  );
  if (questionMatch) {
    const question =
      demoQuestions.find((item) => item.id === questionMatch[1]) ??
      demoQuestions[0];
    const action = questionMatch[2];
    if (!question)
      return new Response(JSON.stringify({ message: "Question not found" }), {
        status: 404,
      });
    if (!action && method === "GET") return response({ question });
    if (action === "priority") {
      const body = bodyOf(init);
      if (typeof body.tier === "string")
        question.tier = body.tier as Question["tier"];
      if (typeof body.rationale === "string")
        question.rationale = body.rationale;
      return response({ question });
    }
    if (action === "transcripts") {
      const body = bodyOf(init);
      if (typeof body.text === "string")
        question.transcript =
          `${question.transcript ?? ""}\n\n${body.text}`.trim();
      return response({
        question,
        artifact: `answers/raw/demo-${Date.now()}.md`,
      });
    }
    if (action === "structure") {
      question.structuredAnswer =
        question.transcript ?? "No transcript has been captured yet.";
      return response({
        question,
        structuredAnswer: question.structuredAnswer,
      });
    }
    if (action === "critic")
      return response({ question, findings: question.findings ?? [] });
    if (action === "claim") {
      question.state = "in-answer";
      return response({ question });
    }
    if (action === "integrate") {
      question.state = "integrating";
      return response({
        question,
        changeRequest: { id: "cr-demo", backend: "local", checks: "running" },
      });
    }
    return response({ question });
  }
  if (url.pathname === "/api/ask" && method === "POST") {
    const body = bodyOf(init);
    const questionText = typeof body.question === "string" ? body.question : "";
    const goals = Array.isArray(body.goals)
      ? body.goals.filter((goal): goal is string => typeof goal === "string")
      : [];
    if (/audio|raw|retention|credential/i.test(questionText)) {
      const answer: AskResponse = {
        kind: "answer",
        answer:
          "Portable project state never contains raw audio or credentials. Audio is saved incrementally in machine-local storage, converted after an ordered finalize check, and raw chunks are removed only after the converted artifact verifies. Credential adapters return opaque capability handles or delegate to installed clients after explicit consent.",
        citations: [
          {
            path: "docs/adr/0002-portable-and-local-state.md",
            title: "Portable and local state",
            line: 12,
          },
          { path: "AGENTS.md", title: "Building Ultradyn Docs", line: 19 },
        ],
        goalResults: goals.map((goal) => ({
          goal,
          status: "satisfied",
          rationale: "The cited documentation directly supports this goal.",
        })),
      };
      return response(answer);
    }
    const logged: Question = {
      id: `q-DEMO${String(demoQuestions.length + 1).padStart(4, "0")}`,
      title: questionText || "Untitled question",
      question: questionText,
      state: "active",
      tier: "P3",
      goals,
      tags: ["raw"],
      createdAt: new Date().toISOString(),
      rationale: "Raw question, default priority.",
      provenance: { kind: "raw" },
    };
    demoQuestions.push(logged);
    return response({ kind: "logged", question: logged } satisfies AskResponse);
  }
  if (url.pathname === "/api/settings/schema")
    return response({ definitions: demoSettingDefinitions });
  if (url.pathname === "/api/settings") {
    if (method === "PUT") {
      const body = bodyOf(init);
      if (
        body.key === "identity.actorHandle" &&
        (typeof body.value !== "string" ||
          (body.value !== "" && !/^[a-z0-9][a-z0-9._:-]*$/u.test(body.value)))
      )
        return new Response(
          JSON.stringify({
            error: {
              code: "invalid_actor_handle",
              message: "Actor handle must be a lowercase stable handle.",
            },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      if (
        typeof body.key === "string" &&
        (typeof body.value === "string" ||
          typeof body.value === "number" ||
          typeof body.value === "boolean" ||
          Array.isArray(body.value))
      ) {
        demoSettings.values[body.key] = body.value as SettingValue;
      } else if (body.values && typeof body.values === "object") {
        Object.assign(demoSettings.values, body.values);
      }
    }
    return response(demoSettings);
  }
  if (url.pathname === "/api/providers")
    return response({ providers: demoProviders });
  const providerMatch = url.pathname.match(
    /^\/api\/providers\/([^/]+)\/(consent|connect|disconnect|test)$/,
  );
  if (providerMatch) {
    const provider = demoProviders.find((item) => item.id === providerMatch[1]);
    if (provider) {
      if (providerMatch[2] === "consent") {
        const body = bodyOf(init);
        const consentScope = provider.consentScopes?.find(
          (candidate) => candidate.scope === body.scope,
        );
        if (consentScope) {
          consentScope.consent = body.granted === false ? "revoked" : "granted";
          consentScope.availability =
            body.granted === false ? "unknown" : "available";
          provider.consent = provider.consentScopes?.every(
            (candidate) => candidate.consent === "granted",
          )
            ? "granted"
            : provider.consentScopes?.some(
                  (candidate) =>
                    candidate.consent === "denied" ||
                    candidate.consent === "revoked",
                )
              ? "denied"
              : "required";
        }
      }
      if (
        providerMatch[2] === "connect" &&
        provider.availability === "available"
      )
        provider.connection = "connected";
      if (providerMatch[2] === "disconnect")
        provider.connection = "disconnected";
    }
    return response({
      provider,
      test:
        providerMatch[2] === "test"
          ? { ok: true, message: "Deterministic fake contract passed." }
          : undefined,
    });
  }
  if (url.pathname === "/api/maintenance") return response(demoMaintenance);
  if (url.pathname === "/api/maintenance/run") {
    demoMaintenance.lastRunAt = new Date().toISOString();
    return response(demoMaintenance);
  }
  if (url.pathname === "/api/agents") return response({ agents: demoAgents });
  const agentFixtureMatch = url.pathname.match(
    /^\/api\/agents\/([^/]+)\/fixtures$/,
  );
  if (agentFixtureMatch) {
    const agent = demoAgents.find((item) => item.id === agentFixtureMatch[1]);
    if (agent) {
      agent.fixtureStatus = "passing";
      agent.lastFixtureRunAt = new Date().toISOString();
    }
    return response({
      agent,
      result: { passed: agent?.fixtureCount ?? 0, failed: 0 },
    });
  }
  if (url.pathname === "/api/agents/agent-smith")
    return response({
      changeRequest: { id: "cr-agent-demo", backend: "local", status: "ready" },
    });
  if (url.pathname === "/api/audio/sessions")
    return response({ id: `aud-demo-${Date.now()}`, acknowledgedSeq: -1 });
  if (/^\/api\/audio\/sessions\/[^/]+\/chunks\/\d+$/.test(url.pathname))
    return response({ acknowledged: true });
  if (/^\/api\/audio\/sessions\/[^/]+\/finalize$/.test(url.pathname)) {
    return response({
      status: "complete",
      transcript:
        "This is a deterministic demo transcript from the recorded audio.",
    });
  }
  return new Response(
    JSON.stringify({ message: `No demo route for ${method} ${url.pathname}` }),
    {
      status: 404,
      headers: { "content-type": "application/json" },
    },
  );
}
