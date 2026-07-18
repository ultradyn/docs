# Docent Automatic Ingestion — Feature Bundle v3

**Artifact:** `ingest-feature-v3.zip`  
**Status:** implementation-oriented design package  
**Primary change:** the ingestion system now treats **source units, claims, questions, answers, and reader-facing documents as distinct layers**, and splits the old Questioner into a strict **Evidence Critic** and a separate **Curiosity Planner**.

## Why v3 exists

The earlier ingestion design had a strong source-grounded Researcher/Questioner loop, but two structural weaknesses remained:

1. the question graph risked becoming the entire knowledge model, even though one claim may answer many questions and one question may need many claims; and
2. one Questioner was asked both to reject inadequate evidence and to generate expansive follow-up questions, creating conflicting incentives.

v3 fixes both without discarding the valuable parts of the design: immutable source snapshots, evidence-only research, reverse questioning, human curiosity injection, non-destructive convergence, finite obligations, a rich live dashboard, and reviewable Docent publication.

## Core model

```text
Source snapshot
  └── source files
       └── structural source units
            └── evidence references
                 └── claims
                      ├── answer compositions for questions
                      └── canonical reader-facing documents

Questions remain the demand, exploration, and navigation graph.
Claims become the reusable knowledge layer.
Documents become the reader-oriented publication layer.
```

## Core loop

```text
Question + goals/facets
  → Researcher proposes an evidence packet
  → Evidence Critic independently verifies sufficiency
      ↳ needs evidence: precise criticism returns to Researcher
      ↳ conflict/authority: dedicated resolution workflow
      ↳ accepted: extract and independently verify atomic claims
      ↳ no evidence: preserve an honest gap and search certificate
  → Curiosity Planner independently proposes grounded child questions
  → Scheduler accepts only children with a new finite obligation
```

The product may still present the Evidence Critic and Curiosity Planner together as the “Questioner experience,” but they are separate model calls, contexts, schemas, and evaluation fixtures.

## Bundle map

| Path | Purpose |
|---|---|
| `00-v3-change-summary.md` | Exact v3 changes and superseded assumptions. |
| `01-goals-and-constraints.md` | Product intent, users, invariants, and release boundary. |
| `02-system-architecture.md` | Components, data planes, runtime boundaries, and diagrams. |
| `03-domain-model.md` | Source–claim–question–answer/document model. |
| `04-agent-roles-and-loops.md` | Narrow agent roles and workflow-compatible loops. |
| `05-source-ingestion-and-indexing.md` | Deterministic import, source units, retrieval, and coverage. |
| `06-evidence-and-claim-protocol.md` | Evidence packets, criticism, claim extraction, and verification. |
| `07-completeness-convergence-and-invalidation.md` | Closure, reverse questioning, human curiosity, dedup, and revisions. |
| `08-answer-writing-and-publication.md` | Answer composition, information architecture, documentation, and Git publication. |
| `09-dashboard-and-operations.md` | Live dashboard, event model, controls, and recovery. |
| `10-security-privacy-and-source-custody.md` | Replay capsules, policy enforcement, extraction safety, and deletion. |
| `11-testing-and-rollout.md` | Staged corpus testing, metrics, adversarial cases, and release gates. |
| `12-risk-resolution-register.md` | Resolutions and residual risk for the major design issues. |
| `13-integration-with-docent.md` | How ingestion outputs enter the existing Docent system. |
| `14-self-review.md` | Cross-reference pass, identified issues, and implemented fixes. |
| `15-project-specification.md` | Consolidated normative requirements and acceptance scenarios. |
| `16-runtime-interfaces.md` | Transport-neutral service, tool, dashboard, graph, and Git interfaces. |
| `IDEA_REGISTER.md` | Adopted, reserve, experimental, and deferred ideas. |
| `architecture.html` | Offline visual overview. |
| `agents/`, `workflows/`, `schemas/` | Machine-readable contracts. |
| `examples/`, `tests/` | Validated records and fixtures. |
| `plan/` | Comprehensive hierarchical implementation plan and task catalogue. |
| `source/` | Immutable copies of the supplied source documents. |

## Plan subfolder

The `plan/` directory is designed to be implementable rather than aspirational. It contains:

- delivery strategy and stage gates;
- a hierarchical work-breakdown structure;
- milestone and dependency maps;
- one machine-readable work-package file per package;
- a flattened task index;
- descriptions, goals, deliverables, dependencies, acceptance criteria, and test surfaces for every leaf task;
- a cross-phase test strategy and definition of done.

## Normative language

**MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** indicate requirement strength. When diagrams and prose differ, the prose and schemas are normative.

## Validation

Run:

```bash
python tools/validate_bundle.py
```

The validator checks schemas, agents, workflows, examples, task dependencies, work-package completeness, diagram renders, source-file integrity, local links, and forbidden committed binary index artifacts.
