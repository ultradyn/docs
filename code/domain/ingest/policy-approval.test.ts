import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Ajv2020Module from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { PolicyApprovalSchema } from "./policy-approval.js";
import { DataRightsPolicyProfileSchema } from "./data-rights-policy-profile.js";

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

const approval = {
  schemaVersion: 1,
  profileId: canonicalProfile.id,
  profile: canonicalProfile,
  profileSha256: "a".repeat(64),
  approvedBy: HUMAN,
  approvedAt: "2026-07-19T07:30:00.000Z",
  reason: "Reviewed against the source licence.",
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
  return new Ajv2020({ allErrors: true, strict: true }).compile(portable(name));
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
