import { demoRequest } from "./demo.js";
import { normaliseQuestion, normaliseQuestionList } from "./model.js";
import type {
  AgentDefinitionStatus,
  AskResponse,
  ChangeRequestInfo,
  GoalDefinition,
  MaintenanceState,
  PriorityTier,
  ProviderConsentScope,
  ProviderStatus,
  Question,
  RuntimeConfig,
  SettingDefinition,
  SettingScope,
  SettingsPayload,
  SettingValue,
  StreamEvent,
} from "./types.js";

const DEFAULT_DESKTOP_API = "http://127.0.0.1:49321";

function defaultApiBase(): string {
  const configured = import.meta.env.VITE_ULTRADYN_API_BASE as
    string | undefined;
  if (configured) return configured.replace(/\/$/, "");
  if (typeof window !== "undefined") {
    if (window.__TAURI_INTERNALS__) return DEFAULT_DESKTOP_API;
    return window.location.origin;
  }
  return "";
}

export class ApiError extends Error {
  readonly status: number;
  readonly detail?: unknown;

  constructor(message: string, status = 0, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function arrayFrom<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (isRecord(value) && Array.isArray(value[key])) return value[key] as T[];
  return [];
}

function itemArray<T>(value: unknown, ...keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!isRecord(value)) return [];
  for (const key of keys)
    if (Array.isArray(value[key])) return value[key] as T[];
  return [];
}

function settingValue(value: unknown): SettingValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return value;
  return String(value ?? "");
}

export function adaptSettingDefinitions(value: unknown): SettingDefinition[] {
  return itemArray<Record<string, unknown>>(value, "definitions", "items").map(
    (item) => ({
      key: typeof item.key === "string" ? item.key : "unknown",
      label:
        typeof item.label === "string"
          ? item.label
          : String(item.key ?? "Setting"),
      description: typeof item.description === "string" ? item.description : "",
      category: typeof item.category === "string" ? item.category : "General",
      scope: item.scope === "personal" ? "personal" : "repo",
      type:
        item.type === "boolean" ||
        item.type === "number" ||
        item.type === "select" ||
        item.type === "multiselect"
          ? item.type
          : "string",
      defaultValue: settingValue(item.defaultValue ?? item.default),
      ...(Array.isArray(item.options)
        ? { options: item.options as Array<{ value: string; label: string }> }
        : {}),
      ...(item.sensitive === true || item.secret === true
        ? { sensitive: true }
        : {}),
      ...(item.restartRequired === true ? { restartRequired: true } : {}),
    }),
  );
}

export function adaptSettings(value: unknown): SettingsPayload {
  if (isRecord(value) && isRecord(value.values))
    return { values: value.values as Record<string, SettingValue> };
  const items = itemArray<Record<string, unknown>>(value, "items");
  return {
    values: Object.fromEntries(
      items.flatMap((item) =>
        typeof item.key === "string"
          ? [[item.key, settingValue(item.value)]]
          : [],
      ),
    ),
  };
}

export function adaptProviders(value: unknown): ProviderStatus[] {
  return itemArray<Record<string, unknown>>(value, "providers", "items").map(
    (item) => {
      const consentScopes: NonNullable<ProviderStatus["consentScopes"]> =
        Array.isArray(item.consentScopes)
          ? item.consentScopes.flatMap((candidate) => {
              if (!candidate || typeof candidate !== "object") return [];
              const value = candidate as Record<string, unknown>;
              if (
                value.scope !== "model" &&
                value.scope !== "transcription" &&
                value.scope !== "git-host"
              )
                return [];
              if (
                value.consent !== "required" &&
                value.consent !== "granted" &&
                value.consent !== "denied" &&
                value.consent !== "revoked"
              )
                return [];
              const availability =
                value.availability === "available" ||
                value.availability === "unavailable"
                  ? value.availability
                  : "unknown";
              return [
                {
                  scope: value.scope,
                  consent: value.consent,
                  availability,
                  ...(typeof value.reason === "string"
                    ? { reason: value.reason }
                    : {}),
                },
              ];
            })
          : [];
      const state = typeof item.state === "string" ? item.state : undefined;
      const availability: ProviderStatus["availability"] =
        state === "activation_required"
          ? "activation_required"
          : state === "unavailable"
            ? "unavailable"
            : state === "error"
              ? "blocked"
              : item.availability === "activation_required" ||
                  item.availability === "unavailable" ||
                  item.availability === "blocked"
                ? item.availability
                : "available";
      const connection: ProviderStatus["connection"] =
        state === "ready"
          ? "connected"
          : state === "error"
            ? "error"
            : item.connection === "connected" ||
                item.connection === "connecting" ||
                item.connection === "error"
              ? item.connection
              : "disconnected";
      const consent: ProviderStatus["consent"] =
        consentScopes.length > 0
          ? consentScopes.every((scope) => scope.consent === "granted")
            ? "granted"
            : consentScopes.some(
                  (scope) =>
                    scope.consent === "denied" || scope.consent === "revoked",
                )
              ? "denied"
              : "required"
          : state === "consent_required" || state === "activation_required"
            ? "required"
            : item.consent === "denied"
              ? "denied"
              : "granted";
      return {
        id: typeof item.id === "string" ? item.id : "unknown",
        label:
          typeof item.label === "string"
            ? item.label
            : typeof item.name === "string"
              ? item.name
              : "Provider",
        kind:
          item.kind === "stt" ||
          item.kind === "git" ||
          item.kind === "codec" ||
          item.kind === "credential"
            ? item.kind
            : "model",
        availability,
        connection,
        consent,
        ...(consentScopes.length > 0 ? { consentScopes } : {}),
        ...(typeof item.description === "string"
          ? { description: item.description }
          : typeof item.detail === "string"
            ? { description: item.detail }
            : {}),
        ...(availability !== "available" && typeof item.detail === "string"
          ? { reason: item.detail }
          : typeof item.reason === "string"
            ? { reason: item.reason }
            : {}),
        ...(Array.isArray(item.capabilities)
          ? {
              capabilities: item.capabilities.filter(
                (capability): capability is string =>
                  typeof capability === "string",
              ),
            }
          : {}),
        ...(Array.isArray(item.activationChecklist)
          ? {
              activationChecklist: item.activationChecklist.filter(
                (step): step is string => typeof step === "string",
              ),
            }
          : {}),
        ...(Array.isArray(item.credentialSources)
          ? {
              credentialSources: item.credentialSources.filter(
                (source): source is string => typeof source === "string",
              ),
            }
          : {}),
        ...(typeof item.source === "string"
          ? { selectedSource: item.source }
          : typeof item.selectedSource === "string"
            ? { selectedSource: item.selectedSource }
            : {}),
        fake: item.fake === true || item.fakeAvailable === true,
      };
    },
  );
}

export function adaptMaintenance(value: unknown): MaintenanceState {
  const record = isRecord(value) ? value : {};
  const rawTasks = itemArray<Record<string, unknown>>(value, "tasks", "items");
  return {
    enabled: record.enabled !== false,
    polling: record.polling === true,
    tasks: rawTasks.map((task) => ({
      id: typeof task.id === "string" ? task.id : "unknown",
      kind: typeof task.kind === "string" ? task.kind : "task",
      title: typeof task.title === "string" ? task.title : "Maintenance task",
      status:
        task.status === "claimed"
          ? "claimed"
          : task.status === "done" || task.status === "complete"
            ? "complete"
            : task.status === "blocked"
              ? "blocked"
              : "ready",
      ...(typeof task.detail === "string" ? { detail: task.detail } : {}),
      ...(typeof task.repository === "string"
        ? { repository: task.repository }
        : {}),
      ...(typeof task.updatedAt === "string"
        ? { updatedAt: task.updatedAt }
        : typeof task.updated === "string"
          ? { updatedAt: task.updated }
          : {}),
    })),
    ...(typeof record.lastRunAt === "string"
      ? { lastRunAt: record.lastRunAt }
      : {}),
    ...(typeof record.nextRunAt === "string"
      ? { nextRunAt: record.nextRunAt }
      : {}),
    ...(typeof record.intervalSeconds === "number"
      ? { intervalSeconds: record.intervalSeconds }
      : {}),
    ...(typeof record.pendingCheckpoints === "number"
      ? { pendingCheckpoints: record.pendingCheckpoints }
      : {}),
    ...(Array.isArray(record.cursors)
      ? { cursors: record.cursors as NonNullable<MaintenanceState["cursors"]> }
      : {}),
  };
}

function adaptStreamEvent(
  value: unknown,
  fallbackType = "message",
): StreamEvent {
  const record = isRecord(value) ? value : {};
  const rawType = typeof record.type === "string" ? record.type : fallbackType;
  const aliases: Record<string, string> = {
    question: "question.updated",
    maintenance: "maintenance.updated",
    provider: "provider.updated",
    settings: "settings.updated",
    audio: "audio.updated",
  };
  const data = isRecord(record.data) ? record.data : record;
  const questionId =
    typeof data.questionId === "string"
      ? data.questionId
      : rawType === "question" && typeof data.id === "string"
        ? data.id
        : undefined;
  return {
    type: aliases[rawType] ?? rawType,
    ...(questionId ? { questionId } : {}),
    ...(typeof data.sessionId === "string"
      ? { sessionId: data.sessionId }
      : {}),
    ...(typeof data.text === "string" ? { text: data.text } : {}),
    ...(typeof data.status === "string" ? { status: data.status } : {}),
    ...(record.data === undefined ? {} : { payload: record.data }),
    ...(typeof record.at === "string" ? { at: record.at } : {}),
  };
}

function unwrapQuestion(value: unknown): Question {
  return normaliseQuestion(
    isRecord(value) && value.question ? value.question : value,
  );
}

export class ApiClient {
  readonly baseUrl: string;
  readonly clientDemo: boolean;

  constructor(options: { baseUrl?: string; clientDemo?: boolean } = {}) {
    this.baseUrl = (options.baseUrl ?? defaultApiBase()).replace(/\/$/, "");
    this.clientDemo = options.clientDemo ?? false;
  }

  static async connect(): Promise<{ api: ApiClient; runtime: RuntimeConfig }> {
    if (import.meta.env.VITE_ULTRADYN_DEMO === "true") {
      const api = new ApiClient({ clientDemo: true });
      return { api, runtime: await api.runtime() };
    }
    const live = new ApiClient();
    const attempts =
      typeof window !== "undefined" && window.__TAURI_INTERNALS__ ? 24 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return { api: live, runtime: await live.runtime() };
      } catch {
        if (attempt < attempts - 1)
          await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
    }
    const api = new ApiClient({ clientDemo: true });
    return { api, runtime: { ...(await api.runtime()), offline: true } };
  }

  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (typeof init.body === "string" && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const response = this.clientDemo
        ? await demoRequest(path, { ...init, headers })
        : await fetch(this.url(path), {
            ...init,
            headers,
            signal: init.signal ?? controller.signal,
          });
      const contentType = response.headers.get("content-type") ?? "";
      const payload: unknown = contentType.includes("application/json")
        ? await response.json()
        : await response.text();
      if (!response.ok) {
        const message =
          isRecord(payload) && typeof payload.message === "string"
            ? payload.message
            : isRecord(payload) &&
                isRecord(payload.error) &&
                typeof payload.error.message === "string"
              ? payload.error.message
              : `Request failed (${response.status})`;
        throw new ApiError(message, response.status, payload);
      }
      return payload as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DOMException && error.name === "AbortError")
        throw new ApiError("The server took too long to respond.");
      throw new ApiError(
        error instanceof Error
          ? error.message
          : "The server could not be reached.",
      );
    } finally {
      window.clearTimeout(timeout);
    }
  }

  runtime(): Promise<RuntimeConfig> {
    return this.request<RuntimeConfig>("/api/runtime");
  }

  async goals(): Promise<GoalDefinition[]> {
    return itemArray<GoalDefinition>(
      await this.request<unknown>("/api/goals"),
      "goals",
      "items",
    );
  }

  ask(input: {
    question: string;
    goals: string[];
    asker: string;
    chat?: string;
  }): Promise<AskResponse> {
    return this.request<AskResponse>("/api/ask", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async questions(
    filters: { bucket?: string; tier?: string; q?: string } = {},
  ): Promise<Question[]> {
    const parameters = new URLSearchParams();
    if (filters.bucket && filters.bucket !== "all")
      parameters.set("bucket", filters.bucket);
    if (filters.tier && filters.tier !== "all")
      parameters.set("tier", filters.tier);
    if (filters.q) parameters.set("q", filters.q);
    const suffix = parameters.size ? `?${parameters.toString()}` : "";
    return normaliseQuestionList(
      await this.request<unknown>(`/api/questions${suffix}`),
    );
  }

  async question(id: string): Promise<Question> {
    return unwrapQuestion(
      await this.request<unknown>(`/api/questions/${encodeURIComponent(id)}`),
    );
  }

  async claim(id: string, answerer: string): Promise<Question> {
    return unwrapQuestion(
      await this.request(`/api/questions/${encodeURIComponent(id)}/claim`, {
        method: "POST",
        body: JSON.stringify({ answerer }),
      }),
    );
  }

  async priority(
    id: string,
    tier: PriorityTier,
    rationale: string,
    by: string,
  ): Promise<Question> {
    return unwrapQuestion(
      await this.request(`/api/questions/${encodeURIComponent(id)}/priority`, {
        method: "POST",
        body: JSON.stringify({ tier, rationale, by }),
      }),
    );
  }

  async addTranscript(
    id: string,
    text: string,
    source: "typed" | "stt" = "typed",
    confidence?: number,
    kind: "transcript" | "correction" = "transcript",
  ): Promise<Question> {
    return unwrapQuestion(
      await this.request(
        `/api/questions/${encodeURIComponent(id)}/transcripts`,
        {
          method: "POST",
          body: JSON.stringify({
            text,
            source,
            kind,
            ...(confidence === undefined ? {} : { confidence }),
          }),
        },
      ),
    );
  }

  questionAction<T = unknown>(
    id: string,
    action: "structure" | "critic" | "integrate" | "accept" | "reject",
    body?: unknown,
  ): Promise<T> {
    return this.request<T>(
      `/api/questions/${encodeURIComponent(id)}/${action}`,
      {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
  }

  async changeRequestAction(
    id: string,
    action: "approve" | "merge",
    body: { by: string; kind?: "answerer" | "maintainer" | "summary" },
  ): Promise<Question> {
    return unwrapQuestion(
      await this.request(
        `/api/questions/${encodeURIComponent(id)}/change-request/${action}`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    );
  }

  changeRequest(id: string): Promise<ChangeRequestInfo> {
    return this.request<ChangeRequestInfo>(
      `/api/change-requests/${encodeURIComponent(id)}`,
    );
  }

  changeRequestReviewAction(
    id: string,
    action: "approve" | "merge",
    body: { by: string; kind?: "answerer" | "maintainer" | "summary" },
  ): Promise<ChangeRequestInfo> {
    return this.request<ChangeRequestInfo>(
      `/api/change-requests/${encodeURIComponent(id)}/${action}`,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  async settings(): Promise<SettingsPayload> {
    return adaptSettings(await this.request<unknown>("/api/settings"));
  }

  async settingSchema(): Promise<SettingDefinition[]> {
    return adaptSettingDefinitions(
      await this.request<unknown>("/api/settings/schema"),
    );
  }

  async settingsSave(
    values: Record<string, SettingValue>,
    scopes: Record<string, SettingScope>,
  ): Promise<SettingsPayload> {
    for (const [key, value] of Object.entries(values)) {
      await this.request("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ key, value, scope: scopes[key] ?? "personal" }),
      });
    }
    return this.settings();
  }

  async providers(): Promise<ProviderStatus[]> {
    return adaptProviders(await this.request<unknown>("/api/providers"));
  }

  providerAction(
    id: string,
    action: "consent" | "connect" | "disconnect" | "test",
    body?: { scope: ProviderConsentScope; granted: boolean },
  ): Promise<unknown> {
    return this.request(`/api/providers/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  maintenance(): Promise<MaintenanceState> {
    return this.request<unknown>("/api/maintenance").then(adaptMaintenance);
  }

  maintenanceRun(): Promise<MaintenanceState> {
    return this.request<unknown>("/api/maintenance/run", {
      method: "POST",
    }).then(adaptMaintenance);
  }

  async agents(): Promise<AgentDefinitionStatus[]> {
    return arrayFrom<AgentDefinitionStatus>(
      await this.request<unknown>("/api/agents"),
      "agents",
    );
  }

  agentFixtures(id: string): Promise<unknown> {
    return this.request(`/api/agents/${encodeURIComponent(id)}/fixtures`, {
      method: "POST",
    });
  }

  agentSmith(input: {
    mode: "create" | "update";
    request: string;
    target?: string;
  }): Promise<unknown> {
    return this.request("/api/agents/agent-smith", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async createAudioSession(
    questionId: string,
    mimeType: string,
  ): Promise<{ id: string }> {
    return this.request<{ id: string }>("/api/audio/sessions", {
      method: "POST",
      body: JSON.stringify({ questionId, mimeType }),
    });
  }

  uploadAudioChunk(
    sessionId: string,
    sequence: number,
    chunk: Blob,
  ): Promise<unknown> {
    return this.request(
      `/api/audio/sessions/${encodeURIComponent(sessionId)}/chunks/${sequence}`,
      {
        method: "PUT",
        body: chunk,
        headers: { "content-type": "application/octet-stream" },
      },
    );
  }

  finalizeAudioSession(
    sessionId: string,
  ): Promise<{ status: string; transcript?: string }> {
    return this.request(
      `/api/audio/sessions/${encodeURIComponent(sessionId)}/finalize`,
      { method: "POST" },
    );
  }

  subscribe(
    onEvent: (event: StreamEvent) => void,
    onConnection: (connected: boolean) => void,
  ): () => void {
    if (this.clientDemo) {
      onConnection(true);
      const timer = window.setInterval(
        () => onEvent({ type: "heartbeat", at: new Date().toISOString() }),
        30_000,
      );
      return () => window.clearInterval(timer);
    }
    const source = new EventSource(this.url("/api/events"));
    source.onopen = () => onConnection(true);
    source.onerror = () => onConnection(false);
    source.onmessage = (message) => {
      try {
        onEvent(adaptStreamEvent(JSON.parse(message.data)));
      } catch {
        onEvent({ type: "message", text: message.data });
      }
    };
    const namedEvents = [
      "question",
      "audio",
      "maintenance",
      "provider",
      "settings",
      "transcript.partial",
      "transcript.final",
      "question.updated",
      "maintenance.updated",
      "provider.updated",
      "settings.updated",
    ];
    for (const name of namedEvents) {
      source.addEventListener(name, (message) => {
        try {
          onEvent(
            adaptStreamEvent(
              JSON.parse((message as MessageEvent<string>).data),
              name,
            ),
          );
        } catch {
          onEvent({ type: name, text: (message as MessageEvent<string>).data });
        }
      });
    }
    return () => source.close();
  }
}
