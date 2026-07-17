# ADR 0001: Reconciled core invariants

Status: accepted

## Context

The source design bundle intentionally left operational questions open and contains a few conflicts between diagrams, folder layout, and prose. The implementation needs one deterministic interpretation.

## Decision

- `question.md.state` is canonical. `active/`, `deferred/`, and `answered/` are queue projections; `logged`, `in-answer`, `integrating`, `merged`, and `reopened` remain in `active/` until they reach a terminal bucket.
- Every question directory may contain `answers/` while work is in progress. Moving between buckets moves the whole directory atomically.
- Contradiction findings create active P1 blockers and prevent Critic DONE. Noncontradictory depth findings create deferred P4/P5 children.
- Successful inline answers are chat events and are not question records unless the asker rejects them or a goal remains unsatisfied.
- Partial insufficiency records only unsatisfied goals, while the immutable chat log retains the partial answer and all originally requested goals.
- Askers are an array with independent acceptance state. Any explicit rejection reopens at P1; acceptance completes when all non-timed-out askers accept. Timeouts are recorded per asker.
- Immutable STT output and append-only correction artifacts are separate from the derived corrected transcript.
- Reviewer sees question, answer, and actual diff. Diff Summarizer sees actual diff only. Simulated Asker sees verbatim question/chat/goals and the post-diff documentation view.
- Auto mode still requires an explicit answerer approval of the isolated diff summary before merge. There is no ambiguous post-merge veto window.
- Registrar, Prioritizer, state transitions, file writes, schemas, and Git are deterministic services. LLM roles are content and evaluation providers behind typed contracts.
- Exact fake-model fixtures are CI contracts. Live-model canaries validate schema and semantic invariants without byte-for-byte output matching.

## Consequences

Folder moves can be recovered from the record state; indexes can always regenerate. Breadth-first behavior cannot hide a contradiction in the deferred queue. Evaluation inputs can be tested for isolation. Derived text can improve without corrupting provenance.

## Implementation status

Per-asker decisions/timeouts and evaluator input isolation are implemented. Acceptance/timeout decisions require a merged question and a pending asker. Explicit rejection cannot use the generic decision method: it is one repository-owned locked and journaled operation that publishes exactly one immutable reason, records the decision, and reopens at P1; its operation identity includes the merged base revision so the same asker and reason on a later attempt is a distinct exactly-once event. The rejecting asker becomes pending again when the reopened question is claimed for its next attempt. Ask intake and canonical records reject duplicate declared goals while preserving distinct-goal order. Change requests persist verbatim chat and goals, Simulated Asker results cover those goals exactly once, and production fake results cannot authorize Critic completion or merge. Legacy records without exact evaluator input remain readable but cannot authorize evaluation or merge. Every shipped portable JSON Schema is exercised through the production `createPortableSchemaValidator` against the corresponding canonical Zod schema. Question records, provenance events, and raw-artifact manifests share the same strict object shape, nonempty/bounded strings, safe-integer bounds, UTF-16 code-unit lengths where bounded, and calendar-valid explicit-offset date-time profile with required `HH:MM:SS` seconds; raw manifest paths are nonempty in both representations. `integrationMode` is persisted but auto/manual behavior is not yet enforced; every merge currently follows the explicit approval path. See `BLOCKED_TASKS.md` for the remaining policy work.
