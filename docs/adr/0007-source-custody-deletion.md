# ADR 0007: Authorised source-custody deletion versus append-only portable history

Status: proposed

Accepting this ADR records **architecture only**. It confers no authority to erase anything. D9 ratification is **not** a prerequisite for accepting the architecture, but it **is** mandatory — together with every capability gate below — before any destructive execution.

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

**Git history is distributed, and the inventory must say so.** The expected custody inventory for class 3 explicitly covers clones, forks, remotes, reflogs, mirrors, CI caches and artifacts, and backups. Copies that cannot be reached are recorded as residual or unknown — which means **true erasure cannot be claimed** for content that reached a distributed history. Remediating the origin repository is necessary, never sufficient.

### Authority and the immutability boundary

A deletion request requires an authorised human actor and a recorded legal-hold check. Agents cannot originate or approve deletions (SEC-003 least privilege).

Ordinary custody stays immutable. `RawArtifactStore` and `ReplayCapsuleStore` keep **no** delete, erase, purge, or unlink member; T-10-04 must not add one. Authorised erasure is a **separate, consented, human-authorised capability** — the sole named exception to the append-only rule — carrying its own expected-custody-revision check, legal-hold decision, immutable dependency-closure snapshot, two-phase freeze → erase → certificate sequence with defined recovery, and explicit idempotency and crash semantics. DESIGN §3's statement that the system "never makes immutable raw bytes deletable" should be read as scoped to ordinary custody stores, with this capability cross-referenced as the exception; DESIGN and this ADR are to be updated together so the two do not appear to contradict.

### Capability gates: acceptance does not unlock erasure

Accepting this ADR and ratifying D9 do **not** by themselves permit physical deletion. The workflow depends on producers that may not exist yet — the graph/validity gateway, the invalidation path, provider adapters, and a certificate signer. Deletion is therefore **fail-closed on capability**: if any required producer is missing, unavailable, or of unknown status, no erasure proceeds.

Backlog task **T-10-04 includes destructive implementation and a deletion drill, and remains blocked** — accepting this ADR does not open it, rescope it, or license any part of it to begin. Destructive execution requires all of: an accepted ADR, ratified D9 retention policy, and every required producer and adapter present with deterministic fake cases covering their failure modes. If non-destructive framework work is wanted earlier, it must be a **separately scoped future task**, not a quiet reinterpretation of T-10-04.

### Execution protocol: crash and idempotency semantics

Deletion is irreversible, so the protocol names exactly where reversibility ends — and that point is **not** an authorisation record but the first real destruction.

**PREPARE (reversible).** Establish an authorised actor and a recorded legal-hold decision. Compute both the exact dependency closure **and** a complete *expected* custody inventory — every object, replica, provider, key, and Git location. Validate and revalidate expected custody and policy revisions, the legal hold, and every capability gate. Acquire a deterministic lock. Persist a durable operation intent/journal with a stable operation ID and per-target sub-operation IDs. Freeze affected use. **No erasure begins until the journal and freeze are durable and revalidated.**

**EXECUTE (attempts destruction).** Persist the `execution-authorised` marker **only after** that final revalidation. The marker authorises attempts; **it is not itself irreversible.** If a crash occurs after the marker but before any confirmed destructive side effect, recovery may safely close or cancel the operation — but only after *proving* none occurred, provider reconciliation included.

Perform each target operation under its stable sub-operation ID, durably recording the request *before* the call and the outcome or receipt *after* it, so a crash between the two is detectable rather than invisible. Retries **query and reconcile** provider state; they never assume a prior call succeeded.

**The irreversible boundary is the first CONFIRMED destructive side effect** — a confirmed object erasure or key destruction. From that moment recovery must continue, reconcile, and finalise, and may **never** present the operation as untouched.

A provider call whose outcome is **unknown** is treated as potentially irreversible: the freeze stays in place, the outcome must be reconciled before any retry or cancellation, and the operation may claim neither "no side effect" nor completeness.

**FINALISE.** Always apply fail-closed invalidation and quarantine. Append portable tombstones where applicable. Reconcile every item in the expected inventory. Produce the signed certificate and evidence. Only then unfreeze unaffected scope and close the journal.

**Crash recovery** resumes from the journal and verifies every recorded transition. When an operation ends partial, affected content **remains frozen and invalid**; a partial certificate is permitted and a complete certificate is forbidden.

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

**Signature envelope.** The certificate is wrapped in a versioned canonical envelope carrying: schema version, algorithm, signer identity, key ID, trust-root and policy version, signed payload digest, signature, and signing time. This ADR does not pick a vendor or key, but the contract fields and the trust policy are mandatory, and **verification, rotation, and revocation rules are a required signer-adapter gate** — an adapter without them does not satisfy the capability gate.

**Expected, not merely observed.** The signed payload carries the **complete expected custody inventory** (as both digest and list) with per-object, per-replica, per-provider, and per-key outcomes — not only the targets that happened to be visited. An inventory that silently omits what was never reached is how a deletion comes to look complete when it is not.

**Completeness predicate.** A certificate may claim completeness only when *every* expected item is confirmed either erased or permissibly retained, with **no residual, no unknown, no outstanding class-3 remediation**, all invalidations and tombstones confirmed, and the signature verified. Any unknown outcome forbids a completeness claim; the result is a partial certificate.

**Portable projection versus protected evidence.** A **non-secret redacted projection** is the canonical Git audit state: actor and authority reference, closure and inventory digests, policy version, outcome summary, residual and unknown flags, and the signer envelope — and no sensitive locations or secrets. The full evidence, provider receipts, and location detail stay in protected machine-local or approved external audit custody, linked by content digest under governed retention. Portability is **never** claimed when the underlying evidence is unavailable.

### Cryptographic erasure

Destroying a key counts as erasure **only** when key exclusivity is verified — that no backup, escrow copy, replica, or provider-held copy of the key survives, and that no plaintext replica of the data exists. Otherwise the affected data is recorded as a residual or unknown, not as erased.

### Retention default

Until Max sets policy (D9): retain everything, append-only, no automatic expiry.

## Consequences

Accepting this ADR settles the architecture and **unlocks no work**. T-10-04 stays blocked as scoped. Physical erasure is confined to class-1 custody objects across every replica; portable history stays append-only via tombstones; and removal of source text from Git is an explicit human incident procedure rather than a feature pathway. Deletion certificates make omission auditable, including what was *not* erased.

The cost is stated plainly: **"deleted" source content generally remains recoverable from portable Git history unless the class-3 exceptional lane is invoked.** This is a deliberate trade favouring auditability. Rights-holders requiring true erasure of text in Git must trigger the incident lane, and any process that promises erasure while writing only tombstones is misrepresenting what happened.

## Open question for ratification (D9)

Max to decide: retention schedules, the legal bases for retention, retention classes, and how legal holds are recorded and released. The interim default of retain-indefinitely stands until then.

## Implementation status

Proposed only; no implementation. Accepting this ADR records architecture and starts nothing.

Backlog **T-10-04 remains blocked as currently scoped** — it includes destructive implementation and a deletion drill, so it requires an accepted ADR **and** ratified D9 **and** every capability gate satisfied. Acceptance alone must not be read as licence to begin it, and it must not be quietly rescoped into framework-only work; that would need a separate, explicitly non-destructive task.

Cross-referenced from DESIGN.md C12, DECISION_LOG (D9 and the deferred-features register), BLOCKED_TASKS "Automatic ingestion (v3)", and the R0/R1 implementation plan's T-10-04 section.
