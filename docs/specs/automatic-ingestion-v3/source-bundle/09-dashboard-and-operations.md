# Dashboard and Operations

## 1. Dashboard purpose

The dashboard is an operational workbench, not a theatrical agent transcript. It helps an operator understand:

- what work is active;
- what evidence exists;
- what claims have been accepted or disputed;
- which source units remain unaccounted;
- why branches are blocked, held, reopened, or complete;
- which assurance gates pass.

## 2. Three information planes

### Activity

Explicit events: agent role messages, searches, references opened, tool receipts, retries, leases, costs, human actions, and graph mutations.

### Evidence

Source files/units, extraction quality, evidence packets, verdicts, claims, authority/lifecycle, conflicts, and coverage dispositions.

### Assurance

Independent gates: reference verification, evidence sufficiency, claim review, source accounting, dedup replay, authority/extraction, answer validity, editorial/navigation review, security/rights, and replay availability.

Agent activity volume never contributes to a quality badge.

## 3. Main views

### Run header

- source snapshot and replay status;
- run/graph revision;
- phase and status;
- active/queued/held/failed branches;
- source coverage and claim counts;
- obligations open/terminal;
- token, cost, cache savings, and elapsed time;
- pause/resume/cancel/export controls.

### Knowledge explorer

Switchable projections:

- question tree;
- full question/claim/source graph;
- claim dependency graph;
- document plan;
- source-file coverage view.

Question and claim nodes remain visually distinct.

### Paired loop panel

For the selected branch:

- question/goals/facets;
- Researcher search events and packet versions;
- Evidence Critic reference/facet verdicts;
- accepted/proposed claims and Claim Review;
- Curiosity Planner child proposals and obligation decisions;
- errors, retries, and invalidations.

The UI labels these as explicit role outputs, not hidden thoughts.

### Source inspector

- original/normalized locator and hash;
- representation/extraction tier and audit;
- source preview;
- evidence packets and claims using the unit;
- coverage disposition;
- authority/lifecycle;
- human repair/exclusion actions.

### Claim workbench

- statement, type, scope, authority, lifecycle;
- evidence and qualifier claims;
- duplicate/variant/contradiction candidates;
- questions/answers/documents that depend on it;
- validity and change impact.

### Curiosity and reverse coverage

- source clusters proposed for reverse questioning;
- topic curation checkboxes;
- grounded reverse questions;
- an **Ask here** control at every graph node;
- human injection status and closure checkpoint.

### Convergence workbench

Side-by-side questions/claims, shared and unique evidence, goals/facets, graph context, replay results, and reversible decisions.

### Publication view

Document plan, canonical homes, generated docs, sentence/claim traceability, navigation tasks, review findings, and final Git diff/PR.

## 4. Event model

Events are persisted before streaming and include:

```text
source.snapshot_created
source.file_processed
source.unit_disposition_changed
question.created
branch.status_changed
research.started
research.packet_created
evidence.verdict_created
claim.proposed
claim.reviewed
curiosity.plan_created
obligation.assigned
duplicate.candidate_created
duplicate.decision_recorded
authority.decision_recorded
invalidation.applied
human.curiosity_injected
coverage.audit_completed
document.plan_created
answer.generated
document.generated
review.completed
publication.pr_created
run.closed
```

Each event has sequence, timestamp, actor, correlation/causation IDs, schema version, visibility, and idempotency key.

## 5. Runtime store and replay

SSE or WebSocket streaming is backed by a durable event/projection store. The UI reconnects from the last sequence and can rebuild views from snapshots plus events. High-frequency token events may be coalesced; state transitions and errors may not be dropped.

## 6. Operational controls

- branch pause/resume/retry;
- obligation priority and ownership override;
- duplicate hold/release/revoke;
- source include/exclude and authority decisions;
- injection and curation;
- budget/concurrency changes;
- extraction repair request;
- publication-mode selection.

Every override records actor and reason.

## 7. Recovery

- every agent output is persisted before graph mutation;
- graph mutations are idempotent and expected-version checked;
- lost provider sessions reconstruct from context manifests;
- failed index builds do not replace the active build;
- a branch retry cannot duplicate claims/questions by accident;
- source replay remains independent of the live runtime database.

## 8. Performance posture

Initial targets, to validate rather than assume:

- terminal state event visible within 1 second p95;
- evidence/claim event within 2 seconds p95;
- interactive clustered graph at 10,000 displayed nodes;
- lazy source explorer at 100,000 units;
- reconnect within 5 seconds for a medium run;
- no client memory growth proportional to unbounded event history.
