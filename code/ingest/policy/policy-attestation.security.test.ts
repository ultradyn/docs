import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalDataRightsPolicyProfile,
  digestPolicyApprovalPayload,
} from "../../domain/ingest/index.js";

import { createFilePolicyApprovalStore, createPolicyService } from "./index.js";
import {
  createFakeAttestationAuthority,
  type FakeAttestationAuthority,
} from "./testing.js";

/**
 * Authenticity suite. A record's digest proves INTEGRITY — that its contents
 * agree with themselves — but not AUTHENTICITY: that an eligible human actually
 * approved it. The ledger is Git-visible by design, so a planted, internally
 * consistent record is a realistic threat, and a run gate that trusts the
 * `approvedBy` label alone is bypassable by anyone who can write the ledger.
 */

const HUMAN = "alex.review-1";
const APPROVED_AT = "2026-07-19T07:30:00.000Z";

const profile = {
  schemaVersion: 1,
  id: "policy-confidential-no-publish",
  dataRightsClass: "confidential",
  include: ["docs/**"],
  exclude: ["docs/private/**"],
  allowedMediaTypes: ["text/markdown"],
  allowedProcessors: ["local-markdown"],
  allowedProviders: ["provider:local-whisper"],
  allowedStorage: ["project-repository"],
  allowedRegions: ["local"],
  retentionClass: "project-lifetime",
  retentionDays: 365,
  logging: "ids-only",
  cache: ["principalId", "profileId"],
  accessClass: "project-members",
  licenceRestrictions: ["no-redistribution"],
  publication: "forbidden",
  maxQuoteBytes: 0,
  maxFiles: 1_000,
  maxFileBytes: 10_000_000,
  maxExpandedBytes: 100_000_000,
} as const;

function digestOf(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalDataRightsPolicyProfile(
          value as Parameters<typeof canonicalDataRightsPolicyProfile>[0],
        ),
      ),
      "utf8",
    )
    .digest("hex");
}

let root = "";
let authority: FakeAttestationAuthority;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "policy-attest-"));
  authority = createFakeAttestationAuthority({
    authorityId: "authority-1",
    eligible: (actor: string) => actor === HUMAN,
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function service(auth = authority) {
  return createPolicyService({
    store: createFilePolicyApprovalStore({ root }),
    authority: auth,
    now: () => APPROVED_AT,
  });
}

function leafFor(profileId: string): string {
  return join(
    root,
    "ingest/policy-approvals",
    `${createHash("sha256").update(profileId, "utf8").digest("hex")}.json`,
  );
}

async function plant(record: unknown): Promise<void> {
  await mkdir(join(root, "ingest/policy-approvals"), { recursive: true });
  await writeFile(leafFor(profile.id), JSON.stringify(record, null, 2));
}

async function approvedRecord() {
  const instance = service();
  const result = await instance.approve({
    profile,
    actor: HUMAN,
    reason: "Reviewed against the source licence.",
  });
  if (!result.ok) throw new Error(`approve failed: ${result.code}`);
  return result.value;
}

describe("run authority requires a verifiable attestation, not a label", () => {
  it("denies a planted record whose approvedBy is forged", async () => {
    // A realistic forger keeps the record integrity-consistent — the digest is
    // just a hash they can recompute — so the payload passes the schema and the
    // attack lands squarely on the authenticity layer. What they cannot produce
    // is a proof the authority will vouch for.
    const payload = {
      schemaVersion: 1 as const,
      profileId: profile.id,
      profileSha256: digestOf(profile),
      approvedBy: "Max",
      approvedAt: APPROVED_AT,
      reason: "Planted directly into the ledger.",
    };
    await plant({
      ...payload,
      profile: canonicalDataRightsPolicyProfile(profile),
      attestation: {
        version: 1,
        authorityId: "authority-1",
        authorityRevision: 1,
        payloadSha256: digestPolicyApprovalPayload(payload),
        proof: "a-plausible-looking-but-forged-proof",
      },
    });
    const allowed = await service().assertRunAllowed(profile.id);
    expect(allowed.ok).toBe(false);
    if (allowed.ok) return;
    expect(allowed.code).toBe("APPROVAL_NOT_AUTHENTIC");
  });

  it("denies a record carrying an attestation copied from another approval", async () => {
    const genuine = await approvedRecord();
    // Lift the genuine proof onto a mutated record and re-point the envelope's
    // payloadSha256 at the mutated payload so integrity passes. The proof was
    // issued over the ORIGINAL payload, so verification recomputes it over the
    // mutated one and the transplant fails.
    const mutated = {
      schemaVersion: genuine.schemaVersion,
      profileId: genuine.profileId,
      profileSha256: genuine.profileSha256,
      approvedBy: genuine.approvedBy,
      approvedAt: genuine.approvedAt,
      reason: "Tampered after approval.",
    };
    await plant({
      ...mutated,
      profile: genuine.profile,
      attestation: {
        ...genuine.attestation,
        payloadSha256: digestPolicyApprovalPayload(mutated),
      },
    });
    const allowed = await service().assertRunAllowed(profile.id);
    expect(allowed.ok).toBe(false);
    if (allowed.ok) return;
    expect(allowed.code).toBe("APPROVAL_NOT_AUTHENTIC");
  });

  it("denies a record whose profile was swapped under a valid attestation", async () => {
    const genuine = await approvedRecord();
    await plant({
      ...genuine,
      profile: {
        ...canonicalDataRightsPolicyProfile(profile),
        maxQuoteBytes: 10_000_000,
      },
    });
    const allowed = await service().assertRunAllowed(profile.id);
    expect(allowed.ok).toBe(false);
  });

  it("denies an attestation from a stale authority revision", async () => {
    const genuine = await approvedRecord();
    await plant(genuine);
    // The authority rotates; the old attestation must no longer verify.
    authority.rotate();
    const allowed = await service().assertRunAllowed(profile.id);
    expect(allowed.ok).toBe(false);
    if (allowed.ok) return;
    expect(allowed.code).toBe("APPROVAL_NOT_AUTHENTIC");
  });

  it("fails closed with a distinct code when no verifier is available", async () => {
    const genuine = await approvedRecord();
    await plant(genuine);
    const allowed = await createPolicyService({
      store: createFilePolicyApprovalStore({ root }),
      authority: undefined,
      now: () => APPROVED_AT,
    }).assertRunAllowed(profile.id);
    expect(allowed.ok).toBe(false);
    if (allowed.ok) return;
    expect(allowed.code).toBe("AUTHORITY_UNAVAILABLE");
  });

  it("still authorises a genuine approval read back by a fresh process", async () => {
    await approvedRecord();
    const allowed = await service().assertRunAllowed(profile.id);
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.value.approvedBy).toBe(HUMAN);
  });

  it("refuses to issue an attestation for an ineligible actor", async () => {
    const result = await service().approve({
      profile,
      actor: "agent:evil",
      reason: "Self approval attempt.",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("APPROVER_NOT_AUTHORIZED");
  });
});
