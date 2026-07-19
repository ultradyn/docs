import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Ajv2020Module from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  PolicyApprovalSchema,
  digestPolicyApprovalPayload,
} from "./policy-approval.js";
import {
  DataRightsPolicyProfileSchema,
  digestDataRightsPolicyProfile,
} from "./data-rights-policy-profile.js";

const HUMAN = "alex.review-1";

const canonicalProfile = {
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

const payload = {
  schemaVersion: 1 as const,
  profileId: canonicalProfile.id,
  // Recomputed, not invented: the schema verifies that the digest commits to
  // the embedded profile, so a record is integrity-consistent (not authentic —
  // authenticity is the injected authority's job, not the schema's).
  profileSha256: digestDataRightsPolicyProfile(canonicalProfile),
  approvedBy: HUMAN,
  approvedAt: "2026-07-19T07:30:00.000Z",
  reason: "Reviewed against the source licence.",
};

const approval = {
  ...payload,
  profile: canonicalProfile,
  attestation: {
    version: 1,
    authorityId: "authority-1",
    authorityRevision: 1,
    // The envelope must commit to the payload; the schema checks this even
    // though only the injected authority can judge the proof genuine.
    payloadSha256: digestPolicyApprovalPayload(payload),
    proof: "envelope-proof-verified-elsewhere",
  },
} as const;

function portable(name: string) {
  return JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`../../../scaffold/schemas/ingest/${name}`, import.meta.url),
      ),
      "utf8",
    ),
  );
}

function compile(name: string) {
  const Ajv2020 = Ajv2020Module.default;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  // The portable approval schema $refs the portable profile schema by $id
  // rather than duplicating it, so both must be registered to resolve.
  ajv.addSchema(portable("data-rights-policy-profile.schema.json"));
  return name === "data-rights-policy-profile.schema.json"
    ? ajv.getSchema(
        "https://ultradyn.dev/schemas/ingest/data-rights-policy-profile.schema.json",
      )!
    : ajv.compile(portable(name));
}

describe("the durable approval record is strict", () => {
  it("accepts a well formed approval", () => {
    expect(PolicyApprovalSchema.safeParse(approval).success).toBe(true);
  });

  it("requires a nonblank reason", () => {
    expect(
      PolicyApprovalSchema.safeParse({ ...approval, reason: "  " }).success,
    ).toBe(false);
  });

  it("requires a sha256-shaped digest", () => {
    expect(
      PolicyApprovalSchema.safeParse({ ...approval, profileSha256: "nope" })
        .success,
    ).toBe(false);
  });

  it("requires the embedded profile id to match the record key", () => {
    // The embedded identity is what proves which profile a record describes,
    // because the on-disk leaf name is a hash of an untrusted id.
    expect(
      PolicyApprovalSchema.safeParse({
        ...approval,
        profileId: "policy-something-else",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown key", () => {
    expect(
      PolicyApprovalSchema.safeParse({ ...approval, revoked: true }).success,
    ).toBe(false);
  });

  it("rejects a revocation or deletion field", () => {
    for (const key of ["revokedAt", "deletedAt", "purgedBy", "supersededBy"]) {
      expect(
        PolicyApprovalSchema.safeParse({ ...approval, [key]: "x" }).success,
      ).toBe(false);
    }
  });

  it("embeds a profile that satisfies the profile schema in its own right", () => {
    expect(
      DataRightsPolicyProfileSchema.safeParse(approval.profile).success,
    ).toBe(true);
  });

  it("requires the attestation envelope", () => {
    const withoutAttestation = { ...approval } as Record<string, unknown>;
    delete withoutAttestation.attestation;
    expect(PolicyApprovalSchema.safeParse(withoutAttestation).success).toBe(
      false,
    );
  });

  it("requires the attestation to commit to the payload", () => {
    expect(
      PolicyApprovalSchema.safeParse({
        ...approval,
        attestation: { ...approval.attestation, payloadSha256: "0".repeat(64) },
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown key inside the attestation", () => {
    expect(
      PolicyApprovalSchema.safeParse({
        ...approval,
        attestation: { ...approval.attestation, forged: true },
      }).success,
    ).toBe(false);
  });
});

describe("portable Draft 2020-12 schemas stay in parity", () => {
  it("accepts the canonical profile through the portable profile schema", () => {
    expect(
      compile("data-rights-policy-profile.schema.json")(canonicalProfile),
    ).toBe(true);
  });

  it("denies unknown keys through the portable profile schema", () => {
    expect(
      compile("data-rights-policy-profile.schema.json")({
        ...canonicalProfile,
        apiKey: "sk-live-1",
      }),
    ).toBe(false);
  });

  it("accepts the canonical approval through the portable approval schema", () => {
    expect(compile("policy-approval.schema.json")(approval)).toBe(true);
  });

  it("denies a revocation field through the portable approval schema", () => {
    expect(
      compile("policy-approval.schema.json")({ ...approval, revokedAt: "now" }),
    ).toBe(false);
  });
});
