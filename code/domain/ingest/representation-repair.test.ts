import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  auditRepresentation,
  unitizeRepresentation,
} from "../../ingest/source/index.js";
import { SourceRepresentationSchema } from "./schemas.js";
import type {
  Sha256,
  SnapshotId,
  SourceFile,
  SourceFileId,
  SourceRepresentation,
  SourceRepresentationId,
  SourceUnit,
} from "./index.js";

import {
  CorrectionArtifactSchema,
  InvalidationRequestSchema,
  REPAIR_TERMINAL_STATES,
  RepresentationRepairApprovalSchema,
  RepresentationRepairRejectionSchema,
  RepresentationRepairSchema,
  canonicalUnitRecord,
  computeInvalidation,
} from "./representation-repair.js";

function sha256(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}

const SNAPSHOT_ID = `snap-${"b".repeat(64)}` as SnapshotId;
const SOURCE_FILE_ID = `file-${"a".repeat(64)}` as SourceFileId;
const FAULTY_REPRESENTATION_ID =
  "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceRepresentationId;
const CORRECTED_REPRESENTATION_ID =
  "repr-01ARZ3NDEKTSV4RRFFQ69G5FBW" as SourceRepresentationId;
const REPAIR_ID = "rpr-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CORRECTION_ARTIFACT_ID = "cor-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const INVALIDATION_REQUEST_ID = "inv-01ARZ3NDEKTSV4RRFFQ69G5FAV";

/**
 * Builds units through the real unitizer so identities and digests are
 * authentic. Hand-cast units would let a broken canonical comparison pass.
 */
function unitsFor(
  text: string,
  representationId: SourceRepresentationId,
): readonly SourceUnit[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let offset = 0;
  const locatorMap: SourceRepresentation["locatorMap"] = lines.map(
    (line, index) => {
      const start = offset;
      const end = start + line.length;
      offset = end + 1;
      const span = {
        utf16Start: start,
        utf16End: end,
        lineStart: index + 1,
        columnStart: 1,
        lineEnd: index + 1,
        columnEnd: line.length + 1,
      };
      return {
        kind: "line" as const,
        normalized: span,
        original: {
          byteStart: start,
          byteEnd: end,
          lineStart: index + 1,
          columnStart: 1,
          lineEnd: index + 1,
          columnEnd: line.length + 1,
        },
      };
    },
  );
  const representation: SourceRepresentation = {
    schemaVersion: 1,
    id: representationId,
    sourceFileId: SOURCE_FILE_ID,
    version: 1,
    kind: "markdown",
    normalizedText: text,
    locatorMap,
    warnings: [],
  };
  const sourceFile: SourceFile = {
    schemaVersion: 1,
    id: SOURCE_FILE_ID,
    snapshotId: SNAPSHOT_ID,
    logicalPath: "docs/guide.md",
    mediaType: "text/markdown",
    size: Buffer.byteLength(text),
    sha256: sha256(text),
  };
  const audited = auditRepresentation(representation);
  if (!audited.ok) throw new Error(audited.message);
  const unitized = unitizeRepresentation({
    sourceFile,
    representation,
    audit: audited.value,
  });
  if (!unitized.ok) throw new Error(unitized.message);
  return unitized.value;
}

/**
 * The empirically verified locator-drift corpus. Only the intro paragraph is
 * rewritten, and it gets longer. The `Stable` section and its paragraph keep
 * byte-identical unit IDs while every locator field shifts, which is exactly
 * the case a removed-IDs-only invalidation rule misses.
 */
const FAULTY_TEXT = [
  "# Guide",
  "",
  "Short intro.",
  "",
  "## Stable",
  "",
  "This paragraph never changes.",
  "",
].join("\n");

const CORRECTED_TEXT = [
  "# Guide",
  "",
  "A considerably longer corrected intro paragraph.",
  "",
  "## Stable",
  "",
  "This paragraph never changes.",
  "",
].join("\n");

function faultyUnits(): readonly SourceUnit[] {
  return unitsFor(FAULTY_TEXT, FAULTY_REPRESENTATION_ID);
}

function correctedUnits(): readonly SourceUnit[] {
  return unitsFor(CORRECTED_TEXT, CORRECTED_REPRESENTATION_ID);
}

function validProposal() {
  return {
    schemaVersion: 1,
    id: REPAIR_ID,
    sourceFileId: SOURCE_FILE_ID,
    representationId: FAULTY_REPRESENTATION_ID,
    correctionArtifactId: CORRECTION_ARTIFACT_ID,
    candidateRepresentationId: CORRECTED_REPRESENTATION_ID,
    proposedBy: "alex.review-1",
    reason: "Extraction dropped the intro paragraph.",
    expectedRevision: 3,
    idempotencyKey: "repair-guide-intro-1",
    state: "proposed",
  };
}

function validApproval() {
  return {
    schemaVersion: 1,
    repairId: REPAIR_ID,
    approvedBy: "alex.review-1",
    reason: "Verified against the original document.",
    approvedRevision: 3,
  };
}

describe("representation repair records are strict and append-only", () => {
  it("accepts a well formed repair proposal", () => {
    expect(RepresentationRepairSchema.parse(validProposal())).toMatchObject({
      id: REPAIR_ID,
      state: "proposed",
    });
  });

  it("rejects unknown fields on a proposal", () => {
    const result = RepresentationRepairSchema.safeParse({
      ...validProposal(),
      editedBy: "alex.review-1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a proposal identity that is not a prefixed ULID", () => {
    const result = RepresentationRepairSchema.safeParse({
      ...validProposal(),
      id: "rpr-not-a-ulid",
    });
    expect(result.success).toBe(false);
  });

  it("requires a nonblank rationale on a proposal", () => {
    for (const reason of ["", "   ", "\t\n"]) {
      const result = RepresentationRepairSchema.safeParse({
        ...validProposal(),
        reason,
      });
      expect(result.success).toBe(false);
    }
  });

  it("requires a nonblank rationale on an approval", () => {
    const result = RepresentationRepairApprovalSchema.safeParse({
      ...validApproval(),
      reason: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("requires a nonblank rationale on a rejection", () => {
    const result = RepresentationRepairRejectionSchema.safeParse({
      schemaVersion: 1,
      repairId: REPAIR_ID,
      rejectedBy: "alex.review-1",
      reason: "",
    });
    expect(result.success).toBe(false);
  });

  it("requires a stable actor handle on an approval", () => {
    const result = RepresentationRepairApprovalSchema.safeParse({
      ...validApproval(),
      approvedBy: "Not A Handle",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty actor handle even though settings allow one", () => {
    // ActorHandleSchema permits "" for unconfigured settings; an approval must
    // name a person, so the repair contract must not inherit that allowance.
    const result = RepresentationRepairApprovalSchema.safeParse({
      ...validApproval(),
      approvedBy: "",
    });
    expect(result.success).toBe(false);
  });

  it("requires a positive integer expected revision", () => {
    for (const expectedRevision of [0, -1, 1.5]) {
      const result = RepresentationRepairSchema.safeParse({
        ...validProposal(),
        expectedRevision,
      });
      expect(result.success).toBe(false);
    }
  });

  it("requires a nonblank idempotency key", () => {
    const result = RepresentationRepairSchema.safeParse({
      ...validProposal(),
      idempotencyKey: "",
    });
    expect(result.success).toBe(false);
  });

  it("pins the terminal repair states", () => {
    expect(REPAIR_TERMINAL_STATES).toEqual(["approved", "rejected"]);
  });

  it("accepts a well formed correction artifact", () => {
    expect(
      CorrectionArtifactSchema.parse({
        schemaVersion: 1,
        id: CORRECTION_ARTIFACT_ID,
        sourceFileId: SOURCE_FILE_ID,
        supersedesRepresentationId: FAULTY_REPRESENTATION_ID,
        sha256: sha256(CORRECTED_TEXT),
        size: Buffer.byteLength(CORRECTED_TEXT),
      }),
    ).toMatchObject({ id: CORRECTION_ARTIFACT_ID });
  });

  it("rejects a correction artifact carrying corrected source text", () => {
    // Corrected bytes live in the append-only artifact store, never inline in
    // a portable record, so custody stays with the store that owns it.
    const result = CorrectionArtifactSchema.safeParse({
      schemaVersion: 1,
      id: CORRECTION_ARTIFACT_ID,
      sourceFileId: SOURCE_FILE_ID,
      supersedesRepresentationId: FAULTY_REPRESENTATION_ID,
      sha256: sha256(CORRECTED_TEXT),
      size: Buffer.byteLength(CORRECTED_TEXT),
      normalizedText: CORRECTED_TEXT,
    });
    expect(result.success).toBe(false);
  });

  it("accepts an invalidation request with sorted unique unit identities", () => {
    const units = faultyUnits();
    const unitIds = [...units.map((unit) => unit.id)].sort();
    expect(
      InvalidationRequestSchema.parse({
        schemaVersion: 1,
        id: INVALIDATION_REQUEST_ID,
        repairId: REPAIR_ID,
        sourceFileId: SOURCE_FILE_ID,
        unitIds,
      }),
    ).toMatchObject({ id: INVALIDATION_REQUEST_ID });
  });

  it("rejects an invalidation request whose unit identities are unsorted", () => {
    const unitIds = [...faultyUnits().map((unit) => unit.id)].sort().reverse();
    const result = InvalidationRequestSchema.safeParse({
      schemaVersion: 1,
      id: INVALIDATION_REQUEST_ID,
      repairId: REPAIR_ID,
      sourceFileId: SOURCE_FILE_ID,
      unitIds,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalidation request repeating a unit identity", () => {
    const [first] = faultyUnits();
    const result = InvalidationRequestSchema.safeParse({
      schemaVersion: 1,
      id: INVALIDATION_REQUEST_ID,
      repairId: REPAIR_ID,
      sourceFileId: SOURCE_FILE_ID,
      unitIds: [first!.id, first!.id],
    });
    expect(result.success).toBe(false);
  });
});

describe("source representation gains an optional supersedes link", () => {
  it("accepts a repaired representation carrying supersedesId", () => {
    const [unit] = faultyUnits();
    expect(unit).toBeDefined();
    const repaired = {
      schemaVersion: 1,
      id: CORRECTED_REPRESENTATION_ID,
      sourceFileId: SOURCE_FILE_ID,
      version: 2,
      kind: "markdown",
      normalizedText: CORRECTED_TEXT,
      locatorMap: [],
      warnings: [],
      supersedesId: FAULTY_REPRESENTATION_ID,
    };
    expect(SourceRepresentationSchema.parse(repaired)).toMatchObject({
      version: 2,
      supersedesId: FAULTY_REPRESENTATION_ID,
    });
  });

  it("keeps legacy representations without supersedesId readable", () => {
    const legacy = {
      schemaVersion: 1,
      id: FAULTY_REPRESENTATION_ID,
      sourceFileId: SOURCE_FILE_ID,
      version: 1,
      kind: "markdown",
      normalizedText: FAULTY_TEXT,
      locatorMap: [],
      warnings: [],
    };
    const parsed = SourceRepresentationSchema.parse(legacy);
    expect(parsed).toMatchObject({ version: 1 });
    expect("supersedesId" in parsed).toBe(false);
  });

  it("rejects a supersedes link that is not a representation identity", () => {
    // Asserts the accepting case first, so this cannot pass merely because the
    // pre-migration strict schema rejects `supersedesId` as an unknown key.
    const base = {
      schemaVersion: 1,
      id: CORRECTED_REPRESENTATION_ID,
      sourceFileId: SOURCE_FILE_ID,
      version: 2,
      kind: "markdown",
      normalizedText: CORRECTED_TEXT,
      locatorMap: [],
      warnings: [],
    };
    expect(
      SourceRepresentationSchema.safeParse({
        ...base,
        supersedesId: FAULTY_REPRESENTATION_ID,
      }).success,
    ).toBe(true);
    expect(
      SourceRepresentationSchema.safeParse({
        ...base,
        supersedesId: SOURCE_FILE_ID,
      }).success,
    ).toBe(false);
  });

  it("rejects a representation that supersedes itself", () => {
    const base = {
      schemaVersion: 1,
      id: CORRECTED_REPRESENTATION_ID,
      sourceFileId: SOURCE_FILE_ID,
      version: 2,
      kind: "markdown",
      normalizedText: CORRECTED_TEXT,
      locatorMap: [],
      warnings: [],
    };
    expect(
      SourceRepresentationSchema.safeParse({
        ...base,
        supersedesId: FAULTY_REPRESENTATION_ID,
      }).success,
    ).toBe(true);
    expect(
      SourceRepresentationSchema.safeParse({
        ...base,
        supersedesId: CORRECTED_REPRESENTATION_ID,
      }).success,
    ).toBe(false);
  });
});

describe("canonical unit record encoding", () => {
  it("is stable across key insertion order", () => {
    const [unit] = faultyUnits();
    const reordered = {
      textSha256: unit!.textSha256,
      originalLocator: { ...unit!.originalLocator },
      normalizedLocator: { ...unit!.normalizedLocator },
      headingPath: [...unit!.headingPath],
      kind: unit!.kind,
      representationId: unit!.representationId,
      sourceFileId: unit!.sourceFileId,
      snapshotId: unit!.snapshotId,
      id: unit!.id,
      schemaVersion: unit!.schemaVersion,
    } as unknown as SourceUnit;
    expect(canonicalUnitRecord(reordered)).toBe(canonicalUnitRecord(unit!));
  });

  it("changes when a locator field changes", () => {
    const [unit] = faultyUnits();
    const shifted = {
      ...unit!,
      normalizedLocator: {
        ...unit!.normalizedLocator,
        utf16Start: unit!.normalizedLocator.utf16Start + 1,
      },
    };
    expect(canonicalUnitRecord(shifted)).not.toBe(canonicalUnitRecord(unit!));
  });

  it("changes when representation provenance changes", () => {
    const [unit] = faultyUnits();
    const rebound = {
      ...unit!,
      representationId: CORRECTED_REPRESENTATION_ID,
    };
    expect(canonicalUnitRecord(rebound)).not.toBe(canonicalUnitRecord(unit!));
  });
});

describe("invalidation is the union of removed and changed units", () => {
  it("returns nothing when the two unit sets are identical", () => {
    const units = faultyUnits();
    expect(computeInvalidation(units, units)).toEqual([]);
  });

  it("returns nothing for records that are canonically identical", () => {
    const units = faultyUnits();
    const cloned = units.map((unit) => structuredClone(unit));
    expect(computeInvalidation(units, cloned)).toEqual([]);
  });

  it("includes units removed by the repair", () => {
    const units = faultyUnits();
    const [removed, ...kept] = units;
    expect(computeInvalidation(units, kept)).toEqual([removed!.id]);
  });

  it("excludes units added by the repair", () => {
    const units = faultyUnits();
    const kept = units.slice(1);
    expect(computeInvalidation(kept, units)).toEqual([]);
  });

  it("classifies two locator-drifted and one provenance-only shared unit", () => {
    // The empirical case. Only the intro paragraph changed, but the Stable
    // section and its paragraph both moved. Their IDs are byte-identical, so a
    // removed-IDs-only rule reports nothing for them.
    const before = faultyUnits();
    const after = correctedUnits();
    const afterById = new Map(after.map((unit) => [unit.id, unit]));
    const locatorDrifted = before.filter((unit) => {
      const next = afterById.get(unit.id);
      return (
        next !== undefined &&
        (JSON.stringify(next.normalizedLocator) !==
          JSON.stringify(unit.normalizedLocator) ||
          JSON.stringify(next.originalLocator) !==
            JSON.stringify(unit.originalLocator))
      );
    });
    const provenanceOnly = before.filter((unit) => {
      const next = afterById.get(unit.id);
      return (
        next !== undefined &&
        next.representationId !== unit.representationId &&
        next.snapshotId === unit.snapshotId &&
        next.sourceFileId === unit.sourceFileId &&
        next.kind === unit.kind &&
        // The parent identity is representation-derived provenance too: the
        // shared paragraph points at the repaired document's new root ID.
        JSON.stringify(next.headingPath) === JSON.stringify(unit.headingPath) &&
        JSON.stringify(next.normalizedLocator) ===
          JSON.stringify(unit.normalizedLocator) &&
        JSON.stringify(next.originalLocator) ===
          JSON.stringify(unit.originalLocator) &&
        next.textSha256 === unit.textSha256
      );
    });
    expect(locatorDrifted).toHaveLength(2);
    expect(provenanceOnly).toHaveLength(1);
    const invalidation = computeInvalidation(before, after);
    for (const unit of [...locatorDrifted, ...provenanceOnly]) {
      expect(invalidation).toContain(unit.id);
    }
  });

  it("counts strictly more than the removed-only rule would", () => {
    // Pins the regression directly: 2 removed plus 3 shared canonical changes.
    const before = faultyUnits();
    const after = correctedUnits();
    const afterById = new Map(after.map((unit) => [unit.id, unit]));
    const removedOnly = before
      .filter((unit) => !afterById.has(unit.id))
      .map((unit) => unit.id);
    const changedShared = before.filter((unit) => {
      const next = afterById.get(unit.id);
      return (
        next !== undefined &&
        canonicalUnitRecord(next) !== canonicalUnitRecord(unit)
      );
    });
    const invalidation = computeInvalidation(before, after);
    expect(removedOnly).toHaveLength(2);
    expect(changedShared).toHaveLength(3);
    expect(invalidation).toEqual(
      [...removedOnly, ...changedShared.map((unit) => unit.id)].sort(),
    );
  });

  it("returns a sorted unique identity list", () => {
    const invalidation = computeInvalidation(faultyUnits(), correctedUnits());
    expect(invalidation).toEqual([...new Set(invalidation)].sort());
  });

  it("is deterministic across repeated calls", () => {
    const before = faultyUnits();
    const after = correctedUnits();
    expect(computeInvalidation(before, after)).toEqual(
      computeInvalidation(before, after),
    );
  });

  it("does not mutate either unit set", () => {
    const before = faultyUnits();
    const after = correctedUnits();
    const snapshot = structuredClone({ before, after });
    computeInvalidation(before, after);
    expect({ before, after }).toEqual(snapshot);
  });

  it("returns a frozen result", () => {
    expect(
      Object.isFrozen(computeInvalidation(faultyUnits(), correctedUnits())),
    ).toBe(true);
  });
});
