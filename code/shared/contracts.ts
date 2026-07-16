export type PriorityTier = "P1" | "P2" | "P3" | "P4" | "P5";

export type GoalResultStatus =
  "satisfied" | "unsatisfied" | "uncertain" | "deferred";

export interface GoalDefinition {
  id: string;
  label: string;
  description: string;
  criteria: string;
}

export interface Citation {
  path: string;
  title?: string;
  line?: number;
  excerpt?: string;
}

export interface GoalResult {
  goal: string;
  status: GoalResultStatus;
  rationale: string;
}

export interface QuestionSummary {
  id: string;
  title: string;
  state: string;
  bucket: "active" | "deferred" | "answered";
  tier: PriorityTier;
  goals: string[];
  tags: string[];
  askers: string[];
  askerDetails?: Array<{
    id: string;
    name: string;
    acceptance: "pending" | "accepted" | "rejected" | "timed-out";
    decidedAt?: string;
  }>;
  created: string;
  updated: string;
  rationale: string;
}

export interface QuestionDetail extends QuestionSummary {
  rawQuestion: string;
  chat: string;
  provenance: Array<Record<string, unknown>>;
  transcripts: Array<{
    id: string;
    text: string;
    source: "typed" | "stt";
    confidence?: number;
    created: string;
  }>;
  structuredAnswer?: string;
  evaluation?: {
    done: boolean;
    goalResults: GoalResult[];
    contradictions: string[];
    deferredChildren: QuestionSummary[];
  };
  changeRequest?: ChangeRequestInfo;
}

export interface ChangeRequestCheck {
  id: string;
  label: string;
  status: "passed" | "failed";
  detail: string;
}

export interface ChangeRequestInfo {
  id: string;
  state: "open" | "approved" | "merged" | "blocked";
  branch: string;
  summary: string;
  diff: string;
  checks: ChangeRequestCheck[];
  approvals: Array<{
    by: string;
    kind: "answerer" | "maintainer" | "summary";
    at: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDefinitionStatus {
  id: string;
  label: string;
  role: string;
  sourcePath: string;
  dynamic: boolean;
  freshContext: boolean;
  fixtureStatus: "passing" | "failing" | "not_run";
  fixtureCount: number;
  lastFixtureRunAt?: string;
  schemaStatus: "valid" | "invalid";
  capabilities: string[];
}

export interface AgentFixtureResult {
  name: string;
  cases: number;
  valid: boolean;
  errors: string[];
}

export interface AgentSmithResult {
  agent: string;
  changeRequest: ChangeRequestInfo;
}

export type AskResult =
  | {
      kind: "answer";
      answer: string;
      citations: Citation[];
      goalResults: GoalResult[];
    }
  | {
      kind: "logged";
      question: QuestionDetail;
      partialAnswer?: string;
      citations?: Citation[];
    };

export type SettingScope = "repo" | "personal";

export interface SettingDescriptor {
  key: string;
  category: string;
  label: string;
  description: string;
  type: "boolean" | "number" | "string" | "select";
  scope: SettingScope;
  default: unknown;
  options?: Array<{ value: string; label: string }>;
  secret?: boolean;
  restartRequired?: boolean;
}

export interface SettingValue {
  key: string;
  value: unknown;
  scope: SettingScope;
  source: "default" | SettingScope;
}

export const ProviderConsentScopes = [
  "model",
  "transcription",
  "git-host",
] as const;
export type ProviderConsentScope = (typeof ProviderConsentScopes)[number];

export interface ProviderConsentScopeStatus {
  scope: ProviderConsentScope;
  consent: "required" | "granted" | "denied" | "revoked";
  availability: "unknown" | "available" | "unavailable";
  reason?: string;
}

export interface ProviderStatus {
  id: string;
  name: string;
  kind: "llm" | "stt" | "git" | "codec";
  state:
    | "ready"
    | "consent_required"
    | "activation_required"
    | "unavailable"
    | "error";
  source?: string;
  detail: string;
  fakeAvailable: boolean;
  capabilities: string[];
  consentScopes?: ProviderConsentScopeStatus[];
  activationChecklist?: string[];
}

export interface MaintenanceTask {
  id: string;
  kind: "review" | "rereview" | "checkpoint" | "provider" | "drift";
  title: string;
  detail: string;
  status: "open" | "claimed" | "done";
  updated: string;
  url?: string;
}

export interface RuntimeInfo {
  maintenanceEnabled: boolean;
  demoMode: boolean;
  repoRoot: string;
  version: string;
}

export type ServerEvent = {
  id: string;
  type: "question" | "audio" | "maintenance" | "provider" | "settings";
  at: string;
  data: unknown;
};
