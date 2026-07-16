# Building Ultradyn Docs

This file is for coding agents constructing and maintaining Ultradyn Docs. It is not guidance for agents operating a generated documentation repository.

## Start here

Read `CONTEXT.md`, the relevant ADRs in `docs/adr/`, this file, and the source plan in `.plan/`. Treat `BLOCKED_TASKS.md` as the release-truth ledger for both unfinished in-repo work and genuine external activation gates.

## Non-negotiable invariants

- Git stores all portable, non-secret project state. Machine indexes, locks, audio, secrets, and runtime cursors remain local.
- Raw artifacts are append-only and immutable after successful creation. Corrections are new raw artifacts; never edit a transcript in place.
- The lifecycle state in `question.md` is canonical. Queue folders are projections maintained transactionally.
- Contradictions are active P1 blockers. Ordinary depth gaps become deferred child questions.
- Evaluators run in fresh provider calls. Reviewer and Diff Summarizer receive the actual diff; Simulated Asker receives the verbatim ask and post-diff view.
- Deterministic services own IDs, filesystem writes, priority precedence, state transitions, git plumbing, and schema validation. Agents suggest content; they do not perform fragile shell work.
- Do not call an external provider complete until it has a production adapter, deterministic fake cases, tests, visible UI state, documentation, and an exact activation checklist. If production cannot run, its public capability boundary must still have a local fake path.
- Never read or copy credential files without an explicit consent record. Prefer delegating to the installed client (for example `codex exec`) over parsing its secret store.
- Agent-authored documentation changes use a branch/change-request lane, never a direct commit to the default branch.

## Development loop

Use the project-local Matt Pocock skills in `.codex/skills/`. For implementation, follow `.codex/skills/tdd/SKILL.md`: one failing behavior test, minimal implementation, then the next vertical slice. The agreed public seams are recorded in `docs/engineering/tdd-seams.md`.

Run before handing off:

```sh
pnpm check
```

Run terminal snapshots separately on a Linux host with tmux:

```sh
pnpm test:tui
```

Do not update a snapshot merely to make CI green. Inspect the plain and ANSI captures at 40, 80, and 120 columns first.

## Code boundaries

- `code/domain/`: lifecycle, priorities, schemas, repository records.
- `code/repository/`: atomic/locked filesystem and Git operations.
- `code/providers/`: consent, credentials, LLM, STT, codec, Git-host contracts and fakes.
- `code/agents/`: dynamic agent runtime, definitions, schemas, fixtures.
- `code/server/`: Fastify API, streaming events, jobs, and static web delivery.
- `code/web/`: React browser UI and browser-owned media capture.
- `code/cli/`: the `npx @ultradyn/docs` installer and command dispatcher.
- `tauri-app/`: thin desktop launcher for the same server and built web UI.

Keep modules deep: export a small public surface from each directory's `index.ts`; tests use those surfaces rather than internals.

## Agent skills

### Issue tracker

Issues live in `ultradyn/docs` on GitHub; use the connected GitHub app first and local `gh` only where the connector lacks an operation. See `docs/agents/issue-tracker.md`.

### Domain docs

This is a single-context repository with root `CONTEXT.md` and system decisions in `docs/adr/`. See `docs/agents/domain.md`.

## Review expectations

Reject changes that weaken raw immutability, evaluator isolation, consent, deterministic fake coverage, or local-only operability. Review generated source and committed snapshots as carefully as handwritten code. Keep YAGNI: prefer a small typed adapter or a one-line library call over a new framework.
