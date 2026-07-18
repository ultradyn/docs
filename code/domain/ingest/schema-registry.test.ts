import { describe, expect, it } from "vitest";
import {
  ingestSchemaRegistry,
  validateIngestRecord,
} from "./schema-registry.js";

describe("ingestion schema registry", () => {
  const sourceFile = {
    schemaVersion: 1,
    id: "sf-01",
    snapshotId: "snap-01",
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

  it("fails unknown versions explicitly", () => {
    expect(() => ingestSchemaRegistry.get("SourceFile", 2 as 1)).toThrowError(
      /UNKNOWN_SCHEMA.*SourceFile.*2/,
    );
  });

  it("returns exact validation paths for malformed strict records", () => {
    const result = validateIngestRecord("SourceSnapshot", 1, {
      schemaVersion: 1,
      id: "snap-01",
      packageSha256: "b".repeat(64),
      policyId: "policy-01",
      files: [{ ...sourceFile, sha256: "a".repeat(63) }],
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
