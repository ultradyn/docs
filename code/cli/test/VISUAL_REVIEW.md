# Installer terminal visual review

Reviewed on 2026-07-17 against committed plain and ANSI renderer captures at exact 40×18, 80×24, and 120×36 terminal sizes, plus fresh executable captures from tmux 3.7b on a Linux host whose configured/default shell is Fish. The ANSI fixtures store escape bytes as visible `\x1b` tokens so color boundaries remain reviewable in ordinary Git diffs. The executable tmux harness uses the same three pane sizes and captures destination, confirmation, completion, cancellation, cursor, and terminal-mode states when tmux 3.3+ is available.

## Pass 1 — wrapping and density

Findings:

- The 40-column tagline retained a leading space after wrapping.
- The nominal ASCII fallback still used a Unicode middle dot.
- A 120-column card expanded across the entire terminal and became visually sparse.

Fixes:

- Enabled whitespace trimming at renderer wrap boundaries.
- Added an ASCII `;` separator when Unicode is unavailable.
- Capped cards at 88 columns while retaining exact 40- and 80-column layouts.

Result: no reviewed line exceeds its terminal width; narrow cards have balanced padding and wide cards remain scannable.

## Pass 2 — narrow-terminal hierarchy

Finding:

- The tagline was authored as two logical lines, creating an unnecessary four-line staircase at 40 columns.

Fix:

- Made the tagline one semantic line and let the width-aware renderer choose its breaks.

Result: the 40-column intro now reads as three balanced lines, and the destination remains visually separate from the explanation.

## Pass 3 — deterministic fallbacks and completion state

Finding:

- `--plain` and non-TTY modes could still inherit Unicode capability from the host locale, making otherwise stable CI/log output differ between machines.

Fix:

- Plain, non-TTY, `NO_COLOR`, and explicit `--no-color` fallbacks now select the ASCII renderer; the full Clack TUI retains Unicode and color when both are supported.

Checks:

- Plain captures contain no ANSI escapes or non-ASCII border/status glyphs.
- ANSI style spans close before padding, so frame alignment uses visible width rather than byte length.
- A standalone `NODE_DISABLE_COLORS=1` PTY case selects the unstyled fallback without requiring `NO_COLOR` or `--no-color`.
- Success cards distinguish initialized Git from preserved Git and show an immediately runnable `serve` command.
- The resize case drives an actual tmux `resize-window` from 80×24 to 40×18 and back, checks the kernel SIGWINCH layout, then cancels cleanly.
- The deterministic destination-error case preserves the blocking file, leaves no transaction directory, emits no ANSI in plain mode, returns exit 1, and does not claim success.
- The standalone Ctrl+C case returns exit 130, creates no repository files, and restores the original `stty` mode.
- Every case validates pane dimensions, cursor bounds, visible line width, malformed escape tails, shell return, and terminal cleanup.
- Snapshot text contains none of the common corruption markers (`undefined`, `[object Object]`, replacement characters, malformed CSI tails).

Artifacts:

- On success the harness publishes normalized captures and a status manifest under `code/cli/test/tmux/artifacts/` for CI upload/review.
- On failure it preserves the error stack plus full ANSI pane history for every live session before cleaning the private tmux socket.
- The artifact directory ignores generated captures/status; Git retains only its `.gitignore` policy while CI uploads each run's artifacts.

Result: accepted for the deterministic renderer suite. PTY execution remains environment-gated when tmux is unavailable; `code/cli/test/tmux/run.mjs` records `SKIP_TMUX_MISSING` and the exact activation command in that case. On this tmux-capable host it executed all six width/mode combinations, standalone `NODE_DISABLE_COLORS`, resize, deterministic error, and Ctrl+C cancellation cases.

## Pass 4 — configured-shell isolation

Finding:

- tmux inherited the host's configured Fish shell while the harness sent Bash/POSIX commands, so `$?` failed before the installer ran.

Fixes:

- Launch every tmux session with explicit `/bin/bash --noprofile --norc` while retaining Fish as tmux's configured default shell for the test.
- Assert both the configured default shell and the pane start command before sending installer input.
- Remove inherited `NO_COLOR` explicitly from ANSI and standalone `NODE_DISABLE_COLORS` cases; plain cases continue to set `NO_COLOR=1` deliberately.

Result: the 2026-07-17 run passed all nine captures plus cancellation with `tmux_default_shell=/bin/fish` and `session_shell=/bin/bash`. The 40-, 80-, and 120-column plain/ANSI captures, resize history, error path, cancellation path, cursor bounds, shell exit codes, and terminal restoration were inspected. No snapshot update was needed.
