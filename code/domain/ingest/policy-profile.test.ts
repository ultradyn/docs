import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { validateIngestRecord } from "./schema-registry.js";

const allowedProfile = {
  schemaVersion: 1,
  id: "policy-internal-docs",
  approved: true,
  dataClass: "internal",
  include: ["docs/**", "README.md"],
  exclude: ["docs/private/**"],
  allowedMediaTypes: ["text/markdown", "text/plain"],
  allowedProcessors: ["local-markdown", "local-text"],
  allowedStorage: ["project-repository"],
  retentionDays: 365,
  accessClass: "project-members",
  maxFiles: 1_000,
  maxFileBytes: 10_000_000,
  maxExpandedBytes: 100_000_000,
} as const;

const deniedProfiles: readonly (readonly [string, unknown])[] = [
  ["missing profile", undefined],
  ["not approved", { ...allowedProfile, approved: false }],
  ["prohibited data", { ...allowedProfile, dataClass: "prohibited" }],
  ["negative limit", { ...allowedProfile, maxFiles: -1 }],
  [
    "literal include/exclude overlap",
    { ...allowedProfile, exclude: ["docs/private/**", "README.md"] },
  ],
  ["unknown key", { ...allowedProfile, publicationAllowed: true }],
] as const;

const portableSchemaPath = fileURLToPath(
  new URL(
    "../../../scaffold/schemas/ingest/policy-profile.schema.json",
    import.meta.url,
  ),
);

describe("minimal ingestion policy profile", () => {
  it("accepts an approved profile through the native registry seam", () => {
    expect(validateIngestRecord("PolicyProfile", 1, allowedProfile)).toEqual({
      ok: true,
      value: allowedProfile,
    });
  });

  it.each(deniedProfiles)("fails closed for %s", (_reason, profile) => {
    const result = validateIngestRecord("PolicyProfile", 1, profile);
    expect(result.ok).toBe(false);
  });

  it("reports overlapping include/exclude literals deterministically", () => {
    const result = validateIngestRecord("PolicyProfile", 1, {
      ...allowedProfile,
      exclude: ["README.md"],
    });

    expect(result).toEqual({
      ok: false,
      code: "INVALID_RECORD",
      message: "exclude: include/exclude overlap: README.md",
    });
  });

  it("keeps the portable Draft 2020-12 schema in parity", () => {
    const portableSchema = JSON.parse(readFileSync(portableSchemaPath, "utf8"));
    const Ajv2020 = Ajv2020Module.default;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
      portableSchema,
    );

    expect(validate(allowedProfile)).toBe(true);
    for (const [reason, deniedProfile] of deniedProfiles) {
      // Draft 2020-12 has no portable value-comparison keyword for proving
      // two arrays disjoint; the native schema owns that semantic refinement.
      if (reason !== "literal include/exclude overlap") {
        expect(validate(deniedProfile), reason).toBe(false);
      }
    }
  });
});
