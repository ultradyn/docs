# Provider model

External capabilities cross typed LLM, STT, codec, credential-source, or Git-host interfaces. The UI represents provider state as `ready`, `consent_required`, `activation_required`, `unavailable`, or `error`. A visible source is not necessarily an executable provider: installed-client discovery currently reports several clients that do not yet have runtime adapters.

## Consent and credentials

Credential inspection is disabled until a person grants consent. Consent receipts are machine-local; repo settings contain provider/source IDs only. Implemented sources are:

- delegated installed-client status for Codex, Grok, Claude, OpenCode, and GitHub CLI;
- explicitly selected environment variables (`OPENAI_API_KEY`, `XAI_API_KEY`, and discovery-only `ANTHROPIC_API_KEY`);
- a versioned Grok OIDC record adapter for `~/.grok/auth.json`;
- browser OAuth sign-in (authorization-code + PKCE, loopback redirect) for xAI (`xai-oauth`) and ChatGPT (`openai-oauth`), with tokens held in a machine-local store (0600) under the server's data root — never in Git;
- an activation-required OpenCode auth-file placeholder that deliberately does not parse an unpinned format.

## Browser OAuth sign-in

Settings → Connections offers **Sign in with xAI** and **Sign in with ChatGPT** for the `xai-oauth` / `openai-oauth` sources. The server starts a 127.0.0.1 loopback listener, presents the provider's authorize URL with an S256 PKCE challenge, and exchanges the returned code for tokens written to `<dataRoot>/oauth/oauth-tokens.json` (file mode 0600). Access tokens are refreshed automatically with a 5-minute early buffer; a terminal refresh failure clears the stored token so the UI returns to the sign-in state.

Honesty boundary: xAI has no public third-party OAuth program, so the flow reuses the public first-party client that other local tools (for example pi) also use; this is a deliberate, documented choice. The xAI token serves both `model` and `transcription` scopes (the user grants each Ultradyn consent scope separately — completing sign-in is not consent). The ChatGPT subscription token serves the `model` scope only; it is not an OpenAI audio-API credential, so `openai-oauth` is not offered as an STT source.

There is no OS-keyring adapter. Consent controls grant or revoke one advertised `model`, `transcription`, or `git-host` scope at a time. Receipts and status remain independent, so model-only consent cannot resolve an STT capability.

Credential values must not enter repo settings, events, browser responses, logs, Git diffs, snapshots, or error details.

## Implemented capability matrix

| Selection/source               | Model path                                                               | Speech path                                                 | Current limitation                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fake-llm` / `fake-stt`        | Deterministic typed LLM events for explicit demo/test injection          | Deterministic STT contract events                           | `fake-llm` remains visible and selectable, but production local services refuse to treat it as an authoritative Critic or merge evaluator. Fake STT partials are not streamed into the browser. |
| `codex-cli`                    | Runs installed `codex exec` with a fresh, read-only delegated invocation | None                                                        | Relies on the Codex client's own sign-in; no ChatGPT-subscription STT.                                                                                                                          |
| `openai-env`                   | OpenAI Responses streaming adapter                                       | OpenAI multipart batch transcription                        | Requires a consented `OPENAI_API_KEY`; no incremental STT.                                                                                                                                      |
| `xai-env`                      | xAI Responses streaming adapter                                          | xAI multipart REST batch transcription                      | Requires a consented `XAI_API_KEY`; no WebSocket STT.                                                                                                                                           |
| `grok-auth-file`               | Same xAI Responses adapter                                               | Same xAI REST batch adapter                                 | Reads a short-lived Grok OIDC bearer only after consent; expiry requires re-login and the public-API entitlement is empirical, not guaranteed.                                                  |
| `xai-oauth`                    | Same xAI Responses adapter                                               | Same xAI REST batch adapter                                 | Browser PKCE sign-in; first-party public client (no third-party xAI OAuth program); token store is machine-local with early-refresh.                                                            |
| `openai-oauth`                 | OpenAI Responses streaming adapter                                       | None                                                        | Browser PKCE sign-in via the ChatGPT/Codex public client; subscription token is model-scope only and is not an audio-API credential.                                                            |
| `ffmpeg` / `fake-codec`        | Not applicable                                                           | Verified Ogg/MP3 conversion or deterministic byte-copy fake | FFmpeg must be installed and on `PATH`.                                                                                                                                                         |
| `github-cli` / `fake-git-host` | GitHub PR polling/publication primitives or local deterministic fake     | Not applicable                                              | Polling is wired to maintenance; approved local change requests are not yet wired to publication.                                                                                               |

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
- the default scaffold exposes fake capability state while failing closed before Critic approval or merge evaluation;
- Codex is invoked through its CLI without reading or naming its credential cache;
- OpenAI/xAI HTTP adapters construct and parse production-shaped requests/responses;
- the Grok OIDC parser rejects expired/unsupported records without disclosing the bearer;
- fake codec/Git-host behavior and FFmpeg capability mapping;
- GitHub ETag/head changes map to idempotent local re-review tasks.

They do not yet establish a common success/denial/interruption/rate-limit/malformed-output/recovery suite for every advertised provider. “Test connection” currently means consent plus local availability, not a live external canary. Live canaries are manual and must use non-sensitive fixtures.
