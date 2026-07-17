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

- Domain/repository tests use real temporary directories and one shared parity harness over corpora for every shipped portable schema: question records, provenance events, and raw-artifact manifests. Every field is represented, including strict nested records, nonempty and bounded strings, safe-integer boundaries, ASCII and astral UTF-16 boundary lengths, duplicate goals, duplicate asker IDs, depth rules, raw manifest paths/bytes/digests, and explicit-offset date-time cases. The harness invokes the shipped generic `createPortableSchemaValidator`, not test-only AJV registration. Rejection recovery repeats the same asker/reason across later merged attempts and injects a crash after immutable publication to prove distinct revision-scoped exactly-once events. Local change-request tests use real local Git repositories and isolated worktrees, including schema-version-1 active/merged fixtures, non-conflicting legacy refs, concurrent identical/different inputs, recovery at every creation persistence/cleanup checkpoint, pre-journal zero-mutation rejection of invalid prior identities/fingerprints/state, zero-mutation rejection of unowned metadata/ref/worktree collisions, forged merge intent across direct/restarted get/list/merge paths, an interposed Git command that moves the attempt ref after validation, exact-merge restart after the attempt ref moves, rejection of an authorized-parent commit with a forged result tree, fingerprint-bound retry/supersession, reopened multi-attempt history, and dirty-worktree preservation. Installer tests deterministically inject `.gitignore` owner replacement in the last precommit window, edits through held displaced inodes before and after the final read, multiple occupied/symlink recovery names, post-publication failure after recovery-claim removal, edits before rollback, and reordered duplicate owner rules around the UUID-marked managed block; they prove every failure restores or visibly preserves the owner inode and removes hidden installer state while rollback removes only installer-owned content.
- Repository audio tests cover ordered durable chunk acknowledgements, adoption of byte-identical unmanifested bytes after metadata failure, conflicting retry rejection, a crash immediately after advanced metadata publication followed by byte replacement/restart, no-follow append-journal reads, a forged post-ack journal against an external symlink, deterministic fifth-descriptor-stat pathname replacement with metadata rollback, schema-v1 active/finalizing/cleaned migration, migration tamper/symlink rejection, bounded FIFO rejection in a child process, directory/socket rejection, verified conversion, and raw retention on transcode failure.
- Server tests use Fastify injection across routes and local services, including lifecycle, settings, provider consent, maintenance persistence, and audio finalization.
- Agent tests cover dynamic definition loading, input projection, fresh invocation IDs, schema validation, and bounded retry. Fixture validation checks each input shape and expected-output schema; it does not execute every golden pair through a real/current model.
- Provider tests cover consent-gated discovery, generic fakes, Codex delegation, OpenAI/xAI request shaping, Grok auth-file parsing, and GitHub head/ETag mapping.
- Browser-hook tests cover active-recorder cleanup on unmount, device-track termination, and MediaRecorder error cleanup.
- Playwright currently builds the package, starts a demo server, persists and reloads the personal actor setting, submits one Chromium Ask flow, verifies the stored question through the server, and checks the final UI state. It does not exercise Answer, the wider settings surface, maintenance, microphone/media, failure recovery, Firefox, or WebKit.
- The package smoke test creates a tarball, invokes that tarball through `npx`, checks required generated files and `git check-ignore` for `.ultradyn/staging/`, installs the generated target, runs typecheck/Vitest/build, starts its built server, waits for `/api/health`, and terminates it.
- Tauri repository-selection and HTTP-identity tests are written in Rust. They require `cargo test` on a machine with the Tauri prerequisites; no native build runs in current CI.

## TUI snapshot rule

Vitest compares committed plain and ANSI renderer snapshots at 40, 80, and 120 columns. When tmux 3.3+ is present, the PTY harness starts every pane with explicit `/bin/bash --noprofile --norc`, independently configures tmux's default shell (Fish when installed), drives the actual CLI with `send-keys`, captures prompt/final/error/resize/cancellation states, checks visible widths and escape sequences, and verifies terminal-mode cleanup. ANSI cases explicitly remove an inherited `NO_COLOR` before applying their color contract. When tmux is absent the harness records `SKIP_TMUX_MISSING` and exits successfully, so that result must not be reported as a PTY pass.

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
