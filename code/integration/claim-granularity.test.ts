import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * T-32-03 — Claim granularity calibration.
 *
 * This is a CALIBRATION task, so the falsifiability discipline from T-31-03 and
 * T-30-03 applies: every metric is computed from LITERAL labels in the fixture,
 * the reviewer-agreement target is pinned and asserted non-vacuous, and the
 * target must be capable of failing. The threshold was set AFTER measuring, not
 * chosen and then fitted with a corpus.
 *
 * The metric helpers below are pure and are exercised directly on inline data,
 * so the math is verified independently of the fixture. The integration cases
 * then apply them to the committed labeled corpus.
 */

// ---------------------------------------------------------------------------
// Pure metrics — computed from labels only
// ---------------------------------------------------------------------------

type GranularityLabel = "atomic" | "overbroad" | "fragmented";

type LabeledClaim = {
  readonly id: string;
  readonly statement: string;
  readonly claimType: string;
  /** Ordered steps for procedure claims; ordered clauses for preconditions. */
  readonly orderedParts?: readonly string[];
  /** Two independent reviewers' granularity labels. */
  readonly reviewerA: GranularityLabel;
  readonly reviewerB: GranularityLabel;
};

type QuestionCitation = {
  readonly questionId: string;
  readonly acceptedClaimIds: readonly string[];
};

type GranularityCorpus = {
  readonly claims: readonly LabeledClaim[];
  readonly questions: readonly QuestionCitation[];
};

/** Fraction of accepted claims cited by two or more distinct questions. */
function reuseRate(corpus: GranularityCorpus): {
  rate: number;
  reusedIds: readonly string[];
  denominator: number;
} {
  const questionsByClaim = new Map<string, Set<string>>();
  for (const q of corpus.questions) {
    for (const id of q.acceptedClaimIds) {
      const set = questionsByClaim.get(id) ?? new Set<string>();
      set.add(q.questionId);
      questionsByClaim.set(id, set);
    }
  }
  const acceptedIds = new Set(
    corpus.questions.flatMap((q) => q.acceptedClaimIds),
  );
  const reusedIds = [...acceptedIds]
    .filter((id) => (questionsByClaim.get(id)?.size ?? 0) >= 2)
    .sort();
  const denominator = acceptedIds.size;
  return {
    rate: denominator === 0 ? Number.NaN : reusedIds.length / denominator,
    reusedIds,
    denominator,
  };
}

/** Fraction of claims either reviewer labelled fragmented (over-split). */
function fragmentationRate(corpus: GranularityCorpus): {
  rate: number;
  denominator: number;
} {
  const denominator = corpus.claims.length;
  const fragmented = corpus.claims.filter(
    (c) => c.reviewerA === "fragmented" || c.reviewerB === "fragmented",
  ).length;
  return {
    rate: denominator === 0 ? Number.NaN : fragmented / denominator,
    denominator,
  };
}

/** Fraction of claims where the two reviewers' granularity labels match. */
function reviewerAgreement(corpus: GranularityCorpus): {
  agreement: number;
  denominator: number;
} {
  const denominator = corpus.claims.length;
  const agree = corpus.claims.filter(
    (c) => c.reviewerA === c.reviewerB,
  ).length;
  return {
    agreement: denominator === 0 ? Number.NaN : agree / denominator,
    denominator,
  };
}

// ---------------------------------------------------------------------------
// Pinned targets — set AFTER measuring the committed corpus (see the guide)
// ---------------------------------------------------------------------------

/** Reviewer agreement must meet the pilot target. Measured then locked. */
const REVIEWER_AGREEMENT_TARGET = 0.8;
/** At least one claim must be reused across two questions. */
const MIN_REUSED_CLAIMS = 1;

function loadCorpus(): GranularityCorpus {
  const path = fileURLToPath(
    new URL("./fixtures/claim-granularity.json", import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8")) as GranularityCorpus;
}

function loadGuide(): string {
  const path = fileURLToPath(
    new URL("../../docs/engineering/claim-granularity-guide.md", import.meta.url),
  );
  return readFileSync(path, "utf8");
}

// ---------------------------------------------------------------------------
// metric math — pure, verified on inline data (independent of the fixture)
// ---------------------------------------------------------------------------
describe("granularity metrics are correct on worked input", () => {
  const inline: GranularityCorpus = {
    claims: [
      { id: "c1", statement: "a", claimType: "behavior", reviewerA: "atomic", reviewerB: "atomic" },
      { id: "c2", statement: "b", claimType: "behavior", reviewerA: "atomic", reviewerB: "fragmented" },
    ],
    questions: [
      { questionId: "q1", acceptedClaimIds: ["c1", "c2"] },
      { questionId: "q2", acceptedClaimIds: ["c1"] },
    ],
  };

  it("reuseRate counts claims cited by two or more questions", () => {
    const r = reuseRate(inline);
    expect(r.reusedIds).toEqual(["c1"]); // c1 in q1+q2, c2 only q1
    expect(r.denominator).toBe(2);
    expect(r.rate).toBeCloseTo(0.5, 6);
  });

  it("fragmentationRate counts either reviewer labelling fragmented", () => {
    expect(fragmentationRate(inline).rate).toBeCloseTo(0.5, 6);
  });

  it("reviewerAgreement counts matching labels", () => {
    expect(reviewerAgreement(inline).agreement).toBeCloseTo(0.5, 6);
  });

  it("empty corpus yields NaN, never a vacuous 0 or 1", () => {
    const empty: GranularityCorpus = { claims: [], questions: [] };
    expect(Number.isNaN(reviewerAgreement(empty).agreement)).toBe(true);
    expect(Number.isNaN(reuseRate(empty).rate)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// committed labeled corpus — acceptance criteria
// ---------------------------------------------------------------------------
describe("claim granularity pilot corpus", () => {
  it("AC1: a claim is reused by two questions, with a pinned non-zero denominator", () => {
    const corpus = loadCorpus();
    const r = reuseRate(corpus);
    expect(r.denominator).toBeGreaterThan(0);
    expect(
      r.reusedIds.length,
      "at least one accepted claim must be cited by two questions",
    ).toBeGreaterThanOrEqual(MIN_REUSED_CLAIMS);
    // Name the reused claim so a corpus edit that drops reuse is visible.
    for (const id of r.reusedIds) {
      const cites = corpus.questions.filter((q) =>
        q.acceptedClaimIds.includes(id),
      );
      expect(cites.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("AC2: procedure and precondition claims preserve their ordering", () => {
    const corpus = loadCorpus();
    const ordered = corpus.claims.filter(
      (c) => c.claimType === "procedure" || c.claimType === "precondition",
    );
    expect(
      ordered.length,
      "corpus must contain ordered procedure/precondition claims",
    ).toBeGreaterThan(0);
    for (const c of ordered) {
      expect(c.orderedParts, `${c.id} must carry ordered parts`).toBeDefined();
      const parts = c.orderedParts ?? [];
      expect(parts.length).toBeGreaterThan(1);
      // Ordering is meaningful only if a reversal would be a different claim.
      // Pin that the parts are NOT already sorted-insensitive: reversing them
      // must produce a different sequence, so order carries information.
      const reversed = [...parts].reverse();
      expect(reversed).not.toEqual(parts);
    }
  });

  it("AC3: reviewer agreement meets the pilot target (measured, not vacuous)", () => {
    const corpus = loadCorpus();
    const a = reviewerAgreement(corpus);
    expect(a.denominator).toBeGreaterThan(0);
    expect(
      a.agreement,
      `reviewer agreement ${a.agreement} below pilot target`,
    ).toBeGreaterThanOrEqual(REVIEWER_AGREEMENT_TARGET);
    // Non-vacuity: the corpus must contain at least one DISAGREEMENT, or a
    // target of 1.0 over unanimous labels would prove nothing about agreement.
    const disagreements = corpus.claims.filter(
      (c) => c.reviewerA !== c.reviewerB,
    );
    expect(
      disagreements.length,
      "corpus must contain at least one reviewer disagreement so agreement < 1 is possible",
    ).toBeGreaterThan(0);
  });

  it("distinguishes atomicity from fragmentation in labels and guide", () => {
    const corpus = loadCorpus();
    // Both distinctions must actually appear, or the calibration is untested.
    const hasAtomic = corpus.claims.some(
      (c) => c.reviewerA === "atomic" || c.reviewerB === "atomic",
    );
    const hasFragmented = corpus.claims.some(
      (c) => c.reviewerA === "fragmented" || c.reviewerB === "fragmented",
    );
    const hasOverbroad = corpus.claims.some(
      (c) => c.reviewerA === "overbroad" || c.reviewerB === "overbroad",
    );
    expect(hasAtomic && hasFragmented && hasOverbroad).toBe(true);

    const guide = loadGuide();
    // The guide must give a rule that distinguishes the two failure directions.
    expect(guide).toMatch(/fragment/i);
    expect(guide).toMatch(/overbroad/i);
    expect(guide).toMatch(/atomic/i);
  });

  it("reports fragmentationRate over a pinned denominator", () => {
    const corpus = loadCorpus();
    const f = fragmentationRate(corpus);
    expect(f.denominator).toBe(corpus.claims.length);
    expect(f.denominator).toBeGreaterThan(0);
    expect(f.rate).toBeGreaterThanOrEqual(0);
    expect(f.rate).toBeLessThanOrEqual(1);
  });
});
