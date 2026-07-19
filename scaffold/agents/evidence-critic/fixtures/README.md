# Evidence Critic fixtures

## Two layers (do not conflate)

### Schema goldens (`001`–`003` input/expected pairs)

These exist for `validateAgentFixtures` (Ajv output schema + inputPolicy
projection). They carry **no behavioural guarantee** by themselves: a wrong
terminal verdict that remains schema-legal still passes the agents pin.

**Measured (T-31-02):** deliberate corruption of `001-expected.json` verdict
from `accepted` to `no_supported_answer` left the ships-all-fourteen agents pin
green. Shape-checking is not evaluation.

Behavioural execution of those goldens is performed by
`code/integration/evidence-critic-fixtures.test.ts` (REQUIRED 1), which loads
each expected proposal against a full packet through
`validateEvidenceCriticProposal`.

### Behavioural criticism cases (named files)

Named files (`partial.json`, `irrelevant.json`, … plus `complete-minimal.json`)
are executed by the integration harness. Fail-closed codes and thresholds are
asserted there, not by `validateAgentFixtures`.
