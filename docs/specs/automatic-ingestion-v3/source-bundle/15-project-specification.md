# Normative Project Specification

## 1. Scope

This document consolidates the release requirements for Automatic Ingestion v3. Companion documents provide rationale, schemas, workflows, examples, and implementation tasks.

## 2. Functional requirements

### 2.1 Source intake and custody

| ID | Requirement |
|---|---|
| FR-SRC-001 | The system MUST create an immutable SourceSnapshot before agentic exploration. |
| FR-SRC-002 | Every included original file MUST have a verified content hash, media type, logical path, access classification, and rights profile. |
| FR-SRC-003 | Promotion MUST require a readable content-addressed replay capsule; external-only sources are exploratory. |
| FR-SRC-004 | The importer MUST reject traversal, link escape, decompression-limit, and configured prohibited-content violations before extraction/model calls. |
| FR-SRC-005 | Supported formats MUST declare A/B/C/D extraction capability tiers and corresponding evidence eligibility. |
| FR-SRC-006 | Qualified representations MUST preserve original-to-normalized locators and extractor/audit versions. |
| FR-SRC-007 | A repair MUST create a new immutable representation and trigger dependent source-unit regeneration/invalidation. |

### 2.2 Source units and retrieval

| ID | Requirement |
|---|---|
| FR-RET-001 | Source text MUST be parsed into structural units with parent/heading relationships and exact source identity. |
| FR-RET-002 | Direct IDs, paths, aliases, headings, acronyms, and error codes MUST be resolved before semantic inference. |
| FR-RET-003 | v1 MUST provide exact/map and lexical retrieval; vectors MAY be enabled only after replay evidence. |
| FR-RET-004 | Retrieval MUST apply access, scope, lifecycle, and authority filters before model exposure where configured. |
| FR-RET-005 | Every Researcher outcome MUST contain a search receipt; service failure MUST NOT be reported as corpus absence. |
| FR-RET-006 | Binary indexes and embeddings MUST be rebuildable and excluded from ordinary Git history. |

### 2.3 Questions and obligations

| ID | Requirement |
|---|---|
| FR-Q-001 | Questions MUST preserve raw/canonical wording, origin, goals, facets, scope, parents/cross-links, and generation. |
| FR-Q-002 | Human, seed, generated, reverse-source, and invalidation-reopened origins MUST remain distinguishable. |
| FR-Q-003 | Every automatically generated branch MUST own a novel unresolved CoverageObligation. |
| FR-Q-004 | Human curiosity questions MAY be admitted without existing source support and may conclude as source gaps. |
| FR-Q-005 | Budget, retry, cache, provider, or index failures MUST NOT satisfy obligations or close a run. |

### 2.4 Research and evidence criticism

| ID | Requirement |
|---|---|
| FR-EV-001 | The Researcher MUST emit evidence references, proposed roles/facet mappings, and a search receipt; it MUST NOT emit a final answer or child questions. |
| FR-EV-002 | The Evidence Critic MUST run in fresh context and independently open material references. |
| FR-EV-003 | The Evidence Critic MUST classify every material reference and every required facet. |
| FR-EV-004 | The Evidence Critic MUST NOT propose child questions. |
| FR-EV-005 | `accepted` requires all required facets, material qualifiers, current/scope correctness, and no unresolved contradiction. |
| FR-EV-006 | A refinement request MUST identify precise missing evidence/search work and be versioned. |
| FR-EV-007 | A no-evidence result MUST be scoped to the snapshot/search configuration and supported by a passing receipt. |

### 2.5 Claims

| ID | Requirement |
|---|---|
| FR-CLM-001 | Promotable answers and documents MUST use accepted Claim records between evidence and prose. |
| FR-CLM-002 | A Claim MUST contain an atomic statement, type, scope, authority, lifecycle, status, and verified evidence. |
| FR-CLM-003 | Claim IDs MUST be assigned and stable; fingerprints MUST NOT define entity identity. |
| FR-CLM-004 | Claim extraction and Claim Review MUST be separate fresh-context calls. |
| FR-CLM-005 | Proposed claims MUST NOT enter answer/document packs until accepted. |
| FR-CLM-006 | Material qualifiers, exceptions, historical status, and version/environment boundaries MUST be preserved. |
| FR-CLM-007 | Claim convergence MUST distinguish equivalence, scoped/qualified variants, broader/narrower, contradiction, and distinct. |
| FR-CLM-008 | Source/extraction/authority changes MUST mark affected claims stale and propagate downstream invalidation. |

### 2.6 Curiosity and coverage

| ID | Requirement |
|---|---|
| FR-CUR-001 | The Curiosity Planner MUST run only after a terminal evidence outcome and MUST NOT alter that outcome. |
| FR-CUR-002 | Every automatic child proposal MUST identify triggers, goals/facets, expected answer type, directive, and obligation. |
| FR-CUR-003 | Generic missingness, undocumented intent, outside-world speculation, and obligation-less reformulations MUST be rejected. |
| FR-CUR-004 | The Coverage Auditor MUST maintain a terminal disposition for every selected semantic source unit. |
| FR-CUR-005 | The Reverse Questioner MUST create the minimum grounded question set or explicit disposition for unaccounted source clusters. |
| FR-CUR-006 | Operators MUST be able to curate uncovered topics and inject a question at any graph anchor. |
| FR-CUR-007 | Perspective sweeps MUST remain disabled until their reserve activation policy is satisfied. |

### 2.7 Convergence, authority, and invalidation

| ID | Requirement |
|---|---|
| FR-CON-001 | Question and claim convergence MUST be evaluated separately. |
| FR-CON-002 | Similarity/evidence overlap MAY create candidates but MUST NOT delete or destructively merge provenance. |
| FR-CON-003 | Pausing redundant execution requires unique-contribution reconciliation and dual replay. |
| FR-CON-004 | A convergence decision MUST be reversible and revocation MUST restore obligations/branches and invalidate dependencies. |
| FR-AUT-001 | A production run MUST reference a project authority/lifecycle policy. |
| FR-AUT-002 | Scope/time/authority MUST be checked before confirming contradiction. |
| FR-AUT-003 | Unresolved organizational authority MUST route to a named authorized human or remain blocked. |
| FR-VAL-001 | Answers/documents/certificates MUST record graph revision and dependency hashes. |
| FR-VAL-002 | Relevant source, claim, policy, convergence, extraction, or curiosity events MUST propagate invalidation. |

### 2.8 Answers and documentation

| ID | Requirement |
|---|---|
| FR-ANS-001 | Answer Composer MUST use only sealed accepted claim packs and MUST have no source retrieval tool. |
| FR-ANS-002 | Answers MUST include per-goal/facet coverage, limitations/gaps/conflicts, claim IDs, and exact citations. |
| FR-ANS-003 | Insufficient claim packs MUST reopen evidence/claim work instead of inducing unsupported synthesis. |
| FR-DOC-001 | Canonical documentation MUST have an approved DocumentPlan before prose generation. |
| FR-DOC-002 | The Information Architect MUST assign one canonical home per durable claim and may map several questions to one section. |
| FR-DOC-003 | Document Writer MUST use sealed claims, preserve traceability, and have no research tools. |
| FR-DOC-004 | Citation/claim review and representative navigation tasks MUST pass before canonical-documentation promotion. |
| FR-DOC-005 | Failed editorial gates MAY produce explicitly scoped partial publication, never falsely labeled canonical documentation. |

### 2.9 Dashboard and operations

| ID | Requirement |
|---|---|
| FR-OPS-001 | Running state MUST be durable/idempotent across retries and provider-session loss. |
| FR-OPS-002 | Graph mutations MUST use expected versions and an idempotency key. |
| FR-OPS-003 | The dashboard MUST separate Activity, Evidence, and Assurance. |
| FR-OPS-004 | Agent messages MUST be labeled explicit outputs/actions, not hidden reasoning. |
| FR-OPS-005 | Every status/gate MUST expose source artifacts, predicate, scope, and required human action. |
| FR-OPS-006 | Git is authoritative for accepted logical state; a transactional runtime MAY own live leases/events/projections. |
| FR-OPS-007 | Correctness/recovery and release economics MUST be tested with provider caches/sessions disabled. |

### 2.10 Security and publication

| ID | Requirement |
|---|---|
| SEC-001 | Source content MUST be treated as untrusted data and cannot alter agent/tool instructions. |
| SEC-002 | Data/rights policy MUST be enforced before extraction, model, cache, storage, and publication boundaries. |
| SEC-003 | Tool/path access MUST follow least privilege; evaluation agents do not mutate authoritative state directly. |
| SEC-004 | Proposed Git changes MUST be scanned for configured secrets and rights violations. |
| SEC-005 | Deletion MUST calculate dependency closure, erase/purge permitted representations, invalidate derived artifacts, and issue a certificate. |
| PUB-001 | Publication MUST occur on an isolated branch/PR, never direct to protected main. |
| PUB-002 | A fresh reviewer and diff-only summarizer MUST inspect the final diff. |
| PUB-003 | Post-merge projection rebuild and question/claim replay MUST pass or publication reopens. |

## 3. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-001 | Every accepted artifact identifies source snapshot/commit, schema, agent/workflow/model/tool versions, and producer. |
| NFR-002 | A failed index build cannot replace the last valid build. |
| NFR-003 | A clean logical export plus retained replay capsule reconstructs accepted run state. |
| NFR-004 | Re-running a completed step is idempotent. |
| NFR-005 | Source text is not duplicated unnecessarily into general telemetry. |
| NFR-006 | Performance reports name corpus size, configuration, models, and hardware. |
| NFR-007 | The system supports an explicit `paused_incomplete` state and never equates an empty queue with closure. |

## 4. Acceptance scenarios

### AS-01 — Complete overview with reusable claims

A Researcher finds purpose/components/boundary sources; the Evidence Critic accepts all facets; three claims pass independent review; two differently framed questions reuse those claims but receive distinct answers.

### AS-02 — Incomplete evidence refinement

The initial packet omits a material exception. The Evidence Critic identifies the exact missing facet and unnecessary citation, the Researcher returns a new packet version, and no Curiosity Planner runs before terminal acceptance.

### AS-03 — Honest source gap

A well-formed human question has no support in the snapshot. The Researcher supplies a sufficient search receipt, the Evidence Critic confirms `no_supported_answer`, and the gap remains distinguishable from retrieval failure.

### AS-04 — Split-role protection

A corpus contains many interesting related topics but weak evidence for the current question. The Evidence Critic rejects the packet rather than accepting it to reach curiosity. Only after terminal resolution does the Curiosity Planner propose grounded children.

### AS-05 — Reverse discovery

A maintenance note is disconnected from overview questions. Coverage clustering and Reverse Questioner propose a grounded maintenance question, which the human can include or exclude.

### AS-06 — Human curiosity reopening

After a provisional closure certificate, the operator injects a question at a claim node. The certificate and affected answer/document validity are invalidated and a normal branch begins.

### AS-07 — Same evidence, distinct question

Two questions cite the same project claims but have onboarding and API-integration goals. Convergence records `shares_answer_with`; neither question is deleted.

### AS-08 — Source change impact

A replacement snapshot changes retry attempts only. The retry claim and dependent answer/document become stale; unrelated project-purpose claims remain accepted.

### AS-09 — Historical versus current

A legacy direct-delivery source conflicts with current queued delivery only when scope is ignored. Authority/lifecycle handling keeps the old claim historical and prevents it from satisfying current answers.

### AS-10 — Reader-oriented publication

Several overlapping questions and shared claims become one overview plus one operational procedure, not one page per question. Citation and navigation checks pass before PR creation.

### AS-11 — Recovery without sessions or indexes

All provider sessions, caches, and derived indexes are deleted. The run reconstructs from durable artifacts and source replay, rebuilds projections, and continues without duplicate claims/questions.

### AS-12 — Unsafe source blocked

An archive contains traversal and a secret-like value. Preflight rejects/quarantines it before any external model event or Git publication.

## 5. Release boundary

The first internal release is complete when M3 in `plan/milestones.yaml` passes on the tiny and small corpora. Full automatic ingestion publication requires M8.
