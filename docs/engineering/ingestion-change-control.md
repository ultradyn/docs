# Automatic ingestion change control

Every ingestion architecture, schema, workflow, agent, or policy change uses a
versioned change record. The record names its change class, version, migration
impact, owner, test evidence, reviewer, and rollback or supersession behavior.

## Review matrix

| Change class | Required evidence                                                   | Required review                               |
| ------------ | ------------------------------------------------------------------- | --------------------------------------------- |
| schema       | migration impact; paired valid and invalid fixtures                 | contract reviewer and compatibility check     |
| workflow     | reachable terminal-state fixture; paired valid and invalid fixtures | workflow reviewer and recovery check          |
| agent        | paired valid and invalid fixtures; fresh-context verification       | independent agent-contract reviewer           |
| policy       | migration impact; allow/deny fixtures; ADR gate                     | authorised policy owner and security reviewer |
| architecture | migration impact; acceptance scenarios; ADR gate                    | maintainer architecture review                |

High-impact evaluator or model changes require fresh-context verification against
both passing and adversarial fixtures. An agent contract change is incomplete
without its output schema, input policy, and paired valid and invalid fixtures.
Unknown schema versions and unowned migrations fail closed.

## Publication lane

The existing change-request manager owns the branch, actual diff, checks,
approval, and deterministic merge authorization. No ingestion-specific branch
manager is permitted. Reviewer, Diff Summarizer, and Simulated Asker retain their
restricted fresh inputs; changing a reviewed input supersedes the attempt rather
than editing its history.
