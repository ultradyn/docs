# Automatic ingestion labelling guide

## Independent labels

Each corpus run is labelled independently by two reviewers who do not see the
other label set or the system prediction. Labels identify source units,
evidence relevance, claim entailment, merge identity, contradiction pairs,
source coverage, and answer sufficiency. Every label set records the corpus
version, rubric version, reviewer, and immutable source digest.

## Metric denominators

- **Evidence recall:** relevant evidence found / all labelled relevant evidence.
- **Evidence precision:** relevant evidence found / all retrieved evidence.
- **False no-evidence rate:** answerable questions incorrectly marked no-evidence / all labelled answerable questions.
- **Claim entailment rate:** entailed proposed claims / all independently reviewed claims.
- **False merge rate:** incorrect merge decisions / all proposed merges.
- **Contradiction recall:** labelled contradictions found / all labelled contradictions.
- **Source coverage:** source units with an explicit disposition / all source units.
- **Answer sufficiency:** sufficient answers / all answers evaluated for their declared goals.

An empty denominator scores `0` and is reported with its raw counts; it never
means perfect performance. Source coverage and answer sufficiency remain
separate: a run may disposition every source unit while failing to answer a
question, or answer a narrow question without covering the corpus.

## Worked examples

A retrieval with 8 true positives, 2 false positives, and 4 false negatives has
recall `8/12` and precision `8/10`. Three false no-evidence decisions among 12
answerable questions score `3/12`. One incorrect merge among five candidates
scores `1/5`.

## Disagreement and adjudication

After blind labelling, compare exact IDs and decisive fields. Disagreements are
not averaged. A third adjudicator reads both rationales and the cited source,
records one accepted label or an explicit unresolved item, and increments the
rubric version when the rule changes. Re-run affected fixtures under the new
version; retain prior labels and results as immutable history. Report reviewer
agreement and unresolved counts alongside every metric result.
