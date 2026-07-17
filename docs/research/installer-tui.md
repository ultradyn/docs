# Installer TUI research

Reviewed: 2026-07-16

## Decision

Use [`@clack/prompts`](https://bomb.sh/docs/clack/packages/prompts/) for the short interactive installer, with a pure initialization plan and a separate line-oriented renderer for non-TTY, `TERM=dumb`, very narrow, and explicit `--plain` use. Clack's own [best-practices guide](https://bomb.sh/docs/clack/guides/best-practices/) fits this flow: progressive disclosure, useful defaults, clear labels, validation, and one task at a time.

Ink remains a good option for a future persistent full-screen terminal client, but it adds a React renderer and state lifecycle that a linear initializer does not need. OpenTUI's rich renderer and memory-frame tests are attractive, but its documented [runtime requirements](https://opentui.com/docs/getting-started/) are currently Bun-first and require Node 26.4 plus experimental FFI for the native Node path. That is too restrictive for a broad `npx` installer.

## Rendering contract

- Node 22 or newer.
- One owner of raw terminal input.
- Detect TTY and width; listen for resize; use terminal-default backgrounds.
- Respect `NO_COLOR`, `NODE_DISABLE_COLORS`, and `FORCE_COLOR`.
- Status is expressed in text as well as color/symbols, with ASCII fallback.
- Ctrl+C unwinds normally, restores terminal state, and exits 130.
- Dynamic spinner labels remain short. The open [Clack narrow-terminal spinner issue](https://github.com/bombshell-dev/clack/issues/132) is covered by width and resize snapshots.
- `--dir`, `--yes`, `--plain`, and `--no-color` make automation deterministic.

Width-aware project copy uses [`string-width`](https://github.com/sindresorhus/string-width) and [`wrap-ansi`](https://github.com/chalk/wrap-ansi), rather than counting code units.

## tmux regression harness

The canonical Ubuntu suite follows tmux's documented [`send-keys` behavior](https://github.com/tmux/tmux/wiki/Advanced-Use#sending-keys) and [`capture-pane` options](https://man7.org/linux/man-pages/man1/tmux.1.html):

1. Use an isolated `tmux -L` server, configure its default shell to Fish when available, and launch every test pane explicitly with `/bin/bash --noprofile --norc`.
2. Create exact 40×18, 80×24, and 120×36 panes; assert the configured default and explicit pane start command independently.
3. Poll captures for prompt text rather than sleeping blindly.
4. Send arbitrary input with literal `send-keys -l`; send Enter separately.
5. Capture visible plain, visible ANSI, and full unjoined history at each meaningful state.
6. Record pane dimensions, cursor/alternate-screen state, exit status, and terminal state before/after.
7. Remove inherited `NO_COLOR` only in cases whose contract explicitly requires ANSI or `NODE_DISABLE_COLORS`, and kill the isolated server in `finally`.

macOS and Windows/WSL are smoke-tested, not byte-snapshot compared with Ubuntu. Snapshot updates require separate happy-path, stress/resize, and accessibility/cleanup review passes.
