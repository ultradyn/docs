# ADR 0002: Portable and local state

Status: accepted

## Context

“The whole system is one Git clone” conflicts with raw audio, credentials, personal preferences, OS keyrings, and runtime locks.

## Decision

Git contains all portable, non-secret project state: documentation, questions, raw text artifacts, structured answers, settings safe to share, agent definitions, committed projections, and change-request metadata.

Machine-local state contains raw/converted audio, secrets, consent receipts that reveal credential locations, personal preferences, provider cursors, locks, caches, and machine indexes. It lives under the platform data/config directories and is addressed by a stable repository ID.

Credential sources return opaque capability handles or delegate to an installed client. They never copy secret material into the repository. Reading even the existence/metadata of a known credential file is consent-gated.

## Consequences

A clone is intended to reconstruct all collaborative knowledge while requiring each machine to re-authorize private capabilities. Backups of raw audio and external credentials remain an operator responsibility.

## Implementation status

Documentation, questions, raw text, answers, project settings, agents, and question projections are portable. Change-request/review records currently live in the machine-local data directory, so a clone does not yet reconstruct that workflow state. Settings also does not yet surface the local data path or backup/transcode inventory. Both gaps are tracked in `BLOCKED_TASKS.md`.
