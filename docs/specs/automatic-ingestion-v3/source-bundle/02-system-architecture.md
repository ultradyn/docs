# System Architecture

## 1. Architectural overview

The feature is divided into four planes:

### Source plane

Immutable source snapshots, original files, qualified representations, structural source units, locators, hashes, and source policies.

### Knowledge plane

Claims, questions, answers, document plans, authority/lifecycle decisions, contradiction and supersession relationships, and provenance.

### Workflow plane

Versioned agents, workflows, branch state machines, human decisions, retries, graph mutations, and answer/document validity.

### Projection plane

Lexical/vector indexes, queue views, dashboards, live events, caches, graph layouts, and performance telemetry. These are rebuildable or operationally ephemeral.

## 2. Logical components

| Component | Responsibility |
|---|---|
| Source Importer | Securely unpacks, hashes, inventories, and retains source snapshots. |
| Representation Pipeline | Extracts supported formats and preserves mappings to originals. |
| Structural Parser | Creates source units by document/heading/table/code/paragraph structure. |
| Retrieval Service | Direct lookup, maps, lexical retrieval, optional semantic candidates, and link expansion. |
| Workflow Orchestrator | Runs durable state machines, retries, human gates, and branch scheduling. |
| Agent Runtime | Instantiates versioned agents with fresh contexts and allowlisted tools. |
| Evidence Gateway | Validates evidence references, search receipts, and packet versions. |
| Claim Registry | Stores proposed/accepted/disputed/superseded claims and dependency edges. |
| Question Graph | Stores demand, goals/facets, branches, obligations, duplicates, and gaps. |
| Answer Composer | Builds question-specific answer compositions from accepted claims. |
| Information Architecture Service | Maps claims/questions into reader-facing document structures. |
| Git/PR Adapter | Creates publication worktrees, commits, checks, summaries, and PRs. |
| Live Projection Store | Materializes events, queues, graph positions, and dashboard state. |
| Policy Services | Data rights, authority precedence, merge risk, retention, and release thresholds. |

## 3. Authoritative-state boundary

Git is authoritative for accepted logical records and configuration. A production runtime MAY use PostgreSQL, SQLite, or an event log for:

- leases and optimistic concurrency;
- live branch state;
- retry counters;
- event streaming;
- provider session handles;
- token and cost telemetry;
- dashboard projections.

A completed run must export the durable logical record to the repository. The runtime store may be deleted without losing accepted knowledge, but it need not be possible to reconstruct every millisecond of scheduler history.

## 4. Source–claim–question–answer flow

```text
Original source bytes
  → qualified representation
  → structural source units
  → evidence packet for a question/facet
  → independently accepted evidence
  → proposed atomic claims
  → independently accepted claims
  → question-specific answer composition
  → information-architecture plan
  → reader-facing document sections
```

Every arrow records producer/version and source dependencies. A downstream artifact becomes stale when an upstream dependency changes.

## 5. Exploration cell

The v3 exploration cell is not one undifferentiated chat:

```text
Researcher ↔ Evidence Critic
                 │ terminal verdict
                 ▼
       Claim Extractor → Claim Reviewer
                 │
                 ▼
          Curiosity Planner
                 │ grounded obligations
                 ▼
             child cells
```

The Curiosity Planner sees terminal evidence/claim artifacts, not the Evidence Critic’s hidden reasoning. The Evidence Critic cannot spawn children.

## 6. Concurrency model

- A branch lease protects one question generation at a time.
- Evidence packets and verdicts are immutable versions.
- Claim creation uses idempotency keys derived from question/evidence/version inputs, not claim text identity.
- Graph mutations use expected versions and deterministic validation.
- Child proposals are accepted by a scheduler only after novelty/obligation checks.
- Duplicate candidates may hold a branch, but its checkpoint remains recoverable.
- Human injections create ordinary branches and may invalidate stabilized artifacts.

## 7. Completion architecture

A run closes only when:

- forward obligations are terminal;
- Reverse Questioner accounting is terminal;
- the human curiosity checkpoint is closed;
- selected source units have terminal dispositions;
- claims and citations verify;
- contradiction/authority/extraction/dedup gates pass;
- answer/document validity matches the current graph revision;
- configured publication/navigation review passes or a scoped partial-publish outcome is recorded;
- the source replay capsule remains accessible.

## 8. Primary diagrams

- `diagrams/01-system-context.svg`
- `diagrams/02-layered-knowledge-model.svg`
- `diagrams/03-exploration-loop.svg`
- `diagrams/04-three-sided-closure.svg`
- `diagrams/05-claim-and-answer-validity.svg`
- `diagrams/06-publication-pipeline.svg`
- `diagrams/07-reingestion-invalidation.svg`
- `diagrams/08-runtime-and-git-boundary.svg`

An offline visual overview is in `architecture.html`.
