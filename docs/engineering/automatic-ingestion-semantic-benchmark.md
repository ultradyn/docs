# Automatic ingestion semantic retrieval benchmark

## Decision

**Keep semantic/vector retrieval disabled.** The deterministic dense and hybrid candidates do not meet the predeclared material-improvement threshold. The production retrieval surface remains exact/map plus lexical MiniSearch; disabling or omitting semantic candidates changes no lexical behavior and requires no source or data migration.

This is an optional, offline, non-gating experiment. Activating vectors would still require a future ADR even if a later candidate met the measurement threshold. This preserves ADR 0005 / architecture constraint C4 (also described as the v1 lexical-first constraint): no production embeddings, vector database, binary index, provider, network call, or source-bundle access is introduced here.

## Predeclared threshold

The threshold is pinned in `SEMANTIC_BENCHMARK_THRESHOLDS`, independently of candidate results. A candidate must satisfy **all** conditions:

- recall delta at least **+0.15**;
- precision delta at least **0.00** (no regression);
- p95 latency delta no more than **+20 ms**;
- total benchmark cost delta no more than **AUD 0.01**.

Passing would only make a candidate eligible for a future ADR; it would not activate vectors automatically. Neither candidate passes.

## Results

| Strategy                  | Recall | Precision | p95 latency | Total cost | Recall delta | Precision delta | p95 delta |  Cost delta | Threshold   |
| ------------------------- | -----: | --------: | ----------: | ---------: | -----------: | --------------: | --------: | ----------: | ----------- |
| Lexical baseline          | 0.6667 |    1.0000 |        5 ms | AUD 0.0000 |            — |               — |         — |           — | baseline    |
| Deterministic dense fake  | 0.7778 |    0.7000 |       30 ms | AUD 0.0070 |      +0.1111 |         -0.3000 |    +25 ms | +AUD 0.0070 | **not met** |
| Deterministic hybrid fake | 0.7778 |    1.0000 |       16 ms | AUD 0.0035 |      +0.1111 |          0.0000 |    +11 ms | +AUD 0.0035 | **not met** |

Dense fails recall, precision, and latency requirements. Hybrid preserves precision and remains inside latency/cost caps, but its +0.1111 recall gain is below the pinned +0.15 material-gain floor.

The portable machine-readable receipt is `code/integration/fixtures/ingest-results/semantic-benchmark-result.json`. It contains only approved aggregate metrics and corpus provenance—not queries, source text, case IDs, or unit IDs. The committed worked inputs are `semantic-benchmark-runs.json`; they contain identifiers and deterministic scores only, never source text.

## Metric and method definitions

- **Relevance truth:** each replay question's `evidenceUnitIds` in the committed expected graph.
- **True positive:** selected unit present in that question's relevance set.
- **False positive:** selected unit absent from the relevance set, including any result for a known unsupported question.
- **False negative:** relevant unit not selected.
- **Recall:** `TP / (TP + FN)`, micro-aggregated over all seven cases. A case with no relevant units contributes no recall denominator.
- **Precision:** `TP / (TP + FP)`, micro-aggregated over all cases. An all-empty run is defined as precision 1 so correct abstention is not penalised.
- **Latency:** deterministic per-case fixture values in milliseconds; p95 is nearest-rank (`ceil(0.95 × n)`) across seven cases. Values model bounded comparative work and are **not wall-clock production measurements**. They exclude network variance, model warm-up, hardware contention, index build time, and persistence because no production semantic stack exists.
- **Cost:** deterministic marginal retrieval cost in Australian dollars per case, summed across the seven-case benchmark. These are comparative fake units pinned to AUD for the experiment; they are not a provider quote or billing forecast. Lexical cost is zero marginal external-provider spend.

Quality, latency, and cost must be considered together. A quality gain alone cannot clear the threshold.

## Fixture provenance and reproducibility

The representative corpus is the committed ingestion replay set:

- `tiny/expected-graph.json`, SHA-256 `a6261cedc3818bd09d2acee02cb92e9d6fe5d0aa9a12aaf0c9a40e167f7cdfdc`, four questions including contradiction, deprecation, duplicate, and unsupported-answer scenarios;
- `small/expected-graph.json`, SHA-256 `a539b027ed0e8d39f3b986fbbab58581d54919791b7ecf48664a4b20f720c9c8`, three repository-domain questions covering custody, canonical lifecycle, and local operation.

The harness is synchronous, bounded to 256 cases and 100 unit IDs per case, strict about exact input fields, rejects duplicate/mismatched cases and changed provenance, and has no filesystem or network access. Re-running it over the immutable committed inputs serialises the same result byte-for-byte.

## Operational consequence

No production file under `code/ingest/` exports semantic, dense, vector, or embedding behavior. If the candidate fixture is disabled or absent, the benchmark reports `semantic-candidate-absent`; the lexical baseline remains measurable and unchanged. There is no migration because source snapshots, source units, lexical receipts, and machine-index rebuild behavior are untouched.
