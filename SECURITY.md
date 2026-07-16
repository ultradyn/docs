# Security policy

Please report vulnerabilities privately through GitHub's security-advisory flow for `ultradyn/docs`. Do not include credentials, raw private documentation, audio, or access tokens in an issue.

## Supported boundary

The initial release is a trusted-team, local-first application. The server binds to loopback by default, rejects unlisted `Host` values and foreign browser origins, requires an HttpOnly local session for content-bearing and state-mutating API routes, and emits restrictive browser security headers. Health and runtime metadata remain available without a session for launcher compatibility; the latter currently includes the absolute repository path and is tracked for hardening. The Tauri launcher additionally proves child ownership and bootstraps its session with a one-time random nonce. These controls reduce DNS-rebinding, cross-origin request, and launcher-race risk; they do not identify the human actor or provide multi-tenant isolation. Exposing the service beyond the local machine requires an explicit hostname allowlist, an authenticating TLS proxy, and a deployment-specific threat review.

The web UI separately requires a machine-local `identity.actorHandle` before it enables claims, priority overrides, answerer/maintainer approvals, or attributed merges. Asker acceptance and rejection controls appear only when that canonical handle matches a pending asker ID. The server rejects missing attribution fields instead of inventing a `local` actor. This handle makes provenance honest inside the trusted-team boundary; it is user-supplied attribution, not proof of identity, authorization, or a security principal.

Security invariants treated as release blockers:

- no secret or delegated token in Git, logs, events, browser JSON, snapshots, fixtures, or errors;
- no credential discovery before provider-and-scope-specific personal consent;
- no mutation/deletion of an existing raw artifact;
- no agent-controlled filesystem or Git plumbing outside typed deterministic tools;
- no shared producer/evaluator context where isolation is required;
- no documentation merge with an unresolved contradiction finding;
- no remote review action attributed to someone other than the authenticated actor;
- no deletion of temporary raw audio until a verified converted artifact exists.

## Dependency and release handling

Lock dependencies, review lifecycle scripts, run `pnpm audit` and `pnpm check`, inspect TUI/browser snapshots for accidental secret paths, and build Tauri artifacts on isolated release runners. Platform signing keys and OAuth client secrets remain in the release secret store.
