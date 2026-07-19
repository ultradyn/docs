import { describe, expect, it } from "vitest";

import type {
  RepresentationCapability,
  SourceFileId,
  SourceRepresentation,
  SourceRepresentationId,
} from "../../domain/ingest/index.js";
import { RepresentationAuditSchema } from "../../domain/ingest/index.js";
import { auditRepresentation, capabilityFor } from "./index.js";

const REPRESENTATION_ID =
  "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceRepresentationId;

const representation: SourceRepresentation = {
  schemaVersion: 1,
  id: REPRESENTATION_ID,
  sourceFileId: `file-${"a".repeat(64)}` as SourceFileId,
  version: 1,
  kind: "text",
  normalizedText: "alpha\nbeta\n",
  locatorMap: [
    {
      kind: "line",
      normalized: {
        utf16Start: 0,
        utf16End: 5,
        lineStart: 1,
        columnStart: 1,
        lineEnd: 1,
        columnEnd: 6,
      },
      original: {
        byteStart: 0,
        byteEnd: 5,
        lineStart: 1,
        columnStart: 1,
        lineEnd: 1,
        columnEnd: 6,
      },
    },
    {
      kind: "line",
      normalized: {
        utf16Start: 6,
        utf16End: 10,
        lineStart: 2,
        columnStart: 1,
        lineEnd: 2,
        columnEnd: 5,
      },
      original: {
        byteStart: 6,
        byteEnd: 10,
        lineStart: 2,
        columnStart: 1,
        lineEnd: 2,
        columnEnd: 5,
      },
    },
  ],
  warnings: [],
};

function capability(
  tier: RepresentationCapability["tier"],
): RepresentationCapability {
  return {
    schemaVersion: 1,
    id: `test:${tier.toLowerCase()}`,
    version: 1,
    representationKind: "text",
    tier,
    requiredChecks:
      tier === "B"
        ? ["mapping", "render", "structure"]
        : ["mapping", "structure"],
  };
}

describe("representation capability audit", () => {
  it("registers all and only the six built-in A-tier kinds", () => {
    for (const kind of [
      "markdown",
      "text",
      "code",
      "json",
      "yaml",
      "csv",
    ] as const) {
      expect(capabilityFor(kind)).toEqual({
        schemaVersion: 1,
        id: `a-tier:${kind}`,
        version: 1,
        representationKind: kind,
        tier: "A",
        requiredChecks: ["mapping", "structure"],
      });
    }
    expect(capabilityFor("unknown" as "text")).toBeUndefined();
  });

  it("returns a canonical deterministic eligible audit for valid A-tier text", () => {
    const first = auditRepresentation(representation);
    const second = auditRepresentation(structuredClone(representation));

    expect(first).toEqual(second);
    expect(first).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        representationId: REPRESENTATION_ID,
        capability: {
          status: "resolved",
          id: "a-tier:text",
          version: 1,
        },
        tier: "A",
        structuralPass: true,
        mappingPass: true,
        humanVerified: false,
        claimEligible: true,
        findings: [],
      },
    });
    if (first.ok) {
      expect(RepresentationAuditSchema.parse(first.value)).toEqual(first.value);
      expect(Object.isFrozen(first.value)).toBe(true);
      expect(Object.isFrozen(first.value.capability)).toBe(true);
      expect(Object.isFrozen(first.value.findings)).toBe(true);
    }
  });

  it("returns INVALID_INPUT rather than minting an audit for an invalid identity", () => {
    expect(auditRepresentation({ ...representation, id: "" })).toEqual({
      ok: false,
      code: "INVALID_INPUT",
      message: expect.stringContaining("source representation"),
    });
  });

  it("rejects malformed, mismatched, and unsupported capabilities without throwing", () => {
    const cases: readonly [unknown, string][] = [
      [{ ...capability("A"), unexpected: true }, "INVALID_CAPABILITY"],
      [
        { ...capability("A"), representationKind: "csv" },
        "CAPABILITY_KIND_MISMATCH",
      ],
      [{ ...capability("A"), version: 2 }, "CAPABILITY_VERSION_UNSUPPORTED"],
    ];

    for (const [candidate, code] of cases) {
      const result = auditRepresentation(representation, candidate);
      expect(result).toMatchObject({
        ok: true,
        value: {
          claimEligible: false,
          findings: expect.arrayContaining([expect.objectContaining({ code })]),
        },
      });
      if (result.ok) {
        expect(RepresentationAuditSchema.parse(result.value)).toEqual(
          result.value,
        );
      }
    }
  });

  it.each([
    {
      tier: "B" as const,
      code: "CAPABILITY_CHECK_UNSUPPORTED",
      message: "render",
    },
    {
      tier: "C" as const,
      code: "TIER_REQUIRES_UNIT_VERIFICATION",
      message: "named human verification per selected source unit",
    },
    {
      tier: "D" as const,
      code: "TIER_UNSUPPORTED",
      message: "cannot support accepted claims",
    },
  ])("keeps Tier $tier fail-closed", ({ tier, code, message }) => {
    const result = auditRepresentation(representation, capability(tier));

    expect(result).toMatchObject({
      ok: true,
      value: {
        tier,
        humanVerified: false,
        claimEligible: false,
        findings: expect.arrayContaining([expect.objectContaining({ code })]),
      },
    });
    if (result.ok) {
      expect(
        result.value.findings.map((finding) => finding.message).join(" "),
      ).toContain(message);
      expect(RepresentationAuditSchema.parse(result.value)).toEqual(
        result.value,
      );
    }
  });
});
