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

Even a successful compare-and-swap retains the displaced inode at the visible, deterministic `<filename-without-leading-dot>.ultradyn-recovery-<device>-<inode>` path before removing private transaction links. This is an intentional recovery artifact, not installer-owned temporary state: an editor holding the old inode may still write after the installer's final read, so Ultradyn Docs never removes that recovery pathname automatically. Operators may inspect, reconcile, and then remove it explicitly. A name collision fails closed and preserves the displaced inode at a visible conflict-suffixed recovery path. If later installation work fails, rollback removes only the exact managed block from the current file; owner-added identical rules, reordered rules, and later edits remain byte-for-byte. Repeat runs remain idempotent when the managed rule is already present and do not create another recovery file.
