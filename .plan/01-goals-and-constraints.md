# Ultradyn Docs — Goals & Constraints

*Working title: **Ultradyn Docs**. Rename freely.*

Document 1 of 6 · Status: draft for review

---

## 1. What this project is

Ultradyn Docs is a question-driven documentation system. People ask questions in a chat interface backed by an LLM agent and a git repository of documents. Either the repository can answer the question, or it can't — and when it can't, that failure is captured as a first-class artifact: a logged, prioritised, goal-tagged question that a designated answerer later resolves by voice brain-dump. Agents structure the brain dump, criticise it against the asker's declared goals, integrate it into the documentation, and propose the whole change as a reviewable git diff.

The system's output is the documentation itself: a breadth-first map of a project's knowledge that grows exactly where questions demonstrate demand, and nowhere else.

## 2. Problems it solves

**P1 — Knowledge lives in heads and dies in chat logs.** Expert answers given in Slack/voice/hallways are high-value and unrecorded. Ultradyn Docs makes the low-friction medium (talking) produce the high-value artifact (consistent documentation) as a side effect.

**P2 — Documentation effort is misallocated.** Docs are traditionally written speculatively, depth-first, by guessing what readers need. Ultradyn Docs inverts this: unanswerable questions *are* the demand signal. Effort flows to proven gaps. Depth is added only where a real question requires it.

**P3 — Answering well is expensive; answering roughly is cheap.** Structuring, checking consistency, and cross-linking are exactly what experts skip. Ultradyn Docs lets the expert deliver an unstructured brain dump and pushes the expensive part (structure, criticism, integration) onto agents, with the expert only reviewing.

**P4 — "Answered" is usually undefined.** Ultradyn Docs makes it decisive: every question carries declared goals; an answer is done when it satisfies those goals with no contradiction against existing docs. Not perfect — good enough *for the declared goals*.

**P5 — Doc bases rot.** Every integration pass is required to update everything the answer touches, so consistency is maintained transactionally (per PR) rather than by periodic heroics.

## 3. Goals

| # | Goal | Decisive test |
|---|------|---------------|
| G1 | Asking a question costs almost nothing | Type question + pick goal tag(s); < 30s to submit |
| G2 | Answering costs little more than talking | Answerer speaks; never formats; reviews a diff and a summary at the end |
| G3 | Every unanswered question is captured with context | Raw verbatim question + chat log + goals + provenance stored under a stable ID |
| G4 | Documentation stays consistent and complete | Integration updates all touched docs; contradiction findings are P1 and block |
| G5 | Everything is inspectable and recoverable | Whole system state = one git clone; every change is a reviewable, revertible diff |
| G6 | Breadth-first by construction | Depth gaps spawn deferred child questions instead of blocking answers |
| G7 | The system improves itself safely | Agent definitions live in the repo and change through the same PR flow as docs |

## 4. Non-goals (explicitly out of scope for v1)

- Notification delivery (email/Slack/push). The unanswered queue is the interface; notifications are a later plugin.
- Access control / multi-tenant security. v1 assumes a trusted team with repo access.
- Serving docs to external consumers. The repo can be ingested elsewhere later; v1 serves its own chat UI.
- Perfect answers, perfect priorities, perfect dedup. Standard is *good enough, criticizable, correctable*. Every automated judgment (priority, done-ness, dedup match) is surfaced to a human who can override it cheaply.

## 5. Constraints

**C1 — Git is the database.** All persistent state (docs, questions, answers, transcripts, indexes-as-maps, agent definitions) lives in one git repository. Committed files must be line-diff-friendly text (markdown, JSONL). No committed binaries, no compressed indexes.

**C2 — Derived indexes are build artifacts.** Anything regenerable (BM25 index, caches) is gitignored and rebuilt from HEAD.

**C3 — Raw inputs are sacred.** Verbatim questions, verbatim answer transcripts, and rejection reasons are stored immutably; everything downstream must be re-derivable from them. Raw audio stays on the capturing machine in a gitignored folder, filenames keyed by question ID.

**C4 — Doc changes land as branches/PRs, never direct commits to main.** Auto-merge mode and manual mode both exist; both produce a diff summary generated from the diff alone by a fresh-context agent.

**C5 — Identity is assigned, not derived.** IDs are ULIDs (time-sortable, collision-safe, edit-stable). Never hash-of-content.

**C6 — Fresh context for evaluation.** Any agent whose job is to evaluate (critic, reviewer, summarizer, simulated asker) runs in a context isolated from the agent that produced the thing being evaluated.

**C7 — Fragile deterministic code goes in libraries.** Audio capture, transcription plumbing, git operations, file I/O: use mature libraries where they exist; keep hand-written glue small and tested. Agent-maintained code concentrates in the generative interior (prompts, agents, doc logic), not the capture path. Rationale: the raw capture path is the only component whose silent failure destroys unrecoverable data.

## 6. Users and friction budget

**The Asker.** Types a question in chat, tags one or more goals from a suggested vocabulary (implementation, api-integration, security-review, complexity-analysis, …; freeform allowed). Gets an answer or "insufficient information — logged as `q-…` at P*n*". When their question is later answered, they receive the answer and can accept or reject with a reason. Rejection reopens the question and the reason enters the provenance chain verbatim. Friction budget: the asker never fills a form longer than question + goal tags, and never waits on the system to decide whether to log.

**The Answerer.** Opens a queue sorted by priority tier. Picks a question; sees the raw question, chat context, goals, and provenance. Dictates freely, iterates with the critic in chat, and ends by reviewing a diff summary (auto mode) or the full PR (manual mode). Friction budget: dictation is the primary input everywhere; typing is always available but never required; critic feedback rounds are faster than the dictation they respond to.

**The Maintainer.** Reviews agent-definition changes, tunes priority rules and goal vocabulary, watches the self-review outputs. In a relaxed deployment this role mostly monitors; the design permits (does not mandate) stricter gates.

## 7. Principles

1. **Decisive checks over vague quality.** Every gate in the pipeline is a yes/no question against declared goals (IGC-style), not a score.
2. **Priorities are tiers with rules, not weighted arithmetic.** P1–P5; contradiction-spawned questions are always P1; depth decay is the default below that; every assignment is human-overridable in one glance.
3. **Deferral over rabbit holes.** The critic never blocks an answer for missing depth; it spawns a tagged, prioritised child question.
4. **Demand promotes.** Deferred questions are promoted when a new incoming question semantically matches one — spawn-time priority is a weak prior, real demand is the signal.
5. **Provenance everywhere.** Every question knows where it came from (raw recording, or parent-question + critic finding + goal cell); every answer knows what it was checked against.
