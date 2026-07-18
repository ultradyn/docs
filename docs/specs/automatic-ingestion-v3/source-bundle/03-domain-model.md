# Domain Model

## 1. Design intent

v3 separates the structures used for evidence, reusable knowledge, demand, and publication. The objective is not to invent a perfect ontology. It is to prevent a question tree from becoming an accidental canonical knowledge model.

## 2. Core entities

### SourceSnapshot

A frozen imported corpus with package hash, retention/replay receipt, import policy, parser/index configuration, and file inventory.

### SourceFile

One original file and its qualified representations. It carries blob hash, media type, original path, access classification, parser status, and authority/lifecycle hints.

### SourceUnit

A stable structural unit such as a document, section, paragraph group, table, code block, slide, sheet range, figure description, or callout. It retains:

- source snapshot and file IDs;
- original and normalized locators;
- content hash;
- parent and heading path;
- extraction quality tier;
- scope/authority/lifecycle hints;
- coverage disposition.

### EvidencePacket

A versioned Researcher proposal for one question generation. It contains:

- search receipt;
- primary, qualifying, example, conflict, and context references;
- proposed facet mapping;
- explicit retrieval failures and limits;
- no final answer prose.

### EvidenceVerdict

The Evidence Critic’s independent decision:

```text
accepted
needs_more_evidence
ambiguous_scope
conflicting_or_deprecated
no_supported_answer
human_authority_required
source_processing_blocked
```

It contains a per-facet matrix and a classification for every material reference.

### Claim

An atomic proposition supported by one or more accepted evidence references.

Recommended fields:

```yaml
id: clm-...
statement: Delivery workers retry a failed endpoint with exponential backoff.
claim_type: behavior
scope:
  component: delivery-worker
  version: 3.x
  environment: production
lifecycle: current
authority: official
status: accepted
evidence_refs: [...]
qualifier_claim_ids: [...]
contradicts_claim_ids: [...]
supersedes_claim_ids: [...]
created_from:
  question_id: q-...
  evidence_packet_id: evp-...
```

Claim types initially include:

```text
definition
purpose
behavior
requirement
constraint
interface_contract
procedure_step
failure_mode
rationale_documented
example
metric
historical_fact
unknown_boundary
```

The claim statement remains natural language. Typed metadata supplies boundaries without requiring an exhaustive formal ontology.

### ClaimReview

A fresh-context verdict that each proposed claim is entailed by its evidence, correctly scoped, minimally phrased, and free of unsupported synthesis.

### Question

A demand and navigation record. It includes:

- raw/canonical wording;
- origin and provenance;
- goals and facets;
- scope;
- primary parent and cross-links;
- finite obligations;
- evidence/claim/answer links;
- status and priority;
- duplicate/equivalence relations.

Generated questions remain distinct from human questions even when they converge.

### Answer

A question-specific composition of accepted claims. It contains:

- direct answer prose;
- claim order and citation placement;
- per-goal/facet coverage;
- limitations/gaps/conflicts;
- graph revision and dependency hashes;
- validity state.

An Answer is not the canonical home of every included fact.

### DocumentPlan

Maps accepted claims to reader-facing document types and canonical homes. It may place several questions under one section or expose one claim in multiple navigational views while retaining a single canonical statement.

### DocumentationRecord

A generated or maintained overview, concept, procedure, interface reference, decision, troubleshooting guide, glossary entry, or historical note. It references accepted claim IDs and exact evidence.

### CoverageObligation

The finite reason a branch or human task exists:

```text
source_unit
question_facet
conflict
human_curiosity
authority_resolution
extraction_repair
ancestor_reopen
supplemental_topic
```

An automatic child must own at least one unresolved obligation.

## 3. Important relationships

```text
SourceUnit --supports--> Claim
SourceUnit --qualifies--> Claim
SourceUnit --contradicts--> Claim
Claim --answers_facet_of--> Question
Question --composed_as--> Answer
Answer --uses--> Claim
Claim --canonical_home_in--> DocumentationRecord
Question --follow_up_of--> Question
Question --equivalent_to/subset_of/shares_answer_with--> Question
Claim --contradicts/supersedes/qualifies--> Claim
DocumentationRecord --references--> DocumentationRecord
```

## 4. Authority and lifecycle

Authority and lifecycle are separate axes.

Authority examples:

```text
approved_policy
canonical_documentation
official_reference
reviewed_historical
accepted_expert_provenance
draft
informal
generated
unknown
```

Lifecycle examples:

```text
current
deprecated
superseded
historical
future_proposal
unknown
```

A relevant deprecated source may be excellent historical evidence but inappropriate for a current operational answer.

## 5. Claim identity and deduplication

Claim IDs are assigned ULIDs. Content fingerprints help find equivalence candidates but do not define identity. Candidate comparison considers:

- normalized proposition;
- scope and time;
- claim type;
- evidence overlap;
- qualifiers and exceptions;
- authority/lifecycle.

Outcomes include exact equivalent, compatible restatement, narrower/broader, qualified variant, scoped difference, contradiction, or distinct.

## 6. Question versus claim deduplication

Two questions may share the same accepted claims but remain distinct because their goals, framing, audience, or answer order differ. Conversely, one question may be split because it requires materially independent claim sets.

Question deduplication therefore uses:

- semantic intent;
- goals/facets;
- scope;
- expected answer type;
- claim/evidence overlap;
- graph context.

Evidence overlap is a strong candidate signal, never a destructive merge instruction.

## 7. Answer and document invalidation

A Claim change invalidates dependent Answers and DocumentationRecords. A source/extraction/authority change invalidates Claims first, then flows downstream. Question wording changes do not alter Claim identity, but may change the answer composition and coverage requirements.

Validity states:

```text
proposed
verified
accepted
stale
superseded
rejected
```

For answers/documents:

```text
evidence_preview
draft_unstable
draft_stable
reviewed
promotable
invalidated
```

## 8. Recommended repository layout

```text
ingestion/
└── <run-id>/
    ├── run.yaml
    ├── source-snapshot.yaml
    ├── source-files.jsonl
    ├── source-units.jsonl
    ├── coverage-obligations.jsonl
    ├── questions/<question-id>/...
    ├── evidence/<evidence-id>.yaml
    ├── claims/<claim-id>.yaml
    ├── claim-reviews/<review-id>.yaml
    ├── answers/<answer-id>.md
    ├── answer-validity/<answer-id>.yaml
    ├── document-plan.yaml
    ├── documents/
    ├── graph.jsonl
    ├── coverage.jsonl
    ├── events.jsonl
    ├── assurance-certificate.yaml
    └── final-report.md
```

Large extracted representations and verbose live events may be stored in an artifact store with content-addressed manifests. Accepted logical records remain reviewable text.
