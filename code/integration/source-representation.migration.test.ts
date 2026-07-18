import { describe, expect, it } from "vitest";

import { SourceRepresentationSchema } from "../domain/ingest/index.js";

const current = {
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
  ],
  warnings: [],
} as const;

describe("SourceRepresentation migration boundary", () => {
  it("accepts the current v1 record", () => {
    expect(SourceRepresentationSchema.parse(current)).toEqual(current);
  });

  it.each([
    ["legacy schema version", { ...current, schemaVersion: 0 }],
    ["empty legacy representation ID", { ...current, id: "" }],
    ["missing locator map", { ...current, locatorMap: undefined }],
    ["missing warnings", { ...current, warnings: undefined }],
    ["unknown legacy field", { ...current, sourcePath: "private/source.txt" }],
  ])("strict-rejects %s without speculative migration", (_name, value) => {
    expect(SourceRepresentationSchema.safeParse(value).success).toBe(false);
  });
});
