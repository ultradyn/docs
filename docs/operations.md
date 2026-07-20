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
loading protected API state. After a server restart, stale-session API requests
and the event stream re-establish the session automatically. Settings retains
an explicit connection link for switching to a different server origin. If a
connection drops during a settings write, the form keeps its unsaved values;
save again after the connection recovers.

If another machine must reach the service, prefer an SSH tunnel. A wildcard bind is refused unless each accepted public hostname is supplied explicitly, for example `--host 0.0.0.0 --allowed-host docs.internal.example`. `--allow-origin` admits an additional exact browser origin but does not provide identity, authorization, or TLS. Put any remote listener behind an authenticating TLS proxy and a deployment-specific threat review.

Maintainer mode can also be enabled while the server is running from Settings. Disabling it stops scheduled polling; changing the poll interval currently requires a server restart.

Before doing human-attributed work, set **Settings → Identity & attribution → Actor handle** to a canonical personal handle such as `alex.review-1`. Missing or unreadable personal identity fails closed: claims, priority overrides, local approvals, and merges remain disabled. A merged answer offers accept/reject controls only to the configured handle matching one of its pending asker IDs. Changing the handle affects future actions only; it never rewrites provenance. The value is not a login and must not be used as an authorization boundary.

## Machine-local data and backups

Git contains portable knowledge and repo-scoped settings. Raw/converted audio, personal settings (including the actor handle), consent receipts, worktrees, local change-request records, maintenance cursors, Ultradyn-owned OAuth tokens, and other machine state live outside the repository.

The local data directory is keyed by the first 16 hexadecimal characters of the SHA-256 of the resolved repository path:

| Platform | Base directory                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------- |
| Linux    | `$XDG_DATA_HOME/ultradyn-docs/repositories/<id>` or `~/.local/share/ultradyn-docs/repositories/<id>` |
| macOS    | `~/Library/Application Support/ultradyn-docs/repositories/<id>`                                      |
| Windows  | `%APPDATA%\ultradyn-docs\repositories\<id>`                                                          |

Notable paths under that directory include `oauth/oauth-tokens.json` (Ultradyn-owned OAuth access/refresh tokens for `xai-oauth` / `openai-oauth`, file mode 0600). A backup of the data directory includes these tokens — treat them as secret material and never copy them into Git, logs, fixtures, or package output.

Back up that directory if local audio, OAuth session state, or review state must be retained. Treat `oauth/oauth-tokens.json` as secret material and never copy it into Git. The current Settings page does not display its path or a transcode inventory; that UI work is tracked in `BLOCKED_TASKS.md`. Environment variables and installed-client credentials remain under their owning environment/client; Ultradyn OAuth tokens live in this data directory. Disconnect on an OAuth source revokes the requested Ultradyn consent and clears Ultradyn-owned tokens for that flow; it does not revoke tokens at the identity provider.

## Recovery

- Installer `.gitignore` recovery: before publishing a managed `.gitignore`, the installer hard-links the still-visible owner inode beside it as `gitignore.ultradyn-recovery-<device>-<inode>`. Occupied files, directories, and symlinks use `-conflict-<transaction-token>[-<attempt>]`; after 64 exclusive claim failures the install aborts before displacement. If publication later fails, the installer restores that inode to `.gitignore` when the pathname is still installer-owned. If a concurrent owner occupies `.gitignore`, it remains untouched while the displaced inode is claimed again at a collision-safe visible recovery path; a removed recovery claim is not trusted, late descriptor writes remain reachable, and no hidden CAS pathname is a recovery dependency. The visible recovery file is intentional and is never automatically removed after success because an editor may still hold and modify that inode. Inspect and reconcile it with `.gitignore`, then remove it manually only when those bytes are no longer needed. Do not alter collision occupants. Re-running an already initialized repository does not create another recovery file.
- Interrupted repository mutation: restart the operation. The repository lock is machine-local and keyed to the canonical repository path, so it never becomes portable Git state. Raw append writes a Git-ignored adjacent pending file, atomically publishes it, and then atomically replaces the manifest; retry adopts a byte-identical published artifact or replaces an incomplete pre-publication file. A different unmanifested payload fails closed.
- Interrupted matched-ask attachment: retry with the original base revision and exact payload. Before publishing either immutable question/chat artifact, Ultradyn Docs atomically stores their reserved paths and payload digest in its private machine-local operation journal. A changed payload at that revision fails closed; a matching retry reuses each manifested artifact and completes the record, provenance, and index exactly once. Valid record mutations made after the interruption are preserved and the recovered attachment is layered onto their current revision; an impossible revision rewind fails closed. The base revision is part of the portable operation marker, so an identical ask intentionally submitted at a later revision remains a new operation.
- Interrupted asker rejection: retry the same asker and reason. The journal binds the immutable reason path to the merged question revision; restart publishes and reopens exactly once. Reusing the same asker/reason on a later merged attempt produces a different operation identity and a second immutable artifact rather than being confused with the earlier event.
- Interrupted change-request creation: restart and read or retry the request. A machine-local lock and pre-mutation journal reconcile worktree creation, proposal commit, new metadata, prior supersession, and journal cleanup before records are returned. If the journaled worktree contains tracked or untracked changes, recovery stops and preserves every byte for manual resolution. Legacy `ultradyn/<question-id>` refs are left untouched; new work uses `ultradyn-attempts/<change-request-id>`.
- Queue projection mismatch: use `KnowledgeRepository.repairQueueProjections()` through a maintenance script/test until a supported CLI command exists.
- Question-index drift: run `pnpm exec tsx code/repository/check-projections.ts <repository>`. This checks `questions/index.jsonl`; it does not regenerate documentation `_map.md` files.
- Raw-integrity concern: run `pnpm exec tsx code/repository/check-raw.ts <repository> [base-ref]`.
- Failed audio metadata write: if the next-sequence chunk bytes already exist but are not in session metadata, retry with the exact same bytes. Ultradyn adopts a byte-identical regular file through a nonblocking, no-follow descriptor and rejects different bytes, special files, or a pathname replacement without advancing sequence. The session-local `append-intent.json` is securely created and read as a stable no-follow regular file; its transition-derived operation ID and integrity digest must match the pending identity in schema-v2 session metadata. Restart may roll back only that exact pending transition. Committed metadata clears the pending identity before acknowledgement, so a journal created or replaced afterward cannot roll back an acknowledged chunk. Descriptor reads and stats finish first, then a sequential no-follow pathname observation is the final filesystem operation before acknowledgement; a swap restores prior metadata and returns an error. Schema-v1 sessions migrate on read only after every retained chunk passes stable inode/size/digest checks. Completed historical sessions with raw cleanup remain readable. Acknowledged chunks remain on disk after a failed transcode and the session can be finalized again after the codec is fixed. Verified output and cleanup intent are persisted before raw deletion; a restart resumes interrupted cleanup without retranscoding. Do not delete the local session directory first. A session refuses uploads beyond 128 MiB or 10,000 chunks before creating the rejected chunk file.
- Provider outage: deterministic fakes remain visible for explicit demo/test workflows, but production Critic and merge evaluation fails closed until a production model provider is selected. Fake output must not be represented as the expert's real answer or authorize a merge.
- Integration conflict or stale review: the merge aborts without claiming success. A changed proposal head or portable base content requires recreation and fresh review. Current question/chat/ordered goals/answer/stored proposed files always pass through the fingerprint-aware ensure seam; identical input reuses the request, while changed input creates an `ultradyn-attempts/<change-request-id>` branch and marks the prior active attempt superseded. The prior worktree is deliberately retained so uncommitted user bytes are never discarded. Version-1 records remain visible, but if exact historic evaluator input is unavailable they fail closed until recreated. Before mutation, merge authorization records a canonical result tree calculated from immutable prepared-base and reviewed-branch commits and binds it into the authorization digest. Only the pre-mutation path validates the mutable attempt ref, then Git receives persisted `branchHeadSha`, never the branch name. If Git successfully created the reviewed merge before metadata or cleanup failed, retry: reconciliation first verifies current HEAD's exact ordered parents and exact result tree, then completes metadata and managed-worktree cleanup even if the attempt ref later moved. A forged two-parent tree or unrelated HEAD fails closed without metadata advance, cleanup, or reset. A failed Git merge restores only the exact authorized base/reviewed result and never force-resets unrelated HEAD. Manually reconcile/recreate other isolated-branch conflicts; automatic rebase-and-replan is still unfinished.
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
