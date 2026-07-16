# ADR 0003: Package and generated repositories

Status: accepted

## Context

The installer must initialize documentation scaffolding “including the code,” while future npm releases also need a practical upgrade path.

## Decision

`@ultradyn/docs` is both the runnable package and canonical source. The installer copies a versioned source snapshot (`code/`, `tauri-app/`, project skills, schemas, and starter data) into the target repository for inspection and customization. The generated repository records the originating package version in `.ultradyn/manifest.json`.

Normal operation may run the installed package with `npx @ultradyn/docs serve <repo>`, so the copied source does not need dependencies immediately. A future `upgrade` command will perform a three-way source-template migration; it is not needed for the first release and is tracked explicitly.

## Consequences

Generated repositories satisfy inspectability and can fork the application. Normal users avoid an immediate dependency install. Updating copied application source requires an explicit migration rather than silent overwrite.
