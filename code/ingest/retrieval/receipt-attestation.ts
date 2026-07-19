/**
 * T-30-04 — Receipt authenticity.
 *
 * THE GAP THIS CLOSES. A SearchReceipt proves INTEGRITY (it is self-consistent)
 * and NOT AUTHENTICITY (a real tool invocation produced it). receiptIdFor is a
 * public content hash over caller-known inputs — snapshot id, index version,
 * corpus digest, query, filters, candidate/selected ids. No secret, no key. So
 * anyone who knows the snapshot and index identity can compute a structurally
 * valid receipt id for a search that never ran, and every schema check will
 * pass. Raising the forgery bar is not the same as closing the hole.
 *
 * WHAT THIS PROVIDES.
 * SCOPE OF THE CLAIM. "Bound to a real tool invocation" holds only as strongly
 * as the injected authority and the wiring around it. This module makes the
 * binding CHECKABLE and makes bypass a type error; it cannot by itself prove an
 * invocation happened, and under the deterministic test fake it proves nothing
 * about the world. Enforcement at the product boundary is a separate wiring
 * step, tracked with the FR proposal — do not read this file as closing the
 * Researcher forgery path end to end.
 *
 * - AttestedSearchReceipt: structurally distinct from SearchReceipt, so a
 *   hand-written receipt CANNOT be passed where an attested one is required.
 *   The distinction is a type-level brand plus a runtime guard, not a comment.
 * - SearchReceiptAttestationAuthority: attest/verify, mirroring
 *   PolicyAttestationAuthority (code/ingest/policy/policy-service.ts). Reusing
 *   that shape is deliberate — it is the repo's established integrity/
 *   authenticity split and reviewers already accept its semantics.
 *
 * FAIL-CLOSED, ALWAYS. A missing, unavailable, or unknown authority yields
 * AUTHORITY_UNAVAILABLE or RECEIPT_NOT_AUTHENTIC — never a pass. An outage must
 * never widen trust: verification of a genuine attestation ALSO refuses while
 * the authority cannot be consulted, because "we cannot check" is not "it is
 * fine". This matches policy-gate's re-verify-on-every-call discipline.
 *
 * DIVISION OF RESPONSIBILITY. This module guarantees: shape validation,
 * payload binding (anti-transplant, checked here before delegating), and
 * faithful propagation of the authority's verdict including unavailability.
 * It does NOT independently adjudicate trust roots — refusing a foreign
 * authorityId is the injected authority's obligation, matching the policy
 * layer's split. A production authority MUST reject unknown roots; this module
 * cannot do it for them and does not pretend to.
 *
 * THE ATTESTATION COMMITS TO THIS PAYLOAD. payloadSha256 is a canonical digest
 * over the receipt's own fields, so an attestation cannot be transplanted onto
 * a different receipt. Whether the proof is genuine is the injected verifier's
 * question — this module supplies the integrity half and delegates authenticity,
 * exactly as policy-approval.ts documents for approvals.
 *
 * SCOPE / HONEST RESIDUAL.
 * - There is NO production trust root here and none is invented. The only
 *   implementation is a deterministic fake for local tests (retrieval/testing.ts,
 *   off the public barrel). It cannot satisfy production activation, matching
 *   the posture recorded for the policy authority: exercise the control path
 *   now, defer real crypto.
 * - No normative requirement currently mandates receipt authenticity. The spec
 *   (FR-RET-005, FR-EV-001, FR-EV-007) requires a receipt to be present, valid,
 *   passing, sufficiently broad — all satisfiable by a structurally valid
 *   forgery. Proposed FR language is in docs/proposals/, NOT applied to the
 *   normative spec, because that is an operator decision.
 */
import { createHash } from "node:crypto";

import {
  canonicalizeSearchFilters,
  type SearchReceipt,
} from "../../domain/ingest/search-receipt.js";
import type { IngestResult, Sha256 } from "../../domain/ingest/types.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const RECEIPT_ATTESTATION_LIMITS = Object.freeze({
  /** Opaque proof bound, mirroring PolicyApprovalAttestation. */
  maxProofChars: 4_096,
  maxAuthorityIdChars: 256,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SearchReceiptAttestation = {
  readonly version: 1;
  readonly authorityId: string;
  readonly authorityRevision: number;
  /** Commits the proof to THIS receipt payload (anti-transplant). */
  readonly payloadSha256: Sha256;
  /** Opaque to this module; meaning belongs to the injected authority. */
  readonly proof: string;
};

declare const attestedBrand: unique symbol;

/**
 * A receipt bound to a real tool invocation.
 *
 * The brand makes the distinction STRUCTURAL: a bare SearchReceipt does not
 * satisfy this type, so a caller cannot accidentally pass an unattested receipt
 * where authenticity is required. Without the brand, "production MUST inject
 * tool-emitted receipts" is only a comment, and comments do not fail builds.
 */
export type AttestedSearchReceipt = SearchReceipt & {
  readonly attestation: SearchReceiptAttestation;
  readonly [attestedBrand]: true;
};

export type ReceiptAttestationError =
  | "RECEIPT_INVALID"
  | "RECEIPT_NOT_AUTHENTIC"
  | "AUTHORITY_UNAVAILABLE";

export type AttestationIssueOutcome =
  | { readonly ok: true; readonly attestation: SearchReceiptAttestation }
  | { readonly ok: false; readonly code: "AUTHORITY_UNAVAILABLE" };

export type AttestationVerifyOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "RECEIPT_NOT_AUTHENTIC" | "AUTHORITY_UNAVAILABLE";
    };

export interface SearchReceiptAttestationAuthority {
  attest(payloadSha256: Sha256): Promise<AttestationIssueOutcome>;
  verify(
    attestation: SearchReceiptAttestation,
    payloadSha256: Sha256,
  ): Promise<AttestationVerifyOutcome>;
}

// ---------------------------------------------------------------------------
// Fixed messages — never interpolate receipt text (query is untrusted)
// ---------------------------------------------------------------------------

const FIXED_MESSAGES: Record<ReceiptAttestationError, string> = {
  RECEIPT_INVALID: "Search receipt is not well formed.",
  RECEIPT_NOT_AUTHENTIC:
    "Search receipt is not bound to a real tool invocation.",
  AUTHORITY_UNAVAILABLE: "Receipt attestation authority is unavailable.",
};

function failure(
  code: ReceiptAttestationError,
): IngestResult<never, ReceiptAttestationError> {
  return Object.freeze({
    ok: false as const,
    code,
    message: FIXED_MESSAGES[code],
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) for (const item of value) deepFreeze(item);
    else for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Canonical payload digest
// ---------------------------------------------------------------------------

/**
 * Canonical digest over the receipt's own fields, in fixed order with
 * set-semantic arrays sorted. The attestation commits to this, so changing any
 * field after attestation invalidates the binding.
 */
export function receiptPayloadDigest(receipt: SearchReceipt): Sha256 {
  const canonical = JSON.stringify([
    "ultradyn.search-receipt.v1",
    receipt.schemaVersion,
    receipt.id,
    receipt.snapshotId,
    receipt.indexVersion,
    receipt.indexedRepresentationsSha256,
    receipt.query,
    // Use the DOMAIN canonicaliser, not a local key sort. A local sort only
    // orders top-level keys and leaves nested arrays in caller order, so two
    // semantically identical filter sets could digest differently — the
    // binding would be incomplete rather than wrong. The canonicaliser already
    // exists for exactly this; reimplementing it badly is how the two drift.
    canonicalizeSearchFilters(receipt.filters),
    [...receipt.candidateIds].sort(),
    [...receipt.selectedIds].sort(),
    [...receipt.failures].sort(),
  ]);
  return createHash("sha256").update(canonical).digest("hex") as Sha256;
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

/**
 * SHAPE PRECHECK — NOT A TRUST GATE. Read this before using it as one.
 *
 * The unique-symbol brand is erased at runtime, so this can only inspect the
 * attestation's shape. A hand-forged object with a plausible attestation field
 * WILL pass this check (verified adversarially). It exists to reject obviously
 * unattested input cheaply and to give the type guard a runtime counterpart.
 *
 * The ONLY authenticity gate is verifyAttestedSearchReceipt, which binds the
 * attestation to the payload and consults the authority. Anything that admits
 * evidence MUST call that, never this.
 */
export function isAttestedSearchReceipt(
  value: unknown,
): value is AttestedSearchReceipt {
  if (typeof value !== "object" || value === null) return false;
  const attestation = (value as { attestation?: unknown }).attestation;
  if (typeof attestation !== "object" || attestation === null) return false;
  const a = attestation as Partial<SearchReceiptAttestation>;
  return (
    a.version === 1 &&
    typeof a.authorityId === "string" &&
    a.authorityId.length > 0 &&
    a.authorityId.length <= RECEIPT_ATTESTATION_LIMITS.maxAuthorityIdChars &&
    typeof a.authorityRevision === "number" &&
    Number.isInteger(a.authorityRevision) &&
    a.authorityRevision > 0 &&
    typeof a.payloadSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(a.payloadSha256) &&
    typeof a.proof === "string" &&
    a.proof.length > 0 &&
    a.proof.length <= RECEIPT_ATTESTATION_LIMITS.maxProofChars
  );
}

// ---------------------------------------------------------------------------
// Attest / verify
// ---------------------------------------------------------------------------

/**
 * Minimal structural validation BEFORE digesting.
 *
 * receiptPayloadDigest spreads candidateIds/selectedIds/failures, so a
 * malformed input previously THREW a TypeError from inside the digest instead
 * of returning RECEIPT_INVALID. A throw escapes the IngestResult contract
 * entirely: callers written against {ok:false, code} never see it, so a
 * fail-closed API became a crash. RECEIPT_INVALID was effectively dead code.
 */
function isWellFormedReceipt(value: unknown): value is SearchReceipt {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<SearchReceipt>;
  return (
    r.schemaVersion === 1 &&
    typeof r.id === "string" &&
    typeof r.snapshotId === "string" &&
    typeof r.indexVersion === "string" &&
    typeof r.indexedRepresentationsSha256 === "string" &&
    typeof r.query === "string" &&
    typeof r.filters === "object" &&
    r.filters !== null &&
    Array.isArray(r.candidateIds) &&
    Array.isArray(r.selectedIds) &&
    Array.isArray(r.failures)
  );
}

export async function attestSearchReceipt(
  authority: SearchReceiptAttestationAuthority,
  receipt: SearchReceipt,
): Promise<IngestResult<AttestedSearchReceipt, ReceiptAttestationError>> {
  if (!isWellFormedReceipt(receipt)) {
    return failure("RECEIPT_INVALID");
  }
  const payloadSha256 = receiptPayloadDigest(receipt);
  const issued = await authority.attest(payloadSha256);
  if (!issued.ok) return failure("AUTHORITY_UNAVAILABLE");

  // Do not trust the authority's output on its word. Two separate checks:
  //
  // (a) SHAPE. A buggy or hostile authority can return ok:true with an empty
  //     proof or a blank authorityId. Validating only the payload binding
  //     would let that through and produce an "attested" receipt carrying a
  //     meaningless attestation — which later verifies as garbage rather than
  //     failing here, where the cause is still visible.
  // (b) BINDING. The commitment must be to the payload WE digested, not one
  //     the authority chose.
  const candidateShape = { ...receipt, attestation: issued.attestation };
  if (!isAttestedSearchReceipt(candidateShape)) {
    return failure("RECEIPT_NOT_AUTHENTIC");
  }
  if (issued.attestation.payloadSha256 !== payloadSha256) {
    return failure("RECEIPT_NOT_AUTHENTIC");
  }

  const attested = {
    ...receipt,
    attestation: issued.attestation,
  } as AttestedSearchReceipt;
  return Object.freeze({ ok: true as const, value: deepFreeze(attested) });
}

export async function verifyAttestedSearchReceipt(
  authority: SearchReceiptAttestationAuthority,
  candidate: AttestedSearchReceipt,
): Promise<IngestResult<"verified", ReceiptAttestationError>> {
  // Shape first: an unattested receipt cast into place must be refused before
  // the authority is consulted at all.
  if (!isAttestedSearchReceipt(candidate)) {
    return failure("RECEIPT_NOT_AUTHENTIC");
  }
  // Shape-valid attestation is not enough to digest safely: the RECEIPT half
  // must also be well formed or the digest throws. Refuse rather than crash.
  if (!isWellFormedReceipt(candidate)) {
    return failure("RECEIPT_INVALID");
  }
  const payloadSha256 = receiptPayloadDigest(candidate);

  // Anti-transplant: the attestation must commit to THIS payload. Checked
  // before the authority call so a re-pointed proof cannot even be presented.
  if (candidate.attestation.payloadSha256 !== payloadSha256) {
    return failure("RECEIPT_NOT_AUTHENTIC");
  }

  const verified = await authority.verify(candidate.attestation, payloadSha256);
  if (verified.ok) return Object.freeze({ ok: true as const, value: "verified" as const });
  return failure(verified.code);
}
