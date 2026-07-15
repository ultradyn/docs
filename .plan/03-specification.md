# Ultradyn Docs — Project Specification

Document 3 of 6 · v0.1 draft · Consolidates docs 01–02 into an implementable spec.

---

## 1. System overview

Ultradyn Docs is a chat-fronted, git-backed, agent-operated documentation system. Two user-facing surfaces (Ask, Answer) and one maintenance surface sit on top of a single git repository containing docs, questions, answers, goal/priority configuration, agent definitions, and the application's generative interior. A thin deterministic shell (audio capture, transcription, git plumbing, file I/O, index building) is built from mature libraries and hand-written glue.

## 2. Repository layout

```
ultradyn-docs.git/
├── docs/                        # the documentation (markdown)
│   ├── <topic>/…
│   └── <dir>/_map.md            # per-directory summary map (committed)
├── questions/
│   ├── index.jsonl              # one line per question: id, title, state, tier, goals, tags
│   ├── active/<qid>/
│   │   ├── question.md          # structured/cleaned question + metadata frontmatter
│   │   ├── raw/                 # VERBATIM asker inputs, immutable
│   │   │   ├── 001-question.md  # original wording, exactly as asked
│   │   │   ├── 002-chatlog.md   # relevant chat context at logging time
│   │   │   └── 003-rejection.md # verbatim rejection reasons (appended on reopen)
│   │   └── provenance.yaml      # see §4
│   ├── deferred/<qid>/…         # same shape; generated questions live here first
│   └── answered/<qid>/
│       ├── …(as above)
│       └── answers/
│           ├── raw/001-transcript.md   # VERBATIM dictation transcripts, immutable
│           ├── structured.md           # final structured answer
│           └── evaluation.md           # critic's final IGC table + findings
├── goals/
│   ├── vocabulary.md            # controlled-but-growing goal tag list w/ definitions
│   └── priority-rules.md        # P1–P5 rules (fitted guidelines)
├── agents/
│   └── <name>/
│       ├── agent.md             # role prompt, allowed tools, behavioural notes
│       ├── schema.json          # structured OUTPUT contract (JSON Schema)
│       └── fixtures/            # golden cases: NNN-input.json → NNN-expected.json
├── app/                         # application code (shell + interior; see §8)
├── .ultradyn-docs/              # derived, gitignored: BM25 index, caches, locks
└── .gitignore                   # includes .ultradyn-docs/, **/audio/
```

Local, never committed: `~/.ultradyn-docs/audio/<qid>/NNN.<ext>` — raw recordings keyed by question ID, so any transcript can be re-checked against source.

**Rules.** Committed files are line-diff-friendly text (markdown, JSONL, YAML, JSON). `index.jsonl` is append-mostly; state changes rewrite single lines. It is committed for readability but fully regenerable from the question folders — merge conflicts in it are resolved by regeneration, never by hand. `raw/` files are immutable once written (enforced by convention + CI check). Nothing regenerable is committed.

## 3. Identity

- IDs are **ULIDs**, displayed with a type prefix: `q-01JZK3F0…`, `ans-…`, `f-…` (finding).
- Assigned at creation; never derived from content (edit-stable, no birthday-collision math).
- Time-sortable for free, which orders queues and folders naturally.
- Registrar checks `index.jsonl` on insert as belt-and-braces.

## 4. Question record & provenance

`question.md` frontmatter:

```yaml
id: q-01JZK3F0N8…
state: active            # asked|logged|active|deferred|in-answer|integrating|merged|accepted|reopened
tier: P2
goals: [implementation, security-review]
tags: [raw]              # raw | generated (+ extra-detail, promoted, reopened…)
asker: max               # attached askers accumulate on demand-promotion
created: 2026-07-16T…
```

`provenance.yaml` — the chain of custody:

```yaml
origin:
  kind: raw              # raw | generated
  # raw:       points at raw/001-question.md + chat log
  # generated: parent question, critic finding id, the goal cell (✘/?) that spawned it
  parent: q-01JZJ…       # generated only
  finding: f-01JZJ…      # generated only — the critic finding text is stored with the finding id
  goal: security-review  # generated only
events:                  # append-only
  - {t: …, e: logged, by: registrar}
  - {t: …, e: prioritized, tier: P3, rationale: "raw question, default"}
  - {t: …, e: rejected, by: asker, raw: raw/003-rejection.md}   # reopen
```

Whoever answers a generated question sees *why the critic thought it was a gap* — questions are never stripped of their motivation.

## 5. Goals

- Askers tag ≥1 goal per question; the Goal Clerk suggests tags from `goals/vocabulary.md`; freeform allowed but nudged toward existing tags.
- Vocabulary entries define what *satisfying* that goal means (per-goal critic guidelines live with the definition). Seed set: `implementation`, `api-integration`, `security-review`, `complexity-analysis`, `documentation`, `onboarding`.
- Answers are evaluated per-goal (IGC row: each goal ✔/✘/?). Satisfied goals are dropped from spawned child questions; children inherit only their unsatisfied goal(s).
- "Good enough" is always relative to declared goals. No goal-free questions: if the asker declines to tag, default `documentation`.

## 6. Priority

Tiers P1 (high) – P5 (low), assigned by rules in `goals/priority-rules.md`:

| Tier | Rule |
|---|---|
| P1 | contradiction-spawned; reopened after asker rejection |
| P2 | unsatisfied goal on an active question; demand-promoted deferred |
| P3 | raw questions (default) |
| P4 | generated, depth 1, no contradiction |
| P5 | generated, depth ≥2; tagged `extra-detail` |

Every assignment includes a one-line rationale; every surfaced priority is human-overridable (one glance, one click). Rules are prose guidelines fitted over time via PRs — never a weighted score.

## 7. Core flows

### 7.1 Ask
1. Asker submits question in chat; Goal Clerk suggests tags from the vocabulary; asker confirms/edits (≥1 tag; default `documentation`).
2. Librarian retrieves agentically (maps → grep/BM25 tool → read) and answers with citations, or declares specific goals unsatisfied. Conversation continues (follow-ups, objections).
3. On unsatisfied: Matcher checks active, deferred, and answered queues.
   - Active match → attach asker to the in-flight question (dedup; no new record).
   - Deferred match → promote to active (P2), attach asker.
   - Answered match → return existing answer; asker rejection reopens (P1).
   - Novel → Registrar records verbatim question + relevant chat log, mints ULID, writes record + index row; Prioritizer assigns tier + rationale; queue updated.
4. Asker is told: "logged as `q-…` at P*n*" — no further asker effort.

### 7.2 Answer
1. Answerer opens queue (sorted by tier, then age), claims a question; sees raw question, chat context, goals, provenance.
2. Dictates. Transcript stored verbatim (immutable); audio kept locally keyed by qID.
3. Structurer produces a structured draft from all transcripts so far.
4. Critic (fresh context per round) evaluates: per-goal ✔/✘/? + contradiction scan against docs. Output: findings + spawn-list.
5. Spawn-list items become deferred child questions (Registrar + Prioritizer; tags `generated`, optionally `extra-detail`; provenance as §4). **Deferred, not blocking** — critic rounds are faster than dictation; depth is never answered inline.
6. Loop 2–5 until DONE: every declared goal ✔ or explicitly deferred, zero unresolved contradictions.

### 7.3 Integrate
1. Integrator plans touched docs from the structured answer, dispatches workers (per-doc edits + map/index updates), opens branch + PR. Concurrent answer branches resolve through ordinary git merge; the integrator rebases and re-plans on conflict.
2. Three isolated checks, mandatory fresh context:
   - **Reviewer**: sees question, answer, and the *diff only* → approve/findings (missed touch-points, inaccurate updates).
   - **Diff Summarizer**: sees the *diff only* → plain-language summary of documentation changes for the answerer. Never sees the integrator's plan (a summarizer that shared context would summarize intent, not the diff — the divergence between them is the target error class).
   - **Simulated Asker**: roleplays from the *verbatim* question + chat log + goals: "does this answer my question, for my goals?" Cheap pre-filter; the real asker is the decisive check.
3. **Auto mode**: findings clean → merge; answerer sees the diff summary and can veto. **Manual mode**: answerer (or maintainer) reviews the PR itself. Mode is a per-repo (optionally per-tier) setting.
4. On merge: question → `answered/`, index updated, asker notified (v1: in-app).
5. Asker accepts, rejects-with-reason, or times out (auto-accept after a configurable window, default 14 days, logged as `timeout-accept` in provenance — silence must not strand questions in `merged`). Rejection is recorded verbatim, joins the provenance chain, and reopens at P1 — the next attempt is grounded in what was tried and the asker's own words on why it missed.

### 7.4 Self-modification
Agent-Smith creates/updates agent definitions (agent.md + schema.json + fixtures) via PR. CI runs fixtures for every touched agent; generated agents must ship passing fixtures of their own. Merge gating is a deployment choice (relaxed by default; the mechanism supports stricter). Fixtures double as drift detection when the underlying model is upgraded.

## 8. Application architecture

**Deterministic shell (small, library-backed, tested):**
- Audio capture + recording UI — *the one unrecoverable failure mode*: silent truncation destroys what nothing can reconstruct. Use mature browser/OS libraries; hand-written glue minimal; tested hardest of anything in the system; agents never modify it.
- Transcription adapter (pluggable STT), git plumbing (branch/commit/PR), file I/O + immutability checks, JSONL index maintenance, ephemeral BM25 builder (e.g. tantivy), MCP server host.

**Generative interior (agent-maintained, cheap to change):**
- All `agents/` definitions, prompts, per-goal critic guidelines, doc-integration logic, UI copy. TDD via fixtures; changed through PRs like everything else.

**Agents as MCP tools.** Each agent is exposed as an MCP tool: highly specialized, instantiated fresh from its file per call, output validated against `schema.json` before it reaches any other agent. Structured interfaces — not prompts alone — are what keep a pipeline of LLMs from becoming a game of telephone.

**Retrieval stack.** Committed human/LLM-readable maps (`_map.md`, `questions/index.jsonl`, topic map) + agentic navigation as primary; ephemeral BM25 as an optional speed tool; no embeddings in v1 (ops burden + git-hostility for no marginal capability, since the LLM in the loop is the semantic matcher).

## 9. Modes, checks, and error philosophy

Every automated judgment is (a) decisive where possible (per-goal ✔/✘/?), (b) accompanied by a short rationale, (c) surfaced to a human who can override in one action. The system's guarantee is not correctness but *cheap correctability*: raw inputs are immutable and everything downstream is re-derivable; every change is a diff; every diff is revertible.

## 10. Open items (tracked in 05-self-review.md)

Notification transport; multi-repo scaling; deferred-question garbage collection; transcript quality thresholds; STT vendor choice; UI framework choice.
