# Provider model

External capabilities cross typed LLM, STT, codec, credential-source, or Git-host interfaces. The UI represents provider state as `ready`, `consent_required`, `activation_required`, `unavailable`, or `error`. A visible source is not necessarily an executable provider: installed-client discovery currently reports several clients that do not yet have runtime adapters.

## Consent and credentials

Credential inspection is disabled until a person grants consent. Consent receipts are machine-local; repo settings contain provider/source IDs only. Implemented sources are:

- delegated installed-client status for Codex, Grok, Claude, OpenCode, and GitHub CLI;
- explicitly selected environment variables (`OPENAI_API_KEY`, `XAI_API_KEY`, and discovery-only `ANTHROPIC_API_KEY`);
- a versioned Grok OIDC record adapter for `~/.grok/auth.json`;
- an activation-required OpenCode auth-file placeholder that deliberately does not parse an unpinned format.

There is no OS-keyring adapter or generic browser OAuth flow yet. Login command definitions exist, but the server/UI does not invoke them. Consent controls grant or revoke one advertised `model`, `transcription`, or `git-host` scope at a time. Receipts and status remain independent, so model-only consent cannot resolve an STT capability.

Credential values must not enter repo settings, events, browser responses, logs, Git diffs, snapshots, or error details.

## Implemented capability matrix

| Selection/source               | Model path                                                               | Speech path                                                 | Current limitation                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `fake-llm` / `fake-stt`        | Deterministic typed LLM events                                           | Deterministic STT contract events                           | Server answer flow consumes STT after finalization; it does not stream fake partials into the browser.                                         |
| `codex-cli`                    | Runs installed `codex exec` with a fresh, read-only delegated invocation | None                                                        | Relies on the Codex client's own sign-in; no ChatGPT-subscription STT.                                                                         |
| `openai-env`                   | OpenAI Responses streaming adapter                                       | OpenAI multipart batch transcription                        | Requires a consented `OPENAI_API_KEY`; no incremental STT.                                                                                     |
| `xai-env`                      | xAI Responses streaming adapter                                          | xAI multipart REST batch transcription                      | Requires a consented `XAI_API_KEY`; no WebSocket STT.                                                                                          |
| `grok-auth-file`               | Same xAI Responses adapter                                               | Same xAI REST batch adapter                                 | Reads a short-lived Grok OIDC bearer only after consent; expiry requires re-login and the public-API entitlement is empirical, not guaranteed. |
| `ffmpeg` / `fake-codec`        | Not applicable                                                           | Verified Ogg/MP3 conversion or deterministic byte-copy fake | FFmpeg must be installed and on `PATH`.                                                                                                        |
| `github-cli` / `fake-git-host` | GitHub PR polling/publication primitives or local deterministic fake     | Not applicable                                              | Polling is wired to maintenance; approved local change requests are not yet wired to publication.                                              |

The following are advertised or discovered but are not runnable model providers today:

| Source                         | Implemented now                            | Missing before selection is truthful                                         |
| ------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------- |
| `grok-cli`                     | Install/sign-in availability status        | Delegated LLM adapter and login action                                       |
| `claude-cli` / `anthropic-env` | Install or environment availability status | Claude CLI/API LLM adapter, tests, and provider-specific UI state            |
| `opencode-cli`                 | Install/sign-in availability status        | Delegated LLM adapter and login action                                       |
| Google                         | Nothing beyond documentation intent        | Credential source, OAuth flow, model/STT adapters, fake cases, tests, and UI |
| Ollama                         | Nothing beyond documentation intent        | Local model adapter, discovery/error handling, tests, and UI                 |

See `docs/research/provider-auth-and-stt.md` and `BLOCKED_TASKS.md` for evidence, unfinished work, and external activation gates.

## What the tests establish

The checked-in provider tests currently establish:

- credential sources are not inspected before scoped consent;
- consent grant/revocation is validated and persisted independently for each advertised scope;
- generic fake LLM/STT events have deterministic order and schema;
- Codex is invoked through its CLI without reading or naming its credential cache;
- OpenAI/xAI HTTP adapters construct and parse production-shaped requests/responses;
- the Grok OIDC parser rejects expired/unsupported records without disclosing the bearer;
- fake codec/Git-host behavior and FFmpeg capability mapping;
- GitHub ETag/head changes map to idempotent local re-review tasks.

They do not yet establish a common success/denial/interruption/rate-limit/malformed-output/recovery suite for every advertised provider. “Test connection” currently means consent plus local availability, not a live external canary. Live canaries are manual and must use non-sensitive fixtures.
