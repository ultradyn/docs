# Answer Writing, Information Architecture, and Publication

## 1. Separation of outputs

The ingestion system produces three different user-facing assets:

1. **Answer compositions** for specific questions and goals.
2. **Claim graph** for reuse, retrieval, impact analysis, and contradiction handling.
3. **Reader-facing documentation** organized around tasks and concepts.

One question does not automatically become one document.

## 2. Answer composition

The Answer Composer receives:

- raw/canonical question;
- goals/facets and scope;
- accepted claim IDs and their qualifier/dependency graph;
- citation targets;
- explicit gaps/conflicts;
- graph revision.

It has no search tool. It may return `claim_pack_insufficient`, which reopens evidence/claim work.

An Answer contains:

- direct answer;
- scope and assumptions;
- ordered claim usage;
- exact citations;
- goal/facet coverage matrix;
- limitations, unknowns, conflicts, and historical distinctions;
- dependency/validity record.

## 3. When answers may be drafted

Evidence previews MAY be generated early for dashboard inspection, but promotable answers require:

- accepted claims;
- terminal relevant descendant/qualifier dependencies;
- no blocking contradiction/authority/extraction issue;
- current graph revision and evidence hashes.

Cyclic claim/question dependencies are condensed into strongly connected components and stabilized together.

## 4. Information architecture

The Information Architect maps claims and demonstrated question demand to document types:

```text
overview
concept
procedure
interface/reference
decision/rationale
troubleshooting
security/operational guide
glossary
historical note
FAQ or question landing page
```

For every durable claim, the plan identifies:

- one canonical home;
- optional summaries/links elsewhere;
- intended audience and task;
- prerequisite concepts;
- historical or scoped variants;
- questions that should resolve to the section.

## 5. Document writer

The Document Writer receives an approved DocumentPlan and sealed claim packs. It must:

- preserve claim scope and qualifiers;
- cite material assertions;
- avoid duplicating canonical facts unnecessarily;
- distinguish current, deprecated, and historical material;
- maintain consistent terminology;
- not introduce new facts or silently research;
- emit claim-to-sentence traceability.

## 6. Independent review

### Deterministic checks

- every referenced claim exists and is accepted/current for scope;
- every material sentence maps to claims/evidence;
- links and section IDs resolve;
- canonical-home uniqueness rules pass;
- no invalidated answer/document enters publication.

### Citation Reviewer

Fresh-context check for entailment, qualification, scope, and unsupported editorial synthesis.

### Navigation Tester

Uses representative tasks such as:

- explain the project to a new engineer;
- locate the supported authentication behavior;
- follow an operational procedure;
- determine whether old behavior still applies;
- answer an API integration question.

It measures success, time, path length, and misleading dead ends relative to the source baseline.

### Human review

Initial broad ingestion PRs default to manual review. Later narrow incremental imports may use risk-based automation.

## 7. Partial publication modes

A run may publish without claiming complete canonical documentation:

```text
evidence_graph_only
coverage_and_gap_report
provisional_questions_and_answers
provisional_FAQ
historical_archive
canonical_documentation
```

Each mode has explicit authority and retrieval visibility.

## 8. Git transaction

The publication PR may include:

- new/updated canonical documentation;
- imported question records;
- accepted claim records;
- answer compositions;
- gaps/conflicts/authority decisions;
- source/replay manifest references;
- graph/maps;
- retrieval fixtures;
- ingestion and assurance reports;
- redirects/cross-links.

A fresh agent summarizes only the final diff. Another fresh reviewer checks the diff against the plan and source/claim artifacts.

## 9. Docent authority

Imported material begins under `provisional_import` unless project policy explicitly promotes it. Human feedback, expert answers, and later source changes can revise or supersede imported claims through ordinary Docent workflows.

## 10. Retrieval after publication

User-mode retrieval should prefer:

- current canonical documents;
- accepted current claims;
- accepted answer compositions.

Raw source passages, disputed claims, ingestion logs, and drafts remain maintainer/answerer evidence unless policy exposes them.
