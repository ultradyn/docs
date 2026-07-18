# Testing and Rollout Strategy

## 1. Testing philosophy

The system can produce persuasive artifacts while still missing source material, accepting irrelevant citations, overgeneralizing claims, merging distinct questions, or publishing unusable documentation. Tests therefore cover deterministic invariants, agent behavior, labeled corpora, human tasks, recovery, security, scale, and economics.

## 2. Test families

### Deterministic unit tests

- archive safety and path normalization;
- hashes and locator mappings;
- structural source-unit identity;
- schema and state transitions;
- graph expected-version/idempotency;
- coverage-obligation ownership;
- claim dependency invalidation;
- map/index manifest reproducibility;
- source replay verification;
- task/dependency validators.

### Agent contract fixtures

Each agent receives happy, partial, adversarial, malformed, and scope/lifecycle cases. Fixtures assert decisive structured fields rather than exact prose.

### Retrieval and evidence fixtures

Known questions with expected source units, forbidden obsolete units, required qualifiers, and expected no-evidence/conflict outcomes.

### Claim fixtures

- atomic versus compound propositions;
- missing qualifiers;
- example generalized as rule;
- version-scoped variants;
- contradiction versus scoped difference;
- equivalent claims from different evidence;
- unsupported rationale.

### Workflow recovery scenarios

Crash/retry after each durable step; duplicate races; source/index unavailability; model malformed output; budget pause; human intervention; Git conflict; deletion.

### Human-factor tests

- uncovered-topic curation;
- duplicate/authority review;
- dashboard Activity/Evidence/Assurance comprehension;
- documentation navigation tasks;
- answer usefulness and misleading confidence.

### Security/adversarial tests

Prompt injection, archive traversal/bombs, secrets/PII, malicious HTML, license restrictions, access leaks, cache isolation, provider/tool failures, deletion and history incident.

## 3. Metrics

### Source and evidence

- source-reference resolution rate;
- evidence precision/recall against labeled units;
- unnecessary-reference rate;
- missing-qualifier rate;
- false no-evidence rate;
- deprecated-as-current rate;
- extraction mapping failure rate.

### Claims

- claim entailment precision;
- qualifier preservation;
- overbroad-claim rate;
- claim reuse across questions;
- claim duplicate/variant adjudication accuracy;
- contradiction precision/recall;
- stale dependency propagation completeness.

### Exploration

- required facet coverage;
- accepted child novelty;
- branches per source unit/obligation;
- refinement-round distribution;
- forward versus reverse unique discoveries;
- human-injection outcomes;
- false closure count.

### Convergence

- question false-merge and false-split rates;
- unique evidence/obligation preservation;
- branch hold/release/revoke counts;
- secondary replay accuracy.

### Publication

- claim/citation sentence support;
- canonical-home duplication;
- navigation task success/time/path length;
- human edit distance and rejection categories;
- imported answer replay success.

### Operations and economics

- calls/tokens/cost per source token and accepted claim;
- zero-cache and observed-cache costs;
- throughput/latency;
- dashboard event lag;
- restart duplicate artifacts;
- held branch age;
- operator decisions per thousand source units.

## 4. Staged corpus plan

### Stage 0 — Contracts and deterministic shell

No meaningful corpus. Validate schemas, IDs, hashes, locators, events, graph mutations, obligations, invalidation, and prompt serialization.

**Gate:** repeated runs produce identical deterministic artifacts; no invalid state is accepted.

### Stage 1 — Tiny synthetic corpus

Five to ten files containing:

- project overview;
- architecture and API behavior;
- explicit deprecation;
- one contradiction with scoped resolution;
- disconnected meaningful note;
- duplicate paragraph;
- one unsupported question.

**Gate:** exact expected source, claim, question, answer, coverage, and document-plan graph.

### Stage 2 — Small branching corpus

Twenty to one hundred files with aliases, same claims answering different questions, paraphrased question candidates, delayed ancestor invalidation, tables/code/HTML, excluded generated/vendor content, and crash injection at every workflow state.

**Gate:** zero high-impact false merges in labels; all selected semantic units terminal; restart creates no duplicate durable records.

### Stage 3 — Medium real project

Hundreds to thousands of files with domain reviewers. Compare:

- question-only model versus source–claim–question–answer model;
- combined Questioner versus separate Evidence Critic/Curiosity Planner;
- lexical-only versus optional vectors;
- forward-only versus forward+reverse;
- cache enabled/disabled;
- early per-question writing versus IA-first publication.

**Gate:** v3 improves claim reuse, qualifier preservation, false-merge rate, and navigation without unacceptable cost.

### Stage 4 — Production-like shadow run

Run in waves: import only, small seeded frontier, selected subtrees, full forward, reverse/curation, human curiosity, convergence, publication dry run, reviewed import.

**Gate:** configured quality/confidence/cost/security thresholds and named reviewer sign-off.

### Stage 5 — Soak and incremental re-ingestion

Multi-day pause/resume, provider changes, source snapshot updates, claim invalidation, index rebuild, runtime projection deletion/rebuild, and Git publication conflicts.

## 5. Direct tests of the two v3 changes

### Source–claim–question–answer model

- Two questions with different goals share one accepted claim but retain distinct answers.
- One question requires three claims from different source units.
- A source change invalidates one claim and only dependent answers/documents.
- Equivalent claim candidates do not automatically merge scoped variants.
- Information Architecture maps several questions to one canonical concept section.
- Claim-first docs reduce duplicated facts compared with one-page-per-question baseline.

### Split Evidence Critic and Curiosity Planner

- Evidence Critic output schema cannot contain child proposals.
- Curiosity Planner cannot alter current evidence verdict.
- A weak evidence packet is rejected even when many interesting child branches are available.
- A passing packet produces no unnecessary evidence-refinement loop.
- Child proposals own novel obligations and do not rephrase the current question.
- Ablation against one combined Questioner measures false acceptance, branch factor, and fixture consistency.

## 6. Release thresholds

Initial thresholds are hypotheses to calibrate, not claims of achieved performance. Before production, define at minimum:

- citation/reference resolution 100%;
- no known false closure in labeled suites;
- false no-evidence upper confidence bound;
- zero observed high-impact false merges in release set;
- claim entailment precision target;
- qualifier/deprecation misuse target;
- navigation task improvement over raw corpus;
- zero-cache cost envelope;
- extraction tiers eligible for release;
- dashboard comprehension target;
- deletion drill pass.

## 7. Every incident becomes a fixture

A discovered failure should become the lowest-level reproducible test available:

- deterministic unit fixture;
- agent structured-output fixture;
- retrieval/evidence/claim replay fixture;
- workflow recovery scenario;
- dashboard event replay;
- corpus mutation test;
- release regression.
