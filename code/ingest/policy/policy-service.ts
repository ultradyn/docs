import {
  DataRightsPolicyProfileSchema,
  canonicalDataRightsPolicyProfile,
  digestDataRightsPolicyProfile,
  type DataRightsPolicyProfile,
  type PolicyApproval,
  type PolicyApprovalAttestation,
  type PolicyApprovalPayload,
} from "../../domain/ingest/index.js";
import type { IngestResult } from "../../domain/ingest/types.js";

import type { PolicyApprovalStore } from "./policy-approval-store.js";

/**
 * The approval-ledger, attestation-bound view of a profile.
 *
 * A run is authorised by a record whose attestation an independent authority
 * verifies, never by a profile's own claim about itself and never by the
 * `approvedBy` label alone. The ledger is Git-visible, so a label is something
 * an attacker can write; only a proof the authority issued and still vouches for
 * distinguishes a genuine approval from a planted one.
 */
export type ApprovedPolicyProfile = PolicyApproval;

export type PolicyApprovalFailure =
  | "POLICY_UNAPPROVED"
  | "PROFILE_PROHIBITED"
  | "PROFILE_NOT_RUNNABLE"
  | "APPROVER_NOT_AUTHORIZED"
  | "APPROVAL_CONFLICT"
  | "APPROVAL_NOT_AUTHENTIC"
  | "AUTHORITY_UNAVAILABLE"
  | "INVALID_APPROVAL"
  | "CUSTODY_UNAVAILABLE";

export type AttestationIssueResult =
  | { ok: true; attestation: PolicyApprovalAttestation }
  | { ok: false; code: "APPROVER_NOT_AUTHORIZED" | "AUTHORITY_UNAVAILABLE" };

export type AttestationVerifyResult =
  | { ok: true }
  | { ok: false; code: "APPROVAL_NOT_AUTHENTIC" | "AUTHORITY_UNAVAILABLE" };

/**
 * The independent authority.
 *
 * `attest` confirms the payload's actor (`approvedBy`) is eligible AND binds a
 * proof to the exact payload during approval. `verify` re-checks, on every run
 * decision, that the proof is genuine and current for the exact payload read
 * back — the actor is carried in the payload (`approvedBy`) and bound by its
 * digest, so a transplant onto a different approver changes the payload and
 * fails. There is no permissive default: a missing authority yields
 * AUTHORITY_UNAVAILABLE, never a pass. This task defines the seam and a
 * deterministic test fake only; no production trust root, key, or signature
 * scheme is invented here.
 */
export interface PolicyAttestationAuthority {
  attest(payload: PolicyApprovalPayload): Promise<AttestationIssueResult>;
  verify(
    attestation: PolicyApprovalAttestation,
    payload: PolicyApprovalPayload,
  ): Promise<AttestationVerifyResult>;
}

function payloadOf(
  approval: Pick<
    PolicyApproval,
    | "schemaVersion"
    | "profileId"
    | "profileSha256"
    | "approvedBy"
    | "approvedAt"
    | "reason"
  >,
): PolicyApprovalPayload {
  return {
    schemaVersion: approval.schemaVersion,
    profileId: approval.profileId,
    profileSha256: approval.profileSha256,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    reason: approval.reason,
  };
}

export interface PolicyServiceDependencies {
  store: PolicyApprovalStore;
  /** Omitted or undefined means no authority is wired, and every run decision
   * fails closed with AUTHORITY_UNAVAILABLE rather than trusting a label. */
  authority: PolicyAttestationAuthority | undefined;
  now(): string;
}

export interface ApprovePolicyInput {
  profile: DataRightsPolicyProfile;
  actor: string;
  reason: string;
}

/**
 * Declarative policy only. There is deliberately no revoke, delete, or expire
 * member: authorised deletion is T-10-04, blocked on ADR 0007, ratified D9,
 * and every capability gate.
 */
export interface PolicyService {
  approve(
    input: ApprovePolicyInput,
  ): Promise<IngestResult<ApprovedPolicyProfile, PolicyApprovalFailure>>;
  assertRunAllowed(
    profileId: string,
  ): Promise<IngestResult<ApprovedPolicyProfile, PolicyApprovalFailure>>;
}

/**
 * A lint against obvious misconfiguration, NOT a control.
 *
 * The authority's eligibility check is the real gate. This pattern is a
 * denylist over an unbounded set of handles, so it catches `agent:x` and says
 * nothing about a handle that simply does not carry one of these prefixes. It
 * runs on a normalised string so invisible characters cannot walk past it.
 */
const AGENT_HANDLE = /^(agent|bot|service):/u;

/**
 * Strip invisibles and fold width FIRST, trim LAST.
 *
 * A zero-width space (U+200B) is not JS whitespace, so a leading one ahead of a
 * space would survive a leading `trim()` and shield that space, leaving the
 * `^`-anchored lint to miss. Removing invisibles and applying NFKC before the
 * trim means the value judged is exactly the value recorded.
 */
function normaliseActor(actor: string): string {
  return actor
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\u2060\ufeff]/gu, "")
    .trim();
}

export function createPolicyService(
  dependencies: PolicyServiceDependencies,
): PolicyService {
  const { store, authority, now } = dependencies;

  const assertRunAllowed = async (
    profileId: string,
  ): Promise<IngestResult<ApprovedPolicyProfile, PolicyApprovalFailure>> => {
    const found = await store.read(profileId);
    if (!found.ok) {
      // An outage is not a policy decision. Reporting it as POLICY_UNAPPROVED
      // would make a storage failure indistinguishable from a deliberate
      // refusal, so the distinct code survives to the caller.
      return { ok: false, code: found.code, message: found.message };
    }
    if (!found.value) {
      return {
        ok: false,
        code: "POLICY_UNAPPROVED",
        message: "no approval record exists for the requested policy profile",
      };
    }
    // Belt and braces over the store and the schema. Run authority is the last
    // gate a caller passes through, so the invariant is asserted here too
    // rather than trusted from the layer below.
    if (found.value.profile.dataRightsClass === "prohibited") {
      return {
        ok: false,
        code: "PROFILE_PROHIBITED",
        message: "material classified prohibited may never authorise a run",
      };
    }

    // Authenticity is decided here, on the record actually read back, on every
    // call. The digest gave integrity; only a proof the authority still vouches
    // for distinguishes a genuine approval from a planted one.
    if (!authority) {
      return {
        ok: false,
        code: "AUTHORITY_UNAVAILABLE",
        message: "no attestation authority is available to authorise a run",
      };
    }
    const verified = await authority.verify(
      found.value.attestation,
      payloadOf(found.value),
    );
    if (!verified.ok) {
      return {
        ok: false,
        code: verified.code,
        message:
          verified.code === "AUTHORITY_UNAVAILABLE"
            ? "the attestation authority could not be reached to authorise a run"
            : "the approval is not authentic and may not authorise a run",
      };
    }
    return { ok: true, value: found.value };
  };

  const approve = async ({
    profile,
    actor,
    reason,
  }: ApprovePolicyInput): Promise<
    IngestResult<ApprovedPolicyProfile, PolicyApprovalFailure>
  > => {
    if (reason.trim().length === 0) {
      return {
        ok: false,
        code: "INVALID_APPROVAL",
        message: "an approval requires a nonblank reason",
      };
    }

    const approver = normaliseActor(actor);
    if (approver.length === 0 || AGENT_HANDLE.test(approver.toLowerCase())) {
      return {
        ok: false,
        code: "APPROVER_NOT_AUTHORIZED",
        message: "the actor may not approve a policy profile",
      };
    }

    if (!authority) {
      return {
        ok: false,
        code: "AUTHORITY_UNAVAILABLE",
        message: "no attestation authority is available to record an approval",
      };
    }

    // A legacy PolicyProfile fails here rather than being silently upgraded:
    // it carries none of the expanded rights fields, so it cannot express the
    // licence, provider, region, or publication decisions a run needs.
    const parsed = DataRightsPolicyProfileSchema.safeParse(profile);
    if (!parsed.success) {
      return {
        ok: false,
        code: "PROFILE_NOT_RUNNABLE",
        message:
          "the profile is not a valid data rights policy profile and cannot authorise a run",
      };
    }

    // Explicitly prohibited material is declarable but never approvable, and is
    // refused with its own code so a gate can distinguish "forbidden" from
    // "merely unapproved". No record is written.
    if (parsed.data.dataRightsClass === "prohibited") {
      return {
        ok: false,
        code: "PROFILE_PROHIBITED",
        message:
          "material classified prohibited may never be approved for a run",
      };
    }

    const canonical = canonicalDataRightsPolicyProfile(parsed.data);
    const payloadFields = {
      schemaVersion: 1 as const,
      profileId: canonical.id,
      profileSha256: digestDataRightsPolicyProfile(parsed.data),
      approvedBy: approver,
      approvedAt: now(),
      reason,
    };

    // The authority independently confirms eligibility AND issues the proof.
    // Eligibility is not a boolean we evaluate and then trust; it is something
    // the authority attests to, so the record carries evidence a verifier can
    // re-check rather than a claim a reader must believe.
    const issued = await authority.attest(payloadFields);
    if (!issued.ok) {
      return {
        ok: false,
        code: issued.code,
        message:
          issued.code === "AUTHORITY_UNAVAILABLE"
            ? "the attestation authority could not be reached to record an approval"
            : "the actor may not approve a policy profile",
      };
    }

    const approval: PolicyApproval = {
      ...payloadFields,
      profile: canonical,
      attestation: issued.attestation,
    };

    const published = await store.publish(approval);
    if (!published.ok) {
      return { ok: false, code: published.code, message: published.message };
    }

    // Read back rather than returning what we hoped we wrote. The stored record
    // is the authority, it may predate this call, and the read-back path runs
    // the same attestation verification a fresh process would.
    return assertRunAllowed(canonical.id);
  };

  return { approve, assertRunAllowed };
}
