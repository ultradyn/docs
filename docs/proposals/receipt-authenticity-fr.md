# Proposal: normative requirement for search-receipt authenticity

**Status: PROPOSED — not applied to the normative specification.**
Author: coordinator (T-30-04). Requires operator (Max) ratification before any
edit to `docs/specs/automatic-ingestion-v3/source-bundle/15-project-specification.md`.

## Why this proposal exists

T-30-04 implements receipt authenticity (`code/ingest/retrieval/receipt-attestation.ts`).
While scoping it, a gap surfaced that is worth stating plainly:

**No normative requirement currently mandates receipt authenticity.** The
existing requirements ask only that a receipt be present and well formed:

| ID | Current text (paraphrased) | Satisfied by a forgery? |
|---|---|---|
| FR-RET-005 | Every Researcher outcome MUST contain a search receipt | Yes |
| FR-EV-001 | The Researcher MUST emit ... a search receipt | Yes |
| FR-EV-007 | A no-evidence result MUST be ... supported by a passing receipt | Yes |

Every one of those is satisfied by a **structurally valid receipt for a search
that never ran**. That is not a drafting oversight to be fixed silently — it is
a scope decision, which is why this is a proposal rather than an edit.

## The underlying fact

`receiptIdFor` is a public content hash over caller-known inputs (snapshot id,
index version, corpus digest, query, filters, candidate/selected ids). There is
no secret and no key. Anyone who knows the snapshot and index identity can
compute a valid receipt id for any query and any result set.

So a `SearchReceipt` proves **integrity** (self-consistency) and not
**authenticity** (a real tool invocation produced it). The repository already
articulates exactly this distinction for policy approvals
(`code/domain/ingest/policy-approval.ts`), and this proposal reuses that framing.

## Proposed requirement

> **FR-RET-00x** — A search receipt admitted as evidence MUST be bound to a real
> tool invocation by an attestation that commits to that receipt's payload.
> A receipt that is unattested, whose attestation does not commit to its payload,
> or whose attesting authority cannot be consulted, MUST be refused. Absence of a
> verifiable binding MUST fail closed and MUST NOT be reported as corpus absence.

Notes on the wording:
- "commits to that receipt's payload" is what makes transplanting an attestation
  onto a different receipt a violation rather than a curiosity.
- "cannot be consulted ... MUST be refused" makes an authority outage fail
  closed. An outage must never widen trust.
- The final clause mirrors FR-RET-005's existing service-failure rule, so a
  refusal is never laundered into "the corpus had nothing".

## What is already implemented (and what is not)

Implemented in T-30-04:
- `AttestedSearchReceipt` — structurally distinct from `SearchReceipt`, so an
  unattested receipt cannot be passed where authenticity is required. The
  distinction is a type brand plus a runtime guard, not a comment.
- `SearchReceiptAttestationAuthority` — attest/verify, mirroring
  `PolicyAttestationAuthority`, fail-closed on unavailable and unknown root.
- Payload-bound attestation, checked by the module itself before delegating, so
  transplant rejection does not depend on each authority remembering to check.

**Not implemented, deliberately:** any production trust root. The only
implementation is a deterministic fake for local tests, off the public barrel.
This matches the operator's 2026-07-19 direction on the policy authority —
exercise the control path now, defer real crypto, never let a fake be mistaken
for production.

## Decision requested

1. Adopt the FR (as worded, or amended), or
2. Record deliberately that receipt authenticity is out of scope for R1, in
   which case the implemented mechanism stays available but unenforced and the
   honest residual should be noted in `BLOCKED_TASKS.md`.

Either answer is workable. What should not persist is the current state, where
a mechanism exists with no requirement behind it — an unmotivated control is one
that a future task can drop without anyone noticing it was load-bearing.
