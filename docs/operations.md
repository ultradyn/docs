# Operations

## Local server

Run from an initialized documentation repository, or pass its path explicitly:

```sh
npx @ultradyn/docs serve
npx @ultradyn/docs serve ./network-docs --maintainer --no-open
```

The maintainer flag is `--maintainer` (not `--maintenance`). The server binds
`127.0.0.1` by default. Open the printed URL directly; the served web client
establishes its local HttpOnly session through a marked same-origin POST before
loading protected API state. Settings retains an explicit connection link for
recovering from a wrong or changed server origin.

If another machine must reach the service, prefer an SSH tunnel. A wildcard bind is refused unless each accepted public hostname is supplied explicitly, for example `--host 0.0.0.0 --allowed-host docs.internal.example`. `--allow-origin` admits an additional exact browser origin but does not provide identity, authorization, or TLS. Put any remote listener behind an authenticating TLS proxy and a deployment-specific threat review.

Maintainer mode can also be enabled while the server is running from Settings. Disabling it stops scheduled polling; changing the poll interval currently requires a server restart.

Before doing human-attributed work, set **Settings → Identity & attribution → Actor handle** to a canonical personal handle such as `alex.review-1`. Missing or unreadable personal identity fails closed: claims, priority overrides, local approvals, and merges remain disabled. A merged answer offers accept/reject controls only to the configured handle matching one of its pending asker IDs. Changing the handle affects future actions only; it never rewrites provenance. The value is not a login and must not be used as an authorization boundary.

## Machine-local data and backups

Git contains portable knowledge and repo-scoped settings. Raw/converted audio, personal settings (including the actor handle), consent receipts, worktrees, local change-request records, maintenance cursors, and other machine state live outside the repository.

The local data directory is keyed by the first 16 hexadecimal characters of the SHA-256 of the resolved repository path:

| Platform | Base directory                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------- |
| Linux    | `$XDG_DATA_HOME/ultradyn-docs/repositories/<id>` or `~/.local/share/ultradyn-docs/repositories/<id>` |
| macOS    | `~/Library/Application Support/ultradyn-docs/repositories/<id>`                                      |
| Windows  | `%APPDATA%\ultradyn-docs\repositories\<id>`                                                          |

Back up that directory if local audio or review state must be retained. The current Settings page does not display its path or a transcode inventory; that UI work is tracked in `BLOCKED_TASKS.md`. Credential values remain under their owning environment/client and must not be copied into this backup.

## Recovery

- Interrupted repository mutation: restart the operation. The repository lock is machine-local and keyed to the canonical repository path, so it never becomes portable Git state. Raw append writes a Git-ignored adjacent pending file, atomically publishes it, and then atomically replaces the manifest; retry adopts a byte-identical published artifact or replaces an incomplete pre-publication file. A different unmanifested payload fails closed.
- Interrupted matched-ask attachment: retry with the original base revision and exact payload. Before publishing either immutable question/chat artifact, Ultradyn Docs atomically stores their reserved paths and payload digest in its private machine-local operation journal. A changed payload at that revision fails closed; a matching retry reuses each manifested artifact and completes the record, provenance, and index exactly once. Valid record mutations made after the interruption are preserved and the recovered attachment is layered onto their current revision; an impossible revision rewind fails closed. The base revision is part of the portable operation marker, so an identical ask intentionally submitted at a later revision remains a new operation.
- Queue projection mismatch: use `KnowledgeRepository.repairQueueProjections()` through a maintenance script/test until a supported CLI command exists.
- Question-index drift: run `pnpm exec tsx code/repository/check-projections.ts <repository>`. This checks `questions/index.jsonl`; it does not regenerate documentation `_map.md` files.
- Raw-integrity concern: run `pnpm exec tsx code/repository/check-raw.ts <repository> [base-ref]`.
- Failed transcode: acknowledged chunks remain on disk and the failed session can be finalized again after the codec is fixed. Verified output and cleanup intent are persisted before raw deletion; a restart resumes an interrupted cleanup without retranscoding. Do not delete the local session directory first. A session refuses uploads beyond 128 MiB or 10,000 chunks before creating the rejected chunk file.
- Provider outage: switch future work to the deterministic fake only for workflow testing. Fake output must not be represented as the expert's real answer.
- Integration conflict or stale review: the merge aborts without claiming success. A changed proposal head or portable base content requires recreation and fresh review. Manually reconcile/recreate the isolated branch; automatic rebase-and-replan is still unfinished.
- Invalid agent output: the runtime makes bounded fresh attempts and then fails the operation. It does not currently create a durable maintenance finding for the rejected output.

## Maintainer mode

Scheduled polling starts immediately, then uses the configured fixed interval with an in-process overlap guard. Maintenance state is atomically persisted outside Git. The GitHub CLI provider stores an opaque cursor containing its last ETag and known PR head SHAs; unchanged `304` responses create no tasks. A changed head reopens the stable task as a re-review.

When `review.checkpointCommits` is disabled and Git reports uncommitted managed state below `questions/` or `settings/`, Maintenance shows one **Checkpoint pending portable state** task and includes it in the pending-checkpoint count. The task identifies the affected portable roots and path count. It is status, not a change request, so the UI does not offer a misleading review action; commit those paths manually, or enable checkpoint commits before the next approved local merge. The task disappears when no managed paths remain pending.

Current limitations are explicit: the provider reads only the first 100 open PRs, has no application-level rate-limit backoff, does not filter by the local reviewer's identity, and does not yet turn tasks into remote review actions. Those are in-repository tasks in `BLOCKED_TASKS.md`.

A server credential may discover work but must not submit an opinion as another user. Use the acting reviewer's own delegated GitHub authorization for any future review action.

## Release checks

From the product repository:

```sh
pnpm check
pnpm test:e2e
pnpm test:tui
pnpm test:package
pnpm pack --dry-run
```

For a representative generated repository, also run the raw-history and question-projection checks shown under Recovery. `pnpm check` runs those scripts at the product root; the checked-in CI workflow separately runs tmux, the single Chromium Playwright flow, and the packed-package smoke test.

When Rust/Tauri prerequisites are available:

```sh
cd tauri-app/src-tauri && cargo test
cd ../../ && pnpm tauri:build
```

Run Tauri builds on Linux, macOS, and native Windows. WSL is supported for the browser server; the Windows desktop artifact must be built and tested outside WSL. Signing/notarization and clean-machine tests remain external release gates in `BLOCKED_TASKS.md`.
