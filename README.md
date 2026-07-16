# Ultradyn Docs

Ultradyn Docs turns real questions into durable, reviewable documentation. It answers from a Git repository when the knowledge exists; when it does not, it records the exact gap, lets an expert answer by voice, checks that answer against the asker's goals, and proposes the resulting documentation as a diff.

## Install a documentation repository

```sh
npx @ultradyn/docs
```

The installer asks where to create the repository, preserves existing Git repositories, and initializes Git when needed. For automation or terminals without interactive support:

```sh
npx @ultradyn/docs init --dir ./network-docs --yes --plain
```

## Start the browser app

From the generated repository:

```sh
npx @ultradyn/docs serve
```

The local server prints and normally opens its browser URL. It binds to loopback by default and gives a directly opened browser an HttpOnly local session. A wildcard bind is refused unless every accepted hostname is supplied with `--allowed-host`; remote deployments still require an authenticating TLS proxy. Generic fake model, transcription, codec, and Git-host providers are available without credentials. They exercise the main local paths, but the provider-specific failure matrix and several release workflows remain in [`BLOCKED_TASKS.md`](./BLOCKED_TASKS.md).

Open Settings once and set the personal **Actor handle** before claiming questions, overriding priority, or approving changes. Ultradyn records that stable handle in provenance and only shows asker acceptance controls when it matches the pending asker. This is inspectable attribution for a trusted team, not login or authentication.

## Develop this repository

Requires Node.js 22.13+ or 24+ and pnpm.

```sh
pnpm install
pnpm check
pnpm dev
```

TUI snapshots additionally require tmux. The Tauri wrapper requires the [Tauri v2 platform prerequisites](https://v2.tauri.app/start/prerequisites/).

## Core guarantees

- Portable non-secret state is readable text in Git.
- Verbatim questions, transcripts, corrections, and rejection reasons are immutable.
- Missing information is logged per declared goal; the model does not guess through it.
- Ordinary depth is deferred breadth-first; contradictions remain P1 blockers.
- Reviewer, diff summary, and simulated-asker checks run in isolated contexts.
- External calls require explicit consent for the exact provider scope, and generic deterministic fakes keep the supported capability boundaries locally testable.

The original design provenance is retained in [`.plan/`](./.plan/). Unfinished implementation work and external activation gates are explicit in [`BLOCKED_TASKS.md`](./BLOCKED_TASKS.md).
