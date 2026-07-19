# Claim granularity guide

Normative rules for how finely a reviewed claim should be cut, and the pilot
metrics that calibrate them. Pilot-scale: the labels are a small hand-authored
set (`code/integration/fixtures/claim-granularity.json`), so the numbers below
are a smoke-level calibration, not a product SLO.

## The two failure directions

A claim's granularity is judged on one axis with **two opposite failure modes**.
Naming both matters: a rule that only warns against one silently encourages the
other.

| Label | Meaning | Failure it represents |
|---|---|---|
| **atomic** | One assertion, reusable across questions, independently verifiable. | none — this is the target |
| **overbroad** | Several distinct assertions fused into one claim (`X and Y and Z`). | under-splitting — the claim cannot be reused for a question that needs only Y, and accepting it accepts all three at once |
| **fragmented** | A single assertion split across multiple claims that are meaningless alone. | over-splitting — `"The gateway limits requests"` + `"The limit is per minute"` are two fragments of one fact |

The Claim Reviewer's `atomicity` axis (`code/ingest/agents/claim-reviewer-agent.ts`)
uses the same three values. This guide is the human-facing calibration of what
those labels mean; the agent does not read it.

## Rules

1. **One assertion per claim.** If a claim reads naturally as `A and B` where A
   and B could be accepted or rejected independently, it is **overbroad** — split
   it. A conjunction that is a single indivisible fact (`AES-256-GCM` is one
   cipher, not "AES" and "256" and "GCM") is atomic.
2. **A claim must stand alone.** If a claim is unintelligible or unverifiable
   without an adjacent claim, the two are **fragmented** — merge them. The test:
   could a reviewer accept this claim, on its own, against evidence?
3. **Prefer reuse.** Cut claims so that a claim answering one question can be
   cited by another. Over-splitting and over-fusing both destroy reuse — a
   fragment is too small to answer anything alone; an overbroad claim is too
   specific to the question that produced it.
4. **Procedures and preconditions preserve order.** A `procedure` or
   `precondition` claim carries its steps/clauses as an **ordered** list.
   Reordering them changes the claim's meaning (migrate-then-start is not
   start-then-migrate), so the order is load-bearing data, not presentation. The
   calibration test asserts these claims carry ordered parts whose reversal is a
   different sequence.

## Pilot metrics (measured, then thresholds locked)

Computed from the literal labels in the fixture. Denominators are pinned and
asserted non-zero; an empty corpus yields `NaN`, never a vacuous 0 or 1.

| Metric | Definition | Measured | Threshold |
|---|---|---|---|
| Reviewer agreement | fraction of claims where reviewer A and B assign the same granularity label | **0.833** (10/12) | ≥ 0.80 (floor) |
| Reuse rate | fraction of accepted claims cited by ≥ 2 questions | **0.333** (2/6) | ≥ 1 claim reused |
| Fragmentation rate | fraction of claims either reviewer labelled `fragmented` | **0.25** (3/12) | reported, not gated |

**Threshold provenance.** The 0.80 agreement floor was chosen **after** measuring
0.833 on this corpus — an honest pre-commit freeze, not a number fitted to pass.
It sits below the measurement so a small labelling regression is caught. If the
corpus is ever re-labelled, re-measure and record the new value here; a floor
whose origin is undocumented drifts into looking authoritative.

**Why agreement must be able to fail.** The corpus deliberately contains
disagreements (`clm-index-rebuild`: atomic vs overbroad; `clm-consent-then-canary`:
atomic vs fragmented). Without at least one disagreement, an agreement of 1.0
over unanimous labels would prove nothing — the metric could not distinguish
"reviewers agree" from "there is nothing to disagree about". The test asserts a
disagreement exists so `agreement < 1` is reachable.

**Why fragmentation rate is reported, not gated.** A higher fragmentation rate is
not self-evidently worse in a pilot — it reflects the mix of claims chosen, not a
regression. Gating it would invite tuning the corpus to the number. It is
surfaced so a reviewer can see it, and left ungated so nobody invents a criterion
from it.
