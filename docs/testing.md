# Testing strategy

Tests target the public seams in `docs/engineering/tdd-seams.md`. Ordinary CI must remain credential-free; live-provider calls are manual activation canaries, not substitutes for deterministic tests.

## Commands and actual scope

```sh
pnpm test           # Vitest unit/integration suites
pnpm test:coverage  # the same suites with V8 coverage
pnpm test:tui       # renderer tests, then tmux harness when tmux 3.3+ exists
pnpm test:e2e       # one Chromium Playwright Ask flow
pnpm test:package   # pack, npx init, install/typecheck/test/build, then health-check serve
pnpm check          # typecheck + lint + Vitest + root integrity scripts + builds
```

`pnpm check` does not run Playwright, tmux, the package smoke test, Cargo tests, or native Tauri builds. Its integrity commands run at the product root, not against generated question history. The checked-in GitHub Actions workflow additionally installs tmux/Chromium and runs `pnpm test:tui`, `pnpm test:e2e`, and `pnpm test:package`.

## Covered seams

- Domain/repository tests use real temporary directories; local change-request tests use real local Git repositories and isolated worktrees.
- Repository audio tests cover ordered durable chunk acknowledgements, byte-identical retry, verified conversion, and raw retention on transcode failure.
- Server tests use Fastify injection across routes and local services, including lifecycle, settings, provider consent, maintenance persistence, and audio finalization.
- Agent tests cover dynamic definition loading, input projection, fresh invocation IDs, schema validation, and bounded retry. Fixture validation checks each input shape and expected-output schema; it does not execute every golden pair through a real/current model.
- Provider tests cover consent-gated discovery, generic fakes, Codex delegation, OpenAI/xAI request shaping, Grok auth-file parsing, and GitHub head/ETag mapping.
- Browser-hook tests cover active-recorder cleanup on unmount, device-track termination, and MediaRecorder error cleanup.
- Playwright currently builds the package, starts a demo server, persists and reloads the personal actor setting, submits one Chromium Ask flow, verifies the stored question through the server, and checks the final UI state. It does not exercise Answer, the wider settings surface, maintenance, microphone/media, failure recovery, Firefox, or WebKit.
- The package smoke test creates a tarball, invokes that tarball through `npx`, checks required generated files, installs the generated target, runs typecheck/Vitest/build, starts its built server, waits for `/api/health`, and terminates it.
- Tauri repository-selection and HTTP-identity tests are written in Rust. They require `cargo test` on a machine with the Tauri prerequisites; no native build runs in current CI.

## TUI snapshot rule

Vitest compares committed plain and ANSI renderer snapshots at 40, 80, and 120 columns. When tmux 3.3+ is present, the PTY harness drives the actual CLI with `send-keys`, captures prompt/final/error/resize/cancellation states, checks visible widths and escape sequences, and verifies terminal-mode cleanup. When tmux is absent the harness records `SKIP_TMUX_MISSING` and exits successfully, so that result must not be reported as a PTY pass.

Every accepted TUI change records three review passes in `code/cli/test/VISUAL_REVIEW.md`: width/density; resize/error/cancel stress; and color/Unicode/accessibility/cleanup. Plain captures, ANSI captures, full pane history, pane metadata, and terminal cleanup should be reviewed together on canonical Ubuntu 24.04.

## Additional release checks

Run the integrity commands against a representative generated repository until CI has a history-bearing fixture, and run Cargo on each native build host:

```sh
pnpm exec tsx code/repository/check-raw.ts <generated-repository> [base-ref]
pnpm exec tsx code/repository/check-projections.ts <generated-repository>
pnpm test:e2e
cd tauri-app/src-tauri && cargo test
```

The remaining browser/media matrix, provider canaries, representative integrity fixture, and native OS matrix are listed with exact completion/activation steps in `BLOCKED_TASKS.md`.
