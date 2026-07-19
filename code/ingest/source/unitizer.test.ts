import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

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

function textInput(
  text: string,
  kind: SourceRepresentation["kind"] = "text",
): UnitizeInput {
  const base = emptyInput();
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let offset = 0;
  const locatorMap: SourceRepresentation["locatorMap"] = lines.map(
    (line, index) => {
      const start = offset;
      const end = start + line.length;
      offset = end + 1;
      return {
        kind: "line",
        normalized: {
          utf16Start: start,
          utf16End: end,
          lineStart: index + 1,
          columnStart: 1,
          lineEnd: index + 1,
          columnEnd: line.length + 1,
        },
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
    ...base.representation,
    kind,
    normalizedText: text,
    locatorMap,
  };
  const audited = auditRepresentation(representation);
  if (!audited.ok) throw new Error(audited.message);
  return {
    sourceFile: {
      ...base.sourceFile,
      size: Buffer.byteLength(text),
      sha256: sha256(text),
    },
    representation,
    audit: audited.value,
  };
}

function csvCell(
  row: number,
  column: number,
  start: number,
  end: number,
  line: number,
  columnStart: number,
): SourceRepresentation["locatorMap"][number] {
  return {
    kind: "cell",
    cell: { row, column },
    normalized: {
      utf16Start: start,
      utf16End: end,
      lineStart: line,
      columnStart,
      lineEnd: line,
      columnEnd: columnStart + (end - start),
    },
    original: {
      byteStart: start,
      byteEnd: end,
      lineStart: line,
      columnStart,
      lineEnd: line,
      columnEnd: columnStart + (end - start),
    },
  };
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

  it("creates document and paragraph units with exact composed locators", () => {
    const input = textInput("Alpha line\ncontinued\n\nBeta\n");
    const result = unitizeRepresentation(input);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(
      result.value.map((unit) => ({
        kind: unit.kind,
        parentId: unit.parentId,
        headingPath: unit.headingPath,
        normalizedLocator: unit.normalizedLocator,
        originalLocator: unit.originalLocator,
        textSha256: unit.textSha256,
      })),
    ).toEqual([
      {
        kind: "document",
        parentId: undefined,
        headingPath: [],
        normalizedLocator: {
          utf16Start: 0,
          utf16End: 27,
          lineStart: 1,
          columnStart: 1,
          lineEnd: 5,
          columnEnd: 1,
        },
        originalLocator: {
          byteStart: 0,
          byteEnd: 26,
          lineStart: 1,
          columnStart: 1,
          lineEnd: 4,
          columnEnd: 5,
        },
        textSha256: sha256("Alpha line\ncontinued\n\nBeta\n"),
      },
      {
        kind: "paragraph",
        parentId: result.value[0]!.id,
        headingPath: [],
        normalizedLocator: {
          utf16Start: 0,
          utf16End: 20,
          lineStart: 1,
          columnStart: 1,
          lineEnd: 2,
          columnEnd: 10,
        },
        originalLocator: {
          byteStart: 0,
          byteEnd: 20,
          lineStart: 1,
          columnStart: 1,
          lineEnd: 2,
          columnEnd: 10,
        },
        textSha256: sha256("Alpha line\ncontinued"),
      },
      {
        kind: "paragraph",
        parentId: result.value[0]!.id,
        headingPath: [],
        normalizedLocator: {
          utf16Start: 22,
          utf16End: 26,
          lineStart: 4,
          columnStart: 1,
          lineEnd: 4,
          columnEnd: 5,
        },
        originalLocator: {
          byteStart: 22,
          byteEnd: 26,
          lineStart: 4,
          columnStart: 1,
          lineEnd: 4,
          columnEnd: 5,
        },
        textSha256: sha256("Beta"),
      },
    ]);
    expect(new Set(result.value.map((unit) => unit.id)).size).toBe(3);
    expectDeepFrozen(result.value);
  });

  it("preserves unaffected paragraph IDs across unrelated edits", () => {
    const before = unitizeRepresentation(textInput("Alpha\n\nBeta\n"));
    const after = unitizeRepresentation(textInput("New\n\nAlpha\n\nBeta\n"));
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) return;

    const byHash = (
      units: readonly { kind: string; id: string; textSha256: string }[],
    ) =>
      new Map(
        units
          .filter((unit) => unit.kind === "paragraph")
          .map((unit) => [unit.textSha256, unit.id]),
      );
    const beforeIds = byHash(before.value);
    const afterIds = byHash(after.value);
    expect(afterIds.get(sha256("Alpha"))).toBe(beforeIds.get(sha256("Alpha")));
    expect(afterIds.get(sha256("Beta"))).toBe(beforeIds.get(sha256("Beta")));
    expect(after.value[0]!.id).not.toBe(before.value[0]!.id);
  });

  it("assigns deterministic distinct ordinals to identical sibling paragraphs", () => {
    const result = unitizeRepresentation(textInput("Same\n\nSame\n"));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const paragraphs = result.value.filter((unit) => unit.kind === "paragraph");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.textSha256).toBe(paragraphs[1]!.textSha256);
    expect(paragraphs[0]!.id).not.toBe(paragraphs[1]!.id);
    expect(unitizeRepresentation(textInput("Same\n\nSame\n"))).toEqual(result);
  });

  it("emits only a document for non-empty whitespace-only text", () => {
    const result = unitizeRepresentation(textInput("  \n\n"));
    expect(result).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ kind: "document" })],
    });
  });

  it.each(["code", "json", "yaml"] as const)(
    "emits one code unit for %s representations",
    (kind) => {
      const result = unitizeRepresentation(textInput("alpha\nbeta\n", kind));
      expect(result).toMatchObject({
        ok: true,
        value: [
          expect.objectContaining({ kind: "document" }),
          expect.objectContaining({ kind: "code" }),
        ],
      });
    },
  );

  it("emits one table unit for a CSV representation", () => {
    const base = emptyInput();
    const representation: SourceRepresentation = {
      ...base.representation,
      kind: "csv",
      normalizedText: "a,b\n1,2\n",
      locatorMap: [
        csvCell(1, 1, 0, 1, 1, 1),
        csvCell(1, 2, 2, 3, 1, 3),
        csvCell(2, 1, 4, 5, 2, 1),
        csvCell(2, 2, 6, 7, 2, 3),
      ],
    };
    const audited = auditRepresentation(representation);
    expect(audited.ok).toBe(true);
    if (!audited.ok) return;
    const result = unitizeRepresentation({
      sourceFile: { ...base.sourceFile, size: 8, sha256: sha256("a,b\n1,2\n") },
      representation,
      audit: audited.value,
    });
    expect(result).toMatchObject({
      ok: true,
      value: [
        expect.objectContaining({ kind: "document" }),
        expect.objectContaining({
          kind: "table",
          normalizedLocator: expect.objectContaining({
            utf16Start: 0,
            utf16End: 7,
          }),
        }),
      ],
    });
  });

  it("parses Markdown headings, paragraphs, lists, tables, and fenced code", async () => {
    const text = await readFile(
      new URL("./fixtures/unitization/markdown-structure.md", import.meta.url),
      "utf8",
    );
    const result = unitizeRepresentation(textInput(text, "markdown"));

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const expected = JSON.parse(
      await readFile(
        new URL(
          "./fixtures/unitization/markdown-structure.expected.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(result.value).toEqual(expected);
    expect(result.value.map((unit) => unit.kind)).toEqual([
      "document",
      "paragraph",
      "section",
      "paragraph",
      "list",
      "table",
      "code",
      "section",
      "paragraph",
    ]);
    const [
      document,
      preamble,
      install,
      paragraph,
      list,
      table,
      code,
      linux,
      details,
    ] = result.value;
    expect(preamble?.parentId).toBe(document?.id);
    expect(install).toMatchObject({
      parentId: document?.id,
      headingPath: ["Install"],
    });
    for (const unit of [paragraph, list, table, code]) {
      expect(unit).toMatchObject({
        parentId: install?.id,
        headingPath: ["Install"],
      });
    }
    expect(linux).toMatchObject({
      parentId: install?.id,
      headingPath: ["Install", "Linux"],
    });
    expect(details).toMatchObject({
      parentId: linux?.id,
      headingPath: ["Install", "Linux"],
    });
  });

  it("distinguishes duplicate headings and their identical children", () => {
    const result = unitizeRepresentation(
      textInput("# Root\n\n## Same\n\nText\n\n## Same\n\nText\n", "markdown"),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const sameSections = result.value.filter(
      (unit) => unit.kind === "section" && unit.headingPath.at(-1) === "Same",
    );
    const textParagraphs = result.value.filter(
      (unit) => unit.kind === "paragraph" && unit.textSha256 === sha256("Text"),
    );
    expect(sameSections).toHaveLength(2);
    expect(textParagraphs).toHaveLength(2);
    expect(sameSections[0]!.id).not.toBe(sameSections[1]!.id);
    expect(textParagraphs[0]!.id).not.toBe(textParagraphs[1]!.id);
    expect(textParagraphs.map((unit) => unit.parentId)).toEqual(
      sameSections.map((unit) => unit.id),
    );
  });

  it("keeps Markdown-looking fenced content inside one code unit", () => {
    const result = unitizeRepresentation(
      textInput(
        "# Root\n\n```md\n## Not heading\n- not list\n```\n",
        "markdown",
      ),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.map((unit) => unit.kind)).toEqual([
      "document",
      "section",
      "code",
    ]);
  });

  it("keeps thematic breaks and separates list continuation at a blank line", () => {
    const result = unitizeRepresentation(
      textInput(
        "# Root\n\n---\n\n- item\n  continuation\n\n  indented paragraph\n",
        "markdown",
      ),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.map((unit) => unit.kind)).toEqual([
      "document",
      "section",
      "paragraph",
      "list",
      "paragraph",
    ]);
  });

  it("fails an unclosed Markdown fence without echoing source text", () => {
    const secret = "PRIVATE_SOURCE_VALUE";
    const result = unitizeRepresentation(
      textInput(`# Root\n\n\`\`\`\n${secret}\n`, "markdown"),
    );
    expect(result).toMatchObject({ ok: false, code: "TEXT_DROPPED" });
    if (!result.ok) expect(result.message).not.toContain(secret);
  });

  it("rejects polluted arrays and accessor-backed records without throwing", () => {
    const base = emptyInput();
    const polluted = structuredClone(base);
    Object.setPrototypeOf(
      polluted.representation.locatorMap,
      Object.create(Array.prototype) as Array<unknown>,
    );
    expect(unitizeRepresentation(polluted)).toMatchObject({
      ok: false,
      code: "AUDIT_REQUIRED",
    });

    const accessor = structuredClone(base) as UnitizeInput;
    Object.defineProperty(accessor.representation, "normalizedText", {
      enumerable: true,
      get(): never {
        throw new Error("EXECUTED_GETTER");
      },
    });
    expect(() => unitizeRepresentation(accessor)).not.toThrow();
    expect(unitizeRepresentation(accessor)).toMatchObject({
      ok: false,
      code: "AUDIT_REQUIRED",
    });
  });

  it("classifies non-empty empty representations as requiring audit", () => {
    const base = emptyInput();
    expect(
      unitizeRepresentation({
        ...base,
        sourceFile: {
          ...base.sourceFile,
          size: 1,
          sha256: sha256("x"),
        },
      }),
    ).toMatchObject({ ok: false, code: "AUDIT_REQUIRED" });
  });

  it("includes trailing separators in the whole-document range and digest", () => {
    const input = textInput("\n# H\n\nP\n\n", "markdown");
    const result = unitizeRepresentation(input);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({
      normalizedLocator: {
        utf16Start: 0,
        utf16End: input.representation.normalizedText.length,
      },
      originalLocator: {
        byteStart: 0,
        byteEnd: 8,
        lineEnd: 5,
        columnEnd: 1,
      },
      textSha256: sha256(input.representation.normalizedText),
    });
  });

  it("rejects audited original locators beyond the source-file byte bound", () => {
    const input = textInput("x\n");
    const locator = input.representation.locatorMap[0]!;
    const representation: SourceRepresentation = {
      ...input.representation,
      locatorMap: [
        {
          ...locator,
          original: {
            ...locator.original,
            byteStart: 99,
            byteEnd: 100,
          },
        },
      ],
    };
    const audited = auditRepresentation(representation);
    expect(audited.ok).toBe(true);
    if (!audited.ok) return;
    expect(
      unitizeRepresentation({ ...input, representation, audit: audited.value }),
    ).toMatchObject({ ok: false, code: "TEXT_DROPPED" });
  });

  it("scales near-linearly across many tiny paragraph units", () => {
    const run = (count: number): number => {
      const text = Array.from(
        { length: count },
        (_, index) => `p${index}\n\n`,
      ).join("");
      const input = textInput(text);
      const started = performance.now();
      const result = unitizeRepresentation(input);
      const duration = performance.now() - started;
      expect(result).toMatchObject({ ok: true });
      return duration;
    };
    run(200);
    const small = run(1_000);
    const large = run(4_000);
    expect(large).toBeLessThan(small * 7 + 50);
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
