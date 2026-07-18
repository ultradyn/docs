# 07 — Automatic Ingestion v3: plan mapping

This document maps the adopted Automatic Ingestion v3 design bundle into this repository's planning and execution surfaces. It is a mapping/adoption record, not a restatement: the bundle's own plan is authoritative for original intent, and the backlog is authoritative for execution state (ADR 0006).

## Sources

- Preserved bundle (immutable provenance): `docs/specs/automatic-ingestion-v3/source-bundle/` — see `IMPORT.md` for the receipt.
- Adopted design and registers: `docs/specs/automatic-ingestion-v3/DESIGN.md` (conflicts C1–C16, decisions D1–D10, normalizations N1–N8).
- ADRs: `docs/adr/0005-automatic-ingestion-v3-adoption.md`, `docs/adr/0006-backlog-execution-truth.md`.
- Terminology note: the bundle uses the product's former name "Docent"; canonical name is Ultradyn Docs (confirmed by Max, 2026-07-18).

## Mapping rule

| Repo level | Bundle source | Instantiation |
|---|---|---|
| Phase | Release increment R0–R4 (`plan/01-roadmap.md`) | 5 backlog phases |
| Milestone | M0–M8 (`plan/milestones.yaml`) | 9 backlog milestones, IDs preserved in names |
| Epic | Work package WP-00…WP-82 (`plan/tasks/wp-*.yaml`) | 31 epics: 15 populated (R0/R1), 16 dependency-gated stubs |
| Task | Leaf task T-XX-NN (`plan/task-index.jsonl`) | 47 atomic tasks (R0/R1 only: 46 bundle leaves + 1 synthetic prerequisite); bundle IDs in tags + body |

R0/R1 scope = M0–M3 = WP-00, 01, 02, 10, 11, 12, 13, 20, 21, 22, 23, 30, 31, 32, 60. Later milestones enter as epic stubs whose bodies carry their gate language (DESIGN.md C10/C12 and the M7/M8 stub-gate paragraph); each stub expands into atomic tasks only at its milestone gate.

Dependency edges follow the bundle's `dependencies` fields with the normalization corrections N1–N4 (WP-60→WP-32; T-60-01 rewired off optional T-31-03; policy-profile contract split ahead of WP-10; unitization depends on representation audit). Optional tasks (T-12-04, T-30-03, T-31-03) are tagged `optional` and nothing depends on them.

## Relationship to earlier plan documents

`.plan/01–06` describe the core product (M0–M6 of the original breakdown) and remain historical/source planning. This feature's execution lives entirely in the backlog under its own phases; nothing in `.plan/06-task-breakdown.md` is renumbered or modified.

## Release truth

`BLOCKED_TASKS.md` gains an "Automatic ingestion" section listing the dependency gates that must clear before deferred epics expand (existing repo gaps such as GitHostProvider publication wiring, plus the C12 deletion-semantics ADR). Backlog stubs cross-link those entries by name.

--- SUMMARY ---

- Preserve the verified 223-file v3 bundle as inert provenance; production code uses reviewed TypeScript/Zod adaptations.
- `.backlog/` is execution truth: 5 phases, 9 milestones, 31 epics, and 47 executable R0/R1 tasks (46 bundle leaves plus N3); R2-R4 remain locked until their release gates are cleared.
- Canonical question lifecycle, contradiction blocking, raw immutability, evaluator isolation, and the existing change-request publication lane remain authoritative.
