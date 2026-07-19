import { createHash } from "node:crypto";

import {
  digestPolicyApprovalPayload,
  type PolicyApprovalAttestation,
  type PolicyApprovalPayload,
} from "../../domain/ingest/index.js";

import type {
  AttestationIssueResult,
  AttestationVerifyResult,
  PolicyAttestationAuthority,
} from "./policy-service.js";

/**
 * Test-only seam.
 *
 * Fault and capability injection for the approval store, and a deterministic
 * attestation authority, live here so they never reach the package barrel.
 * Production callers construct the store through `createFilePolicyApprovalStore`
 * and must inject a REAL attestation authority; there is deliberately no
 * production default, and this fake is never exported from `index.ts`.
 */
export type { PolicyApprovalCapabilities } from "./policy-approval-store.js";
export { createFilePolicyApprovalStore as createFilePolicyApprovalStoreForTests } from "./policy-approval-store.js";

export interface FakeAttestationAuthority extends PolicyAttestationAuthority {
  /** Advance the authority revision, as a key rotation would. Attestations
   * issued under an earlier revision no longer verify. */
  rotate(): void;
  /** Revoke a specific actor's eligibility, retroactively. Their existing
   * attestations stop verifying. */
  revoke(actor: string): void;
  /** Make the authority unreachable, as an outage would. */
  setUnavailable(unavailable: boolean): void;
}

export interface FakeAttestationAuthorityOptions {
  authorityId: string;
  eligible(actor: string): boolean;
}

/**
 * Deterministic stand-in for a real attestation authority.
 *
 * The proof is a keyed digest over (authorityId, revision, payloadSha256) using
 * a fake-internal secret. This is NOT a production scheme — it exists so tests
 * can distinguish a genuine attestation from a forged, transplanted, or stale
 * one without a real trust root. Because the payload digest already binds the
 * actor (`approvedBy`) and every other approval field, a proof over that digest
 * transitively binds them all: a transplant onto a different approver or a
 * mutated field changes the payload digest and the proof no longer matches.
 */
export function createFakeAttestationAuthority(
  options: FakeAttestationAuthorityOptions,
): FakeAttestationAuthority {
  const FAKE_SECRET = "fake-authority-secret-not-for-production";
  let revision = 1;
  let unavailable = false;
  const revoked = new Set<string>();

  function proofFor(revisionAt: number, payloadSha256: string): string {
    return createHash("sha256")
      .update(
        `${FAKE_SECRET}|${options.authorityId}|${revisionAt}|${payloadSha256}`,
        "utf8",
      )
      .digest("hex");
  }

  return {
    async attest(
      payload: PolicyApprovalPayload,
    ): Promise<AttestationIssueResult> {
      if (unavailable) return { ok: false, code: "AUTHORITY_UNAVAILABLE" };
      if (
        !options.eligible(payload.approvedBy) ||
        revoked.has(payload.approvedBy)
      ) {
        return { ok: false, code: "APPROVER_NOT_AUTHORIZED" };
      }
      const payloadSha256 = digestPolicyApprovalPayload(payload);
      return {
        ok: true,
        attestation: {
          version: 1,
          authorityId: options.authorityId,
          authorityRevision: revision,
          payloadSha256,
          proof: proofFor(revision, payloadSha256),
        },
      };
    },

    async verify(
      attestation: PolicyApprovalAttestation,
      payload: PolicyApprovalPayload,
    ): Promise<AttestationVerifyResult> {
      if (unavailable) return { ok: false, code: "AUTHORITY_UNAVAILABLE" };

      // Every mismatch is the same verdict: not authentic. The authority must
      // never leak which check failed, or an attacker learns how to shape the
      // next forgery.
      const payloadSha256 = digestPolicyApprovalPayload(payload);
      const genuine =
        attestation.authorityId === options.authorityId &&
        // A stale or rotated-past revision no longer stands.
        attestation.authorityRevision === revision &&
        // The envelope must commit to the payload we actually hold.
        attestation.payloadSha256 === payloadSha256 &&
        // The approver must still be eligible; revocation is retroactive.
        options.eligible(payload.approvedBy) &&
        !revoked.has(payload.approvedBy) &&
        // The proof must reproduce under the current revision.
        proofFor(revision, payloadSha256) === attestation.proof;

      return genuine
        ? { ok: true }
        : { ok: false, code: "APPROVAL_NOT_AUTHENTIC" };
    },

    rotate(): void {
      revision += 1;
    },

    revoke(actor: string): void {
      revoked.add(actor);
    },

    setUnavailable(value: boolean): void {
      unavailable = value;
    },
  };
}

/**
 * A schema-valid attestation ENVELOPE for store-level tests, which exercise
 * integrity (payload digest consistency) and never authenticity. It commits to
 * the payload but its proof is not a genuine authority proof — service-level
 * tests that need real authenticity use `createFakeAttestationAuthority`.
 */
export function integrityAttestation(
  payload: PolicyApprovalPayload,
): PolicyApprovalAttestation {
  return {
    version: 1,
    authorityId: "test-authority",
    authorityRevision: 1,
    payloadSha256: digestPolicyApprovalPayload(payload),
    proof: "integrity-envelope-not-a-genuine-proof",
  };
}
