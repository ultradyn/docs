/**
 * T-30-03 — Researcher retrieval calibration tests.
 *
 * Measurement-first: floors and TP pin match live MiniSearch results on the
 * hash-pinned tiny+small expected graphs (see researcher-retrieval-profile.md).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CORPUS_GRAPH_SHA256,
  RESEARCHER_ANSWERABLE_PIN,
  RESEARCHER_FALSE_NO_EVIDENCE_PIN,
  RESEARCHER_FALSE_NEGATIVE_UNIT_IDS,
  RESEARCHER_RECALL_FLOOR,
  RESEARCHER_RECALL_LABELED_PAIRS,
  RESEARCHER_RECALL_TP_PIN,
  RESEARCHER_RETRIEVAL_PROFILE_V1,
  assertCorpusPins,
  diffMetrics,
  expandQuery,
  loadCalibrationCorpus,
  scoreRetrieval,
  type RetrievalProfile,
} from "./researcher-calibration.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpusRoot = join(here, "fixtures", "ingest-corpus");

function load() {
  return loadCalibrationCorpus(corpusRoot);
}

describe("corpus integrity", () => {
  it("pins expected-graph SHAs (silent corpus edit fails)", () => {
    for (const corpus of ["tiny", "small"] as const) {
      const raw = readFileSync(
        join(corpusRoot, corpus, "expected-graph.json"),
      );
      const digest = createHash("sha256").update(raw).digest("hex");
      expect(digest).toBe(CORPUS_GRAPH_SHA256[corpus]);
    }
    const { graphSha256 } = load();
    expect(() => assertCorpusPins(graphSha256)).not.toThrow();
  });

  it("labeled denominators are non-vacuous and match pins", () => {
    const { cases } = load();
    const labeled = cases.reduce((n, c) => n + c.relevantUnitIds.length, 0);
    const answerable = cases.filter((c) => c.relevantUnitIds.length > 0).length;
    expect(labeled).toBe(RESEARCHER_RECALL_LABELED_PAIRS);
    expect(labeled).toBeGreaterThanOrEqual(6);
    expect(answerable).toBe(RESEARCHER_ANSWERABLE_PIN);
    expect(answerable).toBeGreaterThanOrEqual(5);
    expect(cases.length).toBe(7);
  });
});

describe("vacuity guards", () => {
  it("empty label set cannot score perfect recall", () => {
    const metrics = scoreRetrieval(
      [
        {
          caseId: "empty",
          corpus: "tiny",
          questionType: "x",
          questionText: "anything",
          relevantUnitIds: [],
        },
      ],
      [{ id: "u1", text: "hello world", path: "a.md" }],
      RESEARCHER_RETRIEVAL_PROFILE_V1,
    );
    // no labeled pairs → recall defined as 0 (not 1.0)
    expect(metrics.labeledRelevantPairCount).toBe(0);
    expect(metrics.recall).toBe(0);
  });
});

describe("live lexical calibration (v1 profile)", () => {
  it("meets measured recall floor and exact TP pin with fne=0", () => {
    const { cases, documents, graphSha256 } = load();
    assertCorpusPins(graphSha256);
    const metrics = scoreRetrieval(
      cases,
      documents,
      RESEARCHER_RETRIEVAL_PROFILE_V1,
    );

    expect(metrics.labeledRelevantPairCount).toBe(
      RESEARCHER_RECALL_LABELED_PAIRS,
    );
    expect(metrics.answerableQuestionCount).toBe(RESEARCHER_ANSWERABLE_PIN);
    expect(metrics.truePositive).toBe(RESEARCHER_RECALL_TP_PIN);
    expect(metrics.falseNegative).toBe(1); // MISSES 1 OF 9 — unit-18 residual
    expect(metrics.recall).toBeGreaterThanOrEqual(RESEARCHER_RECALL_FLOOR);
    expect(metrics.falseNoEvidenceCount).toBe(
      RESEARCHER_FALSE_NO_EVIDENCE_PIN,
    );
    expect(metrics.falseNoEvidenceRate).toBe(0);
    // precision reported, not gated — stemming raises recall AND noise
    expect(metrics.falsePositive).toBeGreaterThanOrEqual(40);
    expect(metrics.precision).toBeLessThan(0.25);
    // B005: unit-22 must surface (morphology); regression if stemmer unwired
    expect(metrics.falseNegativeUnitIds).not.toContain("small-unit-22");
  });

  it("names the sole remaining under-retrieval miss (local 18; 22 recovered)", () => {
    const { cases, documents } = load();
    const local = cases.find((c) => c.caseId === "small-question-local");
    // Labels still include both 18 and 22 — do not strip 18 to improve the number.
    expect(local?.relevantUnitIds).toEqual(
      expect.arrayContaining(["small-unit-18", "small-unit-22"]),
    );
    // Pin THE gap set, not merely the count — unit-22 must stay recovered.
    const mini = scoreRetrieval(
      cases,
      documents,
      RESEARCHER_RETRIEVAL_PROFILE_V1,
    );
    expect(mini.falseNegative).toBe(1);
    expect([...mini.falseNegativeUnitIds]).toEqual([
      ...RESEARCHER_FALSE_NEGATIVE_UNIT_IDS,
    ]);
    expect(mini.falseNegativeUnitIds).toEqual(["small-unit-18"]);
  });

  it("reports metrics by question type with non-empty types", () => {
    const { cases, documents } = load();
    const metrics = scoreRetrieval(
      cases,
      documents,
      RESEARCHER_RETRIEVAL_PROFILE_V1,
    );
    const types = Object.keys(metrics.byQuestionType);
    expect(types.length).toBeGreaterThanOrEqual(4);
    for (const t of types) {
      const row = metrics.byQuestionType[t]!;
      expect(row.labeledPairs + row.tp + row.fp + row.fn).toBeGreaterThanOrEqual(
        0,
      );
    }
  });

  it("queryExpansion default is false with measured no-gain justification pin", () => {
    expect(RESEARCHER_RETRIEVAL_PROFILE_V1.queryExpansion).toBe(false);
    expect(RESEARCHER_RETRIEVAL_PROFILE_V1.rerank).toBe(false);
    const { cases, documents } = load();
    const off = scoreRetrieval(cases, documents, {
      ...RESEARCHER_RETRIEVAL_PROFILE_V1,
      queryExpansion: false,
    });
    const on = scoreRetrieval(cases, documents, {
      ...RESEARCHER_RETRIEVAL_PROFILE_V1,
      queryExpansion: true,
    });
    // Measured ZERO GAIN (and zero change to FN) — equality pins the claim.
    // <= would still pass if expansion HURT TP while the doc said "zero gain".
    expect(on.truePositive).toBe(off.truePositive);
    expect(on.falseNegative).toBe(off.falseNegative);
    expect(expandQuery("Where does Atlas keep knowledge?").length).toBeGreaterThan(
      "Where does Atlas keep knowledge?".length,
    );
  });
});

describe("profile replay regression", () => {
  it("slashing maxOpenedUnits reduces recall vs v1 (diff non-zero)", () => {
    const { cases, documents } = load();
    const baseline = scoreRetrieval(
      cases,
      documents,
      RESEARCHER_RETRIEVAL_PROFILE_V1,
    );
    const slashed: RetrievalProfile = {
      ...RESEARCHER_RETRIEVAL_PROFILE_V1,
      version: "slash-open-1",
      maxOpenedUnits: 1,
      maxCandidates: 1,
    };
    const worse = scoreRetrieval(cases, documents, slashed);
    const diff = diffMetrics(baseline, worse);
    expect(diff.tpDelta).toBeLessThan(0);
    expect(diff.recallDelta).toBeLessThan(0);
  });
});

describe("profile surface", () => {
  it("v1 profile is frozen and conservative literals", () => {
    expect(Object.isFrozen(RESEARCHER_RETRIEVAL_PROFILE_V1)).toBe(true);
    expect(RESEARCHER_RETRIEVAL_PROFILE_V1.maxCandidates).toBe(8);
    expect(RESEARCHER_RETRIEVAL_PROFILE_V1.maxOpenedUnits).toBe(8);
    expect(RESEARCHER_RECALL_FLOOR).toBe(0.7);
    expect(RESEARCHER_RECALL_TP_PIN).toBe(8); // B005 stemmer recovered unit-22
  });
});
