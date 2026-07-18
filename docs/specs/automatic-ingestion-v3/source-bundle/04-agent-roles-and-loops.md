# Agent Roles and Workflow-Compatible Loops

## 1. Role-design rule

Every agent has one decisive responsibility, a narrow input/output schema, an allowlisted tool set, and an explicit failure behavior. Evaluation agents use fresh context. Agents propose durable artifacts; deterministic services validate and apply mutations.

## 2. Core roles

### Seed Planner

Creates a small initial seed set from operator-selected presets, project maps, and source inventory. It does not attempt exhaustive questioning.

### Researcher

Finds evidence for one question and facet set. It emits exact source references, search receipts, proposed reference roles, and retrieval limits. It cannot answer the question or propose child questions.

### Evidence Critic

Independently opens references and judges whether the evidence is complete, necessary, current, correctly scoped, and non-contradictory for the current question. It emits a per-facet verdict and precise bounded refinement request. It cannot generate future questions.

### Claim Extractor

Transforms a terminal accepted evidence packet into minimal atomic proposed claims. It preserves scope, qualifiers, authority, lifecycle, and evidence. It does not decide that its own claims are correct.

### Claim Reviewer

Independently verifies entailment, minimality, scope, qualifier preservation, and claim relationships. Only passing claims enter the accepted claim registry.

### Curiosity Planner

Runs after the current evidence/claim stage is terminal. It proposes materially distinct child questions, each with source-grounded triggers and a new coverage obligation. It cannot change the current verdict.

### Reverse Questioner

Receives uncovered semantic source-unit clusters and the existing claim/question graph. It emits the minimum grounded question set needed to account for their meaning or an explicit disposition.

### Duplicate Adjudicator

Evaluates question and claim convergence. It can create reversible equivalence, subset, shared-answer, or related links and recommend branch holds. It cannot delete provenance.

### Authority Resolver

Applies deterministic project policy, searches for scope/supersession evidence, and emits scoped decisions or a named human authority task.

### Answer Composer

Builds a question-specific answer from accepted claims and a coverage matrix. It has no retrieval tool and may return `claim_pack_insufficient`.

### Information Architect

Maps claims and question demand into canonical reader-facing document types and sections.

### Document Writer

Writes documents from an approved DocumentPlan and sealed claim packs. It cannot perform silent research.

### Citation and Claim Reviewer

Checks every material sentence against claim/evidence dependencies and detects unsupported editorial synthesis.

### Navigation Tester

Uses fresh context and representative reader tasks to determine whether the generated documentation is discoverable and useful.

### Final Auditor

Evaluates closure predicates, source coverage, claim/answer/document validity, unresolved problems, and publication eligibility.

## 3. Main exploration workflow

```text
1. Admit question and goals/facets.
2. Researcher creates EvidencePacket v1.
3. Evidence Critic returns EvidenceVerdict v1.
4. If needs_more_evidence:
     Researcher receives only the precise criticism and prior receipt,
     then produces EvidencePacket v2.
5. If conflicting/authority/extraction blocked:
     run the specialized workflow.
6. If accepted:
     Claim Extractor proposes claims.
     Claim Reviewer accepts/rejects each claim.
7. If no_supported_answer:
     preserve question gap and search certificate.
8. Curiosity Planner receives terminal artifacts and proposes children.
9. Deterministic scheduler enforces admissibility, novelty, and obligation ownership.
10. Create paired child workflows breadth-first.
```

The Evidence Critic and Curiosity Planner never execute in the same model context.

## 4. Evidence-refinement stopping rule

The evidence loop terminates when:

- all required facets pass;
- the source snapshot genuinely contains no supported answer and search receipt passes;
- a conflict/authority/extraction issue is routed elsewhere;
- the configured refinement limit is reached, producing `search_incomplete` rather than a false gap;
- a human intervention is required.

A repeated refinement request must identify materially new search work. Otherwise the branch becomes `search_incomplete` or `needs_human`.

## 5. Claim protocol

The Claim Extractor receives only accepted evidence, the question/facets, and scope. Proposed claims should be:

- atomic enough to be independently supported;
- complete enough to preserve material qualifiers;
- reusable outside the current answer;
- explicit about unknowns and historical status;
- free of inferred purpose unless the source documents it.

The Claim Reviewer may split an overbroad claim, reject unsupported wording, or require a qualifier claim.

## 6. Curiosity protocol

A child proposal must include:

```yaml
question_text: ...
reason: ...
expected_answer_type: ...
goals: [...]
facets: [...]
trigger_source_unit_ids: [...]
trigger_claim_ids: [...]
coverage_obligation:
  kind: source_unit | question_facet | conflict | ...
  subject_id: ...
branch_directive: ...
```

Forbidden proposals include:

- generic “what else is missing?” questions;
- undocumented intention, recommendation, or future prediction;
- reformulations that own no new obligation;
- questions whose only purpose is optional detail with no selected source or goal demand;
- outside-world questions unless an operator explicitly enables external research.

## 7. Reverse Questioner loop

1. Coverage Auditor clusters selected unaccounted source units.
2. Reverse Questioner proposes minimum grounded questions or dispositions.
3. Human may accept/exclude/defer topic clusters.
4. Accepted questions enter normal evidence exploration.
5. New claims/questions update coverage.
6. A final reverse reconciliation confirms no selected semantic units remain silently unaccounted.

## 8. Human curiosity loop

A person can inject a raw question at the root or any node. The system records actor, exact wording, goals, anchors, and context note. The injection creates a `human_curiosity` obligation and ordinary exploration branch. It may end in an accepted claim/answer, explicit source gap, or authority task.

## 9. Agent-change governance

Agent manifests, prompts, schemas, and fixtures live in the repository. Changes run:

- schema validation;
- golden and adversarial fixtures;
- end-to-end regression questions;
- model-drift checks;
- independent diff summary;
- risk-based human review.

Agents that evaluate evidence, claims, authority, or publication default to manual review when changed.
