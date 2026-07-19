import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  IngestResult,
  RepresentationAudit,
  Sha256,
  SourceFile,
  SourceRepresentation,
  SourceUnit,
  SourceUnitId,
  SourceUnitKind,
} from "../../domain/ingest/index.js";
import {
  RepresentationAuditSchema,
  SourceFileSchema,
  SourceRepresentationSchema,
  SourceUnitIdSchema,
  SourceUnitSchema,
} from "../../domain/ingest/index.js";
import {
  auditRepresentation,
  capabilityFor,
} from "./representation-auditor.js";

export interface UnitizeRepresentationInput {
  readonly sourceFile: SourceFile;
  readonly representation: SourceRepresentation;
  readonly audit: RepresentationAudit;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function sha256(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}

function unitId(input: {
  readonly logicalPath: string;
  readonly anchor: readonly {
    readonly heading: string;
    readonly occurrence: number;
  }[];
  readonly kind: SourceUnitKind;
  readonly textSha256: Sha256;
  readonly duplicateOrdinal: number;
}): SourceUnitId {
  const key = JSON.stringify({
    logicalPath: input.logicalPath,
    anchor: input.anchor,
    kind: input.kind,
    textSha256: input.textSha256,
    duplicateOrdinal: input.duplicateOrdinal,
  });
  const bytes = createHash("sha256").update(key).digest().subarray(0, 16);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD[Number(value & 31n)]! + encoded;
    value >>= 5n;
  }
  return SourceUnitIdSchema.parse(`unit-${encoded}`);
}

function hasPlainPrototype(input: unknown): input is Record<string, unknown> {
  return (
    typeof input === "object" &&
    input !== null &&
    Object.getPrototypeOf(input) === Object.prototype
  );
}

function hasPlainRepresentation(input: unknown): boolean {
  if (!hasPlainPrototype(input)) return false;
  if (!Array.isArray(input.locatorMap) || !Array.isArray(input.warnings)) {
    return false;
  }
  for (const value of input.locatorMap) {
    if (!hasPlainPrototype(value)) return false;
    if (
      !hasPlainPrototype(value.normalized) ||
      !hasPlainPrototype(value.original) ||
      (value.cell !== undefined && !hasPlainPrototype(value.cell))
    ) {
      return false;
    }
  }
  for (const value of input.warnings) {
    if (!hasPlainPrototype(value) || !hasPlainPrototype(value.location)) {
      return false;
    }
  }
  return true;
}

function hasPlainAudit(input: unknown): boolean {
  if (!hasPlainPrototype(input)) return false;
  if (!hasPlainPrototype(input.capability) || !Array.isArray(input.findings)) {
    return false;
  }
  return input.findings.every(
    (value) =>
      hasPlainPrototype(value) &&
      (value.cell === undefined || hasPlainPrototype(value.cell)),
  );
}

function qualificationFailure(
  message: string,
): IngestResult<never, "AUDIT_REQUIRED"> {
  return { ok: false, code: "AUDIT_REQUIRED", message };
}

function textDropped(message: string): IngestResult<never, "TEXT_DROPPED"> {
  return { ok: false, code: "TEXT_DROPPED", message };
}

function freezeUnits(units: readonly SourceUnit[]): readonly SourceUnit[] {
  for (const unit of units) {
    Object.freeze(unit.headingPath);
    Object.freeze(unit.normalizedLocator);
    Object.freeze(unit.originalLocator);
    Object.freeze(unit);
  }
  return Object.freeze(units);
}

export function unitizeRepresentation(
  input: UnitizeRepresentationInput,
): IngestResult<readonly SourceUnit[], "AUDIT_REQUIRED" | "TEXT_DROPPED"> {
  if (!hasPlainPrototype(input) || !hasPlainPrototype(input.sourceFile)) {
    return qualificationFailure(
      "Canonical plain source-file input is required.",
    );
  }
  if (
    !hasPlainRepresentation(input.representation) ||
    !hasPlainAudit(input.audit)
  ) {
    return qualificationFailure(
      "Canonical plain representation audit input is required.",
    );
  }

  const sourceFileResult = SourceFileSchema.safeParse(input.sourceFile);
  const representationResult = SourceRepresentationSchema.safeParse(
    input.representation,
  );
  const auditResult = RepresentationAuditSchema.safeParse(input.audit);
  if (
    !sourceFileResult.success ||
    !representationResult.success ||
    !auditResult.success
  ) {
    return qualificationFailure(
      "Canonical source-file, representation, and audit records are required.",
    );
  }
  const sourceFile = sourceFileResult.data as SourceFile;
  const representation = representationResult.data as SourceRepresentation;
  const audit = auditResult.data as RepresentationAudit;
  const capability = capabilityFor(representation.kind);
  if (
    sourceFile.id !== representation.sourceFileId ||
    audit.representationId !== representation.id ||
    capability === undefined ||
    audit.capability.status !== "resolved" ||
    audit.capability.id !== capability.id ||
    audit.capability.version !== capability.version ||
    audit.tier !== "A" ||
    !audit.structuralPass ||
    !audit.mappingPass ||
    !audit.claimEligible
  ) {
    return qualificationFailure(
      "A matching eligible built-in representation audit is required.",
    );
  }
  const currentAudit = auditRepresentation(representation);
  if (!currentAudit.ok || !isDeepStrictEqual(currentAudit.value, audit)) {
    return qualificationFailure(
      "The representation no longer matches its audit.",
    );
  }

  if (
    sourceFile.size !== 0 ||
    representation.normalizedText !== "" ||
    representation.locatorMap.length !== 0
  ) {
    return textDropped(
      "Structural units cannot yet account for the qualified text.",
    );
  }

  const textSha256 = sha256("");
  const parsedUnit = SourceUnitSchema.parse({
    schemaVersion: 1,
    id: unitId({
      logicalPath: sourceFile.logicalPath,
      anchor: [],
      kind: "document",
      textSha256,
      duplicateOrdinal: 1,
    }),
    snapshotId: sourceFile.snapshotId,
    sourceFileId: sourceFile.id,
    representationId: representation.id,
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
    textSha256,
  }) as SourceUnit;

  return { ok: true, value: freezeUnits([parsedUnit]) };
}
