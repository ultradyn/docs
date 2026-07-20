/**
 * T-30-03 — Offline Researcher retrieval calibration (optional, non-gating).
 *
 * HONESTY:
 * - Labels are committed expected-graph evidenceUnitIds (tiny/small), independent
 *   of this scorer. Not dual-live-labeller; pilot-scale only.
 * - Calibration can always succeed by moving the target: floors are set ONLY after
 *   measured live MiniSearch runs (see docs/engineering/researcher-retrieval-profile.md).
 * - Precision is REPORT-ONLY — gating it would punish over-retrieval (safe direction).
 * - queryExpansion default is FALSE because measured expansion produced zero recall
 *   gain on this labeled set (not a "cautious feeling" default).
 * - No production task under code/ingest may import this module.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import MiniSearch from "minisearch";

import { processLexicalTerm } from "../ingest/retrieval/stem-term.js";

// ---------------------------------------------------------------------------
// Profile + measured pins (re-measured 2026-07-20 after B005 stemmer)
// ---------------------------------------------------------------------------

export type RetrievalProfile = {
  readonly version: string;
  readonly maxCandidates: number;
  readonly maxOpenedUnits: number;
  readonly queryExpansion: boolean;
  readonly rerank: false;
};

/**
 * Measured on tiny+small expected graphs (SHAs below) with live MiniSearch +
 * symmetric Porter processTerm (B005 stemmer@2.0.1):
 * TP=8 FN=1 → recall 8/9 ≈ 0.8889; false-no-evidence 0/6.
 * Expansion ON still does not recover the residual FN.
 *
 * THIS PROFILE MISSES 1 OF 9 LABELED PAIRS (small-unit-18 only).
 * small-unit-22 recovered via morphology stemming (capabilities/capability,
 * locally/local, operate/operation). small-unit-18 has ZERO lexical overlap
 * with the local question — needs semantic/vector retrieval (R1 excludes).
 * Precision is re-measured with stemming (stemming raises recall AND noise);
 * report-only, not gated. See docs/engineering/researcher-retrieval-profile.md.
 */
export const RESEARCHER_RETRIEVAL_PROFILE_V1: RetrievalProfile = Object.freeze({
  version: "researcher-retrieval-v1",
  maxCandidates: 8,
  maxOpenedUnits: 8,
  queryExpansion: false,
  rerank: false,
});

/** Minimum recall; exact TP pin below is the real regression guard. */
export const RESEARCHER_RECALL_FLOOR = 0.7 as const;

/** Exact measured true positives after B005 stemmer (was 7 pre-stem). */
export const RESEARCHER_RECALL_TP_PIN = 8 as const;
export const RESEARCHER_RECALL_LABELED_PAIRS = 9 as const;
export const RESEARCHER_ANSWERABLE_PIN = 6 as const;
export const RESEARCHER_FALSE_NO_EVIDENCE_PIN = 0 as const;

/** Sole remaining lexical FN after B005 — zero-overlap semantic residual. */
export const RESEARCHER_FALSE_NEGATIVE_UNIT_IDS = Object.freeze([
  "small-unit-18",
] as const);

export const CORPUS_GRAPH_SHA256 = Object.freeze({
  tiny: "a6261cedc3818bd09d2acee02cb92e9d6fe5d0aa9a12aaf0c9a40e167f7cdfdc",
  small: "a539b027ed0e8d39f3b986fbbab58581d54919791b7ecf48664a4b20f720c9c8",
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CalibrationCase = {
  readonly caseId: string;
  readonly corpus: "tiny" | "small";
  readonly questionType: string;
  readonly questionText: string;
  readonly relevantUnitIds: readonly string[];
};

export type CalibrationMetrics = {
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
  /** Sorted unique labeled unit ids that were not selected (the named gap set). */
  readonly falseNegativeUnitIds: readonly string[];
  readonly labeledRelevantPairCount: number;
  readonly answerableQuestionCount: number;
  readonly falseNoEvidenceCount: number;
  readonly recall: number;
  readonly precision: number;
  readonly falseNoEvidenceRate: number;
  readonly byQuestionType: Readonly<
    Record<
      string,
      {
        readonly tp: number;
        readonly fp: number;
        readonly fn: number;
        readonly labeledPairs: number;
        readonly recall: number;
        readonly precision: number;
      }
    >
  >;
};

export type ProfileDiff = {
  readonly recallDelta: number;
  readonly precisionDelta: number;
  readonly falseNoEvidenceDelta: number;
  readonly tpDelta: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function sectionText(fileText: string, locator: string): string {
  const heading = locator.startsWith("#")
    ? locator.replace(/^#+\s*/, "").trim()
    : locator;
  const lines = fileText.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (heading && lines[i]!.includes(heading)) {
      start = i;
      break;
    }
  }
  if (start < 0) return fileText;
  const out = [lines[start]!];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,3}\s/.test(lines[i]!)) break;
    out.push(lines[i]!);
  }
  return out.join("\n");
}

const STOP = new Set(
  "the a an does where what how for of to and or in is keep without do we use which".split(
    " ",
  ),
);

/** Domain synonym expansion — query-side only (no label leakage). */
export function expandQuery(query: string): string {
  const toks = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => !STOP.has(t) && t.length > 2,
  );
  const syn: Record<string, readonly string[]> = {
    atlas: ["project", "portable", "documentation"],
    knowledge: ["documentation", "docs", "project"],
    portable: ["git", "committed", "documentation"],
    settings: ["configuration", "procedure", "apply", "restart"],
    apply: ["settings", "procedure", "project"],
    export: ["legacy", "bundle", "download"],
    legacy: ["export", "old"],
    custody: ["raw", "artifact", "immutable", "snapshot"],
    raw: ["artifact", "immutable", "custody"],
    lifecycle: ["state", "pending", "answered", "closed"],
    state: ["lifecycle", "pending", "answered"],
    machine: ["index", "rebuild", "local"],
    index: ["machine", "rebuild", "projection"],
    local: ["machine", "index", "settings"],
  };
  const extra: string[] = [];
  for (const t of toks) {
    const s = syn[t];
    if (s) extra.push(...s);
  }
  return [...new Set([query, ...toks, ...extra])].join(" ");
}

function inferQuestionType(caseId: string): string {
  const m = caseId.match(/question-([a-z0-9-]+)$/i);
  return m?.[1] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Load labeled cases + unit docs from corpus fixtures
// ---------------------------------------------------------------------------

export function loadCalibrationCorpus(corpusRoot: string): {
  readonly cases: readonly CalibrationCase[];
  readonly documents: readonly {
    readonly id: string;
    readonly text: string;
    readonly path: string;
  }[];
  readonly graphSha256: { readonly tiny: string; readonly small: string };
} {
  const documents: { id: string; text: string; path: string }[] = [];
  const cases: CalibrationCase[] = [];
  const graphSha256: { tiny: string; small: string } = { tiny: "", small: "" };

  for (const corpus of ["tiny", "small"] as const) {
    const graphPath = join(corpusRoot, corpus, "expected-graph.json");
    const raw = readFileSync(graphPath);
    const digest = sha256Hex(raw);
    graphSha256[corpus] = digest;
    const graph = JSON.parse(raw.toString("utf8")) as {
      files: readonly { id: string; path: string }[];
      units: readonly {
        id: string;
        fileId: string;
        locator: string;
      }[];
      questions: readonly {
        id: string;
        text: string;
        evidenceUnitIds?: readonly string[];
      }[];
    };
    const files = new Map(graph.files.map((f) => [f.id, f]));
    for (const u of graph.units) {
      const f = files.get(u.fileId);
      if (!f) continue;
      const fileText = readFileSync(
        join(corpusRoot, corpus, "source", f.path),
        "utf8",
      );
      documents.push({
        id: u.id,
        text: sectionText(fileText, u.locator),
        path: f.path,
      });
    }
    for (const q of graph.questions) {
      cases.push({
        caseId: q.id,
        corpus,
        questionType: inferQuestionType(q.id),
        questionText: q.text,
        relevantUnitIds: [...(q.evidenceUnitIds ?? [])],
      });
    }
  }

  return {
    cases: Object.freeze(cases),
    documents: Object.freeze(documents),
    graphSha256: Object.freeze(graphSha256),
  };
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

export function scoreRetrieval(
  cases: readonly CalibrationCase[],
  documents: readonly { readonly id: string; readonly text: string; readonly path: string }[],
  profile: RetrievalProfile,
): CalibrationMetrics {
  // B005: same processTerm at index and query (MiniSearch constructor option).
  const mini = new MiniSearch({
    fields: ["text", "path"],
    storeFields: ["id", "path"],
    processTerm: processLexicalTerm,
    searchOptions: { boost: { text: 2 }, fuzzy: 0.15, prefix: true },
  });
  mini.addAll(documents.map((d) => ({ ...d })));

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let falseNoEvidence = 0;
  let answerable = 0;
  let labeledPairs = 0;
  const falseNegativeUnitIds = new Set<string>();
  const byType = new Map<
    string,
    { tp: number; fp: number; fn: number; labeledPairs: number }
  >();

  for (const c of cases) {
    labeledPairs += c.relevantUnitIds.length;
    const bucket = byType.get(c.questionType) ?? {
      tp: 0,
      fp: 0,
      fn: 0,
      labeledPairs: 0,
    };
    bucket.labeledPairs += c.relevantUnitIds.length;

    const query = profile.queryExpansion
      ? expandQuery(c.questionText)
      : c.questionText;
    const hits = mini.search(query);
    const selected = hits
      .map((h) => String(h.id))
      .slice(0, profile.maxCandidates)
      .slice(0, profile.maxOpenedUnits);

    const rel = new Set(c.relevantUnitIds);
    const sel = new Set(selected);
    let ctp = 0;
    let cfp = 0;
    let cfn = 0;
    for (const id of sel) {
      if (rel.has(id)) ctp += 1;
      else cfp += 1;
    }
    for (const id of rel) {
      if (!sel.has(id)) {
        cfn += 1;
        falseNegativeUnitIds.add(id);
      }
    }
    tp += ctp;
    fp += cfp;
    fn += cfn;
    bucket.tp += ctp;
    bucket.fp += cfp;
    bucket.fn += cfn;
    byType.set(c.questionType, bucket);

    if (c.relevantUnitIds.length > 0) {
      answerable += 1;
      if (selected.length === 0) falseNoEvidence += 1;
    }
  }

  const byQuestionType: {
    [type: string]: {
      readonly tp: number;
      readonly fp: number;
      readonly fn: number;
      readonly labeledPairs: number;
      readonly recall: number;
      readonly precision: number;
    };
  } = {};
  for (const [type, b] of [...byType.entries()].sort(([a], [c]) =>
    a.localeCompare(c),
  )) {
    byQuestionType[type] = Object.freeze({
      tp: b.tp,
      fp: b.fp,
      fn: b.fn,
      labeledPairs: b.labeledPairs,
      recall: b.tp + b.fn === 0 ? 0 : b.tp / (b.tp + b.fn),
      precision: b.tp + b.fp === 0 ? 1 : b.tp / (b.tp + b.fp),
    });
  }

  return Object.freeze({
    truePositive: tp,
    falsePositive: fp,
    falseNegative: fn,
    falseNegativeUnitIds: Object.freeze(
      [...falseNegativeUnitIds].sort((a, b) => a.localeCompare(b)),
    ),
    labeledRelevantPairCount: labeledPairs,
    answerableQuestionCount: answerable,
    falseNoEvidenceCount: falseNoEvidence,
    recall: tp + fn === 0 ? 0 : tp / (tp + fn),
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    falseNoEvidenceRate:
      answerable === 0 ? 0 : falseNoEvidence / answerable,
    byQuestionType: Object.freeze(byQuestionType),
  });
}

export function diffMetrics(
  before: CalibrationMetrics,
  after: CalibrationMetrics,
): ProfileDiff {
  return Object.freeze({
    recallDelta: after.recall - before.recall,
    precisionDelta: after.precision - before.precision,
    falseNoEvidenceDelta:
      after.falseNoEvidenceCount - before.falseNoEvidenceCount,
    tpDelta: after.truePositive - before.truePositive,
  });
}

export function assertCorpusPins(graphSha256: {
  readonly tiny: string;
  readonly small: string;
}): void {
  if (graphSha256.tiny !== CORPUS_GRAPH_SHA256.tiny) {
    throw new Error(
      `tiny expected-graph SHA mismatch: ${graphSha256.tiny} !== ${CORPUS_GRAPH_SHA256.tiny}`,
    );
  }
  if (graphSha256.small !== CORPUS_GRAPH_SHA256.small) {
    throw new Error(
      `small expected-graph SHA mismatch: ${graphSha256.small} !== ${CORPUS_GRAPH_SHA256.small}`,
    );
  }
}
