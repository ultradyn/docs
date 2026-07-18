# v3 Change Summary

## 1. Two load-bearing changes

### Change A — The question graph is no longer the whole knowledge model

Earlier versions treated questions and their referenced answers as the main graph. v3 separates five concerns:

1. **Source units** preserve what the imported corpus actually contains.
2. **Claims** represent reusable, atomic, scoped knowledge supported by source units.
3. **Questions** represent demand, exploration paths, goals, and navigation.
4. **Answers** compose accepted claims for a particular question and goal set.
5. **Documents** organize accepted claims for readers through an explicit information architecture.

This avoids several pathologies:

- two questions can reuse one claim without duplicating prose;
- one question can require many claims without treating one source paragraph as “the answer”;
- contradictions can be recorded claim-to-claim;
- source changes can invalidate affected claims, answers, and documents precisely;
- deduplication can distinguish “same evidence surface” from “same question”;
- publication can be reader-oriented rather than mirroring an agent conversation tree.

v3 deliberately does **not** require a universal ontology or RDF-style triple store. A claim is initially a textual atomic proposition with typed metadata, scope, authority, lifecycle, evidence, and relationships.

### Change B — Evidence criticism and curiosity planning are separate roles

The former Questioner role had incompatible pressures:

- be strict enough to reject incomplete, irrelevant, outdated, or contradictory evidence; and
- be expansive enough to discover new branches.

v3 separates these into independent calls:

#### Evidence Critic

Receives the raw question, goals/facets, proposed evidence packet, relevant source excerpts, and scope. It may:

- accept the evidence;
- identify exact missing facets;
- reject unnecessary references;
- flag scope, lifecycle, authority, or contradiction problems;
- ask for a bounded evidence refinement;
- return terminal no-evidence or human-authority-required states.

It **cannot** propose child questions.

#### Curiosity Planner

Runs only after the evidence loop reaches a terminal verdict. It receives accepted claims/evidence, the branch path, coverage obligations, and source-grounded triggers. It may propose materially distinct child questions, but each proposal must own a new finite obligation.

It **cannot** grade or reopen the current evidence packet.

This gives each evaluator one decisive job and makes fixtures far easier to write.

## 2. What remains from v2

v3 preserves and integrates:

- immutable source snapshots and hash-bound references;
- deterministic extraction before agentic work;
- exact and lexical retrieval as the default;
- optional semantic retrieval only after benchmark evidence;
- Reverse Questioner source-led discovery;
- Human Curiosity Injection;
- perspective sweeps held in reserve;
- finite branch obligations;
- non-destructive deduplication and recoverable holds;
- authority/deprecation resolution;
- ancestor invalidation;
- prompt-cache-compatible contexts with zero-cache correctness;
- live graph, source coverage, and agent activity dashboard;
- information-architecture and editorial publication gates;
- Git branches/PRs for Docent integration.

## 3. Superseded assumptions

The following statements are no longer valid:

- “A fully explored question tree is the complete knowledge representation.”
- “The Questioner both judges an answer and decides what to ask next in one call.”
- “One final answer page should be written for every graph node.”
- “Evidence overlap alone is sufficient to merge questions.”
- “The writer should receive only the ancestor question transcript.”

## 4. New decisive invariants

1. **Claims are reusable.** Answers and documents reference accepted claim IDs rather than copying unsupported synthesis.
2. **Questions are demand records.** They remain immutable and independently addressable even when they share claims or answer surfaces.
3. **Evidence judgment is bounded.** The Evidence Critic cannot generate future work.
4. **Curiosity is obligation-bound.** The Curiosity Planner cannot fork without a novel source, facet, conflict, human, or reopen obligation.
5. **Claim promotion is independently verified.** No proposed claim becomes accepted solely because the same context generated it.
6. **Publication is an information-architecture transaction.** The final docs are not a transcript dump.
7. **Invalidation flows through dependencies.** Source/authority/claim changes mark dependent answers and documents stale.

## 5. Recommended implementation order

v3 should not begin by building every agent and dashboard screen. The first vertical slice is:

1. immutable Markdown/text source snapshot;
2. structural source units and lexical search;
3. question, evidence packet, and verdict records;
4. one Researcher and one Evidence Critic loop;
5. proposed and accepted claims;
6. a simple answer composed from claims;
7. an end-to-end replay fixture.

Curiosity branching, reverse questioning, human injection, convergence, documentation composition, and the rich dashboard build on that measured core.
