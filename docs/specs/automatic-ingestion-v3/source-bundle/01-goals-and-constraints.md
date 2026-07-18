# Goals, Constraints, Users, and Product Principles

## 1. Product definition

Automatic ingestion takes an immutable snapshot of existing project documentation and turns it into a source-grounded knowledge seed for Docent. It does this by combining deterministic source processing with narrow LLM roles that explore questions, assess evidence, extract claims, identify gaps and contradictions, and prepare reader-oriented documentation.

The durable output is not merely a summary or chat transcript. It is:

- an auditable source inventory;
- a graph of questions and their declared goals;
- reusable claims with exact evidence;
- answer compositions and explicit gaps;
- contradiction, authority, lifecycle, and exclusion records;
- a source coverage ledger;
- reader-oriented documentation proposals;
- regression fixtures and an ingestion report.

## 2. Problems solved

### P1 — Existing documentation is hard to understand as a whole

Large repositories contain valuable but disconnected material. The system maps it through questions while retaining source-level accounting.

### P2 — Ordinary RAG can sound complete while missing decisive evidence

The Researcher does not grade its own retrieval. A fresh Evidence Critic independently opens references and evaluates every required facet.

### P3 — A question tree cannot safely represent all reusable knowledge

v3 introduces atomic claims between source evidence and answers/documents. Claims may support multiple questions and appear in several reader contexts without losing one canonical provenance chain.

### P4 — Strict criticism and expansive curiosity conflict

Evidence Criticism and Curiosity Planning are separate roles, contexts, outputs, and fixtures.

### P5 — “Fully ingested” is usually an untestable assertion

Operational closure is scoped to a named source snapshot, extraction/index configuration, question grammar, graph revision, source coverage ledger, human-curiosity checkpoint, and explicit exclusions.

### P6 — Imported documentation may preserve old errors

Authority, lifecycle, contradiction, and extraction quality remain attached to claims. Unresolved material blocks canonical promotion instead of being flattened into a confident answer.

### P7 — Generated Q&A is not automatically good documentation

An Information Architect organizes accepted claims into overviews, concepts, procedures, references, decisions, troubleshooting guides, and historical notes before publication.

## 3. Goals and decisive tests

| ID | Goal | Decisive test |
|---|---|---|
| G1 | Source fidelity | Every cited unit resolves to retained source bytes and verified original/normalized coordinates. |
| G2 | Evidence honesty | Every accepted question facet has independently verified evidence or an explicit gap/conflict state. |
| G3 | Reusable knowledge | Accepted claims can support multiple answers without duplicating provenance. |
| G4 | Bounded exploration | Every automatic child owns a novel finite obligation; budget exhaustion never counts as closure. |
| G5 | Bidirectional accounting | Forward exploration and Reverse Questioning account for all selected semantic source units. |
| G6 | Human steerability | A person can inject curiosity at any node and reopen affected work. |
| G7 | Non-destructive convergence | No duplicate decision deletes raw questions, evidence, claims, or branch checkpoints. |
| G8 | Reader-oriented output | Documentation passes claim, citation, canonical-home, and representative navigation checks. |
| G9 | Reproducibility | Accepted logical state is reconstructable from Git records plus retained source replay capsules. |
| G10 | Independent evaluation | Evidence, claims, deduplication, authority, and final publication are evaluated in fresh contexts. |
| G11 | Measurable retrieval | Resolved questions and claims become replay fixtures for future index/model changes. |
| G12 | Safe processing | Unapproved or unclassifiable content cannot cross model, storage, or publication boundaries. |

## 4. Non-goals for the first implementation

- Supporting every file format weakly.
- Proving that every conceivable human question has been generated.
- Building a general ontology or universal knowledge graph.
- Running perspective-specific sweeps by default.
- Automatically resolving organizational authority where the corpus is ambiguous.
- Publishing imported material as canonical policy without configured review.
- Making provider prompt caching necessary for viability.
- Using Git as the only live worker-lease or event-stream database.

## 5. Constraints

### C1 — Git contains authoritative logical records

Accepted source manifests, questions, claims, answers, decisions, agent/workflow definitions, maps, fixtures, and publication proposals live as diff-friendly text. Live orchestration stores are projections and checkpoints, not the sole owners of accepted knowledge.

### C2 — Source bytes are immutable and replayable

Original imports may remain outside ordinary Git, but promotion requires a content-addressed replay capsule with verified retention/access. A hash without retained bytes is not sufficient.

### C3 — Derived indexes are disposable

Lexical, vector, graph, cache, and dashboard projections are rebuilt from a pinned source snapshot and repository commit.

### C4 — Raw questions and human interventions are immutable

Original generated seeds, human curiosity injections, criticisms, rejection reasons, and agent outputs are append-only. Corrections create new records.

### C5 — Roles have narrow interfaces

The Researcher returns evidence proposals and search receipts, not answers. The Evidence Critic returns verdicts and refinement requests, not future questions. The Curiosity Planner returns grounded child proposals, not evidence verdicts.

### C6 — Fresh context for evaluation

Evidence Critic, Claim Reviewer, Duplicate Adjudicator, Authority Resolver, Citation Reviewer, Navigation Tester, and Final Auditor run without the producer’s private context.

### C7 — Claims require explicit scope and evidence

No accepted claim lacks evidence, authority/lifecycle metadata, and scope sufficient to distinguish current, historical, draft, environment-specific, and version-specific statements.

### C8 — Automatic children require obligations

A child must claim an uncovered source unit, unsatisfied facet, conflict, authority issue, extraction issue, ancestor deficiency, or selected supplemental topic. Human curiosity is explicit demand and may create a source gap.

### C9 — Deduplication is reversible

Canonicalization may pause redundant execution and share claims/answers, but it never removes original nodes or provenance.

### C10 — Publication is a PR

Imported questions, claims, answers, documents, fixtures, and reports enter Docent through a reviewable branch/PR with independent diff review.

### C11 — Security precedes model processing

Archive safety, access classification, secret/PII policy, licensing, and permitted providers are checked before source text leaves the approved boundary.

### C12 — Perspective sweeps are reserve capability

They are not baseline tasks or agents. They require measured activation evidence and an additional design decision.

## 6. Users and friction budgets

### Ingestion operator

Uploads or selects a source snapshot, confirms scope/policies/seeds, watches the live run, handles ambiguity, injects curiosity, curates uncovered topics, and reviews the final report.

Friction target: one setup screen for ordinary trusted Markdown imports; human decisions appear only for material ambiguity, security/rights, authority, uncovered-topic curation, and final publication.

### Maintainer

Owns parser/index configuration, authority and data policies, agent contracts, evaluation fixtures, and release thresholds.

### Documentation reviewer

Reviews the information architecture, generated docs, claim/citation support, and Git diff. Does not need to inspect every agent event unless a gate fails.

### Future asker

Receives answers from accepted claims/documents and can challenge imported knowledge through normal Docent feedback and reopening.

## 7. Principles

1. **Deterministic before agentic.** Establish source identity, structure, and search before asking models to interpret it.
2. **Evidence before prose.** Exploration produces evidence and claims; writing happens after stabilization.
3. **Claims between sources and answers.** Questions are demand; claims are reusable knowledge; documents are publication.
4. **Criticism before curiosity.** Finish judging the current evidence before planning the next branch.
5. **Minimal complete evidence.** Answer sufficiency does not require citing every related paragraph.
6. **Account for the rest separately.** Coverage and Reverse Questioning prevent silent source loss.
7. **Fresh eyes for every consequential gate.** Producers do not certify their own work.
8. **Reversible convergence.** Similarity can save execution but never erase history.
9. **Bounded closure, explicit exceptions.** The system states exactly what it completed and what it did not.
10. **Small first vertical slice.** Build and measure the evidence/claim loop before the full orchestration and dashboard.
