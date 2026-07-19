import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type {
  Sha256,
  SnapshotId,
  SourceFile,
  SourceFileId,
  SourceRepresentationId,
} from "../domain/ingest/index.js";
import { SourceUnitSchema } from "../domain/ingest/index.js";
import {
  auditRepresentation,
  extractATier,
  unitizeRepresentation,
} from "../ingest/source/index.js";

const fixtures = new URL(
  "../ingest/source/fixtures/extraction/",
  import.meta.url,
);
const representationId =
  "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceRepresentationId;
const cases = [
  ["markdown-crlf.md", "text/markdown"],
  ["text-cr.txt", "text/plain"],
  ["code-lf.ts", "text/typescript"],
  ["object-crlf.json", "application/json"],
  ["mapping-lf.yaml", "application/yaml"],
  ["table-cr.csv", "text/csv"],
] as const;

function sourceFile(
  logicalPath: string,
  mediaType: string,
  bytes: Uint8Array,
): SourceFile {
  return {
    schemaVersion: 1,
    id: `file-${"a".repeat(64)}` as SourceFileId,
    snapshotId: `snap-${"b".repeat(64)}` as SnapshotId,
    logicalPath,
    mediaType,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex") as Sha256,
  };
}

const identities = { derive: () => representationId };

function expectDeepFrozen(value: unknown): void {
  expect(Object.isFrozen(value)).toBe(true);
  if (Array.isArray(value)) {
    for (const item of value) expectDeepFrozen(item);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) expectDeepFrozen(item);
  }
}

function expectAtomicCoverage(
  text: string,
  units: readonly {
    kind: string;
    normalizedLocator: { utf16Start: number; utf16End: number };
  }[],
): void {
  const counts = new Uint8Array(text.length);
  for (const unit of units) {
    if (unit.kind === "document") continue;
    for (
      let offset = unit.normalizedLocator.utf16Start;
      offset < unit.normalizedLocator.utf16End;
      offset += 1
    ) {
      if (!/\s/u.test(text[offset]!)) counts[offset] = counts[offset]! + 1;
    }
  }
  for (let offset = 0; offset < text.length; offset += 1) {
    if (!/\s/u.test(text[offset]!)) expect(counts[offset]).toBe(1);
  }
}

function qualifiedText(text: string, logicalPath = "docs/stability.txt") {
  const bytes = new TextEncoder().encode(text);
  const file = sourceFile(logicalPath, "text/plain", bytes);
  const extraction = extractATier({
    sourceFile: file,
    bytes,
    version: 1,
    identities,
  });
  if (!extraction.ok) throw new Error(extraction.message);
  const audit = auditRepresentation(extraction.value);
  if (!audit.ok) throw new Error(audit.message);
  const units = unitizeRepresentation({
    sourceFile: file,
    representation: extraction.value,
    audit: audit.value,
  });
  if (!units.ok) throw new Error(units.message);
  return units.value;
}

function qualifiedMarkdown(text: string, logicalPath = "docs/stability.md") {
  const bytes = new TextEncoder().encode(text);
  const file = sourceFile(logicalPath, "text/markdown", bytes);
  const extraction = extractATier({
    sourceFile: file,
    bytes,
    version: 1,
    identities,
  });
  if (!extraction.ok) throw new Error(extraction.message);
  const audit = auditRepresentation(extraction.value);
  if (!audit.ok) throw new Error(audit.message);
  const units = unitizeRepresentation({
    sourceFile: file,
    representation: extraction.value,
    audit: audit.value,
  });
  if (!units.ok) throw new Error(units.message);
  return units.value;
}

describe("public extraction-to-unitization seam", () => {
  it.each(cases)(
    "unitizes %s twice with canonical tree and complete atomic coverage",
    async (name, mediaType) => {
      const bytes = new Uint8Array(await readFile(new URL(name, fixtures)));
      const file = sourceFile(`fixtures/${name}`, mediaType, bytes);
      const extraction = extractATier({
        sourceFile: file,
        bytes,
        version: 1,
        identities,
      });
      if (!extraction.ok) throw new Error(extraction.message);
      const audit = auditRepresentation(extraction.value);
      if (!audit.ok) throw new Error(audit.message);

      const input = {
        sourceFile: file,
        representation: extraction.value,
        audit: audit.value,
      };
      const first = unitizeRepresentation(input);
      const second = unitizeRepresentation(structuredClone(input));
      expect(first).toEqual(second);
      expect(first).toMatchObject({ ok: true });
      if (!first.ok) return;

      expect(first.value[0]?.kind).toBe("document");
      expect(new Set(first.value.map((unit) => unit.id)).size).toBe(
        first.value.length,
      );
      const positions = new Map(
        first.value.map((unit, index) => [unit.id, index]),
      );
      for (const [index, unit] of first.value.entries()) {
        expect(SourceUnitSchema.parse(unit)).toEqual(unit);
        if (unit.parentId)
          expect(positions.get(unit.parentId)).toBeLessThan(index);
      }
      expectAtomicCoverage(extraction.value.normalizedText, first.value);
      expectDeepFrozen(first.value);
    },
  );

  it("preserves unaffected IDs while changing edited or re-anchored units", () => {
    const before = qualifiedText("Alpha\n\nBeta\n");
    const inserted = qualifiedText("New\n\nAlpha\n\nBeta\n");
    const edited = qualifiedText("Alpha changed\n\nBeta\n");
    const paragraphByHash = (units: typeof before) =>
      new Map(
        units
          .filter((unit) => unit.kind === "paragraph")
          .map((unit) => [unit.textSha256, unit.id]),
      );
    const beforeIds = paragraphByHash(before);
    expect(paragraphByHash(inserted).get(before[1]!.textSha256)).toBe(
      beforeIds.get(before[1]!.textSha256),
    );
    expect(paragraphByHash(inserted).get(before[2]!.textSha256)).toBe(
      beforeIds.get(before[2]!.textSha256),
    );
    expect(paragraphByHash(edited).has(before[1]!.textSha256)).toBe(false);

    const underA = qualifiedMarkdown("# A\n\nSame text\n");
    const underB = qualifiedMarkdown("# B\n\nSame text\n");
    const paragraphA = underA.find((unit) => unit.kind === "paragraph")!;
    const paragraphB = underB.find((unit) => unit.kind === "paragraph")!;
    expect(paragraphA.textSha256).toBe(paragraphB.textSha256);
    expect(paragraphA.id).not.toBe(paragraphB.id);
  });
});
