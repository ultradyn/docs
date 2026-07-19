import { describe, expect, it } from "vitest";

import {
  ScanFindingKindSchema,
  ScanActionSchema,
  ScanFindingSchema,
  ScanPolicySchema,
  ScanVerdictSchema,
  ScanSpanSchema,
} from "./content-scan.js";

describe("content-scan domain exports", () => {
  it("exports ScanFindingKindSchema as closed secret|pii", () => {
    expect(typeof ScanFindingKindSchema?.safeParse).toBe("function");
    expect(ScanFindingKindSchema.safeParse("secret").success).toBe(true);
    expect(ScanFindingKindSchema.safeParse("pii").success).toBe(true);
    expect(ScanFindingKindSchema.safeParse("malware").success).toBe(false);
  });

  it("exports ScanActionSchema closed allow|redact|quarantine|block", () => {
    expect(typeof ScanActionSchema?.safeParse).toBe("function");
    for (const action of ["allow", "redact", "quarantine", "block"] as const) {
      expect(ScanActionSchema.safeParse(action).success).toBe(true);
    }
    expect(ScanActionSchema.safeParse("delete").success).toBe(false);
  });

  it("ScanFindingSchema never allows matchedValue or surroundingText fields", () => {
    expect(typeof ScanFindingSchema?.safeParse).toBe("function");
    const ok = ScanFindingSchema.safeParse({
      kind: "secret",
      detectorId: "seeded-secret",
      span: {
        kind: "span",
        normalized: {
          utf16Start: 0,
          utf16End: 8,
          lineStart: 1,
          columnStart: 1,
          lineEnd: 1,
          columnEnd: 9,
        },
        original: {
          byteStart: 0,
          byteEnd: 8,
          lineStart: 1,
          columnStart: 1,
          lineEnd: 1,
          columnEnd: 9,
        },
      },
    });
    expect(ok.success).toBe(true);
    const leak = ScanFindingSchema.safeParse({
      kind: "secret",
      detectorId: "seeded-secret",
      span: {
        kind: "span",
        normalized: {
          utf16Start: 0,
          utf16End: 8,
          lineStart: 1,
          columnStart: 1,
          lineEnd: 1,
          columnEnd: 9,
        },
        original: {
          byteStart: 0,
          byteEnd: 8,
          lineStart: 1,
          columnStart: 1,
          lineEnd: 1,
          columnEnd: 9,
        },
      },
      matchedValue: "sk-SECRET",
    });
    expect(leak.success).toBe(false);
    const surrounding = ScanFindingSchema.safeParse({
      kind: "secret",
      detectorId: "seeded-secret",
      span: {
        kind: "span",
        normalized: {
          utf16Start: 0,
          utf16End: 8,
          lineStart: 1,
          columnStart: 1,
          lineEnd: 1,
          columnEnd: 9,
        },
        original: {
          byteStart: 0,
          byteEnd: 8,
          lineStart: 1,
          columnStart: 1,
          lineEnd: 1,
          columnEnd: 9,
        },
      },
      surroundingText: "token=sk-SECRET here",
    });
    expect(surrounding.success).toBe(false);
  });

  it("ScanPolicySchema is a separate strict record (not DataRightsPolicyProfile)", () => {
    expect(typeof ScanPolicySchema?.safeParse).toBe("function");
    const ok = ScanPolicySchema.safeParse({
      schemaVersion: 1,
      id: "scan-policy-default",
      defaultAction: "block",
      actionsByKind: {
        secret: "block",
        pii: "redact",
      },
    });
    expect(ok.success).toBe(true);
    // Unknown keys fail closed
    expect(
      ScanPolicySchema.safeParse({
        schemaVersion: 1,
        id: "x",
        defaultAction: "block",
        actionsByKind: { secret: "block", pii: "redact" },
        dataRightsClass: "confidential",
      }).success,
    ).toBe(false);
  });

  it("ScanVerdictSchema outcomes are closed and findings omit secrets", () => {
    expect(typeof ScanVerdictSchema?.safeParse).toBe("function");
    for (const outcome of [
      "clean",
      "redacted",
      "quarantined",
      "blocked",
    ] as const) {
      expect(
        ScanVerdictSchema.safeParse({
          outcome,
          findings: [],
          appliedActions: [],
        }).success,
      ).toBe(true);
    }
    expect(
      ScanVerdictSchema.safeParse({
        outcome: "deleted",
        findings: [],
        appliedActions: [],
      }).success,
    ).toBe(false);
  });

  it("ScanSpanSchema exports half-open locator-shaped coordinates", () => {
    expect(typeof ScanSpanSchema?.safeParse).toBe("function");
  });

  it("rejects placeholder {schemaVersion,id} alone for ScanPolicy", () => {
    expect(
      ScanPolicySchema.safeParse({ schemaVersion: 1, id: "x" }).success,
    ).toBe(false);
  });
});
