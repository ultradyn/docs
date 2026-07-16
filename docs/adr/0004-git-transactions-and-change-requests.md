# ADR 0004: Git transactions and change requests

Status: accepted

## Context

Questions, claims, transcripts, and integrations all mutate the Git-backed database. They need concurrency and local-only behavior without assuming every operator can create remote pull requests.

## Decision target

Repository mutations acquire a repository lock, validate the expected lifecycle revision, write temp files, atomically rename, regenerate projections, and then release. A checkpoint service creates small state commits when configured; otherwise it leaves an explicit pending checkpoint visible in Maintenance.

Documentation integration uses an isolated Git worktree and a `ultradyn/<question-id>` branch. A change request is backend-neutral: local branches and review metadata are complete implementations; GitHub PR publication is optional. Remote polling never performs a review under a different identity—it creates a locally claimable review task.

## Consequences

The target design allows one repository to be served by multiple processes without silent lost updates. Users without GitHub write/review roles can complete checks locally; remote publication adds coordination, not core correctness.

## Implementation status

Question mutations use a canonical-repository-keyed machine-local lock, expected revisions, atomic replacement, and question-index regeneration. Raw artifact append is restartable across the file-publication/manifest boundary and fails closed when recovered bytes differ. Matched-ask attachment reserves all raw paths in an atomic machine-local journal before publication and records a base-revision-scoped operation marker in portable provenance; retry therefore completes question, chat, record, provenance, and index exactly once, while a changed same-revision payload fails closed. Recovery composes onto a newer valid record revision without overwriting intervening changes and rejects an impossible rewind. Local documentation proposals use isolated worktrees, actual diffs, checks, and explicit approvals. The checkpoint setting is enforced around approved local merges: when enabled it commits managed question/settings state, and when disabled any uncommitted managed paths produce one explicit pending-checkpoint task and count in Maintenance. A general checkpoint service for portable mutations outside that merge path is still absent. Change-request metadata is machine-local, general map regeneration and automatic rebase/re-plan are absent, and cross-process safety is not established for every settings/Git workflow. GitHub polling creates visible review/re-review tasks, but they are not claimable/actionable and publication is not wired to local approvals. These are in-repository items in `BLOCKED_TASKS.md`.
