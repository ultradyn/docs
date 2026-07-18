# Runtime and Tool Interfaces

Transport is implementation-specific; the contracts below define stable logical boundaries.

## 1. Source services

```text
SourceSnapshotService.create(artifact, policy_profile) -> SourceSnapshot
SourceSnapshotService.verify_replay(snapshot_id) -> ReplayReceipt
SourceFileService.list(snapshot_id, filters, cursor) -> SourceFile[]
SourceUnitService.get(unit_id, expected_hash) -> verified SourceUnit
SourceUnitService.context(unit_id, parent_depth, sibling_count) -> bounded units
ExtractionService.repair(representation_id, repair_artifact, actor, reason) -> new representation
```

## 2. Retrieval tools exposed to Researcher

```text
source.exact(snapshot_id, identifiers, filters) -> candidates + receipt
source.maps(snapshot_id, topic_or_path, filters) -> entries + receipt
source.lexical(snapshot_id, query, filters, limit) -> candidates + receipt
source.vector_optional(snapshot_id, query, filters, limit) -> candidates + receipt
source.open_unit(unit_id, expected_hash) -> verified unit
source.follow_links(unit_id, types, limit) -> candidates + receipt
source.search_authority(subject, scope) -> candidates + receipt
source.search_deprecation(subject, scope) -> candidates + receipt
```

The Evidence Critic receives only `open_reference` and bounded context tools; it cannot silently search around Researcher omissions.

## 3. Question and obligation services

```text
QuestionService.create_seed(...)
QuestionService.create_generated(proposal, obligation_id)
QuestionService.inject_human(raw_question, goals, anchor, actor)
QuestionService.transition(question_id, expected_generation, event)
ObligationService.create(kind, subject, reason)
ObligationService.assign(obligation_id, question_id)
ObligationService.satisfy(obligation_id, artifacts)
ObligationService.transfer(obligation_id, new_owner, decision_id)
```

## 4. Evidence and claim services

```text
EvidenceService.store_packet(packet, idempotency_key)
EvidenceService.store_verdict(verdict, idempotency_key)
EvidenceService.verify_reference(source_ref)
ClaimService.propose(claim, idempotency_key)
ClaimService.apply_review(claim_id, review, expected_status)
ClaimService.find_candidates(statement, type, scope, evidence)
ClaimService.build_pack(question_id, graph_revision)
```

## 5. Graph and validity gateway

```text
graph.apply(mutation, expected_version, idempotency_key) -> new_version
graph.read_path(question_id) -> accepted ancestor artifacts
graph.read_dependencies(artifact_id) -> dependency closure
graph.invalidate(event, affected_roots) -> stale artifact IDs
validity.check_answer(answer_id)
validity.check_document(document_id)
validity.check_certificate(run_id)
```

Agents submit proposals to this gateway and never mutate files/projections directly.

## 6. Workflow control

```text
RunService.create(snapshot_id, seed_set, budgets, policies)
RunService.pause(run_id, actor, reason)
RunService.resume(run_id, actor)
RunService.cancel(run_id, actor, reason)
BranchService.retry(branch_id, expected_generation)
BranchService.hold(branch_id, convergence_decision)
BranchService.release(branch_id, actor_or_decision)
```

## 7. Dashboard APIs

```text
GET /runs/{run_id}
GET /runs/{run_id}/events?after_sequence=...
GET /runs/{run_id}/graph?projection=question|claim|source|document
GET /runs/{run_id}/coverage
GET /runs/{run_id}/obligations
GET /runs/{run_id}/questions/{id}
GET /runs/{run_id}/claims/{id}
GET /runs/{run_id}/source-units/{id}
POST /runs/{run_id}/curiosity-injections
POST /runs/{run_id}/curation-decisions
POST /runs/{run_id}/convergence-decisions
POST /runs/{run_id}/authority-decisions
POST /runs/{run_id}/publication/preview
```

Events are persisted before streaming. SSE is adequate for one-way updates; WebSockets may carry operator commands with explicit acknowledgments.

## 8. Git publication adapter

```text
git.create_worktree(run_id, base_commit)
git.write_validated_artifacts(publication_plan)
git.commit(message, provenance)
git.open_pr(title, body, checks)
git.read_final_diff(pr_id)
git.merge(pr_id, policy_decision)
```

Merge credentials are never exposed to LLM agent context.

## 9. Structured error envelope

```json
{
  "error": {
    "code": "SOURCE_REFERENCE_HASH_MISMATCH",
    "message": "The cited source unit no longer matches the snapshot.",
    "retryable": false,
    "correlation_id": "call-...",
    "details": {"source_unit_id": "unit-..."}
  }
}
```

Errors distinguish source absence, retrieval unavailability, policy denial, malformed agent output, stale graph version, authority block, extraction failure, and budget pause.
