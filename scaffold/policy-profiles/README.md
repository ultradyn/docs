# Reference data-rights policy profiles

Five representative profiles covering the classes named in
`docs/specs/automatic-ingestion-v3/source-bundle/10-security-privacy-and-source-custody.md` §3.

**Provenance.** Hand-authored for T-13-01 against
`scaffold/schemas/ingest/data-rights-policy-profile.schema.json`. They are
repo-native artifacts, not copies from `source-bundle/`, which N8 forbids
importing at runtime.

**Status: fixtures only.** These are examples and test corpus. They are
deliberately _not_ a public enum, _not_ auto-selected, and _not_ an ambient
default. There is no allow-all fallback anywhere: a run without an approved
profile cannot begin, and approval is an explicit human act recorded in the
append-only ledger under `ingest/policy-approvals/`.

## Vocabulary

| Field                              | Meaning                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `allowedProcessors`                | Deterministic local extraction — reads bytes already in custody and emits derived representations. e.g. `local-markdown`.                                                                                                            |
| `allowedProviders`                 | LLM/STT model capabilities, **whether local or remote**. e.g. `provider:local-whisper`. Distinct from processors because a model capability is a different kind of thing from deterministic extraction, regardless of where it runs. |
| `allowedRegions`                   | Where execution and egress may occur. The explicit `local` token means no egress. An empty list is never allow-all; it is rejected.                                                                                                  |
| `allowedStorage`                   | Durable destinations.                                                                                                                                                                                                                |
| `retentionClass` / `retentionDays` | Declared intent for ingestion exposure. **Not** a custody erase schedule — nothing here expires or removes retained bytes. Authorised deletion is T-10-04, blocked on ADR 0007, ratified D9, and every capability gate.              |
| `publication`                      | Closed vocabulary. `external` is admissible only for `public` material carrying no licence restrictions.                                                                                                                             |
| `licenceRestrictions`              | Closed machine-checkable codes, so a downstream gate is never handed one it cannot interpret.                                                                                                                                        |
| `maxQuoteBytes`                    | Source bytes exposable to model or quote surfaces. `0` means no quotes, and is required when the licence carries `no-verbatim-quotes`.                                                                                               |

## The profiles

| File                           | Class                   | Notes                                                                                                                                                                                                                                                             |
| ------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public-docs.json`             | `public`                | The only profile permitting `publication: "external"`, and only because it carries no licence restrictions.                                                                                                                                                       |
| `internal-docs.json`           | `internal`              | `internal-only` publication, attribution required.                                                                                                                                                                                                                |
| `confidential-no-publish.json` | `confidential`          | Publication forbidden, no quotes.                                                                                                                                                                                                                                 |
| `restricted-local-only.json`   | `restricted-local-only` | Local model capability with `allowedRegions: ["local"]`, so no egress. Engagement-scoped retention.                                                                                                                                                               |
| `prohibited.json`              | `prohibited`            | **Declarable but never approvable.** It parses as a valid declaration so a gate can distinguish explicitly-forbidden material from merely unclassified or unapproved material; `PolicyService.approve` refuses it with `PROFILE_PROHIBITED` and writes no record. |
