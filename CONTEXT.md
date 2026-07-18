# Ultradyn Docs

Ultradyn Docs is a question-driven documentation system whose portable project state is a Git repository. It turns demonstrated knowledge gaps and low-friction expert dictation into inspectable documentation change requests.

## Knowledge flow

**Question**:
A stable record of what an asker needs to know, the goals the answer must satisfy, and its complete provenance.
_Avoid_: Ticket, prompt, query

**Goal**:
A declared use for an answer with decisive satisfaction criteria, such as implementation or security review.
_Avoid_: Rubric, category

**Knowledge gap**:
A specific goal that the current documentation cannot satisfy and which must be logged rather than guessed through.
_Avoid_: Failure, hallucination

**Raw artifact**:
An immutable verbatim input—question, chat context, STT transcript, correction, or rejection reason—from which derived artifacts can be rebuilt.
_Avoid_: Source blob, editable transcript

**Structured answer**:
The current derived answer assembled from all raw transcript segments and corrections.
_Avoid_: Canonical answer, raw answer

**Finding**:
A stable critic observation tied to a goal and classified as satisfied, unsatisfied, uncertain, deferred depth, or contradiction.
_Avoid_: Score, comment

**Deferred question**:
A nonblocking child knowledge gap retained for breadth-first future work.
_Avoid_: Backlog item, ignored question

**Change request**:
A reviewable documentation diff with isolated checks; it may be represented by a local branch or a GitHub pull request.
_Avoid_: PR when the backend may be local

## Automatic ingestion

Adopted by ADR 0005; design at `docs/specs/automatic-ingestion-v3/DESIGN.md`. The preserved design bundle uses the product's former name "Docent" for Ultradyn Docs.

**Source snapshot**:
An immutable, hash-verified capture of an imported corpus created before any agentic exploration.
_Avoid_: Upload, mirror

**Source unit**:
A structural fragment of a snapshot file with parent/heading relationships and exact source identity, used as the unit of evidence and coverage.
_Avoid_: Chunk, embedding unit

**Evidence packet**:
A Researcher's proposed set of source-unit references with role/facet mappings and a search receipt; never a final answer.
_Avoid_: Answer draft

**Claim**:
An atomic, scoped, independently reviewed proposition with typed metadata, authority/lifecycle, and verified evidence; the reusable knowledge layer between evidence and prose.
_Avoid_: Fact triple, answer

**Answer composition**:
A claim-derived answer for one question and goal set, assembled only from sealed accepted claim packs; distinct from the transcript-derived Structured answer.
_Avoid_: Structured answer

**Coverage obligation**:
A finite, owned reason a branch of exploration exists; automatic child questions must each own a novel unresolved obligation.
_Avoid_: TODO, open question

## People and agents

**Asker**:
A person who poses or follows a question and independently accepts, rejects, or times out on its eventual answer.
_Avoid_: User, customer

**Answerer**:
A person who supplies expert knowledge, primarily through dictation, and approves the resulting change request.
_Avoid_: Author

**Maintainer**:
A person or server mode responsible for repository-wide review queues, agent definitions, integrations, and operational health.
_Avoid_: Admin

**Librarian**:
The isolated agent that retrieves from project documentation and either answers with citations or reports unsatisfied goals.
_Avoid_: RAG agent, chatbot

**Critic**:
A fresh-context evaluator that checks every goal and blocks unresolved contradictions while deferring ordinary depth.
_Avoid_: Reviewer

**Evidence Critic**:
The ingestion-lane fresh-context evaluator that judges evidence sufficiency for one question and cannot propose child questions.
_Avoid_: Critic, Questioner

**Curiosity Planner**:
The ingestion-lane agent that proposes obligation-bound child questions only after a terminal evidence verdict and cannot revise that verdict.
_Avoid_: Questioner, Explorer

**Reviewer**:
A fresh-context evaluator restricted to the question, structured answer, and actual diff.
_Avoid_: Critic

**Simulated Asker**:
A fresh-context evaluator that checks the verbatim ask against the post-diff documentation view before the real asker decides.
_Avoid_: Persona

## State and priority

**Lifecycle state**:
The canonical state field on a question record; queue folders are projections grouping active, deferred, and answered records.
_Avoid_: Folder state

**Priority tier**:
A rule-selected P1–P5 urgency class with a human-readable rationale and a direct override.
_Avoid_: Priority score, rank

**Committed projection**:
A deterministic, human-readable map or JSONL index committed for inspection and regenerated from canonical records.
_Avoid_: Cache, database

**Machine index**:
A disposable retrieval structure rebuilt from HEAD and never committed.
_Avoid_: Committed projection

## Local boundaries

**Project settings**:
Non-secret, portable behavior stored in the repository and reviewed like documentation.
_Avoid_: Personal settings

**Personal settings**:
Machine-local preferences and consent decisions applied across repositories, never committed.
_Avoid_: Project settings

**Credential source**:
A consent-gated adapter that delegates to an installed client, environment variable, keyring, or provider login without copying secrets into project settings.
_Avoid_: Credentials file

**Provider**:
A typed boundary for a model, transcription service, Git host, codec, or other external capability, always accompanied by a deterministic fake.
_Avoid_: Vendor integration
