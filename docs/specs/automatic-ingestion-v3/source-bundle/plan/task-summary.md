# Task Summary

**Work packages:** 31  
**Leaf tasks:** 95

| Task | Work package | Title | Owner | Estimate | Risk | Test surfaces |
|---|---|---|---|---|---|---|
| T-00-01 | WP-00 | Approve v3 architecture decisions | Product architect | M | high | contract, human_factors |
| T-00-02 | WP-00 | Define repository and package conventions | Platform engineer | S | medium | schema, integration, migration |
| T-00-03 | WP-00 | Create decision-change workflow | Maintainer | S | medium | workflow, contract |
| T-01-01 | WP-01 | Implement schema registry | Platform engineer | M | high | unit, schema, integration |
| T-01-02 | WP-01 | Implement agent and workflow manifest validation | Platform engineer | M | high | schema, contract, workflow |
| T-01-03 | WP-01 | Implement bundle and link validator | Tooling engineer | S | medium | unit, schema, integration |
| T-02-01 | WP-02 | Build tiny synthetic corpus and expected graph | Evaluation engineer | M | high | retrieval, claim, e2e |
| T-02-02 | WP-02 | Define quality metrics and labeling guide | Evaluation lead | M | high | human_factors, claim, retrieval |
| T-02-03 | WP-02 | Build fixture runner and result store | Evaluation engineer | L | high | unit, agent_fixture, workflow, cost |
| T-10-01 | WP-10 | Implement package preflight | Security engineer | L | critical | unit, security, privacy |
| T-10-02 | WP-10 | Create immutable source snapshot | Platform engineer | L | high | unit, integration, recovery |
| T-10-03 | WP-10 | Implement replay capsule lifecycle | Storage engineer | L | critical | integration, security, privacy, recovery |
| T-11-01 | WP-11 | Implement A-tier text extractors | Document engineer | L | high | unit, integration, migration |
| T-11-02 | WP-11 | Implement representation audit framework | Document engineer | M | high | unit, security, human_factors |
| T-11-03 | WP-11 | Implement immutable repair path | Document engineer | M | medium | workflow, recovery, migration |
| T-12-01 | WP-12 | Implement structural source-unit parser | Search engineer | L | high | unit, integration, retrieval |
| T-12-02 | WP-12 | Build exact maps and aliases | Search engineer | M | medium | unit, retrieval, migration |
| T-12-03 | WP-12 | Build lexical index and search receipts | Search engineer | L | high | retrieval, integration, performance, recovery |
| T-12-04 | WP-12 | Benchmark optional semantic retrieval | Evaluation engineer | M | medium | retrieval, performance, cost |
| T-13-01 | WP-13 | Implement data and rights policy profiles | Security architect | M | critical | schema, security, privacy |
| T-13-02 | WP-13 | Enforce policy at retrieval/model boundaries | Security engineer | L | critical | security, privacy, integration |
| T-13-03 | WP-13 | Implement secret/PII and publication scans | Security engineer | M | critical | security, privacy, workflow |
| T-20-01 | WP-20 | Implement Question repository and lifecycle | Domain engineer | M | high | unit, schema, workflow |
| T-20-02 | WP-20 | Implement CoverageObligation ledger | Domain engineer | M | high | unit, workflow, recovery |
| T-20-03 | WP-20 | Implement question admissibility and novelty gate | Domain engineer | M | high | unit, agent_fixture, e2e |
| T-21-01 | WP-21 | Implement EvidencePacket and SearchReceipt repository | Domain engineer | M | high | unit, schema, retrieval |
| T-21-02 | WP-21 | Implement EvidenceVerdict lifecycle | Domain engineer | M | high | unit, schema, workflow |
| T-21-03 | WP-21 | Implement evidence loop limiter | Workflow engineer | S | medium | workflow, recovery, cost |
| T-22-01 | WP-22 | Implement Claim repository and lifecycle | Domain engineer | L | critical | unit, schema, claim |
| T-22-02 | WP-22 | Implement claim candidate search | Search engineer | M | high | claim, retrieval, performance |
| T-22-03 | WP-22 | Implement ClaimReview application | Domain engineer | M | critical | workflow, claim, recovery |
| T-23-01 | WP-23 | Implement graph mutation gateway | Platform engineer | L | critical | unit, integration, recovery |
| T-23-02 | WP-23 | Implement dependency graph and SCC analysis | Domain engineer | L | high | unit, claim, workflow |
| T-23-03 | WP-23 | Implement invalidation propagation | Domain engineer | L | critical | unit, integration, migration, recovery |
| T-30-01 | WP-30 | Implement Researcher source tools | Search engineer | L | critical | contract, retrieval, security |
| T-30-02 | WP-30 | Implement Researcher agent contract and prompt | Agent engineer | M | high | agent_fixture, retrieval, security |
| T-30-03 | WP-30 | Calibrate Researcher retrieval policy | Evaluation engineer | L | high | retrieval, performance, cost |
| T-31-01 | WP-31 | Implement Evidence Critic contract and prompt | Agent engineer | M | critical | agent_fixture, claim, retrieval |
| T-31-02 | WP-31 | Build evidence-criticism fixtures | Evaluation engineer | M | critical | agent_fixture, security, retrieval |
| T-31-03 | WP-31 | Run combined-versus-split ablation | Evaluation lead | M | high | agent_fixture, e2e, cost |
| T-32-01 | WP-32 | Implement Claim Extractor agent | Agent engineer | M | high | agent_fixture, claim |
| T-32-02 | WP-32 | Implement Claim Reviewer agent | Agent engineer | M | critical | agent_fixture, claim, security |
| T-32-03 | WP-32 | Calibrate claim granularity and relationships | Knowledge engineer | L | high | claim, human_factors, e2e |
| T-33-01 | WP-33 | Implement Curiosity Planner agent | Agent engineer | M | high | agent_fixture, workflow, cost |
| T-33-02 | WP-33 | Implement novelty/obligation scheduler | Workflow engineer | L | high | unit, workflow, recovery |
| T-33-03 | WP-33 | Implement paired context manifests and recovery | Platform engineer | M | high | recovery, cost, integration |
| T-40-01 | WP-40 | Implement uncovered-unit clustering | Search engineer | M | high | unit, retrieval, performance |
| T-40-02 | WP-40 | Implement Reverse Questioner agent | Agent engineer | M | high | agent_fixture, retrieval, e2e |
| T-40-03 | WP-40 | Implement iterative reverse reconciliation | Workflow engineer | M | high | workflow, e2e, recovery |
| T-41-01 | WP-41 | Implement Ask-here injection model and API | Product engineer | M | high | integration, workflow, human_factors |
| T-41-02 | WP-41 | Implement uncovered-topic curation | Product engineer | M | medium | workflow, human_factors, observability |
| T-41-03 | WP-41 | Implement human curiosity checkpoint | Workflow engineer | S | high | workflow, e2e, recovery |
| T-42-01 | WP-42 | Implement gate collectors | Platform engineer | M | critical | unit, integration, observability |
| T-42-02 | WP-42 | Implement closure certificate issuance/invalidation | Platform engineer | M | critical | schema, workflow, recovery |
| T-42-03 | WP-42 | Build closure adversarial suite | Evaluation engineer | M | critical | e2e, workflow, human_factors |
| T-50-01 | WP-50 | Implement multi-signal candidate generation | Search engineer | L | high | retrieval, claim, performance |
| T-50-02 | WP-50 | Implement Duplicate Adjudicator and typed relations | Agent engineer | M | critical | agent_fixture, workflow, human_factors |
| T-50-03 | WP-50 | Implement dual replay, holds, and revocation | Workflow engineer | L | critical | e2e, recovery, migration |
| T-51-01 | WP-51 | Implement project authority policy | Knowledge governance lead | M | critical | schema, human_factors, security |
| T-51-02 | WP-51 | Implement contradiction laboratory | Search engineer | M | critical | retrieval, agent_fixture, workflow |
| T-51-03 | WP-51 | Implement human authority decision and history graph | Product engineer | M | critical | workflow, security, migration |
| T-52-01 | WP-52 | Implement source continuity diff | Platform engineer | L | high | unit, migration, recovery |
| T-52-02 | WP-52 | Schedule affected obligations and targeted replay | Workflow engineer | L | critical | workflow, claim, performance |
| T-52-03 | WP-52 | Generate focused update PR and migration report | Git integration engineer | M | high | integration, migration, e2e |
| T-60-01 | WP-60 | Implement sealed claim-pack builder | Domain engineer | M | critical | unit, claim, recovery |
| T-60-02 | WP-60 | Implement Answer Composer agent | Agent engineer | M | high | agent_fixture, claim, e2e |
| T-60-03 | WP-60 | Implement answer citation/validity review | Evaluation engineer | M | critical | claim, workflow, recovery |
| T-61-01 | WP-61 | Define document types and IA rules | Documentation architect | M | high | contract, human_factors |
| T-61-02 | WP-61 | Implement Information Architect agent | Agent engineer | M | high | agent_fixture, human_factors, claim |
| T-61-03 | WP-61 | Build document-plan review workbench | Product engineer | M | medium | integration, human_factors, workflow |
| T-62-01 | WP-62 | Implement Document Writer agent and traceability | Agent engineer | M | high | agent_fixture, claim, security |
| T-62-02 | WP-62 | Implement deterministic and fresh citation review | Evaluation engineer | M | critical | claim, integration, workflow |
| T-62-03 | WP-62 | Implement representative navigation tests | UX researcher | L | high | human_factors, e2e, performance |
| T-63-01 | WP-63 | Implement publication planner and worktree writer | Git integration engineer | L | critical | integration, security, recovery |
| T-63-02 | WP-63 | Implement independent diff review and summary | Evaluation engineer | M | high | agent_fixture, workflow, human_factors |
| T-63-03 | WP-63 | Implement Docent import and replay | Git integration engineer | M | critical | e2e, migration, recovery |
| T-70-01 | WP-70 | Implement durable event model and streaming API | Frontend/platform engineer | L | high | integration, recovery, observability, security |
| T-70-02 | WP-70 | Implement graph/source/claim dashboard views | Frontend engineer | XL | high | performance, human_factors, observability |
| T-70-03 | WP-70 | Implement human decision workbenches | Product engineer | L | high | human_factors, workflow, security |
| T-70-04 | WP-70 | Run transparency comprehension study | UX researcher | M | medium | human_factors, observability |
| T-71-01 | WP-71 | Select/implement durable workflow engine | Platform architect | XL | critical | workflow, recovery, performance |
| T-71-02 | WP-71 | Implement leases, optimistic graph writes, and idempotency | Platform engineer | L | critical | integration, recovery, performance |
| T-71-03 | WP-71 | Implement context reconstruction and compaction | Platform engineer | L | high | recovery, cost, agent_fixture |
| T-72-01 | WP-72 | Implement telemetry and cost ledger | Platform engineer | M | high | observability, cost, privacy |
| T-72-02 | WP-72 | Implement deterministic prompt compiler and prefix tests | Agent platform engineer | M | medium | unit, agent_fixture, cost |
| T-72-03 | WP-72 | Implement preflight work/cost forecast and circuit breakers | Platform engineer | M | high | cost, performance, recovery |
| T-80-01 | WP-80 | Build full CI test matrix | Test engineer | L | critical | unit, agent_fixture, workflow, e2e |
| T-80-02 | WP-80 | Build adversarial source and agent suite | Security test engineer | L | critical | security, privacy, agent_fixture, e2e |
| T-80-03 | WP-80 | Build mutation and invalidation suite | Test engineer | M | critical | migration, claim, recovery |
| T-81-01 | WP-81 | Run tiny and small deterministic pilots | Pilot lead | L | high | e2e, human_factors, recovery |
| T-81-02 | WP-81 | Run v3 architecture ablations | Evaluation lead | L | critical | claim, agent_fixture, cost, human_factors |
| T-81-03 | WP-81 | Run medium real-project shadow ingestion | Pilot lead | XL | critical | e2e, human_factors, performance, cost |
| T-82-01 | WP-82 | Finalize release thresholds and operating policies | Product owner | M | critical | human_factors, security, observability |
| T-82-02 | WP-82 | Run disaster recovery and deletion drills | SRE lead | L | critical | recovery, security, privacy |
| T-82-03 | WP-82 | Roll out in controlled cohorts | Product owner | L | critical | e2e, observability, human_factors |
