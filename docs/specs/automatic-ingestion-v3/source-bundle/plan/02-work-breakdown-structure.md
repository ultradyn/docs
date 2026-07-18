# Work Breakdown Structure

## Phase 0 — Foundations

### [WP-00 — Architecture baseline and decision control](tasks/wp-00.yaml)
Freeze the v3 boundaries, terminology, source–claim–question–answer model, and agent-role separation before implementation begins.

- **T-00-01 — Approve v3 architecture decisions** — Review and approve the v3 change summary, domain boundaries, completion predicate, and deferred features.
- **T-00-02 — Define repository and package conventions** — Specify paths, naming, ULIDs, append-only records, generated maps, and source replay references.
- **T-00-03 — Create decision-change workflow** — Define how architecture, schema, workflow, agent, and policy changes are proposed and reviewed.

### [WP-01 — Schema, contract, and validation toolchain](tasks/wp-01.yaml)
Implement the machine-readable contracts and validators used by every later work package.

- **T-01-01 — Implement schema registry** — Load, version, and resolve JSON Schemas for all domain and agent/workflow records.
- **T-01-02 — Implement agent and workflow manifest validation** — Validate tool allowlists, output schemas, fresh-context flags, state transitions, and referenced agents/subworkflows.
- **T-01-03 — Implement bundle and link validator** — Check internal links, source-copy hashes, diagrams, task dependencies, and forbidden artifacts.

### [WP-02 — Evaluation baseline and corpus laboratory](tasks/wp-02.yaml)
Create the test harness and labeled corpora before agent quality is optimized.

- **T-02-01 — Build tiny synthetic corpus and expected graph** — Author a compact corpus with overview, procedure, deprecation, contradiction, disconnected note, duplicate content, and unsupported question.
- **T-02-02 — Define quality metrics and labeling guide** — Specify evidence, claim, exploration, dedup, publication, operations, and human-task metrics.
- **T-02-03 — Build fixture runner and result store** — Run deterministic, agent, workflow, retrieval, claim, and navigation fixtures with versioned results.

## Phase 1 — Deterministic source plane

### [WP-10 — Source intake and replay custody](tasks/wp-10.yaml)
Securely accept source packages, assign immutable snapshots, and retain replayable bytes.

- **T-10-01 — Implement package preflight** — Validate archive paths, file counts/sizes, media types, include/exclude rules, and policy prerequisites.
- **T-10-02 — Create immutable source snapshot** — Hash original artifacts/files and persist SourceSnapshot and SourceFile records idempotently.
- **T-10-03 — Implement replay capsule lifecycle** — Seal, replicate, verify, export, retain, and delete source replay capsules.

### [WP-11 — Extraction and qualified representations](tasks/wp-11.yaml)
Produce faithful representations and original-to-normalized locators for supported formats.

- **T-11-01 — Implement A-tier text extractors** — Support Markdown, text, code, JSON/YAML, and CSV with exact mappings.
- **T-11-02 — Implement representation audit framework** — Classify format tiers and run structural/render checks with audit records.
- **T-11-03 — Implement immutable repair path** — Allow human-corrected representations with provenance and supersession without changing originals.

### [WP-12 — Structural unitization, maps, and lexical retrieval](tasks/wp-12.yaml)
Create stable source units and the default exact/lexical retrieval projection.

- **T-12-01 — Implement structural source-unit parser** — Create document/section/paragraph/list/table/code units with parent and heading relationships.
- **T-12-02 — Build exact maps and aliases** — Generate ID/path/title/heading/acronym/error-code maps and ambiguity handling.
- **T-12-03 — Build lexical index and search receipts** — Index structural fields, apply scope/status filters, and emit engine-neutral search receipts.
- **T-12-04 — Benchmark optional semantic retrieval** — Compare lexical-only and dense/hybrid candidates on representative replay fixtures.

### [WP-13 — Data policy and source access enforcement](tasks/wp-13.yaml)
Propagate classification, rights, access, and processing policies through every source boundary.

- **T-13-01 — Implement data and rights policy profiles** — Define classification, providers, region, retention, logging, cache, quote, and publication rules.
- **T-13-02 — Enforce policy at retrieval/model boundaries** — Filter before LLM exposure and isolate cache/storage namespaces.
- **T-13-03 — Implement secret/PII and publication scans** — Scan intake representations and proposed Git changes with configured actions.

## Phase 2 — Knowledge core

### [WP-20 — Question and coverage-obligation model](tasks/wp-20.yaml)
Implement questions as demand/navigation records and obligations as finite work ownership.

- **T-20-01 — Implement Question repository and lifecycle** — Persist raw/canonical wording, goals/facets, scope, origin, graph links, and generations.
- **T-20-02 — Implement CoverageObligation ledger** — Create, assign, transfer, satisfy, block, and revoke finite obligations.
- **T-20-03 — Implement question admissibility and novelty gate** — Reject ungrounded, generic, duplicate, or obligation-less automatic proposals.

### [WP-21 — Evidence packet and verdict model](tasks/wp-21.yaml)
Implement immutable evidence/search artifacts and bounded evidence-refinement state.

- **T-21-01 — Implement EvidencePacket and SearchReceipt repository** — Persist packet versions, references, roles, facet mappings, queries, filters, and failures.
- **T-21-02 — Implement EvidenceVerdict lifecycle** — Persist reference classifications, facet states, terminal verdicts, and bounded refinement requests.
- **T-21-03 — Implement evidence loop limiter** — Detect repeated/non-novel refinement requests and route search-incomplete or human action.

### [WP-22 — Claim registry and independent review](tasks/wp-22.yaml)
Implement reusable claims between evidence and answers/documents.

- **T-22-01 — Implement Claim repository and lifecycle** — Persist proposed/accepted/disputed/stale/superseded claims with scope, type, evidence, and relationships.
- **T-22-02 — Implement claim candidate search** — Find equivalent, variant, broader/narrower, and contradiction candidates using text, scope, type, and evidence.
- **T-22-03 — Implement ClaimReview application** — Apply split, qualifier, acceptance, rejection, authority, and extraction outcomes idempotently.

### [WP-23 — Graph gateway and dependency validity](tasks/wp-23.yaml)
Provide serialized logical mutations, dependency graphs, and invalidation primitives.

- **T-23-01 — Implement graph mutation gateway** — Validate IDs, expected versions, idempotency, relationship types, and event persistence.
- **T-23-02 — Implement dependency graph and SCC analysis** — Track source→evidence→claim→answer/document dependencies and strongly connected components.
- **T-23-03 — Implement invalidation propagation** — Mark affected packets/claims/answers/documents/fixtures/certificates stale after dependency changes.

## Phase 3 — Measured agentic vertical slice

### [WP-30 — Researcher agent and source tools](tasks/wp-30.yaml)
Implement evidence-only research with exact references and auditable search receipts.

- **T-30-01 — Implement Researcher source tools** — Expose exact/maps/lexical/open/follow/authority searches with receipts and access filtering.
- **T-30-02 — Implement Researcher agent contract and prompt** — Return packet proposals, reference roles, facet support, and limits only.
- **T-30-03 — Calibrate Researcher retrieval policy** — Tune candidate counts, query expansion, context opening, and optional reranking on labeled corpora.

### [WP-31 — Evidence Critic agent](tasks/wp-31.yaml)
Implement the strict independent current-question evidence gate.

- **T-31-01 — Implement Evidence Critic contract and prompt** — Open material references and return reference/facet classifications and terminal verdict.
- **T-31-02 — Build evidence-criticism fixtures** — Cover partial evidence, irrelevant citations, redundant citations, wrong scope, deprecation, conflict, and no evidence.
- **T-31-03 — Run combined-versus-split ablation** — Compare the v3 critic with a combined critic/curiosity baseline.

### [WP-32 — Claim Extractor and Claim Reviewer agents](tasks/wp-32.yaml)
Turn accepted evidence into independently reviewed reusable claims.

- **T-32-01 — Implement Claim Extractor agent** — Propose minimal claims with type, scope, authority/lifecycle, evidence, and candidate relationships.
- **T-32-02 — Implement Claim Reviewer agent** — Verify entailment, atomicity, scope, qualifiers, authority eligibility, and split/merge candidates.
- **T-32-03 — Calibrate claim granularity and relationships** — Label pilot claims and tune guidelines for reuse versus fragmentation.

### [WP-33 — Curiosity Planner and branch scheduler](tasks/wp-33.yaml)
Implement grounded expansion after terminal evidence/claim outcomes.

- **T-33-01 — Implement Curiosity Planner agent** — Propose child questions with goals/facets, triggers, expected answer types, directives, and obligation IDs.
- **T-33-02 — Implement novelty/obligation scheduler** — Admit, rewrite, queue, prioritize, or reject proposals deterministically.
- **T-33-03 — Implement paired context manifests and recovery** — Build compact reconstructable branch contexts independent of live provider sessions.

## Phase 4 — Coverage and human steering

### [WP-40 — Reverse Questioner and source-led accounting](tasks/wp-40.yaml)
Discover meaningful source content that forward question expansion did not use.

- **T-40-01 — Implement uncovered-unit clustering** — Group unaccounted units by structure, topic, authority, lifecycle, and duplication.
- **T-40-02 — Implement Reverse Questioner agent** — Create minimum grounded questions or explicit dispositions from source clusters.
- **T-40-03 — Implement iterative reverse reconciliation** — Route selected questions into exploration and repeat until source accounting stabilizes.

### [WP-41 — Human curiosity and source-topic curation](tasks/wp-41.yaml)
Let operators inject tacit demand and choose supplemental uncovered topics.

- **T-41-01 — Implement Ask-here injection model and API** — Create human questions at root/question/claim/document/source anchors with goals and context.
- **T-41-02 — Implement uncovered-topic curation** — Present topic tree with include/exclude/defer/historical/duplicate decisions and previews.
- **T-41-03 — Implement human curiosity checkpoint** — Require explicit acknowledgment and zero open injections before closure.

### [WP-42 — Operational closure and assurance certificate](tasks/wp-42.yaml)
Compute the bounded completion predicate and expose exact exceptions.

- **T-42-01 — Implement gate collectors** — Collect forward/reverse/human/coverage/evidence/claim/authority/extraction/dedup/validity/publication/replay gates.
- **T-42-02 — Implement closure certificate issuance/invalidation** — Issue scoped status and invalidate on dependency changes.
- **T-42-03 — Build closure adversarial suite** — Test empty queues with unreviewed units, held duplicates, stale claims, unavailable source, and budget pauses.

## Phase 5 — Convergence and maintenance

### [WP-50 — Question and claim convergence](tasks/wp-50.yaml)
Detect and safely reconcile duplicate/equivalent work without deleting provenance.

- **T-50-01 — Implement multi-signal candidate generation** — Combine semantic intent, goals/facets, scope, expected answer, claims/evidence, and graph context.
- **T-50-02 — Implement Duplicate Adjudicator and typed relations** — Produce reversible exact/subset/shared-answer/scoped/contradiction/distinct decisions.
- **T-50-03 — Implement dual replay, holds, and revocation** — Replay later question and canonical facets, pause redundant execution, and restore on revocation.

### [WP-51 — Authority, lifecycle, and contradiction resolution](tasks/wp-51.yaml)
Keep current, historical, scoped, and conflicting claims honest.

- **T-51-01 — Implement project authority policy** — Define precedence, scope dimensions, effective-time, owners, and historical handling.
- **T-51-02 — Implement contradiction laboratory** — Search for supersession, exceptions, scope, and implementation/policy evidence for a conflict.
- **T-51-03 — Implement human authority decision and history graph** — Record named decisions, rationale, evidence, scope/time, and reversibility.

### [WP-52 — Incremental re-ingestion and invalidation](tasks/wp-52.yaml)
Update a seeded knowledge base from replacement source snapshots without rebuilding all logical work blindly.

- **T-52-01 — Implement source continuity diff** — Classify unchanged, moved, changed, deleted, new, and authority-metadata changes.
- **T-52-02 — Schedule affected obligations and targeted replay** — Create obligations for stale claims/questions/new units and rerun only affected branches.
- **T-52-03 — Generate focused update PR and migration report** — Regenerate affected answers/docs/fixtures and explain continuity/replacements.

## Phase 6 — Answers and publication

### [WP-60 — Answer composition from accepted claims](tasks/wp-60.yaml)
Generate question-specific answers without direct source research.

- **T-60-01 — Implement sealed claim-pack builder** — Assemble accepted claims, qualifiers, relationships, citations, gaps, and graph revision for one question.
- **T-60-02 — Implement Answer Composer agent** — Produce direct answers, claim order, citations, coverage, and limitations; return insufficient pack when needed.
- **T-60-03 — Implement answer citation/validity review** — Verify sentence support, scope, graph revision, and dependency hashes.

### [WP-61 — Information architecture and canonical homes](tasks/wp-61.yaml)
Transform claim/question demand into reader-oriented document structure.

- **T-61-01 — Define document types and IA rules** — Specify overview/concept/procedure/reference/decision/troubleshooting/glossary/history templates and canonical-home policy.
- **T-61-02 — Implement Information Architect agent** — Map stabilized claims/questions into an approved DocumentPlan.
- **T-61-03 — Build document-plan review workbench** — Allow human review of canonical homes, duplicates, redirects, and publication mode.

### [WP-62 — Document generation, citation, and navigation review](tasks/wp-62.yaml)
Produce and verify reader-facing documentation from sealed claims and approved IA.

- **T-62-01 — Implement Document Writer agent and traceability** — Write document sections from claim packs and emit sentence/claim mapping.
- **T-62-02 — Implement deterministic and fresh citation review** — Check links, canonical homes, claim validity, entailment, qualifiers, and unsupported editorial content.
- **T-62-03 — Implement representative navigation tests** — Run fresh reader tasks and compare to raw source baseline.

### [WP-63 — Git publication and Docent import](tasks/wp-63.yaml)
Create a coherent reviewable transaction for provisional or canonical import.

- **T-63-01 — Implement publication planner and worktree writer** — Select artifacts, paths, maps, fixtures, and authority mode; write isolated branch.
- **T-63-02 — Implement independent diff review and summary** — Review final diff against plan/claims and summarize final diff alone.
- **T-63-03 — Implement Docent import and replay** — Merge by risk policy, rebuild projections, and replay imported questions/claims.

## Phase 7 — Product operations

### [WP-70 — Live dashboard and operator workbench](tasks/wp-70.yaml)
Expose activity, evidence, claims, coverage, assurance, and human controls accurately.

- **T-70-01 — Implement durable event model and streaming API** — Persist ordered events and deliver snapshot+incremental SSE/WebSocket projections.
- **T-70-02 — Implement graph/source/claim dashboard views** — Render question tree, claim graph, source coverage, branch lanes, and validity.
- **T-70-03 — Implement human decision workbenches** — Support curiosity injection, curation, dedup, authority, extraction repair, budgets, and publication review.
- **T-70-04 — Run transparency comprehension study** — Test Activity versus Evidence versus Assurance semantics and bounded closure language.

### [WP-71 — Workflow orchestration, concurrency, and recovery](tasks/wp-71.yaml)
Provide durable, idempotent execution for parallel paired branches and human waits.

- **T-71-01 — Select/implement durable workflow engine** — Evaluate existing engine versus custom state machine and implement adapters.
- **T-71-02 — Implement leases, optimistic graph writes, and idempotency** — Coordinate branches, graph mutations, duplicate leaders, and coverage batches.
- **T-71-03 — Implement context reconstruction and compaction** — Build immutable context manifests and verified compaction for long branches.

### [WP-72 — Observability, cost, and cache optimization](tasks/wp-72.yaml)
Measure quality, operations, and economics without making cache a correctness assumption.

- **T-72-01 — Implement telemetry and cost ledger** — Record per-step/model/tool tokens, latency, cost, errors, and cache receipts without duplicating sensitive text.
- **T-72-02 — Implement deterministic prompt compiler and prefix tests** — Assemble stable P0–P4 layers with hashes and provider-neutral context packs.
- **T-72-03 — Implement preflight work/cost forecast and circuit breakers** — Estimate obligation-bound work under zero/conservative/observed cache and enforce budgets.

## Phase 8 — Evaluation and rollout

### [WP-80 — Comprehensive automated and adversarial test suite](tasks/wp-80.yaml)
Integrate deterministic, agent, workflow, security, migration, and end-to-end tests in CI.

- **T-80-01 — Build full CI test matrix** — Partition fast schema/unit, agent fixtures, workflow recovery, corpus replay, security, and slow scale tests.
- **T-80-02 — Build adversarial source and agent suite** — Include injection, archive attacks, secrets, stale/current ambiguity, duplicate traps, locator corruption, and malformed outputs.
- **T-80-03 — Build mutation and invalidation suite** — Programmatically alter source text, locators, scope, authority, and claim relationships.

### [WP-81 — Pilot corpora and architecture ablations](tasks/wp-81.yaml)
Validate the two v3 changes and optional retrieval choices on realistic projects.

- **T-81-01 — Run tiny and small deterministic pilots** — Reach exact expected graphs and debug workflow/UX issues.
- **T-81-02 — Run v3 architecture ablations** — Compare claim-mediated versus question-only and split versus combined Questioner designs.
- **T-81-03 — Run medium real-project shadow ingestion** — Use domain reviewers and stratified sampling across claims/questions/coverage/documents.

### [WP-82 — Production readiness and staged rollout](tasks/wp-82.yaml)
Turn pilot evidence into a supportable production service and operating model.

- **T-82-01 — Finalize release thresholds and operating policies** — Set quality confidence bounds, supported formats, data profiles, budgets, review rules, and SLIs.
- **T-82-02 — Run disaster recovery and deletion drills** — Exercise source/runtime/index loss, provider outage, Git conflict, and authorized deletion.
- **T-82-03 — Roll out in controlled cohorts** — Start with trusted A-tier corpora, monitor, expand formats/teams, and review incidents.

