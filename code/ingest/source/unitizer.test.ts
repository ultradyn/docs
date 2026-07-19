import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  RepresentationAudit,
  Sha256,
  SnapshotId,
  SourceFile,
  SourceFileId,
  SourceRepresentation,
  SourceRepresentationId,
} from "../../domain/ingest/index.js";
import { SourceUnitSchema } from "../../domain/ingest/index.js";
import { auditRepresentation, unitizeRepresentation } from "./index.js";

const SNAPSHOT_ID = `snap-${"b".repeat(64)}` as SnapshotId;
const SOURCE_FILE_ID = `file-${"a".repeat(64)}` as SourceFileId;
const REPRESENTATION_ID =
  "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceRepresentationId;

function sha256(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}

function emptyInput(): {
  sourceFile: SourceFile;
  representation: SourceRepresentation;
  audit: RepresentationAudit;
} {
  const sourceFile: SourceFile = {
    schemaVersion: 1,
    id: SOURCE_FILE_ID,
    snapshotId: SNAPSHOT_ID,
    logicalPath: "docs/empty.txt",
    mediaType: "text/plain",
    size: 0,
    sha256: sha256(""),
  };
  const representation: SourceRepresentation = {
    schemaVersion: 1,
    id: REPRESENTATION_ID,
    sourceFileId: SOURCE_FILE_ID,
    version: 1,
    kind: "text",
    normalizedText: "",
    locatorMap: [],
    warnings: [],
  };
  const audited = auditRepresentation(representation);
  if (!audited.ok) throw new Error(audited.message);
  return { sourceFile, representation, audit: audited.value };
}

function expectDeepFrozen(value: unknown): void {
  expect(Object.isFrozen(value)).toBe(true);
  if (Array.isArray(value)) {
    for (const item of value) expectDeepFrozen(item);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) expectDeepFrozen(item);
  }
}

describe("unitizeRepresentation", () => {
  it("creates one deterministic zero-byte document unit", () => {
    const input = emptyInput();
    const first = unitizeRepresentation(input);
    const second = unitizeRepresentation(structuredClone(input));

    expect(first).toEqual(second);
    expect(first).toEqual({
      ok: true,
      value: [
        {
          schemaVersion: 1,
          id: "unit-2269JBVTNCMWXT7V7WSJHGG4B4",
          snapshotId: SNAPSHOT_ID,
          sourceFileId: SOURCE_FILE_ID,
          representationId: REPRESENTATION_ID,
          kind: "document",
          headingPath: [],
          normalizedLocator: {
            utf16Start: 0,
            utf16End: 0,
            lineStart: 1,
            columnStart: 1,
            lineEnd: 1,
            columnEnd: 1,
          },
          originalLocator: {
            byteStart: 0,
            byteEnd: 0,
            lineStart: 1,
            columnStart: 1,
            lineEnd: 1,
            columnEnd: 1,
          },
          textSha256: sha256(""),
        },
      ],
    });
    if (first.ok) {
      expect(SourceUnitSchema.parse(first.value[0])).toEqual(first.value[0]);
      expectDeepFrozen(first.value);
    }
  });

  it("requires exact canonical provenance and a fresh matching built-in audit", () => {
    const base = emptyInput();
    const customAudit: RepresentationAudit = {
      ...base.audit,
      capability: { status: "resolved", id: "a-tier:custom", version: 1 },
    };
    const ineligible: RepresentationAudit = {
      ...base.audit,
      tier: "C",
      structuralPass: true,
      mappingPass: true,
      humanVerified: false,
      claimEligible: false,
      findings: [
        {
          code: "TIER_REQUIRES_UNIT_VERIFICATION",
          severity: "error",
          message:
            "Tier C requires named human verification per selected source unit.",
        },
      ],
    };
    const cases: readonly [string, UnitizeInput][] = [
      [
        "source-file binding",
        {
          ...base,
          representation: {
            ...base.representation,
            sourceFileId: `file-${"c".repeat(64)}` as SourceFileId,
          },
        },
      ],
      ["custom audit", { ...base, audit: customAudit }],
      ["ineligible audit", { ...base, audit: ineligible }],
      [
        "post-audit mutation",
        {
          ...base,
          representation: {
            ...base.representation,
            normalizedText: "changed",
          },
        },
      ],
    ];

    for (const [label, input] of cases) {
      expect(unitizeRepresentation(input), label).toMatchObject({
        ok: false,
        code: "AUDIT_REQUIRED",
      });
    }
    const inherited = Object.create(base) as UnitizeInput;
    expect(unitizeRepresentation(inherited)).toMatchObject({
      ok: false,
      code: "AUDIT_REQUIRED",
    });
  });

  it("requires a qualifying audit for non-empty unmappable text", () => {
    const base = emptyInput();
    const representation: SourceRepresentation = {
      ...base.representation,
      normalizedText: "x",
      locatorMap: [],
    };
    const audited = auditRepresentation(representation);
    expect(audited.ok).toBe(true);
    if (!audited.ok) return;

    expect(
      unitizeRepresentation({
        sourceFile: { ...base.sourceFile, size: 1, sha256: sha256("x") },
        representation,
        audit: audited.value,
      }),
    ).toMatchObject({ ok: false, code: "AUDIT_REQUIRED" });
  });
});

type UnitizeInput = ReturnType<typeof emptyInput>;
