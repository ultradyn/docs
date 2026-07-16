# Ultradyn Docs — Task Breakdown

Document 6 of 6 · Hierarchical decomposition of the spec (doc 03) into implementable tasks. Milestones are ordered constraint-first: each milestone's output is the thing the next milestone cannot proceed without, and every milestone ends in a usable (if narrow) system. Task IDs are stable references; `⛓` marks the milestone's constraint task — the one that gates everything after it.

---

## M0 — Repo schema & shell skeleton

_Constraint: nothing can be built or tested until the data layout and git plumbing exist._

- **T0.1 ⛓ Repository schema** — create the layout of 03 §2 as a template repo: `docs/`, `questions/{active,deferred,answered}`, `goals/`, `agents/`, `app/`, `.ultradyn-docs/`, `.gitignore` (derived dirs, `**/audio/`).
  - T0.1.1 `question.md` frontmatter schema + `provenance.yaml` schema (03 §4) as JSON Schema files.
  - T0.1.2 `index.jsonl` row schema + regeneration rule (rebuild from question folders).
  - T0.1.3 Seed `goals/vocabulary.md` (six seed goals, satisfaction-criteria stubs) and `goals/priority-rules.md` (P1–P5 table).
- **T0.2 Git plumbing library layer** — branch/commit/PR/rebase operations via a mature git library; no shelling out from agents.
- **T0.3 ULID module** — mint, prefix (`q-`,`ans-`,`f-`), index uniqueness check on insert.
- **T0.4 Immutability CI check** — fail any PR that modifies an existing file under any `raw/`.
- **T0.5 Index regenerator** — `questions/index.jsonl` and `_map.md` rebuild commands; conflict-resolution hook (regenerate, never hand-merge).

## M1 — Capture path (the unrecoverable component)

_Constraint: raw inputs are sacred (C3); everything downstream re-derives from them, so this must be trustworthy before anything consumes it._

- **T1.1 ⛓ Audio capture** — record/pause/resume/persist, library-backed (browser MediaRecorder or equivalent); local storage at `~/.ultradyn-docs/audio/<qid>/NNN.<ext>`.
  - T1.1.1 Failure-mode tests: interrupted recording, disk-full, permission-revoked, silent-truncation detection (duration vs expected).
- **T1.2 Transcription adapter** — pluggable STT interface; transcripts written verbatim to `raw/` with STT confidence in frontmatter (self-review §11).
- **T1.3 Verbatim question capture** — chat-side: freeze question text + relevant chat log into `raw/` at logging time.
- **T1.4 Capture-path test suite** — hardest-tested code in the system; agents never modify this directory (enforced by CODEOWNERS or equivalent).

## M2 — Agent runtime & definitions

_Constraint: every loop is made of agents; the runtime that loads, isolates, and validates them gates all three loops._

- **T2.1 ⛓ Agent runtime (MCP host)** — load `agents/<name>/`, instantiate fresh context per call, validate output against `schema.json` before returning; reject-and-retry on schema violation.
- **T2.2 Fixture runner** — CI: run `fixtures/` for every agent whose files a PR touches; generated agents must ship passing fixtures (03 §7.4).
- **T2.3 Agent definitions, wave 1** — Librarian, Goal Clerk, Registrar, Matcher, Prioritizer: agent.md + schema.json + ≥3 fixtures each.
- **T2.4 Agent definitions, wave 2** — Structurer, Critic (per-goal IGC output format), Integrator.
- **T2.5 Agent definitions, wave 3 (isolated evaluators)** — Reviewer, Diff Summarizer, Simulated Asker; runtime-enforced input restriction (diff-only / raw-only inputs, C6).
- **T2.6 Retrieval tooling** — ephemeral BM25 builder (tantivy or equiv.) exposed as a Librarian tool; map-first navigation conventions in Librarian's agent.md.

## M3 — Loop A: Ask

_First end-to-end user value: questions get answered from docs or logged well._

- **T3.1 ⛓ Chat UI (asker surface)** — question input, goal-tag confirm (Clerk suggestions), cited answers, follow-up chat.
- **T3.2 Intake pipeline** — Librarian → (insufficient) → Matcher (active/deferred/answered) → Registrar → Prioritizer → queue; asker sees `logged as q-… at Pn`.
- **T3.3 Dedup behaviors** — attach-asker (active match), promote (deferred match, →P2), return-existing (answered match).
- **T3.4 Queue views** — unanswered queue sorted tier→age; per-question detail (raw q, chat log, goals, provenance, rationale); one-click priority override.

## M4 — Loop B: Answer

- **T4.1 ⛓ Answerer surface** — claim question, dictation UI (M1 components), transcript review, typed-edit fallback.
- **T4.2 Evaluator–optimizer loop** — Structurer draft → Critic round (fresh ctx) → findings to answerer → repeat; DONE detection (all goals ✔/deferred, zero contradictions).
- **T4.3 Spawn pipeline** — critic findings → Registrar (generated, provenance = parent+finding+goal, tags incl. `extra-detail`) → Prioritizer (depth decay; contradiction ⇒ P1) → deferred queue.
- **T4.4 Answer artifacts** — `answers/raw/`, `structured.md`, `evaluation.md` (final IGC table) written per 03 §2.

## M5 — Loop C: Integrate

- **T5.1 ⛓ Integrator orchestration** — touched-doc planning, worker edits, map/index updates, branch+PR; rebase-and-replan on conflict.
- **T5.2 Isolated checks** — Reviewer, Diff Summarizer, Simulated Asker wired to the PR; findings loop back to Integrator.
- **T5.3 Merge modes** — auto (clean checks + answerer summary veto) and manual (full PR review); per-repo/per-tier config.
- **T5.4 Closure flow** — merge → move to `answered/` → in-app notify → asker accept / reject-with-reason (verbatim → provenance, reopen P1) / timeout-accept (default 14d, logged).

## M6 — Loop D: Self-modification & hardening

- **T6.1 Agent-Smith** — meta-agent producing agent files + fixtures via PR; may not touch `app/capture/` or `raw/`.
- **T6.2 Dynamic agent loading** — hot-load agents from HEAD; in-app agent-creation surface.
- **T6.3 Model-drift canary** — scheduled fixture run against current model; drift reported as findings, not auto-fixed.
- **T6.4 Per-goal critic guidelines** — fit satisfaction criteria from accumulated real transcripts (self-review §10).
- **T6.5 Friction instrumentation** — measure ask-time and critic-round-vs-dictation latency against doc 01 targets (self-review §12).
- **T6.6 Deferred-question GC decision** — revisit self-review §9 with real accumulation data.

## Dependency spine

```
M0 ⛓ schema ─→ M1 ⛓ capture ─→ M2 ⛓ runtime ─→ M3 Ask ─→ M4 Answer ─→ M5 Integrate ─→ M6 Self-mod
                                      └────────── fixtures (T2.2) gate every later agent task
```

M3 is the first shippable increment (read-only Ultradyn Docs: answer-from-docs + question logging). M4+M5 complete the core value loop. M6 is deliberately last: self-modification is only safe once fixtures (M2) and the PR lane (M5) exist to contain it.
