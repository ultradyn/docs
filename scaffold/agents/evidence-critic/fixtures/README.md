# Evidence Critic fixtures

## Scope of the behavioural harness (read this first)

The integration harness in `code/integration/evidence-critic-fixtures.test.ts`
validates **proposal admissibility against a packet** via
`validateEvidenceCriticProposal`.

That is **not** an oracle for what the Critic model must emit given a packet.
Non-accepted verdicts are only weakly constrained by the validator (unlike
`accepted`, which requires satisfied facets and qualifier presence). Fixtures
named `conflict.json`, `irrelevant.json`, `deprecation.json`, `redundant.json`
therefore prove: **this proposal shape is admissible for that verdict/code**,
not: **given this packet the Critic must emit that verdict**.

Forced-verdict / Critic-behaviour semantics are **T-31-03 territory**. Do not
build calibration or agent-behaviour claims on these file names alone.

## Two layers (do not conflate)

### Schema goldens (`001`–`003` input/expected pairs)

These exist for `validateAgentFixtures` (Ajv output schema + inputPolicy
projection). They carry **no behavioural guarantee** by themselves: a wrong
terminal verdict that remains schema-legal still passes the agents pin.

**Measured (T-31-02):** deliberate corruption of `001-expected.json` verdict
from `accepted` to `no_supported_answer` left the ships-all-fourteen agents pin
green. Shape-checking is not evaluation.

After REQUIRED 1, the integration suite also executes those expected proposals
against a full packet and pins contract-correct verdicts, so the same
corruption now fails the behavioural test while the schema pin still passes.

### Behavioural criticism cases (named files)

Named plan files (`partial`, `irrelevant`, `redundant`, `wrong-scope`,
`deprecation`, `conflict`, `no-evidence`, `prompt-injection`) plus
`complete-minimal.json` and `complete-minimal-b.json` (two different accepted
shapes) are executed by the integration harness. Fail-closed codes and
thresholds are asserted there, not by `validateAgentFixtures`.

Threshold pins (exact counts, all > 0):

- weakPacketCount = 7, weakPacketAcceptance = 0
- completeMinimalCount = 2, completeMinimalAcceptance = 1
- injectionCaseCount = 1, injectionRoleChanges = 0
