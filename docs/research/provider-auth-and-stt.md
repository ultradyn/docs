# Provider authentication and speech research

Reviewed: 2026-07-20

This note separates published provider contracts, observed behavior, and code that is actually wired into Ultradyn Docs.

## OpenAI/Codex

Codex supports ChatGPT subscription sign-in and API-key sign-in, but these are different authorization surfaces. The implementation delegates model work to the installed Codex client through `codex exec`; it never reads `~/.codex/auth.json` or repurposes its tokens as Platform API credentials. The [Codex app-server](https://developers.openai.com/codex/app-server) is a documented alternative integration surface but is not used by this version. OpenAI's [authentication guidance](https://developers.openai.com/codex/auth) distinguishes ChatGPT subscription access from usage-based API-key access.

OpenAI model and audio HTTP adapters are wired only to a consented `OPENAI_API_KEY`. ChatGPT/Codex subscription login is not treated as a general audio API credential. The STT adapter uses multipart batch transcription after local recording/finalization; it is not incremental speech streaming.

## xAI/Grok

xAI documents batch and streaming speech recognition. The [Speech to Text guide](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text) describes `POST https://api.x.ai/v1/stt` with bearer `XAI_API_KEY`; the [streaming reference](https://docs.x.ai/developers/rest-api-reference/inference/voice) describes `wss://api.x.ai/v1/stt`, supported raw-audio frames, interim events, `audio.done`, and final events.

Ultradyn Docs currently implements only the REST batch path plus the xAI Responses model path. Both can use either a consented `XAI_API_KEY` or the consented Grok auth-file adapter described below. WebSocket STT is not implemented.

The [Grok CLI reference](https://docs.x.ai/build/cli/reference) documents device-code login and an agent stdio surface. The codebase can discover whether the CLI is installed and contains a login command definition, but it does not yet invoke login or delegate LLM work to Grok CLI.

### Consent-gated Grok auth-file adapter

The adapter reads `~/.grok/auth.json` only after personal consent for the requested scope. It accepts only a user OIDC record for an `https://auth.x.ai::…` issuer, returns only an HTTP bearer capability, re-reads and expiry-checks the record for every authorization, and deliberately ignores refresh material. Expiry requires the person to sign in again with the owning Grok client.

On 2026-07-16, the credential supplied for development was used for three non-sensitive live checks: model discovery, one xAI Responses model call, and one REST batch transcription. All three succeeded. This is observed compatibility for that credential at that time, not a published guarantee that Grok consumer OIDC credentials authorize the public xAI API. Release activation must confirm entitlement/terms and repeat expiry, re-login, revocation, and retention checks. No credential value or attached auth file belongs in Git, logs, snapshots, or package output.

## Claude, OpenCode, Google, and Ollama

Claude CLI, OpenCode CLI, and `ANTHROPIC_API_KEY` currently have credential-source discovery only; no executable model adapter selects them. Google and Ollama have no implemented credential/provider adapters. These are in-repository gaps, not items made complete by obtaining client registrations or credentials.

## OAuth status

Browser OAuth sign-in (authorization-code + PKCE, 127.0.0.1 loopback redirect) is implemented for xAI (`xai-oauth`) and ChatGPT (`openai-oauth`). The server starts a loopback listener, presents the provider authorize URL, exchanges the code, and writes tokens to a machine-local store under the server data root (`oauth/oauth-tokens.json`, mode 0600) with automatic early refresh. Settings → Connections exposes **Sign in with xAI** / **Sign in with ChatGPT**. Completing sign-in is not consent: Ultradyn still requires a separate personal consent receipt per advertised scope. Honesty boundary: these flows reuse public first-party clients (no Ultradyn-owned OAuth registration yet); xAI has no public third-party OAuth program. The ChatGPT subscription token is model-scope only and is not an OpenAI audio API credential. Residuals: OS-matrix tests for cancel/deny/expiry/logout; IdP token revocation (disconnect clears Ultradyn-owned tokens and consent only). Claude/Google/other OAuth surfaces are not implemented. Static installed-client login command definitions remain discovery-only and are not equivalent to an implemented login action.

## Credential-registry behavior implemented now

- Source inspection is off until a machine-local consent receipt exists for the source and scope.
- Environment sources check only their named variable and never return its value to the UI or logs.
- Installed-client sources currently check command availability after consent; they do not invoke login/delegation except for the separately implemented Codex LLM provider.
- The Grok file source is a versioned exception: it parses only the known short-lived OIDC fields after consent.
- Repo settings store provider/source IDs and behavior, never bearer values or credential paths.
- Generic deterministic LLM, STT, codec, and Git-host fakes are available. A complete provider-specific failure fake matrix is still unfinished.

## Audio data path

The browser uploads MediaRecorder chunks incrementally, and the server durably acknowledges them before finalization. On stop, the server joins the chunks, converts and verifies Ogg/MP3 output, persists a cleanup intent, and only then removes raw chunks. A persisted finalizing session resumes cleanup without retranscoding verified output; pre-cleanup failures preserve acknowledged raw chunks for retry. Sessions reject uploads above 128 MiB or 10,000 chunks before creating the rejected chunk file. The selected OpenAI/xAI STT provider receives the completed audio as one multipart batch; provider partials are not streamed while the person is speaking.
