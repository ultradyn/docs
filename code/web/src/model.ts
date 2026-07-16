import type {
  ChangeRequestInfo,
  Finding,
  PriorityTier,
  Question,
  QuestionState,
  SettingDefinition,
  SettingScope,
} from "./types.js";

export type { SettingDefinition } from "./types.js";

const priorities: PriorityTier[] = ["P1", "P2", "P3", "P4", "P5"];
const states: QuestionState[] = [
  "asked",
  "logged",
  "active",
  "deferred",
  "in-answer",
  "integrating",
  "merged",
  "accepted",
  "reopened",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normaliseFindings(
  record: Record<string, unknown>,
): Finding[] | undefined {
  if (Array.isArray(record.findings)) return record.findings as Finding[];
  if (!isRecord(record.evaluation)) return undefined;
  const findings: Finding[] = Array.isArray(record.evaluation.goalResults)
    ? (record.evaluation.goalResults as Finding[]).map((finding) => ({
        ...finding,
      }))
    : [];
  if (Array.isArray(record.evaluation.contradictions)) {
    for (const contradiction of record.evaluation.contradictions) {
      if (typeof contradiction === "string") {
        findings.push({
          goal: "documentation",
          status: "contradiction",
          rationale: contradiction,
        });
      }
    }
  }
  if (Array.isArray(record.evaluation.deferredChildren)) {
    for (const child of record.evaluation.deferredChildren) {
      if (!isRecord(child)) continue;
      const childId = stringValue(child.id);
      findings.push({
        goal: stringList(child.goals)[0] ?? "documentation",
        status: "deferred",
        rationale: stringValue(
          child.rationale,
          "Additional detail was deferred without blocking this answer.",
        ),
        question: stringValue(
          child.title,
          stringValue(child.rawQuestion, "Deferred child question"),
        ),
        ...(childId ? { childQuestionId: childId } : {}),
      });
    }
  }
  return findings;
}

function normaliseChangeRequest(value: unknown): ChangeRequestInfo | undefined {
  if (!isRecord(value)) return undefined;
  const state = stringValue(value.state);
  if (!["open", "approved", "merged", "blocked"].includes(state))
    return undefined;
  const checks = Array.isArray(value.checks)
    ? value.checks.flatMap((check) =>
        isRecord(check) &&
        (check.status === "passed" || check.status === "failed")
          ? [
              {
                id: stringValue(check.id, "check"),
                label: stringValue(check.label, stringValue(check.id, "Check")),
                status: check.status as "passed" | "failed",
                detail: stringValue(check.detail),
              },
            ]
          : [],
      )
    : [];
  const approvals = Array.isArray(value.approvals)
    ? value.approvals.flatMap((approval) =>
        isRecord(approval) &&
        typeof approval.by === "string" &&
        (approval.kind === "answerer" ||
          approval.kind === "maintainer" ||
          approval.kind === "summary") &&
        typeof approval.at === "string"
          ? [
              {
                by: approval.by,
                kind: approval.kind as "answerer" | "maintainer" | "summary",
                at: approval.at,
              },
            ]
          : [],
      )
    : [];
  return {
    id: stringValue(value.id, "cr-unknown"),
    state: state as ChangeRequestInfo["state"],
    branch: stringValue(value.branch),
    summary: stringValue(value.summary),
    diff: stringValue(value.diff),
    checks,
    approvals,
    createdAt: stringValue(value.createdAt, new Date(0).toISOString()),
    updatedAt: stringValue(value.updatedAt, new Date(0).toISOString()),
  };
}

export function normaliseQuestion(value: unknown): Question {
  const record = isRecord(value) ? value : {};
  const title = stringValue(
    record.title,
    stringValue(record.question, "Untitled question"),
  );
  const tierCandidate = stringValue(
    record.tier,
    stringValue(record.priority, "P3"),
  ) as PriorityTier;
  const stateCandidate = stringValue(record.state, "active") as QuestionState;
  const id = stringValue(record.id, "q-unknown");
  const createdAt = stringValue(
    record.createdAt,
    stringValue(record.created, new Date(0).toISOString()),
  );
  const provenance = isRecord(record.provenance)
    ? {
        ...(typeof record.provenance.kind === "string"
          ? { kind: record.provenance.kind as "raw" | "generated" }
          : {}),
        ...(typeof record.provenance.parent === "string"
          ? { parent: record.provenance.parent }
          : {}),
        ...(typeof record.provenance.finding === "string"
          ? { finding: record.provenance.finding }
          : {}),
        ...(typeof record.provenance.goal === "string"
          ? { goal: record.provenance.goal }
          : {}),
      }
    : Array.isArray(record.provenance)
      ? {
          kind: stringList(record.tags).includes("generated")
            ? ("generated" as const)
            : ("raw" as const),
        }
      : undefined;
  const askerSource = Array.isArray(record.askerDetails)
    ? record.askerDetails
    : record.askers;
  const askers = Array.isArray(askerSource)
    ? askerSource.flatMap((asker) =>
        typeof asker === "string"
          ? [{ name: asker }]
          : isRecord(asker) &&
              (typeof asker.name === "string" || typeof asker.id === "string")
            ? [
                {
                  name: stringValue(
                    asker.name,
                    stringValue(asker.id, "unknown"),
                  ),
                  ...(typeof asker.id === "string" ? { id: asker.id } : {}),
                  ...(typeof asker.status === "string" ||
                  typeof asker.acceptance === "string"
                    ? {
                        status: stringValue(
                          asker.status,
                          String(asker.acceptance),
                        ),
                      }
                    : {}),
                },
              ]
            : [],
      )
    : undefined;
  const transcript =
    typeof record.transcript === "string"
      ? record.transcript
      : Array.isArray(record.transcripts)
        ? record.transcripts
            .flatMap((item) =>
              isRecord(item) && typeof item.text === "string"
                ? [item.text]
                : [],
            )
            .join("\n\n")
        : undefined;
  const findings = normaliseFindings(record);
  const changeRequest = normaliseChangeRequest(record.changeRequest);

  return {
    id,
    title,
    question: stringValue(
      record.question,
      stringValue(record.rawQuestion, title),
    ),
    state: states.includes(stateCandidate) ? stateCandidate : "active",
    tier: priorities.includes(tierCandidate) ? tierCandidate : "P3",
    goals: stringList(record.goals),
    tags: stringList(record.tags),
    createdAt,
    ...(typeof record.updatedAt === "string"
      ? { updatedAt: record.updatedAt }
      : typeof record.updated === "string"
        ? { updatedAt: record.updated }
        : {}),
    ...(typeof record.revision === "number"
      ? { revision: record.revision }
      : {}),
    ...(typeof record.rationale === "string"
      ? { rationale: record.rationale }
      : {}),
    ...(typeof record.chat === "string" ? { chat: record.chat } : {}),
    ...(typeof record.rawQuestion === "string"
      ? { rawQuestion: record.rawQuestion }
      : {}),
    ...(transcript ? { transcript } : {}),
    ...(typeof record.structuredAnswer === "string"
      ? { structuredAnswer: record.structuredAnswer }
      : {}),
    ...(provenance ? { provenance } : {}),
    ...(findings ? { findings } : {}),
    ...(askers ? { askers } : {}),
    ...(changeRequest ? { changeRequest } : {}),
  };
}

export function normaliseQuestionList(value: unknown): Question[] {
  const source = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : isRecord(value) && Array.isArray(value.questions)
        ? value.questions
        : [];
  return source.map(normaliseQuestion);
}

export function sortQuestions(questions: Question[]): Question[] {
  return [...questions].sort((left, right) => {
    const priority =
      priorities.indexOf(left.tier) - priorities.indexOf(right.tier);
    return (
      priority ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id)
    );
  });
}

export interface SettingsFilter {
  query: string;
  scope: SettingScope | "all";
  category: string | "all";
}

export function filterSettings(
  definitions: SettingDefinition[],
  filter: SettingsFilter,
): SettingDefinition[] {
  const query = filter.query.trim().toLocaleLowerCase();
  return definitions.filter((definition) => {
    if (filter.scope !== "all" && definition.scope !== filter.scope)
      return false;
    if (filter.category !== "all" && definition.category !== filter.category)
      return false;
    if (!query) return true;
    const haystack = [
      definition.key,
      definition.label,
      definition.description,
      definition.category,
      definition.scope,
    ]
      .join(" ")
      .toLocaleLowerCase();
    return haystack.includes(query);
  });
}

export type RecorderState =
  | "idle"
  | "requesting"
  | "recording"
  | "paused"
  | "finalising"
  | "complete"
  | "failed";

export function recorderLabel(state: RecorderState): string {
  return {
    idle: "Ready to record",
    requesting: "Requesting microphone access",
    recording: "Recording and uploading",
    paused: "Recording paused",
    finalising: "Saving and transcribing",
    complete: "Recording saved",
    failed: "Recording needs attention",
  }[state];
}

export function formatRelativeTime(value?: string): string {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  const seconds = Math.round((date.valueOf() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function readableState(state: string): string {
  return state
    .replaceAll("-", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
