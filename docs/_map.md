# Documentation map

| Document                             | Use it for                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| [`architecture.md`](architecture.md) | Runtime boundaries, state placement, agents, retrieval, and change requests. |
| [`api.md`](api.md)                   | Local HTTP/SSE/audio API contract.                                           |
| [`providers.md`](providers.md)       | Consent, credential sources, provider states, and contract tests.            |
| [`operations.md`](operations.md)     | Server operation, backup, recovery, maintenance, and releases.               |
| [`testing.md`](testing.md)           | TDD seams, test layers, commands, and snapshot review rules.                 |
| [`adr/`](adr/)                       | Durable architectural decisions that reconcile the source plan.              |
| [`agents/`](agents/)                 | Engineering-skill issue tracker and domain-doc configuration.                |
| [`engineering/`](engineering/)       | Agreed public TDD seams.                                                     |
| [`research/`](research/)             | Time-stamped primary-source research behind implementation choices.          |

The original design package and conversation provenance remain under [`.plan/`](../.plan/). External activation gates are in [`BLOCKED_TASKS.md`](../BLOCKED_TASKS.md).
