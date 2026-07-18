# ADR 0006: Backlog as execution truth beside .plan and BLOCKED_TASKS

Status: accepted

## Context

Work has been tracked in `.plan/06-task-breakdown.md` (milestone plan) and `BLOCKED_TASKS.md` (release-truth ledger). The `backlog` (`bl`) CLI is installed but was never initialized, so there was no claim/parallelize mechanism for multi-agent execution. The automatic-ingestion adoption (ADR 0005) introduces 46 immediately executable tasks plus dependency-gated future work, and multiple agents will implement independent slices in parallel.

## Decision target

Initialize `.backlog/` and give each ledger one precise role:

- **`.backlog/` is execution truth**: what is claimable, claimed, blocked, or done, with dependencies, owners, and provenance tags. Agents `claim` before creating a worktree and `done` only after parent review and merge.
- **`.plan/` is the historical/source plan**: numbered planning documents remain immutable history plus mapping docs; they are not updated to reflect execution state.
- **`BLOCKED_TASKS.md` remains release truth**: unfinished in-repository work and external activation gates. Backlog stubs that depend on a release-truth item cross-link it by name.

Ledgers are cross-linked by ID but never auto-generated from one another. Backlog tasks originating from the ingestion bundle carry their bundle work-package/task IDs (`WP-XX`, `T-XX-NN`) in tags and body for traceability to `docs/specs/automatic-ingestion-v3/source-bundle/plan/`.

## Consequences

Multi-agent execution gets atomic claims and dependency-aware scheduling without disturbing the existing ledgers' meanings. The cost is one more surface to keep honest: only R0/R1-scope atomic tasks are instantiated now, and later bundle milestones enter as dependency-gated epic stubs expanded at their milestone gates, so the backlog never advertises work that current repository reality cannot support.

## Implementation status

`.backlog/` initialized in the automatic-ingestion S1 transaction with 5 phases (R0–R4), 9 milestones (M0–M8), 31 epics (15 populated with 46 atomic tasks; 16 dependency-gated stubs), normalization N1–N5 applied (see DESIGN.md appendix).
