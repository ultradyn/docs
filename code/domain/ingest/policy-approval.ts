import { z } from "zod";

import {
  DataRightsPolicyProfileSchema,
  type DataRightsPolicyProfile,
} from "./data-rights-policy-profile.js";

/**
 * The durable approval record.
 *
 * It embeds the CANONICAL profile alongside its digest and human provenance, so
 * a cold process can answer `assertRunAllowed` from this record alone without
 * locating the candidate profile from anywhere else.
 *
 * There is deliberately no revocation, supersession, expiry, or deletion field.
 * Approval is append-only: changed content takes a NEW profile id rather than
 * retargeting an existing one. Authorised deletion is T-10-04, blocked on
 * ADR 0007, ratified D9, and every capability gate.
 */
export interface PolicyApproval {
  schemaVersion: 1;
  profileId: string;
  profile: DataRightsPolicyProfile;
  profileSha256: string;
  approvedBy: string;
  approvedAt: string;
  reason: string;
}

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const NonBlankSchema = z.string().trim().min(1);
const IsoTimestampSchema = z.string().datetime();

export const PolicyApprovalSchema: z.ZodType<PolicyApproval> = z
  .object({
    schemaVersion: z.literal(1),
    profileId: NonBlankSchema,
    profile: DataRightsPolicyProfileSchema,
    profileSha256: Sha256Schema,
    approvedBy: NonBlankSchema,
    approvedAt: IsoTimestampSchema,
    reason: NonBlankSchema,
  })
  .strict()
  .superRefine((approval, context) => {
    // The on-disk leaf name is a hash of an untrusted id, so the embedded
    // identity is what actually proves which profile a record describes. A
    // record whose key and payload disagree is not merely odd, it is the shape
    // an attacker would use to bind one profile's approval to another's name.
    if (approval.profileId !== approval.profile.id) {
      context.addIssue({
        code: "custom",
        path: ["profileId"],
        message: `approval profileId "${approval.profileId}" does not match embedded profile id "${approval.profile.id}"`,
      });
    }
  });
