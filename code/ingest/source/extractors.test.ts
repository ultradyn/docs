import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type {
  Sha256,
  SnapshotId,
  SourceFile,
  SourceFileId,
  SourceRepresentationId,
} from "../../domain/ingest/index.js";
import {
  SourceRepresentationSchema,
  type SourceRepresentationKind,
} from "../../domain/ingest/index.js";
import { extractATier } from "./index.js";

const fixtures = new URL("./fixtures/extraction/", import.meta.url);

function sha256(bytes: Uint8Array): Sha256 {
  return createHash("sha256").update(bytes).digest("hex") as Sha256;
}

function sourceFile(mediaType: string, bytes: Uint8Array): SourceFile {
  return {
    schemaVersion: 1,
    id: `file-${"a".repeat(64)}` as SourceFileId,
    snapshotId: `snap-${"b".repeat(64)}` as SnapshotId,
    logicalPath: "untrusted.bin",
    mediaType,
    size: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

const REPRESENTATION_ID =
  "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SourceRepresentationId;

const identities = {
  derive(input: {
    sourceFileId: SourceFileId;
    version: number;
    kind: SourceRepresentationKind;
  }): SourceRepresentationId {
    void input;
    return REPRESENTATION_ID;
  },
};

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(name, fixtures)));
}

async function expectedFixture(name: string): Promise<{
  normalizedText: string;
  locatorMap: unknown[];
}> {
  return JSON.parse(await readFile(new URL(name, fixtures), "utf8"));
}

describe("extractATier", () => {
  it("normalizes Markdown CRLF while mapping each output line to exact source bytes", async () => {
    const bytes = await fixture("markdown-crlf.md");

    const result = extractATier({
      sourceFile: sourceFile("text/markdown", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        id: REPRESENTATION_ID,
        sourceFileId: `file-${"a".repeat(64)}`,
        version: 1,
        kind: "markdown",
        normalizedText: "# Héading\nBody\n",
        locatorMap: [
          {
            kind: "line",
            normalized: {
              utf16Start: 0,
              utf16End: 9,
              lineStart: 1,
              lineEnd: 1,
              columnStart: 1,
              columnEnd: 10,
            },
            original: {
              byteStart: 0,
              byteEnd: 10,
              lineStart: 1,
              columnStart: 1,
              lineEnd: 1,
              columnEnd: 10,
            },
          },
          {
            kind: "line",
            normalized: {
              utf16Start: 10,
              utf16End: 14,
              lineStart: 2,
              lineEnd: 2,
              columnStart: 1,
              columnEnd: 5,
            },
            original: {
              byteStart: 12,
              byteEnd: 16,
              lineStart: 2,
              columnStart: 1,
              lineEnd: 2,
              columnEnd: 5,
            },
          },
        ],
        warnings: [],
      },
    });
    if (!result.ok) throw new Error(result.message);
    expect({
      kind: result.value.kind,
      normalizedText: result.value.normalizedText,
      locatorMap: result.value.locatorMap,
      warnings: result.value.warnings,
    }).toEqual(await expectedFixture("markdown-crlf.expected.json"));
  });

  it.each([
    ["text/plain", "text"],
    ["text/typescript", "code"],
  ] as const)(
    "classifies %s from media metadata, never the extension",
    (mediaType, kind) => {
      const bytes = new TextEncoder().encode("const π = 1;\n");
      const file = sourceFile(mediaType, bytes);
      file.logicalPath = kind === "code" ? "misleading.txt" : "misleading.ts";

      const result = extractATier({
        sourceFile: file,
        bytes,
        version: 1,
        identities,
      });

      expect(result).toMatchObject({
        ok: true,
        value: { kind, normalizedText: "const π = 1;\n" },
      });
    },
  );

  it("validates JSON without lossy reserialization and maps normalized source lines", () => {
    const bytes = new TextEncoder().encode(
      '{\r\n  "z": "é",\r\n  "a": 1\r\n}\r\n',
    );

    const result = extractATier({
      sourceFile: sourceFile("application/json", bytes),
      bytes,
      version: 2,
      identities,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        version: 2,
        kind: "json",
        normalizedText: '{\n  "z": "é",\n  "a": 1\n}\n',
        locatorMap: [
          { original: { byteStart: 0, byteEnd: 1, lineStart: 1 } },
          { original: { byteStart: 3, byteEnd: 15, lineStart: 2 } },
          { original: { byteStart: 17, byteEnd: 25, lineStart: 3 } },
          { original: { byteStart: 27, byteEnd: 28, lineStart: 4 } },
        ],
      },
    });
  });

  it("validates YAML without reordering mappings", () => {
    const bytes = new TextEncoder().encode("z: café\na: 1\n");

    const result = extractATier({
      sourceFile: sourceFile("application/yaml", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "yaml",
        normalizedText: "z: café\na: 1\n",
        locatorMap: [
          {
            original: { byteStart: 0, byteEnd: 8, lineStart: 1, columnEnd: 8 },
          },
          {
            original: { byteStart: 9, byteEnd: 13, lineStart: 2, columnEnd: 5 },
          },
        ],
      },
    });
  });

  it("normalizes CSV records and maps every quoted multiline cell", async () => {
    const bytes = await fixture("quoted-multiline.csv");

    const result = extractATier({
      sourceFile: sourceFile("text/csv", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        id: REPRESENTATION_ID,
        sourceFileId: `file-${"a".repeat(64)}`,
        version: 1,
        kind: "csv",
        normalizedText: 'name,note\nAda,"line 1\nline 2, with ""quote"""\n',
        locatorMap: [
          {
            kind: "cell",
            cell: { row: 1, column: 1 },
            normalized: {
              utf16Start: 0,
              utf16End: 4,
              lineStart: 1,
              lineEnd: 1,
              columnStart: 1,
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
          {
            kind: "cell",
            cell: { row: 1, column: 2 },
            normalized: {
              utf16Start: 5,
              utf16End: 9,
              lineStart: 1,
              lineEnd: 1,
              columnStart: 6,
              columnEnd: 10,
            },
            original: {
              byteStart: 5,
              byteEnd: 9,
              lineStart: 1,
              columnStart: 6,
              lineEnd: 1,
              columnEnd: 10,
            },
          },
          {
            kind: "cell",
            cell: { row: 2, column: 1 },
            normalized: {
              utf16Start: 10,
              utf16End: 13,
              lineStart: 2,
              lineEnd: 2,
              columnStart: 1,
              columnEnd: 4,
            },
            original: {
              byteStart: 11,
              byteEnd: 14,
              lineStart: 2,
              columnStart: 1,
              lineEnd: 2,
              columnEnd: 4,
            },
          },
          {
            kind: "cell",
            cell: { row: 2, column: 2 },
            normalized: {
              utf16Start: 14,
              utf16End: 45,
              lineStart: 2,
              lineEnd: 3,
              columnStart: 5,
              columnEnd: 24,
            },
            original: {
              byteStart: 15,
              byteEnd: 47,
              lineStart: 2,
              columnStart: 5,
              lineEnd: 3,
              columnEnd: 24,
            },
          },
        ],
        warnings: [],
      },
    });
    if (!result.ok) throw new Error(result.message);
    expect({
      kind: result.value.kind,
      normalizedText: result.value.normalizedText,
      locatorMap: result.value.locatorMap,
      warnings: result.value.warnings,
    }).toEqual(await expectedFixture("quoted-multiline.expected.json"));
  });

  it("maps CR-only CSV records in normalized and exact original coordinates", async () => {
    const bytes = await fixture("table-cr.csv");
    const result = extractATier({
      sourceFile: sourceFile("text/csv", bytes),
      bytes,
      version: 1,
      identities,
    });
    if (!result.ok) throw new Error(result.message);

    expect({
      kind: result.value.kind,
      normalizedText: result.value.normalizedText,
      locatorMap: result.value.locatorMap,
      warnings: result.value.warnings,
    }).toEqual(await expectedFixture("table-cr.expected.json"));
    expect(result.value.locatorMap[2]).toMatchObject({
      cell: { row: 2, column: 1 },
      normalized: { lineStart: 2, columnStart: 1 },
      original: { byteStart: 4, lineStart: 2, columnStart: 1 },
    });
    expect(result.value.locatorMap[3]).toMatchObject({
      cell: { row: 2, column: 2 },
      normalized: { lineStart: 2, columnStart: 3 },
      original: { byteStart: 6, lineStart: 2, columnStart: 3 },
    });
  });

  it("uses physical normalized line coordinates after a multiline CSV cell", () => {
    const bytes = new TextEncoder().encode('a,b\n1,"x\ny"\n2,z\n');
    const result = extractATier({
      sourceFile: sourceFile("text/csv", bytes),
      bytes,
      version: 1,
      identities,
    });
    if (!result.ok) throw new Error(result.message);

    expect(result.value.locatorMap[4]).toMatchObject({
      cell: { row: 3, column: 1 },
      normalized: { lineStart: 4, columnStart: 1, lineEnd: 4, columnEnd: 2 },
    });
  });

  it.each([
    ['a"b,c', 1, 1, 2],
    ['a,"x"z', 5, 1, 6],
    ['a,"open', 2, 1, 3],
  ] as const)(
    "rejects strict CSV grammar at the exact offending coordinate for %j",
    (content, byteOffset, line, column) => {
      const bytes = new TextEncoder().encode(content);
      expect(
        extractATier({
          sourceFile: sourceFile("text/csv", bytes),
          bytes,
          version: 1,
          identities,
        }),
      ).toEqual({
        ok: false,
        code: "MALFORMED_STRUCTURE",
        message:
          content === 'a,"open'
            ? "Malformed CSV structure: unterminated quoted field"
            : "Malformed CSV structure",
        location: { byteOffset, line, column },
      });
    },
  );

  it("accepts quoted delimiters, newlines, and escaped quotes", () => {
    const bytes = new TextEncoder().encode('a,"x,y\nz""q"\n');
    const result = extractATier({
      sourceFile: sourceFile("text/csv", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        normalizedText: 'a,"x,y\nz""q"\n',
        locatorMap: [
          { cell: { row: 1, column: 1 } },
          {
            cell: { row: 1, column: 2 },
            original: { byteStart: 2, byteEnd: 12, lineEnd: 2 },
          },
        ],
      },
    });
  });

  it("extracts many tiny CSV fields without quadratic latency", () => {
    const fields = 50_000;
    const bytes = new TextEncoder().encode(`${"x,".repeat(fields - 1)}x\n`);
    const started = performance.now();
    const result = extractATier({
      sourceFile: sourceFile("text/csv", bytes),
      bytes,
      version: 1,
      identities,
    });
    const elapsedMs = performance.now() - started;

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.locatorMap).toHaveLength(fields);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("does not invent a trailing newline absent from original bytes", () => {
    const bytes = new TextEncoder().encode("no newline");
    const result = extractATier({
      sourceFile: sourceFile("text/plain", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { normalizedText: "no newline" },
    });
  });

  it("rejects overlong, surrogate, out-of-range, and truncated UTF-8 at the leading byte", () => {
    for (const invalid of [
      [0xc0, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xe2, 0x82],
    ]) {
      const bytes = Uint8Array.from(invalid);
      expect(
        extractATier({
          sourceFile: sourceFile("text/plain", bytes),
          bytes,
          version: 1,
          identities,
        }),
      ).toMatchObject({
        ok: false,
        code: "MALFORMED_ENCODING",
        location: { byteOffset: 0, line: 1, column: 1 },
      });
    }
  });

  it("locates malformed structure after a UTF-8 BOM in original byte coordinates", () => {
    const bytes = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('{"a": }'),
    ]);
    const result = extractATier({
      sourceFile: sourceFile("application/json", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      location: { byteOffset: 9, line: 1, column: 7 },
    });
  });

  it("fails malformed UTF-8 at the exact original byte and coordinate", () => {
    const bytes = Uint8Array.from([0x6f, 0x6b, 0x0a, 0xf0, 0x28, 0x8c, 0xbc]);

    const result = extractATier({
      sourceFile: sourceFile("text/plain", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toEqual({
      ok: false,
      code: "MALFORMED_ENCODING",
      message: "Malformed UTF-8 at byte 3 (line 2, column 1)",
      location: { byteOffset: 3, line: 2, column: 1 },
    });
  });

  it.each([
    ["application/json", '{"a": }', 6, 1, 7],
    ["application/yaml", "a: [1,\n", 7, 2, 1],
    ["text/csv", 'a,b\n"open,b\n', 4, 2, 1],
  ] as const)(
    "returns a stable located MALFORMED_STRUCTURE for %s",
    (mediaType, content, byteOffset, line, column) => {
      const bytes = new TextEncoder().encode(content);

      const result = extractATier({
        sourceFile: sourceFile(mediaType, bytes),
        bytes,
        version: 1,
        identities,
      });

      expect(result).toMatchObject({
        ok: false,
        code: "MALFORMED_STRUCTURE",
        location: { byteOffset, line, column },
      });
    },
  );

  it("locates the offending repeated JSON token rather than its first valid occurrence", () => {
    const bytes = new TextEncoder().encode("[{},}]");
    const result = extractATier({
      sourceFile: sourceFile("application/json", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toEqual({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Malformed JSON structure",
      location: { byteOffset: 4, line: 1, column: 5 },
    });
  });

  it("locates a repeated token after a valid JSON string occurrence", () => {
    const bytes = new TextEncoder().encode('["}",}]');
    const result = extractATier({
      sourceFile: sourceFile("application/json", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toEqual({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Malformed JSON structure",
      location: { byteOffset: 5, line: 1, column: 6 },
    });
  });

  it("locates a malformed non-ASCII JSON token at its UTF-8 boundary", () => {
    const bytes = new TextEncoder().encode('{"a":🙂}');
    const result = extractATier({
      sourceFile: sourceFile("application/json", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toEqual({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Malformed JSON structure",
      location: { byteOffset: 5, line: 1, column: 6 },
    });
  });

  it("rejects deeply nested malformed JSON without recursion overflow", () => {
    const content = `${"[".repeat(100_000)}x`;
    const bytes = new TextEncoder().encode(content);
    const result = extractATier({
      sourceFile: sourceFile("application/json", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toEqual({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Malformed JSON structure",
      location: { byteOffset: 100_000, line: 1, column: 100_001 },
    });
  });

  it("rejects excessive YAML block nesting before invoking the parser", () => {
    const content = `${"- ".repeat(1_000)}x`;
    const bytes = new TextEncoder().encode(content);
    const result = extractATier({
      sourceFile: sourceFile("application/yaml", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toEqual({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Malformed YAML structure: nesting limit exceeded",
      location: { byteOffset: 512, line: 1, column: 513 },
    });
  });

  it("rejects excessive indentation-based YAML nesting", () => {
    const content = `${Array.from({ length: 257 }, (_, depth) => `${" ".repeat(depth * 2)}-`).join("\n")}\n${" ".repeat(514)}x\n`;
    const bytes = new TextEncoder().encode(content);
    const result = extractATier({
      sourceFile: sourceFile("application/yaml", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Malformed YAML structure: nesting limit exceeded",
      location: { line: 257, column: 513 },
    });
  });

  it("accepts mixed YAML sequence-map nesting at the collection limit", () => {
    const content = `${Array.from({ length: 128 }, (_, depth) => `${" ".repeat(depth * 4)}- key:`).join("\n")}\n${" ".repeat(512)}value\n`;
    const bytes = new TextEncoder().encode(content);
    expect(
      extractATier({
        sourceFile: sourceFile("application/yaml", bytes),
        bytes,
        version: 1,
        identities,
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects mixed YAML sequence-map nesting beyond the collection limit", () => {
    const content = `${Array.from({ length: 129 }, (_, depth) => `${" ".repeat(depth * 4)}- key:`).join("\n")}\n${" ".repeat(516)}value\n`;
    const bytes = new TextEncoder().encode(content);
    expect(
      extractATier({
        sourceFile: sourceFile("application/yaml", bytes),
        bytes,
        version: 1,
        identities,
      }),
    ).toMatchObject({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Malformed YAML structure: nesting limit exceeded",
      location: { line: 129 },
    });
  });

  it.each(['"key # literal"', "'key # literal'"])(
    "rejects deeply nested %s YAML keys without treating embedded hash as comment",
    (key) => {
      const content = `${Array.from({ length: 257 }, (_, depth) => `${" ".repeat(depth * 2)}${key}:`).join("\n")}\n${" ".repeat(514)}value\n`;
      const bytes = new TextEncoder().encode(content);
      expect(
        extractATier({
          sourceFile: sourceFile("application/yaml", bytes),
          bytes,
          version: 1,
          identities,
        }),
      ).toMatchObject({
        ok: false,
        code: "MALFORMED_STRUCTURE",
        message: "Malformed YAML structure: nesting limit exceeded",
      });
    },
  );

  it("rejects quoted-key YAML mappings beyond the collection limit", () => {
    const content = `${Array.from({ length: 257 }, (_, depth) => `${" ".repeat(depth * 2)}"key":`).join("\n")}\n${" ".repeat(514)}value\n`;
    const bytes = new TextEncoder().encode(content);
    expect(
      extractATier({
        sourceFile: sourceFile("application/yaml", bytes),
        bytes,
        version: 1,
        identities,
      }),
    ).toMatchObject({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Malformed YAML structure: nesting limit exceeded",
    });
  });

  it("rejects same-line sequence-map nesting beyond the collection limit", () => {
    const content = `${Array.from({ length: 86 }, (_, depth) => `${" ".repeat(depth * 4)}- - key:`).join("\n")}\n${" ".repeat(344)}value\n`;
    const bytes = new TextEncoder().encode(content);
    expect(
      extractATier({
        sourceFile: sourceFile("application/yaml", bytes),
        bytes,
        version: 1,
        identities,
      }),
    ).toMatchObject({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Malformed YAML structure: nesting limit exceeded",
    });
  });

  it("ignores flow-like text after a separated YAML comment marker", () => {
    const content = `${Array.from({ length: 255 }, (_, depth) => `${" ".repeat(depth * 2)}key:`).join("\n")}\n${" ".repeat(510)}value: scalar # comment [[ignored]]\n`;
    const bytes = new TextEncoder().encode(content);
    expect(
      extractATier({
        sourceFile: sourceFile("application/yaml", bytes),
        bytes,
        version: 1,
        identities,
      }),
    ).toMatchObject({ ok: true });
  });

  it("does not treat an unseparated hash in a YAML key as a comment", () => {
    const content = `${Array.from({ length: 255 }, (_, depth) => `${" ".repeat(depth * 2)}key:`).join("\n")}\n${" ".repeat(510)}value#literal: [[x]]\n`;
    const bytes = new TextEncoder().encode(content);
    expect(
      extractATier({
        sourceFile: sourceFile("application/yaml", bytes),
        bytes,
        version: 1,
        identities,
      }),
    ).toMatchObject({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Malformed YAML structure: nesting limit exceeded",
    });
  });

  it("rejects combined block and flow nesting beyond the collection limit", () => {
    const content = `${Array.from({ length: 255 }, (_, depth) => `${" ".repeat(depth * 2)}key:`).join("\n")}\n${" ".repeat(510)}value: [[x]]\n`;
    const bytes = new TextEncoder().encode(content);
    expect(
      extractATier({
        sourceFile: sourceFile("application/yaml", bytes),
        bytes,
        version: 1,
        identities,
      }),
    ).toMatchObject({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Malformed YAML structure: nesting limit exceeded",
    });
  });

  it("accepts deeply nested YAML mappings at the collection limit", () => {
    const content = `${Array.from({ length: 256 }, (_, depth) => `${" ".repeat(depth * 2)}key:`).join("\n")}\n${" ".repeat(512)}value\n`;
    const bytes = new TextEncoder().encode(content);
    expect(
      extractATier({
        sourceFile: sourceFile("application/yaml", bytes),
        bytes,
        version: 1,
        identities,
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects deeply nested YAML mappings beyond the collection limit", () => {
    const content = `${Array.from({ length: 257 }, (_, depth) => `${" ".repeat(depth * 2)}key:`).join("\n")}\n${" ".repeat(514)}value\n`;
    const bytes = new TextEncoder().encode(content);
    expect(
      extractATier({
        sourceFile: sourceFile("application/yaml", bytes),
        bytes,
        version: 1,
        identities,
      }),
    ).toMatchObject({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Malformed YAML structure: nesting limit exceeded",
      location: { line: 257 },
    });
  });

  it("rejects alternating map-sequence-map nesting beyond the collection limit", () => {
    const lines: string[] = [];
    let indentation = 0;
    for (let group = 0; group < 86; group += 1) {
      lines.push(`${" ".repeat(indentation)}map:`);
      indentation += 2;
      lines.push(`${" ".repeat(indentation)}- nested:`);
      indentation += 2;
    }
    lines.push(`${" ".repeat(indentation)}value`);
    const bytes = new TextEncoder().encode(`${lines.join("\n")}\n`);
    expect(
      extractATier({
        sourceFile: sourceFile("application/yaml", bytes),
        bytes,
        version: 1,
        identities,
      }),
    ).toMatchObject({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Malformed YAML structure: nesting limit exceeded",
    });
  });

  it("accepts shallow mixed YAML mappings and sequences", () => {
    const bytes = new TextEncoder().encode(
      "root:\n  items:\n    - name: one\n      values:\n        - a\n        - b\n",
    );
    expect(
      extractATier({
        sourceFile: sourceFile("application/yaml", bytes),
        bytes,
        version: 1,
        identities,
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects tabs in YAML indentation", () => {
    const bytes = new TextEncoder().encode("root:\n\t- value\n");
    expect(
      extractATier({
        sourceFile: sourceFile("application/yaml", bytes),
        bytes,
        version: 1,
        identities,
      }),
    ).toEqual({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Malformed YAML structure: tabs in indentation",
      location: { byteOffset: 6, line: 2, column: 1 },
    });
  });

  it("accepts YAML block nesting at the configured limit", () => {
    const content = `${Array.from({ length: 256 }, (_, depth) => `${" ".repeat(depth * 2)}-`).join("\n")}\n${" ".repeat(512)}x\n`;
    const bytes = new TextEncoder().encode(content);
    expect(
      extractATier({
        sourceFile: sourceFile("application/yaml", bytes),
        bytes,
        version: 1,
        identities,
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects excessive YAML flow nesting before invoking the parser", () => {
    const content = `${"[".repeat(1_000)}x`;
    const bytes = new TextEncoder().encode(content);
    const result = extractATier({
      sourceFile: sourceFile("application/yaml", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toEqual({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Malformed YAML structure: nesting limit exceeded",
      location: { byteOffset: 256, line: 1, column: 257 },
    });
  });

  it("rejects YAML aliases before resolution", () => {
    const bytes = new TextEncoder().encode("value: *anchor\n");
    const result = extractATier({
      sourceFile: sourceFile("application/yaml", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toEqual({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Malformed YAML structure: aliases are disabled",
      location: { byteOffset: 7, line: 1, column: 8 },
    });
  });

  it("rejects unresolved custom YAML tags rather than treating them as data", () => {
    const bytes = new TextEncoder().encode("command: !exec run\n");
    const result = extractATier({
      sourceFile: sourceFile("application/yaml", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      location: { byteOffset: 9, line: 1, column: 10 },
    });
  });

  it("accepts an empty file and represents it without invented source spans", () => {
    const bytes = new Uint8Array();

    const result = extractATier({
      sourceFile: sourceFile("text/plain", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { normalizedText: "", locatorMap: [] },
    });
  });

  it("represents an empty CSV without inventing a cell", () => {
    const bytes = new Uint8Array();
    const result = extractATier({
      sourceFile: sourceFile("text/csv", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { normalizedText: "", locatorMap: [] },
    });
  });

  it("maps blank normalized lines with zero-width exact source spans", () => {
    const bytes = new TextEncoder().encode("a\n\nb\n");
    const result = extractATier({
      sourceFile: sourceFile("text/plain", bytes),
      bytes,
      version: 1,
      identities,
    });
    if (!result.ok) throw new Error(result.message);

    expect(result.value.locatorMap).toHaveLength(3);
    expect(result.value.locatorMap[1]).toMatchObject({
      normalized: { utf16Start: 2, utf16End: 2, lineStart: 2, lineEnd: 2 },
      original: { byteStart: 2, byteEnd: 2, lineStart: 2, lineEnd: 2 },
    });
  });

  it("uses the canonical media type while ignoring case and parameters", () => {
    const bytes = new TextEncoder().encode("typed\n");
    const result = extractATier({
      sourceFile: sourceFile("Text/Plain; Charset=UTF-8", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toMatchObject({ ok: true, value: { kind: "text" } });
  });

  it("rejects unsupported media regardless of a trusted-looking extension", () => {
    const bytes = new TextEncoder().encode("# not accepted");
    const file = sourceFile("application/pdf", bytes);
    file.logicalPath = "looks-like-markdown.md";

    expect(
      extractATier({ sourceFile: file, bytes, version: 1, identities }),
    ).toEqual({
      ok: false,
      code: "UNSUPPORTED_MEDIA",
      message: "Unsupported A-tier media type: application/pdf",
    });
  });

  it.each([
    ["application/javascript", "code"],
    ["text/javascript", "code"],
    ["application/typescript", "code"],
    ["text/x-python", "code"],
    ["application/x-ndjson", "code"],
    ["application/x-yaml", "yaml"],
    ["text/yaml", "yaml"],
    ["application/csv", "csv"],
  ] as const)(
    "supports registered A-tier media %s as %s",
    (mediaType, kind) => {
      const content =
        kind === "yaml" ? "a: 1\n" : kind === "csv" ? "a,b\n1,2\n" : "value\n";
      const bytes = new TextEncoder().encode(content);

      expect(
        extractATier({
          sourceFile: sourceFile(mediaType, bytes),
          bytes,
          version: 1,
          identities,
        }),
      ).toMatchObject({ ok: true, value: { kind } });
    },
  );

  it.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid representation version %s as malformed deterministic configuration",
    (version) => {
      const bytes = new TextEncoder().encode("schema\n");
      expect(
        extractATier({
          sourceFile: sourceFile("text/plain", bytes),
          bytes,
          version,
          identities,
        }),
      ).toEqual({
        ok: false,
        code: "MALFORMED_STRUCTURE",
        message: "Invalid extraction input: representation version",
      });
    },
  );

  it("rejects a source file whose digest does not verify the supplied bytes", () => {
    const bytes = new TextEncoder().encode("schema\n");
    const file = sourceFile("text/plain", bytes);
    file.sha256 = "0".repeat(64) as Sha256;
    expect(
      extractATier({ sourceFile: file, bytes, version: 1, identities }),
    ).toEqual({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Invalid extraction input: source file bytes",
    });
  });

  it("rejects a noncanonical source file before extracting", () => {
    const bytes = new TextEncoder().encode("schema\n");
    const file = sourceFile("text/plain", bytes);
    file.size += 1;
    expect(
      extractATier({ sourceFile: file, bytes, version: 1, identities }),
    ).toEqual({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Invalid extraction input: source file",
    });
  });

  it("maps a throwing identity deriver to malformed deterministic configuration", () => {
    const bytes = new TextEncoder().encode("schema\n");
    expect(
      extractATier({
        sourceFile: sourceFile("text/plain", bytes),
        bytes,
        version: 1,
        identities: {
          derive(): SourceRepresentationId {
            throw new Error("deterministic deriver failure");
          },
        },
      }),
    ).toEqual({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Invalid extraction configuration: representation identity",
    });
  });

  it("rejects an invalid identity deriver result", () => {
    const bytes = new TextEncoder().encode("schema\n");
    expect(
      extractATier({
        sourceFile: sourceFile("text/plain", bytes),
        bytes,
        version: 1,
        identities: {
          derive: () => "" as SourceRepresentationId,
        },
      }),
    ).toEqual({
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Invalid extraction configuration: representation identity",
    });
  });

  it("exposes a strict runtime schema for representation records", () => {
    const bytes = new TextEncoder().encode("schema\n");
    const result = extractATier({
      sourceFile: sourceFile("text/plain", bytes),
      bytes,
      version: 1,
      identities,
    });
    if (!result.ok) throw new Error(result.message);

    expect(SourceRepresentationSchema.parse(result.value)).toEqual(
      result.value,
    );
    expect(
      SourceRepresentationSchema.safeParse({
        ...result.value,
        privatePath: "/tmp/raw",
      }).success,
    ).toBe(false);
    expect(
      SourceRepresentationSchema.safeParse({
        ...result.value,
        sourceFileId: "not-a-source-file-id",
      }).success,
    ).toBe(false);
  });

  it("produces deeply immutable, alias-free, repeated structured output", () => {
    const bytes = new TextEncoder().encode("stable\n");
    const file = sourceFile("text/plain", bytes);
    const first = extractATier({
      sourceFile: file,
      bytes,
      version: 1,
      identities,
    });
    const second = extractATier({
      sourceFile: file,
      bytes,
      version: 1,
      identities,
    });

    expect(first).toStrictEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).not.toBe(second);
    if (!first.ok || !second.ok) throw new Error("extraction failed");
    expect(first.value).not.toBe(second.value);
    expect(new TextDecoder().decode(bytes)).toBe("stable\n");
    expect(first.value.locatorMap).not.toBe(second.value.locatorMap);
    expect(Object.isFrozen(first.value)).toBe(true);
    expect(Object.isFrozen(first.value.locatorMap)).toBe(true);
    expect(Object.isFrozen(first.value.locatorMap[0]!.original)).toBe(true);
    expect(Object.isFrozen(first.value.warnings)).toBe(true);
  });

  it("deep-freezes BOM warnings and their locations", () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0x78]);
    const result = extractATier({
      sourceFile: sourceFile("text/plain", bytes),
      bytes,
      version: 1,
      identities,
    });
    if (!result.ok) throw new Error(result.message);

    expect(Object.isFrozen(result.value.warnings[0])).toBe(true);
    expect(Object.isFrozen(result.value.warnings[0]!.location)).toBe(true);
  });

  it("preserves LF, CRLF, and CR line-ending presence with LF normalization", () => {
    for (const [source, normalizedText] of [
      ["a\nb", "a\nb"],
      ["a\r\nb\r\n", "a\nb\n"],
      ["a\rb\r", "a\nb\n"],
    ] as const) {
      const bytes = new TextEncoder().encode(source);
      const result = extractATier({
        sourceFile: sourceFile("text/plain", bytes),
        bytes,
        version: 1,
        identities,
      });
      expect(result).toMatchObject({ ok: true, value: { normalizedText } });
    }
  });

  it("maps every non-empty normalized line for all line-oriented formats", () => {
    for (const [mediaType, content] of [
      ["text/markdown", "a\nb\n"],
      ["text/plain", "a\nb\n"],
      ["text/typescript", "a\nb\n"],
      ["application/json", '{\n  "a": 1\n}\n'],
      ["application/yaml", "a: 1\nb: 2\n"],
    ] as const) {
      const bytes = new TextEncoder().encode(content);
      const result = extractATier({
        sourceFile: sourceFile(mediaType, bytes),
        bytes,
        version: 1,
        identities,
      });
      if (!result.ok) throw new Error(result.message);
      expect(result.value.locatorMap).toHaveLength(
        result.value.normalizedText.split("\n").filter(Boolean).length,
      );
    }
  });

  it("strips a UTF-8 BOM and maps content after its exact three-byte prefix", () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a]);

    const result = extractATier({
      sourceFile: sourceFile("text/plain", bytes),
      bytes,
      version: 1,
      identities,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        normalizedText: "hi\n",
        locatorMap: [
          {
            original: {
              byteStart: 3,
              byteEnd: 5,
              columnStart: 1,
              columnEnd: 3,
            },
          },
        ],
        warnings: [
          {
            code: "UTF8_BOM_REMOVED",
            location: {
              byteStart: 0,
              byteEnd: 3,
              lineStart: 1,
              columnStart: 1,
              lineEnd: 1,
              columnEnd: 1,
            },
          },
        ],
      },
    });
  });
});
