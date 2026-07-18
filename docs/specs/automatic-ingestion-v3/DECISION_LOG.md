# Automatic Ingestion v3 — Architecture Decision Log

Deliverable of backlog task P1.M1.E1.T001 (bundle T-00-01). Disposition of every open architecture choice: **accepted**, **deferred with trigger**, or **assigned with owner/date**. Decided 2026-07-18 by the joint coordinators (claude-pivot-cotton-27tq, pi-73c593) under Max's `/max-afk` delegation; items marked _ratify_ are additionally flagged for Max's explicit sign-off at the named gate. Normative sources: `DESIGN.md` (C1–C16, D1–D10, N1–N8), ADR 0005/0006.

## The two v3 changes (approved)

- **Change A — layered knowledge model** (source units → claims → questions → answers → documents; claims reusable; no ontology). **Accepted**; represented in `docs/architecture.md` §Automatic ingestion, DESIGN §2, ADR 0005, CONTEXT.md glossary.
- **Change B — Evidence Critic / Curiosity Planner split** (bounded judgment vs obligation-bound curiosity; separate contexts/schemas/fixtures). **Accepted**; same locations, plus the C9 contract migration in ADR 0005.

## Bundle open decisions (source-bundle 14-self-review §4)

| ID  | Choice                                | Disposition                                                                               | Trigger / owner / date                                                                       |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| D1  | Lexical engine                        | **Accepted: MiniSearch** (existing dependency)                                            | Falsified by WP-12 retrieval fixtures if inadequate                                          |
| D2  | Workflow engine vs custom             | **Accepted: custom durable state machine** on the repo durable-cursor pattern             | —                                                                                            |
| D3  | First B-tier formats                  | **Deferred**                                                                              | Trigger: M4 gate; owner: M4 gate reviewers                                                   |
| D4  | Projection store                      | **Accepted for R0/R1: filesystem/durable-cursor behind interface**; store choice deferred | Trigger: M7 measured scale evidence                                                          |
| D5  | Model/provider routing by role        | **Deferred (structure accepted: typed provider contracts + fakes, per-role config)**      | Trigger: E-30/E-31 implementation                                                            |
| D6  | Claim granularity guidelines          | **Deferred**                                                                              | Trigger: M3 pilot annotation evidence                                                        |
| D7  | Navigation-test tasks, first project  | **Assigned**                                                                              | Owner: M6 planning; project = this repo's docs; date: M6 gate                                |
| D8  | Vector retrieval threshold            | **Deferred**                                                                              | Trigger: dedicated ADR + bundle replay-evidence gate; nothing may depend on optional T-12-04 |
| D9  | Replay-capsule retention/legal policy | **Assigned — _ratify Max_**                                                               | Owner: Max; date: M6 (publication) gate; interim default: append-only retention              |
| D10 | Claim registry layout                 | **Accepted: one file per claim**                                                          | Revisit trigger: M7 scale evidence (partitioned JSONL)                                       |

## Repo-adaptation decisions (accepted)

Language = TypeScript only; terminology = Ultradyn Docs (Docent is the former product name — Max, 2026-07-18); preserved source bundle is inert provenance, never production-loaded (N8); production contracts are curated adaptations registered through `createPortableSchemaValidator` (N7 dialect decision finalized in T-01-01/T-01-03); existing transcript Structurer/Critic lane untouched, ingestion roles orthogonal (C13); `AnswerComposition` distinct from Structured answer (C15); publication reuses the change-request manager (C16); intake lexical matching is routing-only (C16).

## Deferred features register (cross-checked against bundle IDEA_REGISTER)

- Perspective sweeps: **reserve** (bundle FR-CUR-007); trigger: reserve activation policy.
- Semantic/vector retrieval: deferred (D8).
- Rich graph UI at 10k scale, generic engine/leases, prompt compiler/forecast/budget, adversarial generator, pilots/shadow runs, production cohorts: dependency-gated M7/M8 stubs (DESIGN M7/M8 gate language).
- Source-custody deletion: **blocked** behind the C12 ADR; execution home T-10-04; owner: T-10-04 claimant + _ratify Max_.
- Obligation `deferred` disposition (C11): **assigned** to WP-20 contract task with mandatory non-closure/non-blocking tests.

## AC3 verification — authoritative-state boundary

Checked 2026-07-18: DESIGN, ADR 0005/0006, CONTEXT.md, `.plan/07`, and the R0/R1 plan all state Git is authoritative for accepted logical records with disposable machine-local projections (ADR 0002 alignment); agents propose only through the graph/validity gateway (ADR 0001/0004 alignment). No normative repo document asserts runtime-store authority over accepted records or direct agent mutation. The bundle's own prose (`02`, `16`) matches after the D4 narrowing. No contradiction found.
