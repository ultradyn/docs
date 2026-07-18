import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  SourceRepresentationSchema,
  type Sha256,
  type SnapshotId,
  type SourceFile,
  type SourceFileId,
  type SourceRepresentationId,
} from "../domain/ingest/index.js";
import { extractATier } from "../ingest/source/index.js";

const fixtures = new URL(
  "../ingest/source/fixtures/extraction/",
  import.meta.url,
);
const representationId =
  "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceRepresentationId;
const cases = [
  ["markdown-crlf.md", "markdown-crlf.expected.json", "text/markdown"],
  ["text-cr.txt", "text-cr.expected.json", "text/plain"],
  ["code-lf.ts", "code-lf.expected.json", "text/typescript"],
  ["object-crlf.json", "object-crlf.expected.json", "application/json"],
  ["mapping-lf.yaml", "mapping-lf.expected.json", "application/yaml"],
  ["table-cr.csv", "table-cr.expected.json", "text/csv"],
] as const;

function sourceFile(mediaType: string, bytes: Uint8Array): SourceFile {
  return {
    schemaVersion: 1,
    id: `file-${"a".repeat(64)}` as SourceFileId,
    snapshotId: `snap-${"b".repeat(64)}` as SnapshotId,
    logicalPath: "fixture.input",
    mediaType,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex") as Sha256,
  };
}

const identities = { derive: () => representationId };

describe("A-tier extractor golden integration", () => {
  it.each(cases)(
    "loads %s through the public source barrel twice and matches its independent golden",
    async (inputName, expectedName, mediaType) => {
      const bytes = new Uint8Array(
        await readFile(new URL(inputName, fixtures)),
      );
      const expected = JSON.parse(
        await readFile(new URL(expectedName, fixtures), "utf8"),
      );
      const input = {
        sourceFile: sourceFile(mediaType, bytes),
        bytes,
        version: 1,
        identities,
      };

      const first = extractATier(input);
      const second = extractATier(input);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      if (!first.ok) throw new Error(first.message);
      expect({
        kind: first.value.kind,
        normalizedText: first.value.normalizedText,
        locatorMap: first.value.locatorMap,
        warnings: first.value.warnings,
      }).toEqual(expected);
      expect(SourceRepresentationSchema.parse(first.value)).toEqual(
        first.value,
      );
    },
  );
});
