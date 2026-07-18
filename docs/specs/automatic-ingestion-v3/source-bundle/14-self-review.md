# Self-Review and Cross-Reference Pass

## 1. Review question

Does the bundle actually integrate the two requested structural changes, or merely mention them in a summary?

## 2. Findings and implemented fixes

### 2.1 Question graph was still at risk of carrying facts implicitly

**Problem:** A design could add a `Claim` schema but continue writing answers directly from evidence and using questions as canonical fact containers.

**Fix:** The normative flow now requires independently reviewed claims between accepted evidence and all promotable answers/documents. Answer Composer and Document Writer have no retrieval tool and use sealed claim packs.

### 2.2 A formal ontology would overcomplicate the first implementation

**Problem:** Introducing claims could accidentally become a universal triple/ontology project.

**Fix:** Claims are natural-language atomic propositions with limited typed metadata, scope, evidence, authority/lifecycle, and relationships. The plan explicitly defers richer ontology work.

### 2.3 Evidence Critic and Curiosity Planner could still leak responsibilities

**Problem:** Separate names are insufficient if schemas allow mixed outputs or workflows share context.

**Fix:** Separate agent schemas, fresh contexts, workflow states, forbidden actions, and fixtures enforce the split. The Evidence Critic cannot emit child proposals; the Curiosity Planner cannot revise verdicts.

### 2.4 Claim extraction could reproduce the original self-grading problem

**Problem:** A Claim Extractor might declare its own claims accepted.

**Fix:** Claim Reviewer is a distinct fresh-context role. Proposed and accepted claim states are separate.

### 2.5 Minimal evidence versus complete source accounting remained easy to conflate

**Problem:** Requiring every relevant passage in an EvidencePacket creates bloated answers; accepting minimal packets can silently lose source content.

**Fix:** Evidence Critic owns minimal complete answer support. The source coverage ledger and Reverse Questioner own corpus accounting.

### 2.6 Deduplication needed separate question and claim decisions

**Problem:** Evidence similarity can indicate shared claims without identical questions.

**Fix:** The domain model and convergence protocol define separate question and claim outcomes, including `shares_answer_with`, scoped claim variants, and reversible equivalence.

### 2.7 Writing needed to stop mirroring the question hierarchy

**Problem:** One page per question would preserve conversational fragmentation.

**Fix:** Information Architecture assigns claims to reader-oriented canonical homes and document types before prose generation.

### 2.8 Git as authoritative state was too easily read as Git-only runtime

**Problem:** Parallel leases, events, retries, and dashboard state are awkward as direct Git writes.

**Fix:** The architecture permits a transactional/event projection store while requiring export of accepted logical state to Git. Completed-run auditability does not depend on reconstructing every scheduler instant.

### 2.9 Early overbuilding risk

**Problem:** The complete design contains many agents and controls before the central quality assumptions are measured.

**Fix:** The implementation plan starts with a narrow vertical slice: A-tier Markdown/text snapshot, lexical retrieval, one Researcher/Evidence Critic loop, claim extraction/review, and one answer replay. Later phases are gated by pilot evidence.

### 2.10 Major-problem controls needed task-level ownership

**Problem:** Risk registers often remain unimplemented prose.

**Fix:** The `plan/tasks/` work packages attach source custody, extraction, independence, dedup, security, editorial, dashboard, and invalidation controls to concrete tasks, dependencies, acceptance criteria, and test surfaces.

## 3. Cross-reference check

| Requirement | Primary locations |
|---|---|
| Source–claim–question–answer model | `00`, `02`, `03`, `06`, schemas, examples, plan Phase 2/6 |
| Evidence Critic / Curiosity Planner split | `00`, `04`, agent manifests, workflows, fixtures, plan Phase 3 |
| Reverse Questioner | `04`, `07`, agent/workflow, plan Phase 4 |
| Human curiosity injection | `04`, `07`, `09`, workflow, plan Phase 4 |
| Perspective sweeps reserve | `01`, `07`, `IDEA_REGISTER.md` |
| Deterministic source/index layer | `05`, schemas, plan Phase 1 |
| Non-destructive dedup | `03`, `07`, workflow, plan Phase 5 |
| Information architecture | `03`, `08`, agents/workflows, plan Phase 6 |
| Complete hierarchical task plan | `plan/` and task validator |

## 4. Remaining open implementation decisions

- exact first-release lexical engine;
- workflow engine versus custom durable state machine;
- first supported B-tier formats;
- transactional projection store choice;
- model/provider routing by role and data policy;
- claim granularity guidelines after pilot annotation;
- navigation-test tasks for the first real project;
- threshold for optional vector retrieval;
- retention duration and legal policy for replay capsules;
- whether a claim registry is one file per claim or partitioned JSONL at scale.

These choices do not alter the two v3 architectural changes.

## 5. Validation posture

The bundle includes a validator for schema conformance, agent/workflow references, example records, task completeness/dependency cycles, source-copy hashes, diagrams, links, and forbidden index artifacts. Validation proves package consistency, not production quality; the staged corpus plan is the evidence mechanism for that.
