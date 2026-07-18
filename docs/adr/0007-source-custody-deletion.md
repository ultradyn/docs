# ADR 0007: Authorised source-custody deletion versus append-only portable history

Status: proposed (requires Max's ratification per DECISION_LOG D9 before acceptance)

## Context

The ingestion design requires a deletion workflow (bundle SEC-005, `10-security-privacy-and-source-custody.md` §8): authorization and legal-hold checks, dependency-closure calculation, erasure of permitted representations, provider deletion requests, downstream invalidation, and a signed deletion certificate. The repository's standing invariants say raw artifacts are append-only and immutable (ADR 0001) and Git history is the portable, authoritative record (ADR 0002/0004). Without reconciliation these conflict: a rights-driven purge cannot coexist with "nothing is ever deleted," and DESIGN.md C12 therefore blocks every deletion task (execution home: backlog T-10-04) until this ADR exists.

## Decision target

Distinguish three custody classes with different deletion semantics.

### Class 1 — Non-Git custody objects and representations (erasable)

Everything holding source bytes or derived representations **outside Git**: replay capsules, caches, derived indexes, extraction representations, organisation-controlled encrypted replicas, external storage locations, and portable escrow copies (bundle source custody §4). This class is deliberately **not** limited to a single machine — a copy in object storage or escrow is as much custody as one on a local disk, and a deletion that ignores it is not a deletion.

Authorised deletion physically erases these. Because the class spans locations, erasure is tracked **per replica, per provider, and per key**:

- Each location is verified independently and yields its own deletion outcome.
- Third-party providers yield a request acknowledgement, which is **not** the same as confirmed erasure. An unacknowledged or unverifiable provider request is recorded as an **unknown**, never as success.
- Any location that cannot be reached, verified, or proven erased is recorded as a **residual**.

Erasing class-1 objects never touches portable history. A capsule deletion makes affected snapshots non-replayable; dependent promotions are revoked by invalidation, not by rewriting history.

### Class 2 — Portable logical records (never physically deleted in the ordinary lane)

Claims, questions, evidence verdicts, answers, documents, and provenance in Git are superseded or marked `withdrawn`/`stale` — append-only tombstones with reasons — so audit history remains intact. The deletion certificate references tombstones, not absence.

**This lane does not erase anything.** A tombstone records that a record should no longer be relied upon; the bytes remain in Git history and remain readable by anyone with the repository.

### Class 3 — Source text that entered portable history (exceptional human lane)

ADR 0002 places raw text artifacts in Git. It follows that **exact source text and source excerpts committed to the repository are portable history, and class-2 tombstones do not erase them.** Any requirement to actually remove such text — a rights request over source content, or prohibited/sensitive material that reached a commit — is therefore class 3, not class 2. This is the single most consequential correction to make when reasoning about this ADR: marking a record `withdrawn` may satisfy an audit obligation but never satisfies an erasure obligation over text in Git.

Class 3 is a human-run, Max-authorised history-remediation procedure (bundle §7 concurs), outside agent authority. Agents may only detect, quarantine, and file the incident. Until remediation completes, dependent records are invalidated and the affected content is quarantined from further use.

### Authority and the immutability boundary

A deletion request requires an authorised human actor and a recorded legal-hold check. Agents cannot originate or approve deletions (SEC-003 least privilege).

Ordinary custody stays immutable. `RawArtifactStore` and `ReplayCapsuleStore` keep **no** delete, erase, purge, or unlink member; T-10-04 must not add one. Authorised erasure is a **separate, consented, human-authorised capability** — the sole named exception to the append-only rule — carrying its own expected-custody-revision check, legal-hold decision, immutable dependency-closure snapshot, two-phase freeze → erase → certificate sequence with defined recovery, and explicit idempotency and crash semantics. DESIGN §3's statement that the system "never makes immutable raw bytes deletable" should be read as scoped to ordinary custody stores, with this capability cross-referenced as the exception; DESIGN and this ADR are to be updated together so the two do not appear to contradict.

### Capability gates: acceptance does not unlock erasure

Accepting this ADR and ratifying D9 do **not** by themselves permit physical deletion. The workflow depends on producers that may not exist yet — the graph/validity gateway, the invalidation path, provider adapters, and a certificate signer. Deletion is therefore **fail-closed on capability**: if any required producer is missing, unavailable, or of unknown status, no erasure proceeds.

T-10-04 may build the framework once this ADR is accepted. **Destructive execution stays blocked** until every required producer and adapter exists, with deterministic fake cases covering their failure modes.

### Deletion certificate

The certificate is content-addressed and signed, with an explicit signer and trust boundary (which key signs, who holds it, and what the signature attests to). It records:

- the request, the authorising actor, and the basis of that authority;
- the legal-hold check and its outcome;
- an immutable dependency-closure snapshot and its digest;
- per-object and per-replica method, outcome, and any provider receipt;
- tombstones written and invalidations issued;
- residuals and unknowns, itemised;
- whether Git-history remediation is required (and therefore whether class-3 work remains outstanding);
- timestamps, policy version, idempotency key, and operation ID.

A certificate **may not claim completeness while any required outcome is unknown.** Partial or unverified erasure is reported as partial.

### Cryptographic erasure

Destroying a key counts as erasure **only** when key exclusivity is verified — that no backup, escrow copy, replica, or provider-held copy of the key survives, and that no plaintext replica of the data exists. Otherwise the affected data is recorded as a residual or unknown, not as erased.

### Retention default

Until Max sets policy (D9): retain everything, append-only, no automatic expiry.

## Consequences

T-10-04 **may implement a fail-closed deletion framework** once this ADR is accepted; destructive execution additionally requires ratified D9 retention policy and satisfied capability gates. Physical erasure is confined to class-1 custody objects across every replica; portable history stays append-only via tombstones; and removal of source text from Git is an explicit human incident procedure rather than a feature pathway. Deletion certificates make omission auditable, including what was *not* erased.

The cost is stated plainly: **"deleted" source content generally remains recoverable from portable Git history unless the class-3 exceptional lane is invoked.** This is a deliberate trade favouring auditability. Rights-holders requiring true erasure of text in Git must trigger the incident lane, and any process that promises erasure while writing only tombstones is misrepresenting what happened.

## Open question for ratification (D9)

Max to decide: retention schedules, the legal bases for retention, retention classes, and how legal holds are recorded and released. The interim default of retain-indefinitely stands until then.

## Implementation status

Proposed only; no implementation. Gates backlog T-10-04, which remains blocked until this ADR is accepted, D9 is ratified, and capability gates are satisfied. Cross-referenced from DESIGN.md C12, DECISION_LOG (deferred-features register), and BLOCKED_TASKS "Automatic ingestion (v3)".
