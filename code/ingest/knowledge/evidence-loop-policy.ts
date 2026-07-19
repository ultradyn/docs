import { createHash } from "node:crypto";

import type { BoundedFollowUp } from "../../domain/ingest/evidence-verdict.js";
import type { IngestResult, Sha256 } from "../../domain/ingest/index.js";

export type EvidenceLoopRoute =
  "continue" | "search_incomplete" | "human_action";

export type EvidenceLoopServiceError = "INVALID_INPUT";

export type EvidenceLoopBudget = {
  readonly maxRefinements: number;
};

export const DEFAULT_EVIDENCE_LOOP_BUDGET = Object.freeze({
  maxRefinements: 3,
} satisfies EvidenceLoopBudget);

export type EvidenceLoopStep = {
  readonly packetId: string;
  readonly packetVersion: number;
  readonly verdictId: string;
  readonly verdictVersion: number;
  readonly verdict: string;
  readonly followUpRequest: BoundedFollowUp | null;
};

export type EvidenceLoopHistory = {
  readonly questionId: string;
  readonly steps: readonly EvidenceLoopStep[];
};

export type EvidenceLoopHistoryReceipt = {
  readonly packetRefs: readonly {
    readonly packetId: string;
    readonly packetVersion: number;
  }[];
  readonly verdictRefs: readonly {
    readonly verdictId: string;
    readonly verdictVersion: number;
  }[];
};

export type EvidenceLoopDecision = {
  readonly route: EvidenceLoopRoute;
  readonly reason: string;
  readonly refinementCount: number;
  readonly noveltyKey: Sha256 | null;
  readonly historyReceipt: EvidenceLoopHistoryReceipt;
};

const QUESTION_ID = /^q-[0-9A-HJKMNP-TV-Z]{26}$/u;
const PACKET_ID = /^pkt-[0-9A-HJKMNP-TV-Z]{26}$/u;
const VERDICT_ID = /^evv-[0-9A-HJKMNP-TV-Z]{26}$/u;

const TERMINAL_COMPLETE = new Set([
  "accepted",
  "no_supported_answer",
  "search_incomplete",
  "human_authority_required",
  "source_processing_blocked",
  "ambiguous_scope",
  "conflicting_or_deprecated",
]);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) {
      for (const item of value) deepFreeze(item);
    } else {
      for (const child of Object.values(value as object)) deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function ownData(
  object: object,
  key: string,
):
  | { ok: true; present: false }
  | { ok: true; present: true; value: unknown }
  | { ok: false } {
  if (!Reflect.ownKeys(object).includes(key)) {
    return { ok: true, present: false };
  }
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    return { ok: false };
  }
  return { ok: true, present: true, value: descriptor.value };
}

function failure(
  message: string,
): IngestResult<never, EvidenceLoopServiceError> {
  return Object.freeze({
    ok: false as const,
    code: "INVALID_INPUT" as const,
    message,
  });
}

/**
 * Fixed-field novelty fingerprint over search obligation only
 * (missing facets + requiredSearch). Prose `whyCurrentPacketFails` is excluded.
 */
export function canonicalNoveltyKey(followUp: BoundedFollowUp): Sha256 {
  const missingFacetIds = [...followUp.missingFacetIds].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const requiredSearch = followUp.requiredSearch
    ? {
        subject: followUp.requiredSearch.subject,
        scope: followUp.requiredSearch.scope ?? null,
        exclusions: [...(followUp.requiredSearch.exclusions ?? [])].sort(
          (a, b) => (a < b ? -1 : a > b ? 1 : 0),
        ),
      }
    : null;
  const material = [
    ["missingFacetIds", missingFacetIds],
    ["requiredSearch", requiredSearch],
  ] as const;
  return createHash("sha256")
    .update(JSON.stringify(material))
    .digest("hex") as Sha256;
}

function parseFollowUp(value: unknown): BoundedFollowUp | null | "invalid" {
  if (value === null) return null;
  if (!isPlainObject(value)) return "invalid";
  const allowed = new Set([
    "missingFacetIds",
    "requiredSearch",
    "whyCurrentPacketFails",
  ]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol" || !allowed.has(key)) return "invalid";
    if (!ownData(value, key).ok) return "invalid";
  }
  const missingProp = ownData(value, "missingFacetIds");
  const whyProp = ownData(value, "whyCurrentPacketFails");
  if (
    !missingProp.ok ||
    !missingProp.present ||
    !Array.isArray(missingProp.value) ||
    Object.getPrototypeOf(missingProp.value) !== Array.prototype
  ) {
    return "invalid";
  }
  if (
    !whyProp.ok ||
    !whyProp.present ||
    typeof whyProp.value !== "string" ||
    whyProp.value.length === 0 ||
    whyProp.value.length > 2_000
  ) {
    return "invalid";
  }
  const missingFacetIds: string[] = [];
  for (let index = 0; index < missingProp.value.length; index += 1) {
    const item = ownData(missingProp.value as object, String(index));
    if (
      !item.ok ||
      !item.present ||
      typeof item.value !== "string" ||
      item.value.length === 0 ||
      item.value.length > 128
    ) {
      return "invalid";
    }
    missingFacetIds.push(item.value);
  }
  if (missingFacetIds.length > 64) return "invalid";

  let requiredSearch: BoundedFollowUp["requiredSearch"];
  const searchProp = ownData(value, "requiredSearch");
  if (searchProp.ok && searchProp.present) {
    if (!isPlainObject(searchProp.value)) return "invalid";
    const searchAllowed = new Set(["subject", "scope", "exclusions"]);
    for (const key of Reflect.ownKeys(searchProp.value)) {
      if (typeof key === "symbol" || !searchAllowed.has(key)) return "invalid";
      if (!ownData(searchProp.value, key).ok) return "invalid";
    }
    const subjectProp = ownData(searchProp.value, "subject");
    if (
      !subjectProp.ok ||
      !subjectProp.present ||
      typeof subjectProp.value !== "string" ||
      subjectProp.value.length === 0 ||
      subjectProp.value.length > 512
    ) {
      return "invalid";
    }
    const search: {
      subject: string;
      scope?: string;
      exclusions?: string[];
    } = { subject: subjectProp.value };
    const scopeProp = ownData(searchProp.value, "scope");
    if (scopeProp.ok && scopeProp.present) {
      if (
        typeof scopeProp.value !== "string" ||
        scopeProp.value.length === 0 ||
        scopeProp.value.length > 512
      ) {
        return "invalid";
      }
      search.scope = scopeProp.value;
    }
    const exclProp = ownData(searchProp.value, "exclusions");
    if (exclProp.ok && exclProp.present) {
      if (
        !Array.isArray(exclProp.value) ||
        Object.getPrototypeOf(exclProp.value) !== Array.prototype ||
        exclProp.value.length > 64
      ) {
        return "invalid";
      }
      const exclusions: string[] = [];
      for (let index = 0; index < exclProp.value.length; index += 1) {
        const item = ownData(exclProp.value as object, String(index));
        if (
          !item.ok ||
          !item.present ||
          typeof item.value !== "string" ||
          item.value.length === 0 ||
          item.value.length > 512
        ) {
          return "invalid";
        }
        exclusions.push(item.value);
      }
      search.exclusions = exclusions;
    }
    requiredSearch = search;
  }

  return {
    missingFacetIds,
    whyCurrentPacketFails: whyProp.value,
    ...(requiredSearch !== undefined ? { requiredSearch } : {}),
  };
}

function parseStep(value: unknown): EvidenceLoopStep | "invalid" {
  if (!isPlainObject(value)) return "invalid";
  const allowed = new Set([
    "packetId",
    "packetVersion",
    "verdictId",
    "verdictVersion",
    "verdict",
    "followUpRequest",
  ]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol" || !allowed.has(key)) return "invalid";
    if (!ownData(value, key).ok) return "invalid";
  }
  const packetId = ownData(value, "packetId");
  const packetVersion = ownData(value, "packetVersion");
  const verdictId = ownData(value, "verdictId");
  const verdictVersion = ownData(value, "verdictVersion");
  const verdict = ownData(value, "verdict");
  const follow = ownData(value, "followUpRequest");
  if (
    !packetId.ok ||
    !packetId.present ||
    typeof packetId.value !== "string" ||
    !PACKET_ID.test(packetId.value)
  ) {
    return "invalid";
  }
  if (
    !verdictId.ok ||
    !verdictId.present ||
    typeof verdictId.value !== "string" ||
    !VERDICT_ID.test(verdictId.value)
  ) {
    return "invalid";
  }
  if (
    !packetVersion.ok ||
    !packetVersion.present ||
    typeof packetVersion.value !== "number" ||
    !Number.isInteger(packetVersion.value) ||
    packetVersion.value < 1
  ) {
    return "invalid";
  }
  if (
    !verdictVersion.ok ||
    !verdictVersion.present ||
    typeof verdictVersion.value !== "number" ||
    !Number.isInteger(verdictVersion.value) ||
    verdictVersion.value < 1
  ) {
    return "invalid";
  }
  if (
    !verdict.ok ||
    !verdict.present ||
    typeof verdict.value !== "string" ||
    verdict.value.length === 0 ||
    verdict.value.length > 64
  ) {
    return "invalid";
  }
  if (!follow.ok || !follow.present) return "invalid";
  const followUp = parseFollowUp(follow.value);
  if (followUp === "invalid") return "invalid";
  if (verdict.value === "needs_more_evidence" && followUp === null) {
    return "invalid";
  }
  return {
    packetId: packetId.value,
    packetVersion: packetVersion.value,
    verdictId: verdictId.value,
    verdictVersion: verdictVersion.value,
    verdict: verdict.value,
    followUpRequest: followUp,
  };
}

function buildReceipt(
  steps: readonly EvidenceLoopStep[],
): EvidenceLoopHistoryReceipt {
  return deepFreeze({
    packetRefs: Object.freeze(
      steps.map((step) =>
        Object.freeze({
          packetId: step.packetId,
          packetVersion: step.packetVersion,
        }),
      ),
    ),
    verdictRefs: Object.freeze(
      steps.map((step) =>
        Object.freeze({
          verdictId: step.verdictId,
          verdictVersion: step.verdictVersion,
        }),
      ),
    ),
  });
}

function decision(
  route: EvidenceLoopRoute,
  reason: string,
  refinementCount: number,
  noveltyKey: Sha256 | null,
  historyReceipt: EvidenceLoopHistoryReceipt,
): IngestResult<EvidenceLoopDecision, EvidenceLoopServiceError> {
  return Object.freeze({
    ok: true as const,
    value: deepFreeze({
      route,
      reason,
      refinementCount,
      noveltyKey,
      historyReceipt,
    }),
  });
}

/**
 * Pure deterministic evidence-refinement loop policy.
 * No persistence / second ledger — evaluates authoritative history only.
 */
export function evaluateEvidenceLoop(
  historyInput: unknown,
  budgetInput: unknown,
): IngestResult<EvidenceLoopDecision, EvidenceLoopServiceError> {
  if (!isPlainObject(historyInput)) {
    return failure("history must be a plain object.");
  }
  const historyAllowed = new Set(["questionId", "steps"]);
  for (const key of Reflect.ownKeys(historyInput)) {
    if (typeof key === "symbol" || !historyAllowed.has(key)) {
      return failure("Unknown or hostile history fields.");
    }
    if (!ownData(historyInput, key).ok) {
      return failure("Hostile history accessors are rejected.");
    }
  }

  const questionProp = ownData(historyInput, "questionId");
  if (
    !questionProp.ok ||
    !questionProp.present ||
    typeof questionProp.value !== "string" ||
    !QUESTION_ID.test(questionProp.value)
  ) {
    return failure("questionId is malformed.");
  }

  const stepsProp = ownData(historyInput, "steps");
  if (
    !stepsProp.ok ||
    !stepsProp.present ||
    !Array.isArray(stepsProp.value) ||
    Object.getPrototypeOf(stepsProp.value) !== Array.prototype
  ) {
    return failure("steps must be a plain array.");
  }
  if (stepsProp.value.length === 0) {
    return failure("steps must be non-empty.");
  }
  if (stepsProp.value.length > 256) {
    return failure("steps exceed bound.");
  }

  const steps: EvidenceLoopStep[] = [];
  for (let index = 0; index < stepsProp.value.length; index += 1) {
    const item = ownData(stepsProp.value as object, String(index));
    if (!item.ok || !item.present) {
      return failure("Hostile steps entry.");
    }
    const parsed = parseStep(item.value);
    if (parsed === "invalid") {
      return failure(`steps[${index}] is invalid.`);
    }
    steps.push(parsed);
  }

  if (!isPlainObject(budgetInput)) {
    return failure("budget must be a plain object.");
  }
  const budgetAllowed = new Set(["maxRefinements"]);
  for (const key of Reflect.ownKeys(budgetInput)) {
    if (typeof key === "symbol" || !budgetAllowed.has(key)) {
      return failure("Unknown or hostile budget fields.");
    }
    if (!ownData(budgetInput, key).ok) {
      return failure("Hostile budget accessors are rejected.");
    }
  }
  const maxProp = ownData(budgetInput, "maxRefinements");
  if (
    !maxProp.ok ||
    !maxProp.present ||
    typeof maxProp.value !== "number" ||
    !Number.isInteger(maxProp.value) ||
    maxProp.value < 1 ||
    maxProp.value > 1_000
  ) {
    return failure("maxRefinements must be a positive integer.");
  }
  const maxRefinements = maxProp.value;

  const receipt = buildReceipt(steps);
  const refinementSteps = steps.filter(
    (step) => step.verdict === "needs_more_evidence",
  );
  const refinementCount = refinementSteps.length;
  const latest = steps[steps.length - 1]!;

  // Non-refine terminals: loop complete; never rewrite to accepted/no-evidence.
  if (latest.verdict !== "needs_more_evidence") {
    if (
      TERMINAL_COMPLETE.has(latest.verdict) ||
      latest.verdict === "accepted"
    ) {
      return decision(
        "continue",
        `terminal_${latest.verdict}_complete`,
        refinementCount,
        null,
        receipt,
      );
    }
    // Unknown non-refine verdict — still do not synthesize; treat as complete continue
    return decision(
      "continue",
      `terminal_${latest.verdict}_complete`,
      refinementCount,
      null,
      receipt,
    );
  }

  if (latest.followUpRequest === null) {
    return failure("needs_more_evidence requires BoundedFollowUp.");
  }

  const noveltyKey = canonicalNoveltyKey(latest.followUpRequest);

  // Budget exhaustion: refinement count has reached/exceeded max → search_incomplete
  if (refinementCount >= maxRefinements) {
    return decision(
      "search_incomplete",
      "refinement_budget_exhausted",
      refinementCount,
      noveltyKey,
      receipt,
    );
  }

  // Non-novel: latest search obligation already seen in a prior refine
  const priorKeys = new Set<string>();
  for (const step of refinementSteps.slice(0, -1)) {
    if (step.followUpRequest) {
      priorKeys.add(canonicalNoveltyKey(step.followUpRequest));
    }
  }
  if (priorKeys.has(noveltyKey)) {
    return decision(
      "human_action",
      "non_novel_refinement",
      refinementCount,
      noveltyKey,
      receipt,
    );
  }

  return decision(
    "continue",
    "novel_refinement_under_budget",
    refinementCount,
    noveltyKey,
    receipt,
  );
}
