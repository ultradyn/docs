import { describe, expect, it } from "vitest";
import {
  RepresentationAuditSchema,
  RepresentationCapabilitySchema,
} from "./representation-audit.js";
import { CoverageObligationSchema } from "./schemas.js";
import {
  ingestSchemaRegistry,
  validateIngestRecord,
} from "./schema-registry.js";

describe("ingestion schema registry", () => {
  const sourceFile = {
    schemaVersion: 1,
    id: `file-${"d".repeat(64)}`,
    snapshotId: `snap-${"c".repeat(64)}`,
    logicalPath: "docs/guide.md",
    mediaType: "text/markdown",
    size: 12,
    sha256: "a".repeat(64),
  } as const;

  it("resolves curated versioned schemas without reading the source bundle", () => {
    expect(ingestSchemaRegistry.get("SourceFile", 1).parse(sourceFile)).toEqual(
      sourceFile,
    );
    expect(ingestSchemaRegistry.names()).toContain("AnswerComposition");
  });

  it("uses the strict canonical coverage-obligation schema", () => {
    const complete = {
      schemaVersion: 1,
      id: "obl-01BX5ZZKBKACTAV9WEVGEMMVS2",
      questionId: "q-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      trigger: "replay-guarantee",
      ownerQuestionId: "q-01BX5ZZKBKACTAV9WEVGEMMVRZ",
      status: "assigned",
      version: 1,
    } as const;

    expect(
      CoverageObligationSchema.safeParse({ schemaVersion: 1, id: "x" }).success,
    ).toBe(false);
    expect(
      ingestSchemaRegistry
        .get("CoverageObligation", 1)
        .safeParse({ schemaVersion: 1, id: "x" }).success,
    ).toBe(false);
    expect(CoverageObligationSchema.parse(complete)).toEqual(complete);
    expect(
      CoverageObligationSchema.safeParse({
        ...complete,
        status: "open",
        ownerQuestionId: complete.questionId,
      }).success,
    ).toBe(false);
    expect(
      ingestSchemaRegistry.get("CoverageObligation", 1).parse(complete),
    ).toEqual(complete);
  });

  it("registers the canonical strict SourceRepresentation schema without a placeholder", () => {
    const valid = {
      schemaVersion: 1,
      id: "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      sourceFileId: `file-${"a".repeat(64)}`,
      version: 1,
      kind: "text",
      normalizedText: "line\n",
      locatorMap: [
        {
          kind: "line",
          normalized: {
            utf16Start: 0,
            utf16End: 4,
            lineStart: 1,
            lineEnd: 1,
            columnStart: 1,
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
      ],
      warnings: [],
    };

    expect(
      ingestSchemaRegistry.get("SourceRepresentation", 1).parse(valid),
    ).toEqual(valid);
    expect(
      ingestSchemaRegistry.get("SourceRepresentation", 1).safeParse({
        schemaVersion: 1,
        id: valid.id,
      }).success,
    ).toBe(false);
    expect(
      ingestSchemaRegistry
        .get("SourceRepresentation", 1)
        .safeParse({ ...valid, id: "" }).success,
    ).toBe(false);
    expect(
      ingestSchemaRegistry.get("SourceRepresentation", 1).safeParse({
        ...valid,
        locatorMap: [{ schemaVersion: 1, id: "placeholder-shaped" }],
      }).success,
    ).toBe(false);
  });

  it("registers a strict policy-consistent RepresentationAudit schema", () => {
    const current = {
      schemaVersion: 1,
      representationId: "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
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
    } as const;

    expect(
      ingestSchemaRegistry.get("RepresentationAudit", 1).parse(current),
    ).toEqual(current);
    expect(ingestSchemaRegistry.names()).toContain("RepresentationAudit");
    expect(
      ingestSchemaRegistry.get("RepresentationAudit", 1).safeParse({
        ...current,
        capability: { status: "unresolved" },
        tier: "D",
        claimEligible: true,
        findings: [
          {
            code: "INVALID_CAPABILITY",
            severity: "error",
            message: "Capability is invalid.",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects malformed capabilities and unsupported audit record shapes", () => {
    const capability = {
      schemaVersion: 1,
      id: "a-tier:text",
      version: 1,
      representationKind: "text",
      tier: "A",
      requiredChecks: ["mapping", "structure"],
    } as const;
    const audit = {
      schemaVersion: 1,
      representationId: "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      capability: { status: "resolved", id: capability.id, version: 1 },
      tier: "A",
      structuralPass: true,
      mappingPass: true,
      humanVerified: false,
      claimEligible: true,
      findings: [],
    } as const;

    expect(RepresentationCapabilitySchema.parse(capability)).toEqual(
      capability,
    );
    for (const requiredChecks of [
      ["structure", "mapping"],
      ["mapping", "mapping"],
    ]) {
      expect(
        RepresentationCapabilitySchema.safeParse({
          ...capability,
          requiredChecks,
        }).success,
      ).toBe(false);
    }
    for (const invalid of [
      { ...audit, schemaVersion: 0 },
      { ...audit, humanVerified: true },
      { ...audit, extra: true },
      {
        ...audit,
        capability: {
          status: "resolved",
          id: capability.id,
          version: Number.MAX_SAFE_INTEGER + 1,
        },
      },
      {
        ...audit,
        tier: "C",
        findings: [
          {
            code: "TIER_REQUIRES_UNIT_VERIFICATION",
            severity: "error",
            message: "Verification required.",
          },
        ],
      },
      {
        ...audit,
        findings: [{ code: "UNKNOWN", severity: "error", message: "Unknown." }],
      },
    ]) {
      expect(RepresentationAuditSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("fails unknown versions explicitly", () => {
    expect(() => ingestSchemaRegistry.get("SourceFile", 2 as 1)).toThrowError(
      /UNKNOWN_SCHEMA.*SourceFile.*2/,
    );
  });

  it("returns exact validation paths for malformed strict records", () => {
    const result = validateIngestRecord("SourceSnapshot", 1, {
      schemaVersion: 1,
      id: `snap-${"c".repeat(64)}`,
      packageSha256: "b".repeat(64),
      contentSha256: "c".repeat(64),
      policyId: "policy-01",
      files: [{ ...sourceFile, sha256: "a".repeat(63) }],
      exclusions: [],
      qualified: true,
      unexpected: true,
    });

    expect(result).toEqual({
      ok: false,
      code: "INVALID_RECORD",
      message: expect.stringContaining("files.0.sha256"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("unexpected");
  });
});
