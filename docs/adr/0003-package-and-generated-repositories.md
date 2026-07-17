# ADR 0003: Package and generated repositories

Status: accepted

## Context

The installer must initialize documentation scaffolding “including the code,” while future npm releases also need a practical upgrade path.

## Decision

`@ultradyn/docs` is both the runnable package and canonical source. The installer copies a versioned source snapshot (`code/`, `tauri-app/`, project skills, schemas, and starter data) into the target repository for inspection and customization. The generated repository records the originating package version in `.ultradyn/manifest.json`.

Normal operation may run the installed package with `npx @ultradyn/docs serve <repo>`, so the copied source does not need dependencies immediately. A future `upgrade` command will perform a three-way source-template migration; it is not needed for the first release and is tracked explicitly.

## Consequences

Generated repositories satisfy inspectability and can fork the application. Normal users avoid an immediate dependency install. Updating copied application source requires an explicit migration rather than silent overwrite.

## Implementation status

Initialization copies the full ignore template for a new destination. When merging into an existing repository, it preserves the existing `.gitignore` and adds `.ultradyn/staging/` exactly once inside a UUID-marked `ultradyn-docs managed staging ignore` block using the file's newline convention. The private lock serializes cooperating installers, while correctness against editors that ignore that lock comes from a link/rename version-token commit: the current path is displaced without destroying its bytes, compared again at the commit boundary, and restored/retried if it changed. No unseen version is overwritten. Any owner version observed after displacement is moved to an explicit non-hidden preservation file before retry, so cleanup never unlinks its only pathname based on a prior identity observation. If a held displaced inode and the visible path both change, installation preserves both and fails closed.

Even a successful compare-and-swap retains the displaced inode at a visible recovery path. Before the owner pathname is displaced or the managed file can appear, the installer exclusively hard-links that still-visible inode to `<filename-without-leading-dot>.ultradyn-recovery-<device>-<inode>`. An occupied file, directory, or symlink advances through the documented `-conflict-<transaction-token>[-<attempt>]` family; every claimed candidate is checked by device and inode. Claims are bounded at 64 attempts, and exhausting them aborts before mutation while the owner file remains at its original pathname. The claimed link is revalidated against the displaced inode after the final byte inspection and before private transaction links are removed.

The recovery file is intentional, not installer-owned temporary state: an editor holding the old inode may still write after the installer's final read, so Ultradyn Docs never removes that recovery pathname automatically. Operators may inspect, reconcile, and then remove it explicitly. Every exception after displacement or managed-file publication runs owner recovery before returning: if the current pathname is still installer-owned, the displaced inode is restored there; if a concurrent owner occupies it, that owner stays untouched and the displaced inode is exclusively linked at a freshly claimed visible recovery candidate. A removed or raced recovery claim is never treated as proof, collision and symlink occupants are skipped, late descriptor writes remain reachable, and private CAS names are removed. If later installation work fails, rollback removes only the exact managed block from the current file; owner-added identical rules, reordered rules, collision occupants, and later edits remain byte-for-byte. Repeat runs remain idempotent when the managed rule is already present and do not create another recovery file.
