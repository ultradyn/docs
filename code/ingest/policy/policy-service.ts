import { createHash } from "node:crypto";

import {
  DataRightsPolicyProfileSchema,
  canonicalDataRightsPolicyProfile,
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
 * Agent-shaped handles are refused regardless of what the injected authority
 * says. The authority seam is the control; this is defence in depth, so a
 * permissive or misconfigured roll still cannot let an agent approve its own
 * work.
 */
const AGENT_HANDLE = /^(agent|bot|service):/iu;

export function digestDataRightsPolicyProfile(
  profile: DataRightsPolicyProfile,
): string {
  // Hash the CANONICAL form so two semantically identical profiles that differ
  // only in list order share a digest. JSON.stringify over the raw object would
  // not do this: Zod rebuilds parsed objects in schema key order, so the byte
  // sequence depends on how the value happened to be constructed.
  return createHash("sha256")
    .update(JSON.stringify(canonicalDataRightsPolicyProfile(profile)), "utf8")
    .digest("hex");
}

export function createPolicyService(
  dependencies: PolicyServiceDependencies,
): PolicyService {
  const { store, approvalPolicy, now } = dependencies;

  return {
    async approve({ profile, actor, reason }) {
      if (reason.trim().length === 0) {
        return {
          ok: false,
          code: "INVALID_APPROVAL",
          message: "an approval requires a nonblank reason",
        };
      }

      if (
        AGENT_HANDLE.test(actor) ||
        !approvalPolicy.isAuthorisedHuman(actor)
      ) {
        return {
          ok: false,
          code: "APPROVER_NOT_AUTHORIZED",
          message: `${actor} may not approve a policy profile`,
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
          message: parsed.error.issues
            .map(
              (issue) =>
                `${issue.path.join(".") || "<root>"}: ${issue.message}`,
            )
            .join("; "),
        };
      }

      const canonical = canonicalDataRightsPolicyProfile(parsed.data);
      const approval: PolicyApproval = {
        schemaVersion: 1,
        profileId: canonical.id,
        profile: canonical,
        profileSha256: digestDataRightsPolicyProfile(parsed.data),
        approvedBy: actor,
        approvedAt: now(),
        reason,
      };

      const published = await store.publish(approval);
      if (!published.ok) {
        return { ok: false, code: published.code, message: published.message };
      }

      // Read back rather than returning what we hoped we wrote. On a replay the
      // stored record is the authority, and it may predate this call.
      return this.assertRunAllowed(canonical.id);
    },

    async assertRunAllowed(profileId) {
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
    },
  };
}
