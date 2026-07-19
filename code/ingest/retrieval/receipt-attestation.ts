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

import type { SearchReceipt } from "../../domain/ingest/search-receipt.js";
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
    Object.keys(receipt.filters ?? {})
      .sort()
      .map((key) => [key, (receipt.filters as Record<string, unknown>)[key]]),
    [...receipt.candidateIds].sort(),
    [...receipt.selectedIds].sort(),
    [...receipt.failures].sort(),
  ]);
  return createHash("sha256").update(canonical).digest("hex") as Sha256;
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

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
    typeof a.payloadSha256 === "string" &&
    a.payloadSha256.length === 64 &&
    typeof a.proof === "string" &&
    a.proof.length > 0 &&
    a.proof.length <= RECEIPT_ATTESTATION_LIMITS.maxProofChars
  );
}

// ---------------------------------------------------------------------------
// Attest / verify
// ---------------------------------------------------------------------------

export async function attestSearchReceipt(
  authority: SearchReceiptAttestationAuthority,
  receipt: SearchReceipt,
): Promise<IngestResult<AttestedSearchReceipt, ReceiptAttestationError>> {
  if (typeof receipt !== "object" || receipt === null) {
    return failure("RECEIPT_INVALID");
  }
  const payloadSha256 = receiptPayloadDigest(receipt);
  const issued = await authority.attest(payloadSha256);
  if (!issued.ok) return failure("AUTHORITY_UNAVAILABLE");

  // Bind the issued attestation to the payload we actually digested. An
  // authority returning a mismatched commitment is not trusted on its word.
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
