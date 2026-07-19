# Evidence role ablation: combined versus split

**Status: comparison machinery delivered; architectural question NOT settled.**
Optional, non-gating (plan N5). No core or release-gating task may depend on this.

## What this task delivers

`code/integration/evidence-role-ablation.ts` — an offline comparison of a
split-role configuration (Evidence Critic separate from Curiosity Planner)
against a combined-role baseline, producing a falsifiable decision:
`retain-split` or `revisit`.

## What it does NOT deliver, stated plainly

**It does not answer whether the split role is architecturally justified.**

The plan forbids adding a combined role to production, so there is no live
combined-role agent to run. The module's inputs are *recorded* report JSON. With
hand-authored or pilot-scale reports, this exercise verifies:

- that the metrics are computed correctly from worked input,
- that incomparable inputs are refused,
- that the decision rule can return either answer.

It does not produce evidence about the real system. Settling ADR-0005 would
require genuine recorded runs of both configurations on identical corpus, model
and prompt versions — which is a larger piece of work than this task, and one
nothing currently depends on.

Every `AblationResult` carries its own `limitations` array for this reason: a
reader quoting the decision cannot strip the context it came from.

## The decision rule, fixed before any measurement

Published as frozen data (`ABLATION_DECISION_RULE`) so a reader can check it was
not tuned to fit an observed result:

| Criterion | Threshold |
|---|---|
| False-acceptance reduction (split vs combined) | ≥ 0.05 absolute |
| Refinement-quality gain (split vs combined) | ≥ 0.10 absolute |
| Cost multiple (split ÷ combined) | ≤ 3× |

**Provenance of these numbers, stated because a reader cannot otherwise audit
it:** they were CHOSEN A PRIORI, not derived from a pilot table in this repo.
That is an honest pre-commit freeze rather than post-hoc tuning — the rule can
and does return `revisit` — but nobody can check *why 0.05* from evidence here.
If they are ever re-frozen, record the measurement and the reasoning in this
document at the same time. A threshold whose origin is undocumented drifts into
looking authoritative.

The split role must clear **all three**. The reasoning: a separate role costs
extra model calls and extra prompt surface, so it has to earn that cost in
measurable quality, not merely be architecturally tidier.

## Why the rule must be able to say "revisit"

The acceptance criterion reads: *the separate role must provide a material
quality/testability gain **or be revisited***. A decision rule that cannot
return `revisit` makes that criterion unmeetable by construction — the ablation
would only ever ratify what was already built.

So the test suite deliberately includes a case where the split role fails to
earn its cost and the decision **must** come out `revisit`. Mutation-verified:
forcing the decision to always return `retain-split` fails that test.

## What is measured but NOT gated

`branchFactor` is computed and reported, and is deliberately **not** part of the
decision rule. A lower branch factor is not self-evidently better — fewer child
questions can mean less curiosity rather than more precision. It is left ungated
rather than inventing a criterion, and said out loud here so a reader does not
invent one either.

## Refusals, not warnings

Two inputs are refused rather than reported with a caveat:

- **`VERSION_MISMATCH`** — reports from different corpus, model or prompt
  versions. Comparing them is not a comparison; it is two unrelated
  measurements printed side by side, which is worse than no measurement because
  it looks like a finding. Mutation-verified: removing the version check fails
  four tests.
- **`INSUFFICIENT_DATA`** — a zero denominator; fewer than two repeats when
  measuring output stability; or counts that would produce a rate outside
  [0,1] (negative values, or a numerator exceeding its denominator). A rate of
  0/0 must not silently become 0 or 1, a single run cannot demonstrate
  stability, and a garbage rate that still yields a confident decision is the
  same failure as a vacuous one — the output looks like a measurement.

## If this ever runs on real data

1. Record both configurations on the **same** corpus SHA, model version, prompt
   version **and metric-definition version**, or the comparison is refused (by
   design). The rubric axis matters: two runs can share a prompt string and
   still be incomparable if what counts as a false acceptance changed between
   them.
2. Use at least two repeats per configuration so stability is measurable.
3. If the result is `revisit`, that is an **input to a human decision** about
   ADR-0005 — not an automatic architectural change. Nothing in R0/R1 consumes
   this output.
