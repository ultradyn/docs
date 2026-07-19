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

## Refusals, not warnings

Two inputs are refused rather than reported with a caveat:

- **`VERSION_MISMATCH`** — reports from different corpus, model or prompt
  versions. Comparing them is not a comparison; it is two unrelated
  measurements printed side by side, which is worse than no measurement because
  it looks like a finding. Mutation-verified: removing the version check fails
  four tests.
- **`INSUFFICIENT_DATA`** — a zero denominator, or fewer than two repeats when
  measuring output stability. A rate of 0/0 must not silently become 0 or 1, and
  a single run cannot demonstrate stability.

## If this ever runs on real data

1. Record both configurations on the **same** corpus SHA, model version and
   prompt version, or the comparison is refused (by design).
2. Use at least two repeats per configuration so stability is measurable.
3. If the result is `revisit`, that is an **input to a human decision** about
   ADR-0005 — not an automatic architectural change. Nothing in R0/R1 consumes
   this output.
