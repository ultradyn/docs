import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type {
  Sha256,
  SnapshotId,
  SourceFile,
  SourceFileId,
  SourceRepresentation,
  SourceRepresentationId,
  SourceRepresentationKind,
} from "../domain/ingest/index.js";
import { RepresentationAuditSchema } from "../domain/ingest/index.js";
import { auditRepresentation, extractATier } from "../ingest/source/index.js";

const fixtures = new URL(
  "../ingest/source/fixtures/extraction/",
  import.meta.url,
);

function sha256(bytes: Uint8Array): Sha256 {
  return createHash("sha256").update(bytes).digest("hex") as Sha256;
}

function sourceFile(mediaType: string, bytes: Uint8Array): SourceFile {
  return {
    schemaVersion: 1,
    id: `file-${"a".repeat(64)}` as SourceFileId,
    snapshotId: `snap-${"b".repeat(64)}` as SnapshotId,
    logicalPath: "fixture.bin",
    mediaType,
    size: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

const identities = {
  derive(input: {
    sourceFileId: SourceFileId;
    version: number;
    kind: SourceRepresentationKind;
  }): SourceRepresentationId {
    void input;
    return "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceRepresentationId;
  },
};

function reordered(representation: SourceRepresentation): SourceRepresentation {
  return {
    ...representation,
    locatorMap: [
      representation.locatorMap[1]!,
      representation.locatorMap[0]!,
      ...representation.locatorMap.slice(2),
    ],
  };
}

describe("public extraction-to-audit seam", () => {
  it.each([
    ["markdown-crlf.md", "text/markdown"],
    ["table-cr.csv", "text/csv"],
    ["quoted-multiline.csv", "text/csv"],
  ])(
    "qualifies %s deterministically and rejects post-extraction reordering",
    async (name, mediaType) => {
      const bytes = new Uint8Array(await readFile(new URL(name, fixtures)));
      const firstExtraction = extractATier({
        sourceFile: sourceFile(mediaType, bytes),
        bytes,
        version: 1,
        identities,
      });
      const secondExtraction = extractATier({
        sourceFile: sourceFile(mediaType, bytes),
        bytes,
        version: 1,
        identities,
      });

      expect(firstExtraction).toEqual(secondExtraction);
      expect(firstExtraction.ok).toBe(true);
      if (!firstExtraction.ok) return;
      const original = structuredClone(firstExtraction.value);
      const firstAudit = auditRepresentation(firstExtraction.value);
      const secondAudit = auditRepresentation(
        secondExtraction.ok ? secondExtraction.value : undefined,
      );

      expect(firstAudit).toEqual(secondAudit);
      expect(firstAudit).toMatchObject({
        ok: true,
        value: {
          tier: "A",
          structuralPass: true,
          mappingPass: true,
          claimEligible: true,
          findings: [],
        },
      });
      if (firstAudit.ok) {
        expect(RepresentationAuditSchema.parse(firstAudit.value)).toEqual(
          firstAudit.value,
        );
      }

      const corrupted = auditRepresentation(reordered(firstExtraction.value));
      expect(corrupted).toMatchObject({
        ok: true,
        value: {
          claimEligible: false,
          findings: expect.arrayContaining([
            expect.objectContaining({
              code:
                firstExtraction.value.kind === "csv"
                  ? "CSV_CELL_ORDER_INVALID"
                  : "LOCATOR_ORDER_INVALID",
            }),
          ]),
        },
      });
      expect(firstExtraction.value).toEqual(original);
      expect(Object.isFrozen(firstExtraction.value)).toBe(true);
      expect(Object.isFrozen(firstExtraction.value.locatorMap)).toBe(true);
    },
  );
});
