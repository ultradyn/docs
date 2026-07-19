# Researcher retrieval profile (T-30-03)

**Status:** pilot-scale calibration, optional / non-gating.  
**Profile version:** `researcher-retrieval-v1`  
**Date measured:** 2026-07-19  

## What was calibrated

`RetrievalProfile { version, maxCandidates, maxOpenedUnits, queryExpansion, rerank:false }` for offline Researcher source search.

## Ground truth

Committed expected graphs (hand-authored labels, not scorer output):

| Corpus | Path | SHA-256 |
|--------|------|---------|
| tiny | `code/integration/fixtures/ingest-corpus/tiny/expected-graph.json` | `a6261cedc3818bd09d2acee02cb92e9d6fe5d0aa9a12aaf0c9a40e167f7cdfdc` |
| small | `code/integration/fixtures/ingest-corpus/small/expected-graph.json` | `a539b027ed0e8d39f3b986fbbab58581d54919791b7ecf48664a4b20f720c9c8` |

Relevance = each question’s `evidenceUnitIds`. Unit text = section under graph `locator` in fixture `source/` files. Labels are independent of MiniSearch ranking.

**Pilot residual:** 7 questions, 9 labeled unit–question pairs. Not a product SLO.

## Method

Live MiniSearch (same field/boost style as production lexical index) over 29 unit documents. No live LLM. Cache disabled by construction (pure function).

## Measured results (before locking floors)

| Profile | Recall | Precision | TP | FP | FN | FNE (answerable) |
|---------|-------:|----------:|---:|---:|---:|-----------------:|
| cap8 open8 **no** expansion | **0.7778** | 0.132 | **7** | 46 | 2 | **0/6** |
| cap8 open8 expansion ON | 0.7778 | 0.132 | 7 | 46 | 2 | 0/6 |
| cap20 open8 | 0.7778 | 0.132 | 7 | 46 | 2 | 0/6 |
| cap20 open20 expansion | 0.7778 | 0.065 | 7 | 101 | 2 | 0/6 |
| cap3 open3 expansion | 0.6667 | 0.286 | 6 | 15 | 3 | 0/6 |

### Named misses (2 of 9 labeled pairs) — not rounded away

| Question | Missed unit | Topic (locator) | Status |
|----------|-------------|-----------------|--------|
| `small-question-local` | `small-unit-18` | Machine index (`# Machine index`) | **FN** — not in top-8 MiniSearch hits for the question text |
| `small-question-local` | `small-unit-22` | Provider (`# Provider`) | **FN** — same |

This profile **misses 2 of 9 labeled pairs**. That is under-retrieval on the axis we called worst. Pilot acceptance is a deliberate, temporary acceptance of a known gap — not a claim that retrieval is fine. A percentage of 0.78 without naming the misses would let a future reader walk past the gap.

**Why not fixed in this task:** closing these FNs needs query/document features or lexical tuning beyond limit calibration (content of `18-machine-index.md` / `22-provider.md` vs question wording). Follow-up: retrieval content/synonym work (not a threshold move). Filed as residual, not a silent floor drop.

### Precision (report-only)

At the chosen profile: **46 false positives for 7 true positives** (precision ≈ **0.132**). Over-retrieval is the safe direction, so precision is not gated; the figure is still stated so it cannot be rediscovered as a hidden defect.

## Q4 — queryExpansion default

**Default `false`.** Expansion ON produced **zero** recall gain on this labeled set. Default-off is therefore measured no-benefit, not a “safer looking” under-retrieve bias. Under-retrieval remains the worst failure; expansion simply did not help here.

## Locked profile v1

```
version: researcher-retrieval-v1
maxCandidates: 8
maxOpenedUnits: 8
queryExpansion: false
rerank: false
```

## Gates (tests)

| Gate | Value | Rationale |
|------|------:|-----------|
| Recall floor | ≥ 0.70 | Below measured 0.7778; allows tiny noise, not large loss |
| Exact TP pin | **7** | Small loss cannot hide under the floor |
| Labeled pairs pin | **9** | Denominator integrity |
| Answerable pin | **6** | |
| False no-evidence | **0** | Safety metric; under-retrieve-by-silence forbidden on answerable set |
| Precision | report-only | Must not punish over-retrieval |

## Safe direction

Under-retrieval / false no-evidence is worst. Precision is never a high hard floor.

## Production

No `code/ingest` production module imports this calibration harness. Profile constants may be copied by hand into tool configs later with a separate task.

## Replay

Tests assert that slashing `maxOpenedUnits`/`maxCandidates` to 1 reduces a negative TP/recall delta vs v1.
