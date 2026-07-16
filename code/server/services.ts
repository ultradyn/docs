import type {
  AskResult,
  AgentDefinitionStatus,
  AgentFixtureResult,
  AgentSmithResult,
  ChangeRequestInfo,
  GoalDefinition,
  MaintenanceTask,
  PriorityTier,
  ProviderConsentScope,
  ProviderStatus,
  QuestionDetail,
  QuestionSummary,
  SettingDescriptor,
  SettingScope,
  SettingValue,
} from "../shared/index.js";

export interface QuestionQuery {
  bucket?: "active" | "deferred" | "answered" | undefined;
  tier?: PriorityTier | undefined;
  q?: string | undefined;
}

export interface AskInput {
  question: string;
  goals: string[];
  asker: string;
  chat?: string | undefined;
}

export interface UltradynServices {
  goals: {
    list(): Promise<GoalDefinition[]>;
  };
  ask(input: AskInput): Promise<AskResult>;
  questions: {
    list(query: QuestionQuery): Promise<QuestionSummary[]>;
    get(id: string): Promise<QuestionDetail | undefined>;
    claim(id: string, answerer: string): Promise<QuestionDetail>;
    setPriority(
      id: string,
      tier: PriorityTier,
      rationale: string,
      by: string,
    ): Promise<QuestionDetail>;
    addTranscript(
      id: string,
      input: {
        text: string;
        source: "typed" | "stt";
        confidence?: number | undefined;
        kind?: "transcript" | "correction" | undefined;
      },
    ): Promise<QuestionDetail>;
    structure(id: string): Promise<QuestionDetail>;
    critic(id: string): Promise<QuestionDetail>;
    integrate(id: string): Promise<QuestionDetail>;
    approveChangeRequest(
      id: string,
      input: { by: string; kind: "answerer" | "maintainer" | "summary" },
    ): Promise<QuestionDetail>;
    mergeChangeRequest(id: string, by: string): Promise<QuestionDetail>;
    accept(id: string, asker: string): Promise<QuestionDetail>;
    reject(id: string, asker: string, reason: string): Promise<QuestionDetail>;
  };
  settings: {
    schema(): Promise<SettingDescriptor[]>;
    values(): Promise<SettingValue[]>;
    set(
      key: string,
      value: unknown,
      scope: SettingScope,
    ): Promise<SettingValue>;
  };
  providers: {
    list(): Promise<ProviderStatus[]>;
    consent(
      id: string,
      scope: ProviderConsentScope,
      granted: boolean,
    ): Promise<ProviderStatus>;
    connect(id: string): Promise<ProviderStatus>;
    disconnect(
      id: string,
      scope: ProviderConsentScope,
    ): Promise<ProviderStatus>;
    test(id: string): Promise<{ ok: boolean; detail: string }>;
  };
  agents: {
    list(): Promise<AgentDefinitionStatus[]>;
    validate(id: string): Promise<AgentFixtureResult>;
    propose(input: {
      mode: "create" | "update";
      request: string;
      target?: string;
    }): Promise<AgentSmithResult>;
  };
  changeRequests: {
    list(): Promise<ChangeRequestInfo[]>;
    get(id: string): Promise<ChangeRequestInfo | undefined>;
    approve(
      id: string,
      input: { by: string; kind: "answerer" | "maintainer" | "summary" },
    ): Promise<ChangeRequestInfo>;
    merge(id: string, by: string): Promise<ChangeRequestInfo>;
  };
  audio: {
    create(input: {
      questionId: string;
      mimeType: string;
    }): Promise<{ id: string; state: string }>;
    append(
      id: string,
      sequence: number,
      bytes: Uint8Array,
    ): Promise<{ sequence: number; durableBytes: number }>;
    finalize(id: string): Promise<{
      id: string;
      state: string;
      chunks: number;
      path?: string;
      transcript?: string;
    }>;
  };
  maintenance: {
    list(): Promise<MaintenanceTask[]>;
    run(): Promise<MaintenanceTask[]>;
  };
}

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
