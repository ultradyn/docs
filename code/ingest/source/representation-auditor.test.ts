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

const csvRepresentation: SourceRepresentation = {
  ...representation,
  kind: "csv",
  normalizedText: "a,b\n1,2\n",
  locatorMap: [
    {
      kind: "cell",
      cell: { row: 1, column: 1 },
      normalized: {
        utf16Start: 0,
        utf16End: 1,
        lineStart: 1,
        columnStart: 1,
        lineEnd: 1,
        columnEnd: 2,
      },
      original: {
        byteStart: 0,
        byteEnd: 1,
        lineStart: 1,
        columnStart: 1,
        lineEnd: 1,
        columnEnd: 2,
      },
    },
    {
      kind: "cell",
      cell: { row: 1, column: 2 },
      normalized: {
        utf16Start: 2,
        utf16End: 3,
        lineStart: 1,
        columnStart: 3,
        lineEnd: 1,
        columnEnd: 4,
      },
      original: {
        byteStart: 2,
        byteEnd: 3,
        lineStart: 1,
        columnStart: 3,
        lineEnd: 1,
        columnEnd: 4,
      },
    },
    {
      kind: "cell",
      cell: { row: 2, column: 1 },
      normalized: {
        utf16Start: 4,
        utf16End: 5,
        lineStart: 2,
        columnStart: 1,
        lineEnd: 2,
        columnEnd: 2,
      },
      original: {
        byteStart: 4,
        byteEnd: 5,
        lineStart: 2,
        columnStart: 1,
        lineEnd: 2,
        columnEnd: 2,
      },
    },
    {
      kind: "cell",
      cell: { row: 2, column: 2 },
      normalized: {
        utf16Start: 6,
        utf16End: 7,
        lineStart: 2,
        columnStart: 3,
        lineEnd: 2,
        columnEnd: 4,
      },
      original: {
        byteStart: 6,
        byteEnd: 7,
        lineStart: 2,
        columnStart: 3,
        lineEnd: 2,
        columnEnd: 4,
      },
    },
  ],
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

  it("rejects canonical line-mapping corruption independently", () => {
    const locator = representation.locatorMap[1]!;
    const cases: readonly [string, SourceRepresentation, string][] = [
      [
        "reordered spans",
        {
          ...representation,
          locatorMap: [...representation.locatorMap].reverse(),
        },
        "LOCATOR_ORDER_INVALID",
      ],
      [
        "overlapping spans",
        {
          ...representation,
          locatorMap: [
            representation.locatorMap[0]!,
            {
              ...locator,
              normalized: { ...locator.normalized, utf16Start: 4 },
            },
          ],
        },
        "LOCATOR_OVERLAP",
      ],
      [
        "out-of-bounds spans",
        {
          ...representation,
          locatorMap: [
            representation.locatorMap[0]!,
            {
              ...locator,
              normalized: { ...locator.normalized, utf16End: 99 },
            },
          ],
        },
        "LOCATOR_OUT_OF_BOUNDS",
      ],
      [
        "forged columns",
        {
          ...representation,
          locatorMap: [
            representation.locatorMap[0]!,
            {
              ...locator,
              normalized: { ...locator.normalized, columnStart: 2 },
            },
          ],
        },
        "LOCATOR_POSITION_MISMATCH",
      ],
      [
        "dropped line coverage",
        {
          ...representation,
          locatorMap: representation.locatorMap.slice(0, 1),
        },
        "MAPPING_COVERAGE_GAP",
      ],
      [
        "wrong locator kind",
        {
          ...representation,
          locatorMap: [
            { ...representation.locatorMap[0]!, kind: "span" },
            locator,
          ],
        },
        "LOCATOR_KIND_MISMATCH",
      ],
    ];

    for (const [label, corrupted, code] of cases) {
      const result = auditRepresentation(corrupted);
      expect(result, label).toMatchObject({
        ok: true,
        value: {
          claimEligible: false,
          findings: expect.arrayContaining([expect.objectContaining({ code })]),
        },
      });
    }
  });

  it("rejects unsafe locator coordinates that pass the representation schema", () => {
    const first = representation.locatorMap[0]!;
    const unsafe: SourceRepresentation = {
      ...representation,
      locatorMap: [
        {
          ...first,
          normalized: {
            ...first.normalized,
            columnEnd: Number.MAX_SAFE_INTEGER + 1,
          },
        },
        representation.locatorMap[1]!,
      ],
    };

    expect(auditRepresentation(unsafe)).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
      message: expect.stringContaining("locatorMap.0.normalized.columnEnd"),
    });
  });

  it("uses UTF-16 columns and accepts explicit empty-line geometry", () => {
    const unicode: SourceRepresentation = {
      ...representation,
      normalizedText: "😀x\n\né\n",
      locatorMap: [
        {
          kind: "line",
          normalized: {
            utf16Start: 0,
            utf16End: 3,
            lineStart: 1,
            columnStart: 1,
            lineEnd: 1,
            columnEnd: 4,
          },
          original: {
            byteStart: 0,
            byteEnd: 5,
            lineStart: 1,
            columnStart: 1,
            lineEnd: 1,
            columnEnd: 4,
          },
        },
        {
          kind: "line",
          normalized: {
            utf16Start: 4,
            utf16End: 4,
            lineStart: 2,
            columnStart: 1,
            lineEnd: 2,
            columnEnd: 1,
          },
          original: {
            byteStart: 6,
            byteEnd: 6,
            lineStart: 2,
            columnStart: 1,
            lineEnd: 2,
            columnEnd: 1,
          },
        },
        {
          kind: "line",
          normalized: {
            utf16Start: 5,
            utf16End: 6,
            lineStart: 3,
            columnStart: 1,
            lineEnd: 3,
            columnEnd: 2,
          },
          original: {
            byteStart: 7,
            byteEnd: 9,
            lineStart: 3,
            columnStart: 1,
            lineEnd: 3,
            columnEnd: 2,
          },
        },
      ],
    };

    expect(auditRepresentation(unicode)).toMatchObject({
      ok: true,
      value: { claimEligible: true, findings: [] },
    });
  });

  it("rejects corrupted CSV cell identity, ordering, and coverage", () => {
    const finalCell = csvRepresentation.locatorMap[3]!;
    const cases: readonly [string, SourceRepresentation, string][] = [
      [
        "duplicate identity",
        {
          ...csvRepresentation,
          locatorMap: [
            ...csvRepresentation.locatorMap.slice(0, 3),
            { ...finalCell, cell: { row: 2, column: 1 } },
          ],
        },
        "CSV_CELL_ORDER_INVALID",
      ],
      [
        "reordered cells",
        {
          ...csvRepresentation,
          locatorMap: [
            csvRepresentation.locatorMap[1]!,
            csvRepresentation.locatorMap[0]!,
            ...csvRepresentation.locatorMap.slice(2),
          ],
        },
        "CSV_CELL_ORDER_INVALID",
      ],
      [
        "dropped cell",
        {
          ...csvRepresentation,
          locatorMap: csvRepresentation.locatorMap.slice(0, 3),
        },
        "MAPPING_COVERAGE_GAP",
      ],
      [
        "forged span",
        {
          ...csvRepresentation,
          locatorMap: [
            ...csvRepresentation.locatorMap.slice(0, 3),
            {
              ...finalCell,
              normalized: { ...finalCell.normalized, utf16Start: 5 },
            },
          ],
        },
        "MAPPING_COVERAGE_GAP",
      ],
    ];

    expect(auditRepresentation(csvRepresentation)).toMatchObject({
      ok: true,
      value: { claimEligible: true, findings: [] },
    });
    for (const [label, corrupted, code] of cases) {
      expect(auditRepresentation(corrupted), label).toMatchObject({
        ok: true,
        value: {
          claimEligible: false,
          findings: expect.arrayContaining([expect.objectContaining({ code })]),
        },
      });
    }
  });

  it("accepts a quoted multiline CSV cell as one row-major cell", () => {
    const multiline: SourceRepresentation = {
      ...csvRepresentation,
      normalizedText: 'name,note\nAda,"line 1\nline 2"\n',
      locatorMap: [
        {
          ...csvRepresentation.locatorMap[0]!,
          normalized: {
            utf16Start: 0,
            utf16End: 4,
            lineStart: 1,
            columnStart: 1,
            lineEnd: 1,
            columnEnd: 5,
          },
          original: {
            byteStart: 0,
            byteEnd: 4,
            lineStart: 1,
            columnStart: 1,
            lineEnd: 1,
            columnEnd: 5,
          },
        },
        {
          ...csvRepresentation.locatorMap[1]!,
          normalized: {
            utf16Start: 5,
            utf16End: 9,
            lineStart: 1,
            columnStart: 6,
            lineEnd: 1,
            columnEnd: 10,
          },
          original: {
            byteStart: 5,
            byteEnd: 9,
            lineStart: 1,
            columnStart: 6,
            lineEnd: 1,
            columnEnd: 10,
          },
        },
        {
          ...csvRepresentation.locatorMap[2]!,
          normalized: {
            utf16Start: 10,
            utf16End: 13,
            lineStart: 2,
            columnStart: 1,
            lineEnd: 2,
            columnEnd: 4,
          },
          original: {
            byteStart: 10,
            byteEnd: 13,
            lineStart: 2,
            columnStart: 1,
            lineEnd: 2,
            columnEnd: 4,
          },
        },
        {
          ...csvRepresentation.locatorMap[3]!,
          normalized: {
            utf16Start: 14,
            utf16End: 29,
            lineStart: 2,
            columnStart: 5,
            lineEnd: 3,
            columnEnd: 8,
          },
          original: {
            byteStart: 14,
            byteEnd: 29,
            lineStart: 2,
            columnStart: 5,
            lineEnd: 3,
            columnEnd: 8,
          },
        },
      ],
    };

    expect(auditRepresentation(multiline)).toMatchObject({
      ok: true,
      value: { claimEligible: true, findings: [] },
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
