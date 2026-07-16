# Local API

The default base URL is `http://127.0.0.1:4173`. Success bodies are JSON unless noted. Errors use:

```json
{ "error": { "code": "stable_code", "message": "Human-readable summary" } }
```

The production server validates `Host` and browser `Origin` before routing. A same-origin web client establishes an HttpOnly, `SameSite=Strict` local session through the marked bootstrap below; an explicit top-level connection navigation remains available for recovery. Non-preflight API requests other than the browser-session bootstrap, health/runtime, and the nonce-gated desktop readiness probe require that session. `OPTIONS` requests are handled without a session for preflight only. Static and API responses include a restrictive CSP plus framing, MIME-sniffing, referrer, resource, and microphone permission headers. These controls protect the trusted local surface and are not human identity or remote access control. `--allow-origin` admits an Origin check; it does not enable cookie-authenticated cross-origin use because session cookies remain `SameSite=Strict` and CORS credentials are disabled.

## Browser session bootstrap

| Method | Path                   | Purpose                                                                  |
| ------ | ---------------------- | ------------------------------------------------------------------------ |
| POST   | `/api/browser-session` | Establish the private cookie before the first protected browser request. |

This is the only ordinary session-exempt POST. The request must carry an
HTTP(S) `Origin` whose hostname and port exactly match the validated `Host`,
plus `X-Ultradyn-Browser-Session: 1`. The custom header prevents a plain HTML
form from invoking the endpoint, and foreign browser requests fail the Origin
check even when their Origin is admitted for non-cookie development CORS. A
valid request returns `{"status":"ok"}`, `Cache-Control: no-store`, and, when
session authorization is enabled, the HttpOnly `SameSite=Strict` cookie.
Invalid requests return `403` without a cookie. A foreign Origin rejected by
the global Origin check uses `origin_not_allowed`; requests that reach this
endpoint but fail its method, exact-origin, or marker checks use
`browser_session_rejected`. Repeating a valid bootstrap is idempotent for the
running server session.

The same-origin web adapter performs this bootstrap before its first runtime
request. If a protected request later returns `401 session_required` (for
example, because the server restarted and rotated its in-memory session), the
adapter deduplicates concurrent bootstrap attempts and replays each rejected
request once. It does not replay network or timeout failures: those are
ambiguous for mutations because the response may have been lost after the
handler committed the change.

## Runtime and events

| Method | Path           | Purpose                                                                           |
| ------ | -------------- | --------------------------------------------------------------------------------- |
| GET    | `/api/health`  | Liveness and package version.                                                     |
| GET    | `/api/runtime` | Repository, demo, version, and live maintenance flags.                            |
| GET    | `/api/events`  | SSE stream; event types are question, audio, settings, provider, and maintenance. |

`GET /api/desktop-readiness` is an internal Tauri ownership probe. It exists only for a server launched with a per-process nonce and returns `404` without the matching request header; it is not an authentication token for ordinary API calls.

SSE events include a ULID `id`, ISO timestamp, `type`, and typed `data`. A
same-origin browser stream that drops re-establishes the browser session and
opens a replacement stream, retrying the bootstrap while the server is
unavailable. Cross-origin development overrides retain the browser's native
EventSource reconnect behavior. Durable state is always reloaded from the
relevant GET route rather than trusting an event replay buffer.

## Ask and queue

| Method | Path                          | Purpose                                                                                    |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------ |
| GET    | `/api/goals`                  | List goal vocabulary and satisfaction criteria.                                            |
| POST   | `/api/ask`                    | Ask with `{question, goals, asker, chat?}`; returns cited `answer` or a `logged` question. |
| GET    | `/api/questions`              | Filter summaries by `bucket`, `tier`, and text `q`.                                        |
| GET    | `/api/questions/:id`          | Full raw-visible detail and derived answer/evaluation.                                     |
| POST   | `/api/questions/:id/claim`    | Claim with `{answerer}`.                                                                   |
| POST   | `/api/questions/:id/priority` | Human override with `{tier,rationale,by}`.                                                 |

## Answer and integration

| Method | Path                                        | Purpose                                                           |
| ------ | ------------------------------------------- | ----------------------------------------------------------------- |
| POST   | `/api/questions/:id/transcripts`            | Append immutable `{text,source,confidence?}`.                     |
| POST   | `/api/questions/:id/structure`              | Rebuild derived answer from all raw segments/corrections.         |
| POST   | `/api/questions/:id/critic`                 | Run an isolated decisive goal/contradiction evaluation.           |
| POST   | `/api/questions/:id/integrate`              | Create/update the documentation change request after Critic DONE. |
| POST   | `/api/questions/:id/accept`                 | Record acceptance with the matching `{asker}` handle.             |
| POST   | `/api/questions/:id/reject`                 | Append `{asker,reason}` verbatim and reopen at P1.                |
| POST   | `/api/questions/:id/change-request/approve` | Record `{by,kind}` approval on the local diff.                    |
| POST   | `/api/questions/:id/change-request/merge`   | Merge the approved local diff with attributed `{by}`.             |

Invalid lifecycle transitions return `409`, never an implicit repair.

## Incremental audio

| Method | Path                                       | Purpose                                                                         |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------- |
| POST   | `/api/audio/sessions`                      | Start with `{questionId,mimeType}`.                                             |
| PUT    | `/api/audio/sessions/:id/chunks/:sequence` | Durably append `application/octet-stream`; ordered, idempotent retry semantics. |
| POST   | `/api/audio/sessions/:id/finalize`         | Join, transcode, verify, then remove temporary raw input.                       |

The browser sends MediaRecorder chunks as they arrive. A successful chunk response means the server has durably recorded it. Sessions refuse data beyond 128 MiB or 10,000 chunks before writing the rejected file. Finalization persists verified output and cleanup intent before raw deletion; failures before cleanup retain raw chunks, failures after cleanup resume idempotently without retranscoding, and the answer UI exposes retry.

## Settings and providers

| Method | Path                            | Purpose                                                                          |
| ------ | ------------------------------- | -------------------------------------------------------------------------------- |
| GET    | `/api/settings/schema`          | Rich field metadata, category, scope, defaults, options, restart requirement.    |
| GET    | `/api/settings`                 | Effective values with `default`, `repo`, or `personal` source.                   |
| PUT    | `/api/settings`                 | Set `{key,value,scope}`; wrong scope is rejected.                                |
| GET    | `/api/providers`                | Capability, per-scope consent, and activation status; never secret values.       |
| POST   | `/api/providers/:id/consent`    | Grant/revoke exactly one `{scope,granted}` personal-consent receipt.             |
| POST   | `/api/providers/:id/connect`    | Re-inspect the consented credential source; does not launch login/OAuth.         |
| POST   | `/api/providers/:id/disconnect` | Revoke exactly one `{scope}` receipt; does not log out the provider/client.      |
| POST   | `/api/providers/:id/test`       | Check consent and local source availability; does not make a live provider call. |

`scope` is one of `model`, `transcription`, or `git-host`, and the source must advertise it. Receipts persist independently, so granting model use cannot authorize transcription or Git hosting. Login invocation, OAuth, and live canaries remain unfinished and are tracked in `BLOCKED_TASKS.md`.

`identity.actorHandle` is a personal string setting. It accepts an empty value (which disables attributed UI actions) or a canonical lowercase handle up to 96 characters using letters, numbers, `.`, `_`, `:`, and `-`. The browser loads it once into shared application state and refreshes it after settings events. Mutation routes still require their explicit actor field; the setting is not a server-side authentication credential.

## Maintenance

`GET /api/maintenance` and `POST /api/maintenance/run` exist only while maintenance mode is enabled. Enabling `server.maintenance` through settings changes the runtime and navigation without restarting. Jobs use durable cursors and emit idempotent local tasks. Changing the interval requires a server restart; remote task actions are not implemented.
