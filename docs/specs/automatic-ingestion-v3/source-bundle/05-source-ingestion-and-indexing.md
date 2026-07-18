# Source Ingestion and Indexing

## 1. Pipeline order

The deterministic shell runs before agentic exploration:

```text
package intake
  → safety and rights preflight
  → immutable snapshot and replay receipt
  → file inventory and exact hashes
  → qualified representations
  → structural source units and locators
  → exact maps and aliases
  → lexical index
  → optional semantic index
  → source coverage ledger
```

No Researcher call should be responsible for discovering whether an uploaded file exists or for inventing locators.

## 2. Package intake

Supported intake forms may include a directory, Git commit, ZIP/TAR upload, or object manifest. The importer MUST:

- reject archive traversal, symlink escape, decompression bombs, excessive counts/sizes, and unsupported nesting;
- identify every original byte stream with SHA-256;
- preserve the original logical path without trusting it as a local filesystem path;
- apply include/exclude rules explicitly;
- classify access, secrets/PII policy, and source rights before external processing;
- create a `SourceSnapshot` before extraction begins.

Production promotion requires a retained content-addressed replay capsule. External-only URLs are exploratory until sealed.

## 3. Format capability tiers

| Tier | Examples | Citation eligibility |
|---|---|---|
| A exact | Markdown, text, source code, JSON/YAML, CSV | Deterministic byte/line/cell mapping after validator pass. |
| B verifiable | Structured HTML, DOCX, PPTX, XLSX, text PDF | Structure/render audit required. |
| C approximate | OCR, complex visual layouts, diagrams | Named human verification or immutable repair per cited unit. |
| D unsupported | No faithful representation | Archive/exclude only; cannot support accepted claims. |

The first implementation SHOULD support a small A-tier set and add B-tier adapters only with golden fixtures.

## 4. Qualified representations

A representation record contains:

- original file hash and media type;
- extractor/parser name and version;
- extracted and normalized text hashes;
- original-to-normalized mapping;
- structural element map;
- warnings and losses;
- capability tier;
- independent audit result;
- repair/supersession relationship where applicable.

A representation hash proves immutability, not fidelity. Fidelity is a separate audit.

## 5. Structural source units

Chunking is document-structural, not fixed-token-only. Units include:

- whole-document metadata/summary descriptors;
- heading sections and subsections;
- coherent paragraph groups;
- list groups;
- tables and row/column ranges;
- code/config blocks;
- slides and speaker-note groups;
- captions/figures through qualified descriptions;
- callouts and warnings.

Each unit knows its parents, siblings, heading path, original and normalized locator, content hash, extraction tier, authority hints, and lifecycle hints.

## 6. Retrieval baseline

The v3 baseline is hybrid in the broad sense, but semantic vectors are optional:

1. exact ID/path/alias/error-code lookup;
2. committed readable maps;
3. lexical BM25/FTS retrieval over structural fields;
4. typed link expansion;
5. optional dense retrieval after regression evidence;
6. bounded reranking/evidence selection.

The public retrieval contract returns candidates, match reasons, fields, filters, and a search receipt. It does not expose engine-specific scores as universal confidence.

## 7. Field precedence

Recommended lexical precedence:

```text
exact IDs and aliases
file/document titles
canonical headings and question text
claim statements
accepted answer summaries
body source text
metadata tags
raw transcripts/agent records (maintenance mode only)
```

## 8. Mode and authority separation

User-facing answer retrieval normally includes:

- current accepted claims;
- current canonical documentation;
- accepted answer compositions.

Ingestion/maintainer retrieval may additionally include:

- raw source units;
- proposed/disputed claims;
- draft answers/documents;
- historical and deprecated sources;
- gaps, conflicts, and agent findings.

These classes retain labels and cannot silently satisfy a user answer.

## 9. Search receipt

Every Researcher result, especially no-evidence, records:

```yaml
snapshot_id: ...
index_build_ids: [...]
queries:
  - kind: exact
    text: ...
  - kind: lexical
    text: ...
filters: ...
candidates_returned: ...
source_units_opened: [...]
maps_followed: [...]
retrieval_failures: [...]
unsearched_reasons: [...]
```

A retrieval outage is `retrieval_unavailable`, not `no_supported_answer`.

## 10. Incremental rebuild

A new source snapshot compares original and source-unit hashes:

- unchanged units retain equivalence links and can reuse derived index entries;
- changed/deleted units invalidate dependent claims;
- moved but byte-identical material receives explicit continuity mapping;
- new units enter the coverage ledger and reverse-accounting frontier;
- authority/lifecycle changes trigger reevaluation even when text is unchanged;
- an index build activates atomically only after validation.

## 11. Source coverage ledger

Every selected semantic source unit ends in one terminal disposition:

```text
cited_primary
cited_qualifying
represented_by_claim
represented_by_question
supplemental_selected
duplicate_content
superseded_or_deprecated
historical_only
boilerplate_or_navigation
human_excluded
unsupported_or_unreadable
processing_failed
```

`unreviewed`, `candidate_relevant`, and `retrieval_missed` are non-terminal. The ledger is separate from answer sufficiency so concise evidence packets do not imply unaccounted source loss.

## 12. Index build manifest

Every build records:

- source snapshot/commit;
- parser and extraction versions;
- structural unit version;
- lexical tokenizer/configuration;
- map and relation versions;
- optional embedding/reranker model/version;
- authority/status filters;
- build time and validation result.

Binary indexes and embeddings are not committed to ordinary Git history.
