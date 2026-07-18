# Completeness, Convergence, and Invalidation

## 1. Operational completeness

The system cannot prove that every conceivable human question has been generated. It can make a bounded, reproducible claim for a named source snapshot and policy.

A run is operationally closed only when:

```text
forward question obligations terminal
AND reverse source accounting terminal
AND human curiosity checkpoint closed
AND selected source units have terminal dispositions
AND accepted evidence and claims verify
AND no blocking authority/extraction/conflict issue remains
AND duplicate/equivalence candidates affecting coverage are resolved
AND answer/document validity matches the current graph revision
AND publication or explicit partial-publish gates pass
AND source replay remains available
```

## 2. Forward frontier

The Curiosity Planner creates children only from new obligations. The frontier is empty when every admitted obligation is satisfied, terminally unsupported, explicitly excluded/deferred, or awaiting a recorded human decision.

A branch stopped for budget, provider outage, retry exhaustion, or unavailable source is not terminal for closure.

## 3. Reverse source accounting

The Coverage Auditor clusters selected unaccounted source units by structure, topic, authority, and lifecycle. The Reverse Questioner receives a bounded cluster and may:

- propose the minimum grounded question set;
- link it to an existing claim/question;
- classify it as duplicate, historical, deprecated, boilerplate, non-project, or unsupported;
- request human curation.

Accepted reverse questions enter normal Researcher/Evidence Critic/Claim/Curiosity workflows. A final reconciliation runs after graph changes stabilize.

## 4. Human curiosity checkpoint

An operator can inject a question at any graph node. The record includes exact wording, actor, goals, anchors, and context. Injections create ordinary obligations and can reopen a closed run.

Closure requires:

- no open human injections; and
- an explicit operator acknowledgment that the current source/graph view has been reviewed for additional curiosity.

This is not a claim that the human imagined everything; it is a clear handoff boundary.

## 5. Perspective sweeps

Perspective-specific Questioners—security, operations, onboarding, API consumer, implementer—remain a reserve capability. They are activated only if pilot metrics show repeated role-specific omissions after forward, reverse, and human mechanisms.

Activation requires:

- measured failure pattern;
- bounded perspective scope;
- finite obligations;
- zero-cache cost estimate;
- fixtures and an ADR;
- operator approval.

## 6. Question convergence

Candidate detection combines:

- question semantics;
- goals/facets;
- scope and expected answer type;
- accepted/proposed claim overlap;
- source-unit evidence overlap;
- graph neighborhood.

Outcomes:

```text
exact_duplicate
subset_of
broader_than
shares_answer_with
same_evidence_surface
related_distinct
insufficient_to_decide
```

No outcome deletes the later question.

## 7. Claim convergence

Claim candidates are evaluated separately. Two questions may remain distinct while sharing accepted claims. Claim outcomes include equivalent, scoped variant, qualified variant, broader/narrower, contradiction, and distinct.

This is one of v3’s central advantages: branch execution can converge on reusable claims without collapsing user intent.

## 8. Recoverable branch holds

When a later branch appears redundant:

1. checkpoint it;
2. preserve all evidence, criticism, goals, and obligations;
3. transfer or share unique obligations with the canonical execution;
4. replay the later raw question against the canonical claim/answer pack;
5. check canonical facets against the later branch’s unique contribution;
6. pause only if both checks pass;
7. retain a reversible equivalence event.

Revocation restores the branch and invalidates affected closure/answer/document artifacts.

## 9. Contradiction and authority

A contradiction is confirmed only after comparing:

- subject and predicate;
- product/component;
- version/environment;
- audience/role;
- effective time;
- authority;
- exception/precondition.

A scoped difference is not flattened. A confirmed unresolved same-scope contradiction creates a blocking finding and high-priority authority task.

## 10. Invalidation graph

Events that may propagate invalidation:

- source unit changed/deleted;
- extraction repaired or downgraded;
- authority/lifecycle decision changed;
- accepted claim rejected/superseded;
- dedup equivalence revoked;
- human curiosity introduced new required context;
- graph relationship changed;
- document plan changed canonical homes.

Dependency order:

```text
SourceUnit/Policy
  → EvidencePacket validity
  → Claim validity
  → Answer validity
  → DocumentationRecord validity
  → Retrieval fixture / closure certificate
```

## 11. Closure certificate

The machine-readable certificate pins:

- snapshot/replay IDs and hashes;
- selected source scope;
- extraction/parser/index versions;
- question grammar and agent/workflow versions;
- graph revision;
- coverage counts and exceptions;
- human curiosity checkpoint;
- authority/extraction/dedup/claim/citation/editorial gates;
- publication mode;
- issuers and timestamps.

Any dependency-changing event marks it invalid.
