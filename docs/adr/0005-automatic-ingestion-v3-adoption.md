# ADR 0005: Adopt the Automatic Ingestion v3 architecture

Status: accepted

## Context

Max supplied a self-consistent design bundle ("Docent Automatic Ingestion v3"; Docent is the product's former name — Ultradyn Docs is canonical) for automatically seeding this system from an existing document corpus. The bundle passed its own validator (27 schemas, 15 agents, 11 workflows, 31 work packages, 95 leaf tasks) and is preserved byte-identical at `docs/specs/automatic-ingestion-v3/source-bundle/` with an import receipt. Joint coordinator review (claude + pi sessions, under `/max-afk` delegation) produced the adopted design in `docs/specs/automatic-ingestion-v3/DESIGN.md`, including a conflict register (C1–C16) and decision register (D1–D10).

## Decision target

Adopt the v3 architecture with these binding commitments:

- **Layered knowledge model.** Source snapshots → structural source units → evidence references → independently reviewed atomic Claims → answer compositions and reader documents. Claims are the reusable knowledge layer; the question graph remains the demand/navigation layer; no ontology/triple store.
- **Split evaluator roles.** A strict Evidence Critic (judges sufficiency; schema-forbidden from proposing child questions) and a separate post-terminal Curiosity Planner (proposes obligation-bound children; cannot revise verdicts). Fresh contexts, separate schemas, separate fixtures.
- **Critic contract migration.** The existing transcript Critic lane stays intact and the new roles are an orthogonal lane. Where the existing Critic directly created deferred P4/P5 depth children, the ingestion lane instead has the Critic emit typed depth findings only; deterministic orchestration invokes the Curiosity Planner for child wording; the scheduler persists deferred P4/P5. Contradictions bypass the planner and immediately create active P1 resolution work forcing `done=false` (preserves ADR 0001 contradiction handling). `question.md.state` stays canonical; run/obligation/certificate records are modeled separately, and the bundle's Question.status enum is never imported over the canonical lifecycle.
- **Naming.** The existing transcript-derived "Structured answer" (`answers/structured.md`) is untouched; the v3 claim-derived record is a distinct `AnswerComposition` with a compatibility adapter.
- **Determinism boundary.** Deterministic services own IDs, writes, state transitions, and Git; agents only propose through a graph/validity gateway with expected versions and idempotency keys (matches ADR 0001/0004).
- **Retrieval.** Exact/map + lexical (MiniSearch) only; semantic/vector retrieval stays excluded until a future ADR supported by the bundle's replay-evidence threshold.
- **Projections.** Machine-local filesystem/durable-cursor patterns behind a projection-store interface; no new storage dependency in R0/R1; store choice revisited at M7 on measured evidence. Git remains authoritative for accepted records (ADR 0002).
- **Publication.** Reuse and generalize the existing isolated change-request manager (ADR 0004); no second publication/worktree subsystem. Intake lexical question matching is conservative routing only, never authoritative convergence.
- **Language.** All production work is TypeScript against `code/`; the bundle's Python validator remains a spec-consistency tool for the preserved bundle only.
- **Deletion gate.** Bundle deletion semantics (SEC-005 purge + certificate) may conflict with the append-only raw-artifact invariant; a dedicated ADR distinguishing authorized source-custody purge from portable append-only history is required before any deletion task starts.

## Consequences

The measured vertical slice (bundle milestones M0–M3) becomes implementable without violating existing invariants: 47 atomic tasks (46 bundle leaves plus the synthetic N3 policy prerequisite) are instantiated in the backlog and later milestones remain dependency-gated epic stubs. Two bundle inconsistencies are owned explicitly: the coverage-obligation `deferred` status gap (resolved with tests in the WP-20 contract work) and WP-60's missing dependency on accepted claim reviews (rewired during backlog normalization).

## Implementation status

Design and plan artifacts only; no production code yet. See `docs/specs/automatic-ingestion-v3/DESIGN.md` (decision register D1–D10, conflict register C1–C16, normalization appendix N1–N5), `.plan/07-automatic-ingestion-v3.md` (plan mapping), and the backlog phase for execution state.
