import {
  DataRightsPolicyProfileSchema,
  canonicalDataRightsPolicyProfile,
  digestDataRightsPolicyProfile,
  type DataRightsPolicyProfile,
  type PolicyApproval,
} from "../../domain/ingest/index.js";
import type { IngestResult } from "../../domain/ingest/types.js";

import type { PolicyApprovalStore } from "./policy-approval-store.js";

/**
 * The approval-ledger, content-digest-bound view of a profile.
 *
 * A run is authorised by the existence of one of these in the ledger, never by
 * a profile's own claim about itself. The frozen legacy PolicyProfile pins
 * `approved: true` at parse time, so any well-formed legacy document always
 * looks approved; treating that as authority would confuse "well-formed
 * approved-shaped document" with "a human approved this for this repository".
 */
export type ApprovedPolicyProfile = PolicyApproval;

export type PolicyApprovalFailure =
  | "POLICY_UNAPPROVED"
  | "PROFILE_PROHIBITED"
  | "PROFILE_NOT_RUNNABLE"
  | "APPROVER_NOT_AUTHORIZED"
  | "APPROVAL_CONFLICT"
  | "INVALID_APPROVAL"
  | "CUSTODY_UNAVAILABLE";

export interface PolicyApprovalAuthority {
  isAuthorisedHuman(actor: string): boolean;
}

export interface PolicyServiceDependencies {
  store: PolicyApprovalStore;
  approvalPolicy: PolicyApprovalAuthority;
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
 * `isAuthorisedHuman` is the only real authority: this pattern is a denylist
 * over an unbounded set of handles, so it catches `agent:x` and nothing about
 * a handle that simply does not carry one of these prefixes. It is applied to
 * a normalised string so that whitespace and invisible characters cannot walk
 * straight past it, but no claim is made that it prevents an agent approving
 * its own work — only the injected seam does that.
 */
const AGENT_HANDLE = /^(agent|bot|service):/u;

/** Normalise once, then judge and record the same value. A trimmed parse plus a
 * raw persist would let the recorded approver differ from the identity the
 * authority was actually asked about. */
function normaliseActor(actor: string): string {
  return actor
    .trim()
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\ufeff]/gu, "");
}

export function createPolicyService(
  dependencies: PolicyServiceDependencies,
): PolicyService {
  const { store, approvalPolicy, now } = dependencies;

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
        message: `no approval record exists for policy profile ${profileId}`,
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
    {
      if (reason.trim().length === 0) {
        return {
          ok: false,
          code: "INVALID_APPROVAL",
          message: "an approval requires a nonblank reason",
        };
      }

      const approver = normaliseActor(actor);
      if (
        approver.length === 0 ||
        AGENT_HANDLE.test(approver.toLowerCase()) ||
        !approvalPolicy.isAuthorisedHuman(approver)
      ) {
        return {
          ok: false,
          code: "APPROVER_NOT_AUTHORIZED",
          message: "the actor may not approve a policy profile",
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

      // Explicitly prohibited material is declarable but never approvable, and
      // is refused with its own code so a gate can distinguish "forbidden" from
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
      const approval: PolicyApproval = {
        schemaVersion: 1,
        profileId: canonical.id,
        profile: canonical,
        profileSha256: digestDataRightsPolicyProfile(parsed.data),
        approvedBy: approver,
        approvedAt: now(),
        reason,
      };

      const published = await store.publish(approval);
      if (!published.ok) {
        return { ok: false, code: published.code, message: published.message };
      }

      // Read back rather than returning what we hoped we wrote. The stored
      // record is the authority, it may predate this call, and because the
      // schema recomputes the digest a record that reads back cleanly is
      // self-authenticating.
      return assertRunAllowed(canonical.id);
    }
  };

  return { approve, assertRunAllowed };
}
