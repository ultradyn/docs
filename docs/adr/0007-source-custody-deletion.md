# ADR 0007: Authorised source-custody deletion versus append-only portable history

Status: proposed (requires Max's ratification per DECISION_LOG D9/C12 before acceptance)

## Context

The ingestion design requires a deletion workflow (bundle SEC-005, `10-security-privacy-and-source-custody.md` §8): authorization and legal-hold checks, dependency-closure calculation, erasure of permitted representations, provider deletion requests, downstream invalidation, and a signed deletion certificate. The repository's standing invariants say raw artifacts are append-only and immutable (ADR 0001) and Git history is the portable, authoritative record (ADR 0002/0004). Without reconciliation these conflict: a rights-driven purge cannot coexist with "nothing is ever deleted," and DESIGN.md C12 therefore blocks every deletion task (execution home: backlog T-10-04) until this ADR exists.

## Decision target

Distinguish three custody classes with different deletion semantics:

1. **Machine-local replay bytes (deletable).** Replay capsules, caches, derived indexes, and extraction representations live outside Git in the machine-local data directory. Authorised deletion physically erases them. This never touches portable history. A capsule deletion makes affected snapshots non-replayable; dependent promotions are revoked by invalidation, not by history rewriting.
2. **Portable logical records (never physically deleted in the ordinary lane).** Claims, questions, evidence verdicts, answers, documents, and provenance in Git are superseded or marked `withdrawn`/`stale` — append-only tombstones with reasons — so audit history remains intact. The deletion certificate references tombstones, not absence.
3. **Sensitive content that entered portable history (exceptional lane).** If prohibited/sensitive source text was committed, ordinary deletion is insufficient; the existing repository incident/history-remediation procedure applies (bundle §7 concurs). This is a human-run, Max-authorised operation outside agent authority; agents may only detect, quarantine, and file the incident.

Deletion authority: a deletion request requires an authorised human actor and recorded legal-hold check; agents cannot originate or approve deletions (SEC-003 least privilege). The deterministic service computes the dependency closure across source units, evidence, claims, answers, documents, and exports; erases class-1 bytes; writes class-2 tombstones and invalidation events through the graph gateway; and issues a content-addressed deletion certificate recording actor, reason, closure, method, and residuals (e.g., "portable tombstones retained; history remediation not required").

Retention default until Max sets policy (D9): retain everything (append-only), no automatic expiry.

## Consequences

T-10-04 can implement deletion without violating ADR 0001/0002: physical erasure is confined to machine-local custody, portable history stays append-only via tombstones, and the rare history-rewrite case is an explicit human incident procedure rather than a feature pathway. Deletion certificates make omission auditable. The cost: "deleted" source content may remain recoverable from portable history unless the exceptional lane is invoked — this is a deliberate trade favouring auditability, and rights-holders requiring true erasure must trigger the incident lane.

## Implementation status

Proposed only; no implementation. Gates backlog T-10-04 (blocked until this ADR is accepted and Max ratifies the retention default). Cross-referenced from DESIGN.md C12, DECISION_LOG (deferred-features register), and BLOCKED_TASKS "Automatic ingestion (v3)".
