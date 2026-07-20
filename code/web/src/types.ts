export type PriorityTier = "P1" | "P2" | "P3" | "P4" | "P5";
export type QuestionState =
  | "asked"
  | "logged"
  | "active"
  | "deferred"
  | "in-answer"
  | "integrating"
  | "merged"
  | "accepted"
  | "reopened";

export interface RuntimeConfig {
  maintenanceEnabled: boolean;
  demoMode: boolean;
  repoRoot: string;
  version: string;
  offline?: boolean;
}

export interface GoalDefinition {
  id: string;
  label: string;
  description: string;
}

export interface Citation {
  path: string;
  title?: string;
  line?: number;
  excerpt?: string;
}

export type GoalStatus =
  "satisfied" | "unsatisfied" | "uncertain" | "deferred" | "contradiction";

export interface GoalResult {
  goal: string;
  status: GoalStatus;
  rationale: string;
}

export interface Finding extends GoalResult {
  id?: string;
  question?: string;
  childQuestionId?: string;
}

export interface ChangeRequestCheck {
  id: string;
  label: string;
  status: "passed" | "failed";
  detail: string;
}

export interface ChangeRequestInfo {
  id: string;
  state: "open" | "approved" | "merged" | "blocked" | "superseded";
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

export interface Question {
  id: string;
  title: string;
  question: string;
  state: QuestionState;
  tier: PriorityTier;
  goals: string[];
  tags: string[];
  createdAt: string;
  updatedAt?: string;
  revision?: number;
  rationale?: string;
  chat?: string;
  rawQuestion?: string;
  askers?: Array<{ id?: string; name: string; status?: string }>;
  provenance?: {
    kind?: "raw" | "generated";
    parent?: string;
    finding?: string;
    goal?: string;
  };
  transcript?: string;
  structuredAnswer?: string;
  findings?: Finding[];
  changeRequest?: ChangeRequestInfo;
}

export interface AskAnswer {
  kind: "answer";
  answer: string;
  citations: Citation[];
  goalResults: GoalResult[];
}

export interface AskLogged {
  kind: "logged";
  question: Question;
  partialAnswer?: string;
  citations?: Citation[];
}

export type AskResponse = AskAnswer | AskLogged;

export type SettingScope = "repo" | "personal";
export type SettingValue = string | number | boolean | string[];

export interface SettingDefinition {
  key: string;
  label: string;
  description: string;
  category: string;
  scope: SettingScope;
  type: "boolean" | "string" | "number" | "select" | "multiselect";
  defaultValue: SettingValue;
  options?: Array<{ value: string; label: string }>;
  sensitive?: boolean;
  restartRequired?: boolean;
}

export interface SettingsPayload {
  values: Record<string, SettingValue>;
  definitions?: SettingDefinition[];
}

export type ProviderAvailability =
  "available" | "unavailable" | "blocked" | "activation_required";
export type ProviderConnection =
  "connected" | "disconnected" | "connecting" | "error";

export type ProviderConsentScope = "model" | "transcription" | "git-host";

export interface ProviderConsentScopeStatus {
  scope: ProviderConsentScope;
  consent: "required" | "granted" | "denied" | "revoked";
  availability: "unknown" | "available" | "unavailable";
  reason?: string;
}

export interface ProviderStatus {
  id: string;
  kind: "model" | "stt" | "git" | "codec" | "credential";
  label: string;
  description?: string;
  availability: ProviderAvailability;
  connection: ProviderConnection;
  consent: "required" | "granted" | "denied";
  consentScopes?: ProviderConsentScopeStatus[];
  reason?: string;
  capabilities?: string[];
  activationChecklist?: string[];
  credentialSources?: string[];
  selectedSource?: string;
  fake?: boolean;
  oauth?: boolean;
}

export interface MaintenanceTask {
  id: string;
  kind: string;
  title: string;
  detail?: string;
  status: "ready" | "claimed" | "blocked" | "complete";
  repository?: string;
  updatedAt?: string;
}

export interface MaintenanceState {
  enabled: boolean;
  polling: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  intervalSeconds?: number;
  tasks: MaintenanceTask[];
  pendingCheckpoints?: number;
  cursors?: Array<{ source: string; status: string; updatedAt?: string }>;
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
  schemaStatus?: "valid" | "invalid";
  capabilities?: string[];
}

export interface StreamEvent {
  type: string;
  questionId?: string;
  sessionId?: string;
  text?: string;
  status?: string;
  payload?: unknown;
  at?: string;
}
