# Speculation and Future Experiments

## High-value experiments

1. Compare combined Questioner versus separate Evidence Critic/Curiosity Planner on false acceptance, branch factor, and reviewer consistency.
2. Compare direct source-to-answer writing with the claim-mediated pipeline on qualifier loss, fact duplication, and source-change invalidation.
3. Use two independent forward/reverse runs to estimate graph stability and recurring undiscovered facets.
4. Add a narrow source-witness agent that verifies exactly one claim against one or more source units.
5. Test whether evidence/claim hubs reduce cost without causing scope leakage between questions.
6. Measure whether questions sharing claims should share a generated answer section or retain different compositions for goals/audiences.
7. Detect suspicious graph motifs: highly reused claims with weak evidence, orphan claims, contradiction clusters, and branches with many children but little new coverage.
8. Generate source-author repair requests containing exact missing questions, affected goals, and searched locations.
9. Use source mutations to verify targeted invalidation rather than broad rebuilds.
10. Compare curation quality when humans see uncovered source topics, reverse-generated questions, or both.

## Perspective sweeps reserve

Potential perspectives include security reviewer, operator, implementer, API consumer, new maintainer, compliance reviewer, and incident responder. Do not build these preemptively. Activate one bounded perspective only when pilot evidence shows a repeated omission category and the ordinary mechanisms cannot close it economically.

## Claim-model extensions

- richer subject/entity aliases;
- machine-readable procedure preconditions/outcomes;
- claim confidence based on process state, never raw model confidence;
- explicit policy/implementation/observation claim classes;
- temporal intervals and version ranges;
- claim packs as external API objects;
- migration from one-file-per-claim to partitioned append-friendly storage at scale.

## Publication extensions

- generated reader paths by role;
- interactive “why is this true?” provenance views;
- automatic changelogs from claim lifecycle changes;
- historical timelines built from supersession edges;
- export to external portals while preserving claim/citation IDs;
- user-feedback analytics that identify high-demand claims and weak document sections.

## Operational extensions

- cache-aware scheduling across providers;
- adaptive model routing by task risk;
- active learning from human overrides;
- budget allocation by source coverage value;
- distributed source processing and graph gateway;
- privacy-preserving local embedding adapters;
- branch simulation before a large curiosity expansion.
