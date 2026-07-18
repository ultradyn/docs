# Unfinished work and external activation gates

This is the release-truth ledger. It tracks both unfinished repository work and capabilities that are implemented locally but cannot be activated without an external contract, credential, runner, or publishing authority. An external dependency is never used to hide missing in-repository code.

## Unfinished in the repository

These items need implementation and tests; no external approval is required to start them.

### Lifecycle ownership and integration policy

- [ ] Add a dedicated asker inbox across questions. Stable personal actor attribution and identity-matched decision controls are implemented on each merged answer, but there is no consolidated view of every acceptance request pending for that handle.
- [ ] Enforce `review.mode` (`manual` versus `auto`) and the answerer summary-veto window. The setting is stored and displayed but merges still require the same explicit approval path.
- [ ] Rebase and re-plan an isolated change request when its base moves. A conflicting local merge currently aborts safely and requires manual recovery.
- [ ] Regenerate documentation maps deterministically for arbitrary Integrator edits. The default single-answer path appends `docs/_map.md`, but there is no general map regenerator or drift check.
- [ ] Decide which change-request metadata is portable. Branch/worktree review records currently live only in the machine-local data directory.

Actual branch diffs, non-prefix-conflicting attempt branches, input-fingerprinted current-input ensure/reuse, preflighted locked/journaled creation and supersession recovery, schema-version-1 change-request migration with fail-closed missing evaluator input, reopened multi-attempt history, stale-attempt supersession that preserves dirty user work, mandatory fresh Reviewer/Diff Summarizer/Simulated Asker calls over stored input, exact Simulated Asker goal coverage, post-diff documentation reads, fail-closed non-authoritative production fakes, durable local-merge reconciliation, dirty-worktree-preserving cleanup, merged-only pending-asker acceptance/timeout, revision-scoped journaled exactly-once rejection/reopen, shared production-validator parity coverage for every shipped portable schema, duplicate-goal intake rejection, conflict-detecting UUID-managed staging-ignore initialization, and acceptance timeout processing are implemented and covered by local tests.

### Audio and browser hardening

- [ ] Add browser-level MediaRecorder/getUserMedia fakes and a Playwright answer-and-audio flow. The current Playwright suite covers one Chromium Ask flow only.
- [ ] Add capture tests for upload/disk-full failure, permission denial and revocation, pause/resume ordering, and silent truncation/duration checks. Unit coverage currently includes unmount cleanup, device removal, recorder error, ordered durable server chunks, byte/chunk quotas, adoption/rejection of unmanifested chunk bytes after metadata failure, nonblocking special-file rejection, metadata-publication pathname-swap rollback, failed transcode retention, retryable finalization UI, and metadata-failure recovery before and after cleanup intent.
- [ ] Stream STT partials from the provider through the server to the active answer session. Browser audio is saved incrementally, but OpenAI/xAI transcription currently begins after finalization and returns a batch final transcript.
- [ ] Surface transcript confidence when a provider supplies it and add an unmistakable fake-transcript banner in the real answer workflow.
- [ ] Display the resolved machine-local data path plus audio/transcode recovery status in Settings so backup instructions are actionable.

### Providers, consent, and login UX

- [ ] Implement provider-specific model adapters for Claude CLI/API, Grok CLI delegation, OpenCode delegation, Google, and Ollama, or remove those choices until implemented. Credential-source status discovery alone is present for the installed clients.
- [ ] Invoke the existing installed-client login definitions from a user-consented server/UI action and test cancellation, denial, refresh/expiry, disconnect, and revocation.
- [ ] Make “Test connection” perform a non-sensitive provider canary. It currently checks only consent and local availability.
- [ ] Add xAI WebSocket streaming STT. The implemented xAI path is REST batch transcription.
- [ ] Add provider-specific deterministic failure fixtures for denial, interruption, rate limiting, malformed output, cancellation, and recovery. Generic LLM/STT/codec/Git-host fakes cover happy-path contracts but not that complete matrix.

### Agents and maintenance

- [ ] Invoke the full Goal Clerk → Matcher → Registrar → Prioritizer agent loop for new asks. The current accessible control loads the vocabulary and accepts normalized freeform goals; deterministic services perform lexical matching, durable registration, and rule-based priority while only Librarian is called through the agent runtime. Agent suggestions must remain advisory to the deterministic authority described in `AGENTS.md`.
- [ ] Run every touched agent fixture through the agent runtime in CI. Current fixture validation checks input projection and expected-output schema; it does not execute every input/expected pair.
- [ ] Make Agent-Smith use its isolated agent contract to propose meaningful prompts, schemas, and fixtures. The current create path emits a generic schema and canned expected files; update appends prose without regenerating schema/fixtures.
- [ ] Wire mandatory fresh Reviewer, Diff Summarizer, and Simulated Asker execution for Agent-Smith proposals. Those proposals now fail closed with pending evaluator checks, so they cannot be approved or merged until that evaluation path runs.
- [ ] Add a model-drift canary and persist its findings.
- [ ] Generalize checkpoint commits beyond the approved-local-merge path. `review.checkpointCommits=true` currently checkpoints managed question/settings state around that merge; `false` leaves it uncommitted and exposes one pending task in Maintenance. Other portable mutation workflows do not yet trigger an autonomous checkpoint commit.
- [ ] Turn remote maintenance entries into actionable local review workflows and wire `GitHostProvider.publish()` to approved change requests. GitHub polling and the `gh pr create` primitive exist independently.
- [ ] Add GitHub pagination, rate-limit/backoff handling, reviewer-identity filtering, and task actions. Polling currently covers the first 100 open PRs, ETag reuse, durable cursor/head state, overlap prevention, and head-change re-review.

### Integrity, packaging, and desktop distribution

- [ ] Eliminate same-user filesystem time-of-check/time-of-use races with no-follow/open-at-style primitives. All known repository-root and path-component symlinks are rejected before reads, writes, and moves, including documentation retrieval, queue projections, generated indexes, and settings; an attacker concurrently swapping a checked component is not yet covered.
- [ ] Stop exposing the absolute repository path on unauthenticated `/api/runtime`, or replace the Tauri compatibility check with a nonce-gated equivalent. The route is loopback-only by default and does not expose document content, but the path itself may be sensitive.
- [ ] Pin third-party GitHub Actions to reviewed commit SHAs and document the update process. Workflows currently use mutable major-version tags.
- [ ] Run raw-history and question-projection checks against a representative generated repository and explicit base in CI. `pnpm check` invokes both scripts at the product root, which does not exercise generated question history; documentation-map drift is not checked.
- [ ] Add Firefox/WebKit Playwright projects where supported. CI currently runs the single Chromium Ask flow.
- [ ] Bundle a backend sidecar or Node runtime for desktop releases. The Tauri source currently starts pinned `npx @ultradyn/docs@<desktop-version>` and therefore still requires Node/npm plus package availability.
- [ ] Generate and commit `tauri-app/src-tauri/Cargo.lock`, then enforce `cargo check/test --locked` at the declared Rust 1.77.2 minimum.
- [ ] Add a native first-run folder chooser, startup progress, bounded diagnostic display, and visible error dialog. The safe source currently requires `--repository`/`ULTRADYN_DOCS_REPOSITORY`; a consoleless double-click launch with no saved path can exit without actionable UI, and a cold pinned `npx` launch is opaque while it waits.
- [ ] Add a native single-instance UX or per-instance ports. The current fixed port rejects every pre-existing listener, a random readiness nonce closes simultaneous-start ownership races, and RAII/window teardown terminates the owned process tree, but a second launch still has no friendly focus-existing-window flow.
- [ ] Add native process-tree and desktop-bootstrap tests on Linux, macOS, and Windows, including a surviving Unix grandchild and Fetch-Metadata behavior in WebKitGTK, WKWebView, and WebView2.
- [ ] Make saved-path replacement atomic on Windows and add Windows path-equivalence/launcher tests.
- [ ] Replace or harden the handwritten localhost HTTP probe for chunked/malformed/oversized/time-out responses.

### Automatic ingestion (v3)

Adopted by ADR 0005/0006; execution truth lives in the backlog (phases R0–R4). Only R0/R1 (bundle M0–M3, 46 atomic tasks) is instantiated; the items below are the release-truth gates that later backlog epic stubs cross-link and must clear before those stubs expand.

- [ ] Complete the R0/R1 measured vertical slice: one A-tier Markdown snapshot → source units + lexical retrieval → Researcher/Evidence Critic loop → independently reviewed claims → one claim-derived answer composition with zero-cache replay fixtures (bundle gate M3; `docs/specs/automatic-ingestion-v3/DESIGN.md`).
- [ ] Author the deletion-semantics ADR distinguishing authorized source-custody purge from portable append-only history (DESIGN C12). Required before any ingestion deletion task starts.
- [ ] Wire `GitHostProvider.publish()` to approved change requests (also listed under Agents and maintenance). Gates the M6 publication epics (WP-63), which reuse the change-request manager rather than adding a publication subsystem.
- [ ] Extend the agent runtime beyond Librarian to the ingestion lane's evaluator roles with runtime-enforced isolation and paired fixtures. Gates M3 agent epics (WP-30–32) beyond contract work and all M4 exploration epics.
- [ ] Establish durable SSE reconnect truth, workflow crash/idempotency evidence, provider/agent receipts, and current-product recovery evidence. These existing-product items are the repo-native precursors the M7 operational epics (WP-70–72) cross-link; ingestion-specific dashboard/orchestration work stays gated on M1–M6 interfaces existing.
- [ ] Vector/semantic retrieval remains excluded pending a dedicated ADR plus the bundle's replay-evidence threshold (DESIGN C4/D8); the optional vector benchmark task (T-12-04) is non-blocking.

## External activation gates

The following sections name only the external step. Any missing implementation remains in the repository list above.

### OpenAI transcription through a ChatGPT/Codex subscription

Status: no official general-purpose audio API credential is derived from a ChatGPT/Codex subscription. Codex subscription work is delegated to the installed Codex CLI; its cached credential is not parsed or repurposed. The implemented OpenAI LLM/STT HTTP adapters use `OPENAI_API_KEY`.

Activation checklist:

- [ ] Configure a supported OpenAI Platform `OPENAI_API_KEY`, or confirm an official subscription-scoped speech surface and its terms.
- [ ] Grant separate personal consent for model and/or transcription scope.
- [ ] Run a non-sensitive model/STT canary and confirm model availability, rate limits, retry behavior, and retention settings.
- [ ] Revoke the test credential and confirm the app immediately returns to an activation-required state.

### xAI/Grok credentials and speech

Status: `XAI_API_KEY` and a consent-gated, versioned `~/.grok/auth.json` OIDC adapter are implemented for xAI Responses LLM and REST batch STT. The adapter re-reads only the short-lived bearer for every request, validates expiry, and never reads refresh material. On 2026-07-16 the user-supplied OIDC credential was live-verified against model discovery, one LLM response, and one batch transcription. That proves the observed credential worked for those calls; it is not a documented promise that every Grok consumer token authorizes the public API. No credential value or attached auth file is committed.

External activation checklist for a release credential:

- [ ] Sign in with a fresh Grok client account or configure `XAI_API_KEY` outside the repository.
- [ ] Grant explicit personal consent for each scope that will be used.
- [ ] Confirm the account/provider terms permit the intended model and speech use, including retention and regional handling.
- [ ] Run non-sensitive model and batch-STT canaries, then test expiry, re-login, and revocation.
- [ ] Remove the temporary validation credential and verify no secret appears in logs, browser responses, Git, snapshots, or packaged files.

Streaming WebSocket STT, automatic login/refresh, and Grok CLI model delegation are in-repository work, not external blockers.

### OAuth application registrations

Status: third-party OAuth callback, state/PKCE, token storage, refresh, logout, and provider login UI are not implemented. Registration becomes an external gate only after those local flows exist and a provider offers a suitable public desktop-client contract.

Activation checklist for each implemented provider flow:

- [ ] Register Ultradyn Docs under the organization and approve exact loopback/deep-link redirects for CLI and Tauri.
- [ ] Put public client configuration in release config and keep all confidential material outside Git.
- [ ] Complete state/PKCE, cancellation, denial, expiry, refresh, revocation, and logout tests on every target OS.
- [ ] Publish privacy, retention, support, and account-deletion disclosures before enabling the login button.

### Claude and OpenCode account activation (after local adapters exist)

Status: installed-client/environment discovery exists, but neither source can currently produce an executable Ultradyn model provider. The adapter/login work is listed above; credentials alone cannot activate it.

Activation checklist after implementation:

- [ ] Install and sign in to the documented owning CLI, or configure a supported provider API key outside the repository.
- [ ] Grant model-scope consent without granting unrelated scopes.
- [ ] Run non-sensitive model-discovery, structured-output, cancellation, expiry, and rate-limit canaries.
- [ ] Disconnect/revoke the source and confirm local fake workflows remain available and no token was copied into Ultradyn state.

### Google account/project activation (after local adapters exist)

Status: no Google credential source, OAuth flow, model adapter, or STT adapter is implemented. A registered project cannot activate the current code.

Activation checklist after implementation:

- [ ] Register a Google desktop OAuth client and exact loopback/deep-link redirects.
- [ ] Enable the selected model/Speech-to-Text APIs, scopes, billing, quotas, and regional data policy.
- [ ] Grant model and transcription consent independently.
- [ ] Test stream interruption, retry, confidence metadata, expiry, logout, and revocation with non-sensitive fixtures.

### GitHub authorization and repository roles

Status: local change requests, a deterministic fake Git host, `gh`-delegated polling, durable cursor/head tracking, and a `gh pr create` primitive are implemented. End-to-end remote review actions and publication remain in-repository work. Live use then requires the acting user to have appropriate repository authorization.

Activation checklist:

- [ ] Install and authorize GitHub CLI for the target repository with least privilege.
- [ ] Confirm the origin resolves to the intended `github.com/owner/repository` and test with a disposable PR.
- [ ] Verify branch protection, review identity, force-push behavior, and rate-limit handling under the real repository policy.
- [ ] Revoke authorization and confirm local-only change requests still work.

### Native Tauri builds and signing

Status: desktop source/config and repository-selection tests are present. On 2026-07-17 this Linux host ran the crate with Cargo 1.97.0 and all 11 tests passed without a lockfile. The declared Rust 1.77.2 minimum and `--locked` build remain unverified because `Cargo.lock` is not committed. Signing identities and clean target machines are also external.

Activation checklist:

- [ ] Install the Tauri v2 prerequisites and stable Rust on Linux, macOS, and native Windows.
- [ ] Generate/commit the lockfile, run `cargo test --locked` in `tauri-app/src-tauri`, then `pnpm tauri:build` on every target.
- [ ] Verify explicit repository selection/persistence, pinned-package startup, `/api/health`, `/api/runtime`, and nonce-owned `/api/desktop-readiness` rejection, one-time session bootstrap, child-tree cleanup, microphone, filesystem, and loopback permissions.
- [ ] Configure Apple signing/notarization and Windows code-signing certificates.
- [ ] Run signed clean-machine install, update, and uninstall tests.

### Canonical tmux snapshot execution (activated in CI)

Status: GitHub Actions [run 7](https://github.com/ultradyn/docs/actions/runs/29464696553) installed tmux 3.4 and passed the canonical harness at 40×18, 80×24, and 120×36 after multiple artifact review-and-fix loops. On 2026-07-17 this local Linux host passed the same matrix with tmux 3.7b while Fish was the configured/default shell and every pane launched explicit `/bin/bash`; no snapshots were updated.

Verified checklist:

- [x] Install tmux 3.3 or newer on Ubuntu 24.04 CI.
- [x] Run `pnpm test:tui` at 40×18, 80×24, and 120×36.
- [x] Inspect plain, ANSI, full-history, cursor, resize, cancellation, and terminal-cleanup artifacts.
- [x] Prove Bash/POSIX harness commands do not depend on the configured/default Fish shell.
- [x] Accept snapshot changes only after the three review passes recorded in `code/cli/test/VISUAL_REVIEW.md`.

### Browser and OS hardware matrix

Status: server audio durability and limited browser-hook failure cases are automated. GitHub Actions [run 7](https://github.com/ultradyn/docs/actions/runs/29464696553) installed Chromium and passed the checked-in server-backed flow, including personal actor persistence, live demo-server verification, Ask submission, durable question retrieval, and final UI state. This local execution image has no browser binary, and its 2026-07-16 download attempts returned a zero-byte/truncated CDN archive. Real microphone/device behavior and clean-OS verification still require hardware runners; there is not yet a complete deterministic browser-media suite.

Activation checklist after the missing browser tests are implemented:

- [x] Run `pnpm exec playwright install --with-deps chromium`, then `pnpm test:e2e` in CI with the browser version pinned by the current lockfile.
- [ ] Run Chromium, Firefox, and WebKit capture tests with grant, denial, revocation, sleep, network loss, and device removal.
- [ ] Exercise native Linux and macOS browsers plus the packaged webviews.
- [ ] Exercise native Windows desktop and WSL-hosted server/browser interoperability.
- [ ] Verify FFmpeg installation or a packaged/licensed codec strategy on every target.

### Source-template upgrades

Status: intentionally deferred by ADR 0003; not required for initial installation or operation.

Activation checklist:

- [ ] Define a three-way merge manifest for user-modified copied source.
- [ ] Implement dry-run, conflict reporting, rollback, and version-skipping tests.
- [ ] Demonstrate that an upgrade never overwrites user changes silently.

### `web-artisan-sol`

Status: the named skill was not available in this execution environment or the supplied bundle.

Activation checklist:

- [ ] Provide/install `.codex/skills/web-artisan-sol/` from an auditable source.
- [ ] Run its prescribed audit against `code/web/`.
- [ ] Record material changes in a UI review note without replacing accessibility or browser tests.
