import { createHash } from "node:crypto";

import { z } from "zod";

import {
  DataRightsPolicyProfileSchema,
  digestDataRightsPolicyProfile,
  type DataRightsPolicyProfile,
} from "./data-rights-policy-profile.js";

/**
 * An independent attestation that an eligible human approved this exact payload.
 *
 * The record's digest proves INTEGRITY — that its fields agree with themselves.
 * It cannot prove AUTHENTICITY, because the ledger is Git-visible and anyone who
 * can write it can mint an internally consistent record and set `approvedBy` to
 * any name. Authenticity therefore rides on a `proof` issued by an authority the
 * store does not control and verified on every run decision. `payloadSha256`
 * binds the canonical approval payload (profile digest, actor, time, reason);
 * it deliberately excludes `proof`, so the proof commits to the payload rather
 * than to itself.
 *
 * This envelope is transport only. The task defines the seam and a deterministic
 * test fake; it invents no production trust root, key, or signature scheme.
 */
export interface PolicyApprovalAttestation {
  version: 1;
  authorityId: string;
  authorityRevision: number;
  payloadSha256: string;
  proof: string;
}

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
  attestation: PolicyApprovalAttestation;
}

/** The approval payload an attestation commits to: everything but the
 * attestation itself, in a fixed key order so the digest is construction
 * independent. */
export interface PolicyApprovalPayload {
  schemaVersion: 1;
  profileId: string;
  profileSha256: string;
  approvedBy: string;
  approvedAt: string;
  reason: string;
}

/**
 * The digest an attestation binds. It covers the profile through its digest
 * rather than by inlining the whole profile, which is why `profileSha256` is
 * itself schema-verified against the embedded profile: the two checks together
 * mean a valid attestation commits transitively to the exact profile bytes.
 */
export function digestPolicyApprovalPayload(
  approval: Pick<
    PolicyApproval,
    | "schemaVersion"
    | "profileId"
    | "profileSha256"
    | "approvedBy"
    | "approvedAt"
    | "reason"
  >,
): string {
  const payload: PolicyApprovalPayload = {
    schemaVersion: approval.schemaVersion,
    profileId: approval.profileId,
    profileSha256: approval.profileSha256,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    reason: approval.reason,
  };
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const NonBlankSchema = z.string().trim().min(1);
const IsoTimestampSchema = z.string().datetime();

/** A proof is an opaque, bounded token. Bounding it keeps a hostile record from
 * carrying an unbounded string, and opacity keeps the store from depending on
 * any particular authority's scheme. */
const ProofSchema = z.string().min(1).max(4096);

const AttestationSchema = z
  .object({
    version: z.literal(1),
    authorityId: NonBlankSchema,
    authorityRevision: z.number().int().nonnegative(),
    payloadSha256: Sha256Schema,
    proof: ProofSchema,
  })
  .strict();

export const PolicyApprovalSchema: z.ZodType<PolicyApproval> = z
  .object({
    schemaVersion: z.literal(1),
    profileId: NonBlankSchema,
    profile: DataRightsPolicyProfileSchema,
    profileSha256: Sha256Schema,
    approvedBy: NonBlankSchema,
    approvedAt: IsoTimestampSchema,
    reason: NonBlankSchema,
    attestation: AttestationSchema,
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

    // Prohibited material is declarable as a PROFILE but can never be the
    // subject of an APPROVAL. Rejecting it here makes the invariant structural:
    // it holds for any record reaching the ledger, not only for those created
    // through the approve() path.
    if (approval.profile.dataRightsClass === "prohibited") {
      context.addIssue({
        code: "custom",
        path: ["profile", "dataRightsClass"],
        message: "prohibited material may never be the subject of an approval",
      });
    }

    // The digest is the sole discriminator between an idempotent replay and a
    // conflict, so it must actually commit to the embedded profile. Left
    // unchecked it is free text, and a record pairing a hostile profile with a
    // legitimate profile's digest replays as if it were the approved one.
    const expected = digestDataRightsPolicyProfile(approval.profile);
    if (approval.profileSha256 !== expected) {
      context.addIssue({
        code: "custom",
        path: ["profileSha256"],
        message:
          "profileSha256 does not commit to the embedded profile; the record is not integrity-consistent",
      });
    }

    // The attestation must at least commit to THIS payload. Whether the proof
    // is genuine is an authenticity question answered by the injected verifier;
    // this is the integrity half, and it lets a transplanted attestation be
    // caught even before a verifier is consulted.
    const payloadDigest = digestPolicyApprovalPayload(approval);
    if (approval.attestation.payloadSha256 !== payloadDigest) {
      context.addIssue({
        code: "custom",
        path: ["attestation", "payloadSha256"],
        message:
          "attestation payloadSha256 does not commit to the approval payload",
      });
    }
  });
