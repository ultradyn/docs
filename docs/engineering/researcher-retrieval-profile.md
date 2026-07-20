# Researcher retrieval profile (T-30-03 / B005)

**Status:** pilot-scale calibration, optional / non-gating.  
**Profile version:** `researcher-retrieval-v1`  
**Date measured (pre-stem):** 2026-07-19  
**Date re-measured (B005 Porter stemmer):** 2026-07-20  

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

Live MiniSearch over 29 unit documents with **symmetric** Porter `processTerm` (`stemmer@2.0.1` via `processLexicalTerm`) at both index and query time. No live LLM. Cache disabled by construction (pure function).

Asymmetric stemming (query-only or index-only) does **not** recover morphology matches — both sides must stem.

## Measured results

### Pre-B005 (2026-07-19, no stemmer)

| Profile | Recall | Precision | TP | FP | FN | FNE (answerable) |
|---------|-------:|----------:|---:|---:|---:|-----------------:|
| cap8 open8 **no** expansion | **0.7778** | 0.132 | **7** | 46 | 2 | **0/6** |
| cap8 open8 expansion ON | 0.7778 | 0.132 | 7 | 46 | 2 | 0/6 |

Named misses then: `small-unit-18`, `small-unit-22`.

### Post-B005 (2026-07-20, symmetric Porter stemmer)

| Profile | Recall | Precision | TP | FP | FN | FNE (answerable) |
|---------|-------:|----------:|---:|---:|---:|-----------------:|
| cap8 open8 **no** expansion + stem | **0.8889** | **0.145** | **8** | **47** | **1** | **0/6** |

Stemming recovered **small-unit-22** (Provider) via morphology:
`capabilities/capability`, `locally/local`, `operate/operation`.

Precision moved slightly (46→47 FP, 7→8 TP → ≈0.145). Stemming raises recall **and** noise; the new precision is recorded, not hidden.

### Named residual miss (1 of 9) — not rounded away

| Question | Missed unit | Topic (locator) | Status |
|----------|-------------|-----------------|--------|
| `small-question-local` | `small-unit-18` | Machine index (`# Machine index`) | **FN** — **zero term overlap** with the question; not lexically recoverable |

**small-unit-18 stays labeled.** Removing it would convert a caught semantic gap into an uncaught one. Closing it needs vector/semantic retrieval (R1 excludes per DESIGN C4/D8).

**small-unit-22 is recovered** and must remain recovered: tests fail if it re-enters the FN set (stemmer unwired).

## Q4 — queryExpansion default

**Default `false`.** Expansion ON still does not recover unit-18. Default-off remains measured no-benefit for the residual FN.

## Locked profile v1

```
version: researcher-retrieval-v1
maxCandidates: 8
maxOpenedUnits: 8
queryExpansion: false
rerank: false
processTerm: processLexicalTerm (Porter / stemmer@2.0.1)
```

## Gates (tests)

| Gate | Value | Rationale |
|------|------:|-----------|
| Recall floor | ≥ 0.70 | Below measured 0.8889; allows tiny noise, not large loss |
| Exact TP pin | **8** | B005 raised from 7; small loss cannot hide under the floor |
| FN count pin | **1** | Sole residual is unit-18 |
| FN unit ids | **[small-unit-18]** | Named gap set; unit-22 must not reappear |
| Labeled pairs pin | **9** | Denominator integrity (18 stays labeled) |
| Answerable pin | **6** | |
| False no-evidence | **0** | Safety metric; under-retrieve-by-silence forbidden on answerable set |
| Precision | report-only (~0.145) | Must not punish over-retrieval |

## Safe direction

Under-retrieval / false no-evidence is worst. Precision is never a high hard floor.

## Production

`code/ingest/retrieval/lexical-index.ts` uses the same `processLexicalTerm` at MiniSearch construction (index + query). Calibration harness mirrors that wiring. No production import of the calibration module itself.

## Replay

Tests assert that slashing `maxOpenedUnits`/`maxCandidates` to 1 reduces a negative TP/recall delta vs v1. Stemmer mutation: disable `processTerm` → unit-22 surfacing / FN pin must fail.
