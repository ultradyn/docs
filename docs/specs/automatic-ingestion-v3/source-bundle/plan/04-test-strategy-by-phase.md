# Test Strategy by Phase

| Phase | Dominant test surfaces | Promotion evidence |
|---|---|---|
| 0 | schema, contract, unit, human review | Invalid contracts fail; tiny corpus and metrics approved. |
| 1 | security, privacy, unit, retrieval, extraction, recovery | Replayable A-tier snapshot and deterministic search. |
| 2 | schema, claim, workflow, migration, concurrency | Durable question/evidence/claim graph and targeted invalidation. |
| 3 | agent fixtures, retrieval, claim, E2E, ablation | Split-role vertical slice beats or justifies cost versus baseline. |
| 4 | E2E, human factors, coverage, recovery | Forward/reverse/human obligations close without false completion. |
| 5 | claim, workflow, migration, authority, dedup replay | Reversible convergence and incremental change correctness. |
| 6 | claim/citation, navigation, human review, Git integration | IA-first docs and imported answers pass review/replay. |
| 7 | performance, observability, recovery, security, cost | Durable orchestration and trustworthy dashboard at target scale. |
| 8 | adversarial, shadow production, DR, deletion, rollout | Configured release thresholds and named owner approval. |

Every work-package YAML lists its specific test surfaces. A task is not done when code exists; its decisive acceptance criteria and named tests must pass.
