/**
 * T-31-03 — Combined-versus-split evidence role ablation (optional, non-gating).
 *
 * WHAT THIS CAN AND CANNOT CONCLUDE — read before quoting any output.
 *
 * The plan requires a FALSIFIABLE decision: retain-split or revisit. So the
 * decision rule is published as frozen data (ABLATION_DECISION_RULE), fixed
 * independently of any particular dataset. A rule chosen after seeing the
 * numbers would confirm whatever was already built, which is the failure mode
 * this kind of task invites.
 *
 * HONEST LIMIT: inputs are RECORDED report JSON. The plan forbids adding a
 * combined role to production, so there is no live combined-role agent to run.
 * With hand-authored or pilot-scale reports this module verifies the COMPARISON
 * MACHINERY and the decision rule — it does NOT by itself settle whether the
 * split role is architecturally justified. That needs real recorded runs of
 * both configurations on identical corpus and model versions.
 *
 * Consequently every result carries its own `limitations`, so a reader quoting
 * the decision cannot strip the context it came from.
 *
 * Version binding is refused rather than warned: comparing runs from different
 * corpora, models or prompts is not a comparison, it is two unrelated
 * measurements printed side by side. That is worse than no measurement because
 * it looks like evidence.
 *
 * NON-GATING (plan N5): no core or release-gating task may depend on this. A
 * "revisit" decision is an input to a human decision about ADR-0005, never an
 * automatic change.
 */
import type { IngestResult } from "../domain/ingest/types.js";

// ---------------------------------------------------------------------------
// Decision rule — FROZEN, and deliberately capable of returning "revisit"
// ---------------------------------------------------------------------------

/**
 * Fixed before measurement. The split role must EARN its extra cost:
 * - materially fewer false acceptances, AND
 * - materially better refinement quality, AND
 * - not cost disproportionately more than the combined baseline.
 *
 * If the split role cannot clear these, the honest answer is "revisit" — the
 * acceptance criterion says material gain OR BE REVISITED, and a rule that
 * cannot produce the second outcome makes that criterion unmeetable.
 */
export const ABLATION_DECISION_RULE = Object.freeze({
  /** Absolute reduction in false-acceptance rate the split must achieve. */
  minFalseAcceptanceReduction: 0.05,
  /** Absolute gain in refinement quality the split must achieve. */
  minRefinementQualityGain: 0.1,
  /** Split may cost at most this multiple of the combined baseline. */
  maxCostMultiple: 3,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EvidenceRole = "split" | "combined";

export type RoleRunReport = {
  readonly role: EvidenceRole;
  readonly corpusSha256: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly falseAcceptances: number;
  readonly totalJudgements: number;
  readonly refinementsUseful: number;
  readonly refinementsTotal: number;
  readonly childBranches: number;
  readonly parentQuestions: number;
  readonly costAud: number;
  /** Outputs from repeated runs; identical repeats mean stable output. */
  readonly outputsByRepeat: readonly (readonly string[])[];
};

export type RoleMetrics = {
  readonly falseAcceptance: number;
  readonly refinementQuality: number;
  readonly branchFactor: number;
  readonly costAud: number;
  readonly outputStability: number;
};

export type AblationResult = {
  readonly split: RoleMetrics;
  readonly combined: RoleMetrics;
  readonly decision: "retain-split" | "revisit";
  readonly rationale: string;
  readonly limitations: readonly string[];
};

export type AblationError =
  | "INVALID_INPUT"
  | "VERSION_MISMATCH"
  | "INSUFFICIENT_DATA";

const FIXED_MESSAGES: Record<AblationError, string> = {
  INVALID_INPUT: "Ablation input is invalid.",
  VERSION_MISMATCH:
    "Reports do not share corpus, model and prompt versions; they are not comparable.",
  INSUFFICIENT_DATA:
    "A required denominator is zero; no rate can be computed honestly.",
};

function failure(code: AblationError): IngestResult<never, AblationError> {
  return Object.freeze({ ok: false as const, code, message: FIXED_MESSAGES[code] });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) for (const item of value) deepFreeze(item);
    else for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isReport(value: unknown): value is RoleRunReport {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<RoleRunReport>;
  return (
    (r.role === "split" || r.role === "combined") &&
    typeof r.corpusSha256 === "string" &&
    typeof r.modelVersion === "string" &&
    typeof r.promptVersion === "string" &&
    typeof r.falseAcceptances === "number" &&
    typeof r.totalJudgements === "number" &&
    typeof r.refinementsUseful === "number" &&
    typeof r.refinementsTotal === "number" &&
    typeof r.childBranches === "number" &&
    typeof r.parentQuestions === "number" &&
    typeof r.costAud === "number" &&
    Array.isArray(r.outputsByRepeat)
  );
}

/**
 * Stability = fraction of repeats whose output matches the first repeat.
 * A single repeat cannot demonstrate stability, so it is INSUFFICIENT_DATA
 * rather than a confident 1.0.
 */
function stability(outputsByRepeat: readonly (readonly string[])[]): number {
  const first = JSON.stringify(outputsByRepeat[0]);
  let same = 0;
  for (const repeat of outputsByRepeat) {
    if (JSON.stringify(repeat) === first) same += 1;
  }
  return same / outputsByRepeat.length;
}

function metrics(report: RoleRunReport): RoleMetrics | undefined {
  if (
    report.totalJudgements <= 0 ||
    report.refinementsTotal <= 0 ||
    report.parentQuestions <= 0 ||
    report.outputsByRepeat.length < 2
  ) {
    return undefined;
  }
  return {
    falseAcceptance: report.falseAcceptances / report.totalJudgements,
    refinementQuality: report.refinementsUseful / report.refinementsTotal,
    branchFactor: report.childBranches / report.parentQuestions,
    costAud: report.costAud,
    outputStability: stability(report.outputsByRepeat),
  };
}

export function compareEvidenceRoles(
  a: unknown,
  b: unknown,
): IngestResult<AblationResult, AblationError> {
  if (!isReport(a) || !isReport(b)) return failure("INVALID_INPUT");
  // Two reports of the same role is a repeat, not an ablation.
  if (a.role === b.role) return failure("INVALID_INPUT");

  // Refuse rather than warn: incomparable inputs produce a number that looks
  // like a finding and is not one.
  if (
    a.corpusSha256 !== b.corpusSha256 ||
    a.modelVersion !== b.modelVersion ||
    a.promptVersion !== b.promptVersion
  ) {
    return failure("VERSION_MISMATCH");
  }

  const splitReport = a.role === "split" ? a : b;
  const combinedReport = a.role === "combined" ? a : b;
  const split = metrics(splitReport);
  const combined = metrics(combinedReport);
  if (!split || !combined) return failure("INSUFFICIENT_DATA");

  const falseAcceptanceReduction =
    combined.falseAcceptance - split.falseAcceptance;
  const refinementQualityGain =
    split.refinementQuality - combined.refinementQuality;
  const costMultiple =
    combined.costAud > 0 ? split.costAud / combined.costAud : Infinity;

  const earnsItsCost =
    falseAcceptanceReduction >= ABLATION_DECISION_RULE.minFalseAcceptanceReduction &&
    refinementQualityGain >= ABLATION_DECISION_RULE.minRefinementQualityGain &&
    costMultiple <= ABLATION_DECISION_RULE.maxCostMultiple;

  const decision = earnsItsCost ? "retain-split" : "revisit";

  return Object.freeze({
    ok: true as const,
    value: deepFreeze({
      split,
      combined,
      decision,
      rationale: earnsItsCost
        ? "Split role reduced false acceptance and improved refinement quality within the cost bound."
        : "Split role did not clear at least one of: false-acceptance reduction, refinement-quality gain, cost bound.",
      limitations: [
        "Computed from RECORDED reports, not live combined-role runs; the plan forbids a combined role in production.",
        "Verifies the comparison machinery and decision rule; does not by itself settle the architecture question.",
        "Non-gating (plan N5): a revisit decision is input to a human ADR-0005 decision, never an automatic change.",
      ],
    }) as AblationResult,
  });
}
