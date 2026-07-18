# Implementation Plan

This subfolder decomposes the v3 design into **31 work packages and 95 leaf tasks** across nine phases. Every leaf task includes a description, goals, dependencies, deliverables, acceptance criteria, test surfaces, owner role, estimate class, and risk level.

## Start here

1. `00-delivery-strategy.md` — how to build the smallest measured vertical slice first.
2. `01-roadmap.md` — milestones and stage gates.
3. `02-work-breakdown-structure.md` — hierarchical phase/work-package index.
4. `03-dependency-map.md` and `dependency-graph.svg` — critical dependencies.
5. `04-test-strategy-by-phase.md` — test surfaces and promotion rules.
6. `05-acceptance-gates.md` — product and release gates.
7. `06-risk-and-decision-log.md` — decisions that remain evidence-dependent.
8. `07-definition-of-done.md` — task, work-package, milestone, and release completion rules.
9. `tasks/` — one YAML file per work package.
10. `task-index.jsonl` — flattened leaf-task view for tooling/import.

## Planning rule

A later phase may prototype early, but it may not claim completion until its dependency milestone passes. In particular, rich dashboarding, reverse exploration at scale, and document generation must not substitute for proving the Researcher → Evidence Critic → Claim → Answer vertical slice.
