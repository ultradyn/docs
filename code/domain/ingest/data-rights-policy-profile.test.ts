import { describe, expect, it } from "vitest";

import {
  DATA_RIGHTS_POLICY_LIMITS,
  DataRightsPolicyProfileSchema,
  canonicalDataRightsPolicyProfile,
} from "./data-rights-policy-profile.js";

// Id vocabulary (binding for T-13-02, which must not invent ids).
//
//   allowedProcessors - LOCAL extraction capabilities. They read bytes already
//                       in custody and emit derived representations. No egress.
//                       e.g. "local-markdown", "local-text", "local-pdf".
//   allowedProviders  - REMOTE model/STT capabilities. They carry egress and
//                       therefore region concerns that processors do not. This
//                       is why the two lists stay distinct rather than merged.
//                       e.g. "provider:anthropic/claude", "provider:local-whisper".
//   allowedStorage    - durable destinations. e.g. "project-repository".
//   allowedRegions    - region codes, or the explicit "local" token. An empty
//                       list is NOT allow-all; it fails closed (threat T12).
const confidentialProfile = {
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
  cache: ["profileId", "principalId"],
  accessClass: "project-members",
  licenceRestrictions: ["no-redistribution"],
  publication: "forbidden",
  maxQuoteBytes: 0,
  maxFiles: 1_000,
  maxFileBytes: 10_000_000,
  maxExpandedBytes: 100_000_000,
} as const;

function withField(overrides: Record<string, unknown>): unknown {
  return { ...confidentialProfile, ...overrides };
}

function withoutField(field: string): unknown {
  const copy: Record<string, unknown> = { ...confidentialProfile };
  delete copy[field];
  return copy;
}

describe("expanded data rights profile parses only when fully explicit", () => {
  // The accepting case is asserted FIRST and separately. A strict schema
  // rejects unknown keys, so a rejection test can pass for the wrong reason if
  // the fixture was never valid to begin with; pinning the accept path makes
  // every later rejection attributable to the field under test.
  it("accepts a fully specified confidential profile", () => {
    const result = DataRightsPolicyProfileSchema.safeParse(confidentialProfile);
    expect(result.success).toBe(true);
  });

  it("is registered under its own name, leaving legacy PolicyProfile v1 alone", async () => {
    const { validateIngestRecord } = await import("./schema-registry.js");
    expect(
      validateIngestRecord(
        "DataRightsPolicyProfile" as never,
        1,
        confidentialProfile,
      ).ok,
    ).toBe(true);
  });
});

describe("every profile maps to explicit processors, providers and storage", () => {
  const mustBeNonEmpty = [
    "allowedProcessors",
    "allowedProviders",
    "allowedStorage",
    "allowedRegions",
  ] as const;

  it.each(mustBeNonEmpty)("rejects an empty %s list", (field) => {
    expect(
      DataRightsPolicyProfileSchema.safeParse(withField({ [field]: [] }))
        .success,
    ).toBe(false);
  });

  it.each(mustBeNonEmpty)("rejects a missing %s list", (field) => {
    expect(
      DataRightsPolicyProfileSchema.safeParse(withoutField(field)).success,
    ).toBe(false);
  });

  it("rejects a wildcard processor rather than treating it as allow-all", () => {
    // Fail closed: "*" must not be a shorthand for unrestricted execution.
    expect(
      DataRightsPolicyProfileSchema.safeParse(
        withField({ allowedProcessors: ["*"] }),
      ).success,
    ).toBe(false);
  });

  it("rejects a wildcard provider", () => {
    expect(
      DataRightsPolicyProfileSchema.safeParse(
        withField({ allowedProviders: ["*"] }),
      ).success,
    ).toBe(false);
  });

  it("treats an empty region list as deny-remote, never allow-all", () => {
    // Threat T12. The explicit "local" token is how a profile says "no egress".
    expect(
      DataRightsPolicyProfileSchema.safeParse(withField({ allowedRegions: [] }))
        .success,
    ).toBe(false);
    expect(
      DataRightsPolicyProfileSchema.safeParse(
        withField({ allowedRegions: ["local"] }),
      ).success,
    ).toBe(true);
  });
});

describe("licence restrictions reach the publication rule", () => {
  it("requires an explicit publication rule rather than defaulting one", () => {
    expect(
      DataRightsPolicyProfileSchema.safeParse(withoutField("publication"))
        .success,
    ).toBe(false);
  });

  it("accepts only closed publication vocabulary", () => {
    expect(
      DataRightsPolicyProfileSchema.safeParse(
        withField({ publication: "sure-why-not" }),
      ).success,
    ).toBe(false);
  });

  it("refuses a confidential profile that permits external publication", () => {
    // This is the cross-field control, and the reason the test above is not
    // sufficient on its own: presence of the field proves nothing if its value
    // may contradict the classification.
    expect(
      DataRightsPolicyProfileSchema.safeParse(
        withField({ publication: "external" }),
      ).success,
    ).toBe(false);
  });

  it("refuses a restricted licence that permits external publication", () => {
    expect(
      DataRightsPolicyProfileSchema.safeParse(
        withField({
          dataRightsClass: "internal",
          licenceRestrictions: ["no-redistribution"],
          publication: "external",
        }),
      ).success,
    ).toBe(false);
  });

  it("permits external publication only for public, unrestricted material", () => {
    expect(
      DataRightsPolicyProfileSchema.safeParse(
        withField({
          dataRightsClass: "public",
          licenceRestrictions: [],
          publication: "external",
          maxQuoteBytes: 4_096,
        }),
      ).success,
    ).toBe(true);
  });

  it("accepts only closed licence restriction codes", () => {
    expect(
      DataRightsPolicyProfileSchema.safeParse(
        withField({ licenceRestrictions: ["whatever-the-caller-invents"] }),
      ).success,
    ).toBe(false);
  });
});

describe("policy declaration never implies erasure", () => {
  const deletionShapedKeys = [
    "deleteAfterDays",
    "purge",
    "erase",
    "unlink",
    "destroy",
  ] as const;

  it.each(deletionShapedKeys)("rejects a %s field", (key) => {
    expect(
      DataRightsPolicyProfileSchema.safeParse(withField({ [key]: 1 })).success,
    ).toBe(false);
  });

  it("rejects a zero retention window rather than reading it as purge-now", () => {
    // Threat T11: retentionDays must never encode "erase immediately".
    expect(
      DataRightsPolicyProfileSchema.safeParse(withField({ retentionDays: 0 }))
        .success,
    ).toBe(false);
  });

  it("accepts only closed retention classes", () => {
    expect(
      DataRightsPolicyProfileSchema.safeParse(
        withField({ retentionClass: "until-i-say-so" }),
      ).success,
    ).toBe(false);
  });

  it("exposes no legal hold field while D9 is unratified", () => {
    // D9 governs legal-hold recording and release and is Max's to ratify.
    // Shipping the field now would let a consumer bind to an unratified shape.
    expect(
      DataRightsPolicyProfileSchema.safeParse(
        withField({ legalHoldAllowed: true }),
      ).success,
    ).toBe(false);
  });
});

describe("hostile rule sets are bounded", () => {
  it("freezes the published limits", () => {
    // Object.isFrozen(undefined) is true per spec, so asserting frozenness
    // alone would pass while the export is still missing. Pin existence first.
    expect(typeof DATA_RIGHTS_POLICY_LIMITS).toBe("object");
    expect(DATA_RIGHTS_POLICY_LIMITS).not.toBeNull();
    expect(Object.isFrozen(DATA_RIGHTS_POLICY_LIMITS)).toBe(true);
  });

  it("rejects an include list beyond the item budget", () => {
    const oversized = Array.from(
      { length: DATA_RIGHTS_POLICY_LIMITS.maxRulesPerList + 1 },
      (_unused, index) => `docs/${index}/**`,
    );
    expect(
      DataRightsPolicyProfileSchema.safeParse(withField({ include: oversized }))
        .success,
    ).toBe(false);
  });

  it("rejects a single pattern beyond the length budget", () => {
    const oversized = `docs/${"a".repeat(DATA_RIGHTS_POLICY_LIMITS.maxRuleChars)}/**`;
    expect(
      DataRightsPolicyProfileSchema.safeParse(
        withField({ include: [oversized] }),
      ).success,
    ).toBe(false);
  });

  it("rejects an unknown key", () => {
    // Also the control that keeps credentials out of the record: a profile has
    // no declared secret-bearing field, so any such key is unknown by
    // construction rather than by a name-based denylist.
    expect(
      DataRightsPolicyProfileSchema.safeParse(
        withField({ apiKey: "sk-live-1" }),
      ).success,
    ).toBe(false);
  });
});

describe("canonicalization is digest-stable without disturbing stored order", () => {
  it("produces equal canonical forms for lists differing only in order", () => {
    const reordered = withField({
      allowedMediaTypes: ["text/markdown"],
      cache: ["principalId", "profileId"],
    });
    expect(canonicalDataRightsPolicyProfile(confidentialProfile)).toEqual(
      canonicalDataRightsPolicyProfile(reordered),
    );
  });

  it("produces different canonical forms when a value actually differs", () => {
    expect(canonicalDataRightsPolicyProfile(confidentialProfile)).not.toEqual(
      canonicalDataRightsPolicyProfile(withField({ retentionDays: 366 })),
    );
  });

  it("does not mutate or reorder the caller's profile", () => {
    // Preflight reports the FIRST matching pattern by name, so reordering a
    // stored list would silently change which rule gets blamed in diagnostics.
    // Canonicalization therefore operates on a copy.
    const input = {
      ...confidentialProfile,
      cache: ["profileId", "principalId"],
    };
    const before = structuredClone(input);
    canonicalDataRightsPolicyProfile(input);
    expect(input).toEqual(before);
  });
});
