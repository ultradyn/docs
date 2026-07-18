# Integration with Docent

## 1. Relationship

Automatic ingestion seeds Docent; it is not a parallel knowledge system. It reuses:

- Git-authoritative logical records;
- ULID identity;
- immutable raw provenance;
- derived indexes outside Git;
- fresh-context evaluation;
- goal/facet sufficiency;
- authority/lifecycle distinctions;
- reviewable publication PRs;
- retrieval regression fixtures.

## 2. Imported records

The feature may propose:

- generated canonical questions with `origin: ingestion_generated`;
- human-injected questions with `origin: human_ingestion_seed`;
- Reverse Questioner seeds with `origin: reverse_source_seed`;
- accepted claim records;
- question-specific answer compositions;
- explicit source gaps and conflicts;
- reader-facing documents and cross-links;
- retrieval/evidence/claim fixtures;
- source snapshot/replay/assurance manifests.

Imported generated questions must not impersonate real askers.

## 3. Authority

Initial broad imports default to `provisional_import`. Project policy may separately promote:

- accepted current claims;
- canonical documents;
- answer compositions;
- historical records.

Raw source units, proposed/disputed claims, agent logs, and held branches do not enter ordinary user-mode retrieval.

## 4. Claim registry integration

Docent gains a lightweight claim registry rather than replacing its document model. Claim records support:

- evidence traceability;
- reuse across questions/documents;
- contradiction and supersession;
- impact analysis;
- source-change invalidation;
- answer composition.

Documents remain the primary maintained reader artifact. Claims are supporting structured records, not a requirement that humans edit triples.

## 5. Question and case behavior

A generated ingestion question may later receive real demand. A new raw user case can attach to it, promote its priority, add goals/scope, and trigger review of its imported answer. Human rejection enters ordinary Docent provenance and may invalidate a claim/answer/document dependency.

## 6. Publication PR

The PR should contain one coherent transaction:

- canonical-home document changes;
- claims and claim reviews;
- questions/answers/gaps;
- maps and relationships;
- fixtures;
- ingestion/assurance report;
- source manifest references;
- authority/history decisions.

Independent reviewers inspect the final diff, not only the integration plan.

## 7. Retrieval behavior

User questions retrieve current canonical docs, accepted claims, and accepted answers. The answering model can cite documents/source sections while claim IDs provide internal traceability. Maintainer/answerer mode may inspect raw ingestion evidence.

## 8. Incremental re-ingestion

For a replacement snapshot:

1. compare file/source-unit hashes;
2. map unchanged/moved units;
3. mark claims depending on changed/deleted units stale;
4. rerun only affected evidence/claim/question obligations;
5. reverse-account newly added units;
6. reevaluate authority/lifecycle;
7. regenerate affected answers/documents/fixtures;
8. propose a focused PR.

The existing accepted knowledge remains available until the replacement transaction passes review.
