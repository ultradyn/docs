import { createHash } from "node:crypto";

import type {
  ExtractionWarning,
  IngestResult,
  LocatorSpan,
  SourceFile,
  SourceRepresentation,
  SourceRepresentationId,
  SourceRepresentationKind,
} from "../../domain/ingest/index.js";
import {
  SourceFileSchema,
  SourceRepresentationIdSchema,
  SourceRepresentationSchema,
} from "../../domain/ingest/index.js";
import { parseDocument } from "yaml";

export type ExtractATierErrorCode =
  "UNSUPPORTED_MEDIA" | "MALFORMED_ENCODING" | "MALFORMED_STRUCTURE";

export interface ExtractionErrorLocation {
  readonly byteOffset: number;
  readonly line: number;
  readonly column: number;
}

export type ExtractATierResult =
  | IngestResult<SourceRepresentation, ExtractATierErrorCode>
  | {
      readonly ok: false;
      readonly code: "MALFORMED_ENCODING" | "MALFORMED_STRUCTURE";
      readonly message: string;
      readonly location: ExtractionErrorLocation;
    };

export interface RepresentationIdentityDeriver {
  derive(input: {
    readonly sourceFileId: SourceFile["id"];
    readonly version: number;
    readonly kind: SourceRepresentationKind;
  }): SourceRepresentationId;
}

/**
 * The caller must pass a `SourceFile` already verified by the source-custody
 * seam together with that file's exact bytes. This boundary deliberately has
 * no filesystem path/store access and does not infer media from logicalPath.
 */
export interface ExtractATierInput {
  readonly sourceFile: SourceFile;
  readonly bytes: Uint8Array;
  readonly version: number;
  readonly identities: RepresentationIdentityDeriver;
}

interface SourceLine {
  readonly text: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly line: number;
}

const MEDIA_KINDS = new Map<string, SourceRepresentationKind>([
  ["text/markdown", "markdown"],
  ["text/plain", "text"],
  ["text/typescript", "code"],
  ["application/typescript", "code"],
  ["text/javascript", "code"],
  ["application/javascript", "code"],
  ["text/x-python", "code"],
  ["application/x-ndjson", "code"],
  ["application/json", "json"],
  ["application/yaml", "yaml"],
  ["application/x-yaml", "yaml"],
  ["text/yaml", "yaml"],
  ["text/csv", "csv"],
  ["application/csv", "csv"],
]);

function sourceLines(text: string, initialByteOffset: number): SourceLine[] {
  const lines: SourceLine[] = [];
  let utf16Start = 0;
  let byteStart = initialByteOffset;
  let line = 1;
  const endings = /\r\n|\r|\n/gu;
  for (const match of text.matchAll(endings)) {
    const utf16End = match.index;
    const value = text.slice(utf16Start, utf16End);
    const byteEnd = byteStart + Buffer.byteLength(value);
    lines.push({ text: value, byteStart, byteEnd, line });
    byteStart = byteEnd + Buffer.byteLength(match[0]);
    utf16Start = utf16End + match[0].length;
    line += 1;
  }
  if (utf16Start < text.length) {
    const value = text.slice(utf16Start);
    lines.push({
      text: value,
      byteStart,
      byteEnd: byteStart + Buffer.byteLength(value),
      line,
    });
  }
  return lines;
}

function freezeRepresentation(
  value: SourceRepresentation,
): SourceRepresentation {
  for (const locator of value.locatorMap) {
    Object.freeze(locator.normalized);
    Object.freeze(locator.original);
    if (locator.cell) Object.freeze(locator.cell);
    Object.freeze(locator);
  }
  Object.freeze(value.locatorMap);
  for (const warning of value.warnings) {
    Object.freeze(warning.location);
    Object.freeze(warning);
  }
  Object.freeze(value.warnings);
  return Object.freeze(value);
}

interface Coordinate {
  readonly byte: number;
  readonly normalizedOffset: number;
  readonly line: number;
  readonly column: number;
}

/** One precomputed table supports all source and normalized boundary lookups. */
function coordinateTable(
  text: string,
  initialByteOffset: number,
): readonly Coordinate[] {
  const result = new Array<Coordinate>(text.length + 1);
  let byte = initialByteOffset;
  let normalizedOffset = 0;
  let line = 1;
  let column = 1;
  let index = 0;
  while (index < text.length) {
    result[index] = { byte, normalizedOffset, line, column };
    const character = text[index]!;
    if (character === "\r") {
      byte += 1;
      if (text[index + 1] === "\n") {
        result[index + 1] = {
          byte,
          normalizedOffset,
          line,
          column: column + 1,
        };
        byte += 1;
        index += 2;
      } else {
        index += 1;
      }
      normalizedOffset += 1;
      line += 1;
      column = 1;
      continue;
    }
    if (character === "\n") {
      byte += 1;
      normalizedOffset += 1;
      index += 1;
      line += 1;
      column = 1;
      continue;
    }
    const codePoint = text.codePointAt(index)!;
    const value = String.fromCodePoint(codePoint);
    const width = value.length;
    if (width === 2) {
      result[index + 1] = {
        byte: byte + Buffer.byteLength(character),
        normalizedOffset: normalizedOffset + 1,
        line,
        column: column + 1,
      };
    }
    byte += Buffer.byteLength(value);
    normalizedOffset += width;
    column += width;
    index += width;
  }
  result[text.length] = { byte, normalizedOffset, line, column };
  return result;
}

function malformedUtf8Offset(bytes: Uint8Array): number | undefined {
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index]!;
    let length: number;
    if (first <= 0x7f) length = 1;
    else if (first >= 0xc2 && first <= 0xdf) length = 2;
    else if (first >= 0xe0 && first <= 0xef) length = 3;
    else if (first >= 0xf0 && first <= 0xf4) length = 4;
    else return index;
    if (index + length > bytes.length) return index;
    for (let offset = 1; offset < length; offset += 1) {
      if ((bytes[index + offset]! & 0xc0) !== 0x80) return index;
    }
    const second = bytes[index + 1] ?? 0;
    if (
      (first === 0xe0 && second < 0xa0) ||
      (first === 0xed && second > 0x9f) ||
      (first === 0xf0 && second < 0x90) ||
      (first === 0xf4 && second > 0x8f)
    ) {
      return index;
    }
    index += length;
  }
  return undefined;
}

function byteLocation(
  bytes: Uint8Array,
  byteOffset: number,
): ExtractionErrorLocation {
  const prefix = new TextDecoder().decode(bytes.subarray(0, byteOffset));
  let line = 1;
  let column = 1;
  for (let index = 0; index < prefix.length;) {
    if (prefix[index] === "\r" && prefix[index + 1] === "\n") {
      line += 1;
      column = 1;
      index += 2;
    } else {
      const value = String.fromCodePoint(prefix.codePointAt(index) ?? 0);
      if (value === "\n" || value === "\r") {
        line += 1;
        column = 1;
      } else column += value.length;
      index += value.length;
    }
  }
  return { byteOffset, line, column };
}

type JsonFrame =
  | { kind: "root"; state: "value" | "end" }
  | {
      kind: "array";
      state: "value-or-end" | "value" | "comma-or-end";
    }
  | {
      kind: "object";
      state: "key-or-end" | "key" | "colon" | "value" | "comma-or-end";
    };

function jsonWhitespace(character: string | undefined): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\r" ||
    character === "\n"
  );
}

function scanJsonString(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"') return index + 1;
    if (character.charCodeAt(0) <= 0x1f) return -index - 1;
    if (character !== "\\") continue;
    index += 1;
    if (index >= text.length) return -text.length - 1;
    const escape = text[index]!;
    if ('"\\/bfnrt'.includes(escape)) continue;
    if (escape !== "u") return -index - 1;
    for (let digit = 0; digit < 4; digit += 1) {
      index += 1;
      if (index >= text.length || !/[0-9a-f]/iu.test(text[index]!)) {
        return -Math.min(index, text.length) - 1;
      }
    }
  }
  return -text.length - 1;
}

function scanJsonNumber(text: string, start: number): number {
  let index = start;
  if (text[index] === "-") index += 1;
  if (text[index] === "0") index += 1;
  else if (/[1-9]/u.test(text[index] ?? "")) {
    while (/\d/u.test(text[index] ?? "")) index += 1;
  } else return -Math.min(index, text.length) - 1;
  if (text[index] === ".") {
    index += 1;
    if (!/\d/u.test(text[index] ?? "")) {
      return -Math.min(index, text.length) - 1;
    }
    while (/\d/u.test(text[index] ?? "")) index += 1;
  }
  if (text[index] === "e" || text[index] === "E") {
    index += 1;
    if (text[index] === "+" || text[index] === "-") index += 1;
    if (!/\d/u.test(text[index] ?? "")) {
      return -Math.min(index, text.length) - 1;
    }
    while (/\d/u.test(text[index] ?? "")) index += 1;
  }
  return index;
}

function scanJsonLiteral(text: string, start: number, literal: string): number {
  for (let offset = 0; offset < literal.length; offset += 1) {
    if (text[start + offset] !== literal[offset]) {
      return -Math.min(start + offset, text.length) - 1;
    }
  }
  return start + literal.length;
}

/** Bounded, iterative JSON grammar pass used only to locate native failures. */
function nativeJsonErrorOffset(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const value = /(?:at position|position) (\d+)/u.exec(error.message)?.[1];
  if (value === undefined) return undefined;
  const offset = Number(value);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : undefined;
}

function jsonErrorUtf16Offset(text: string, error: unknown): number {
  const nativeOffset = nativeJsonErrorOffset(error);
  if (nativeOffset !== undefined) return Math.min(nativeOffset, text.length);
  const stack: JsonFrame[] = [{ kind: "root", state: "value" }];
  let index = 0;

  const valueComplete = (frame: JsonFrame): void => {
    if (frame.kind === "root") frame.state = "end";
    else frame.state = "comma-or-end";
  };

  const parseValue = (frame: JsonFrame): number | undefined => {
    const character = text[index];
    if (character === "{") {
      valueComplete(frame);
      stack.push({ kind: "object", state: "key-or-end" });
      return index + 1;
    }
    if (character === "[") {
      valueComplete(frame);
      stack.push({ kind: "array", state: "value-or-end" });
      return index + 1;
    }
    let end: number;
    if (character === '"') end = scanJsonString(text, index);
    else if (character === "t") end = scanJsonLiteral(text, index, "true");
    else if (character === "f") end = scanJsonLiteral(text, index, "false");
    else if (character === "n") end = scanJsonLiteral(text, index, "null");
    else if (character === "-" || /\d/u.test(character ?? "")) {
      end = scanJsonNumber(text, index);
    } else return undefined;
    if (end < 0) return end;
    valueComplete(frame);
    return end;
  };

  while (stack.length > 0) {
    while (jsonWhitespace(text[index])) index += 1;
    const frame = stack.at(-1)!;
    const character = text[index];
    if (frame.kind === "root") {
      if (frame.state === "end") return index;
      const end = parseValue(frame);
      if (end === undefined) return index;
      if (end < 0) return -end - 1;
      index = end;
      continue;
    }
    if (frame.kind === "array") {
      if (frame.state === "comma-or-end") {
        if (character === ",") {
          frame.state = "value";
          index += 1;
        } else if (character === "]") {
          stack.pop();
          index += 1;
        } else return index;
        continue;
      }
      if (frame.state === "value-or-end" && character === "]") {
        stack.pop();
        index += 1;
        continue;
      }
      const end = parseValue(frame);
      if (end === undefined) return index;
      if (end < 0) return -end - 1;
      index = end;
      continue;
    }
    if (frame.state === "comma-or-end") {
      if (character === ",") {
        frame.state = "key";
        index += 1;
      } else if (character === "}") {
        stack.pop();
        index += 1;
      } else return index;
      continue;
    }
    if (frame.state === "key-or-end" && character === "}") {
      stack.pop();
      index += 1;
      continue;
    }
    if (frame.state === "key" || frame.state === "key-or-end") {
      if (character !== '"') return index;
      const end = scanJsonString(text, index);
      if (end < 0) return -end - 1;
      frame.state = "colon";
      index = end;
      continue;
    }
    if (frame.state === "colon") {
      if (character !== ":") return index;
      frame.state = "value";
      index += 1;
      continue;
    }
    const end = parseValue(frame);
    if (end === undefined) return index;
    if (end < 0) return -end - 1;
    index = end;
  }
  while (jsonWhitespace(text[index])) index += 1;
  return index;
}

interface CsvFailure {
  readonly offset: number;
  readonly unterminated: boolean;
}

function csvLocators(
  text: string,
  positions: readonly Coordinate[],
): { readonly locators: LocatorSpan[] } | { readonly failure: CsvFailure } {
  const locators: LocatorSpan[] = [];
  let row = 1;
  let cellColumn = 1;
  let fieldStart = 0;
  let index = 0;
  let quoted = false;
  let closedQuote = false;
  let expectedColumns: number | undefined;

  const emit = (fieldEnd: number): void => {
    const start = positions[fieldStart]!;
    const end = positions[fieldEnd]!;
    locators.push({
      kind: "cell",
      cell: { row, column: cellColumn },
      normalized: {
        utf16Start: start.normalizedOffset,
        utf16End: end.normalizedOffset,
        lineStart: start.line,
        columnStart: start.column,
        lineEnd: end.line,
        columnEnd: end.column,
      },
      original: {
        byteStart: start.byte,
        byteEnd: end.byte,
        lineStart: start.line,
        columnStart: start.column,
        lineEnd: end.line,
        columnEnd: end.column,
      },
    });
  };

  const endRecord = (offset: number): CsvFailure | undefined => {
    if (expectedColumns === undefined) expectedColumns = cellColumn;
    else if (cellColumn !== expectedColumns) {
      return { offset, unterminated: false };
    }
    row += 1;
    cellColumn = 1;
    return undefined;
  };

  while (index < text.length) {
    const character = text[index]!;
    if (index === fieldStart && character === '"') {
      quoted = true;
      index += 1;
      continue;
    }
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') index += 2;
        else {
          quoted = false;
          closedQuote = true;
          index += 1;
        }
      } else index += 1;
      continue;
    }
    if (character === '"')
      return { failure: { offset: index, unterminated: false } };
    if (
      closedQuote &&
      character !== "," &&
      character !== "\r" &&
      character !== "\n"
    ) {
      return { failure: { offset: index, unterminated: false } };
    }
    if (character === ",") {
      emit(index);
      cellColumn += 1;
      index += 1;
      fieldStart = index;
      closedQuote = false;
      continue;
    }
    if (character === "\r" || character === "\n") {
      emit(index);
      const failure = endRecord(index);
      if (failure) return { failure };
      if (character === "\r" && text[index + 1] === "\n") index += 2;
      else index += 1;
      fieldStart = index;
      closedQuote = false;
      continue;
    }
    index += 1;
  }
  if (quoted) return { failure: { offset: fieldStart, unterminated: true } };
  if (fieldStart < text.length || text.endsWith(",")) {
    emit(text.length);
    const failure = endRecord(text.length);
    if (failure) return { failure };
  }
  return { locators };
}

function malformedStructure(message: string): ExtractATierResult {
  return { ok: false, code: "MALFORMED_STRUCTURE", message };
}

const YAML_NESTING_LIMIT = 256;
const YAML_MAX_BYTES = 16 * 1024 * 1024;

type YamlPreflightFailure = {
  readonly kind: "nesting" | "alias" | "indentation-tab";
  readonly offset: number;
};

interface YamlLineLexical {
  readonly code: string;
  readonly structuralOffsets: ReadonlySet<number>;
}

function yamlLineLexical(content: string): YamlLineLexical {
  let inSingleQuoted = false;
  let inDoubleQuoted = false;
  let escaped = false;
  const structuralOffsets = new Set<number>();
  let commentOffset = content.length;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (inDoubleQuoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inDoubleQuoted = false;
      continue;
    }
    if (inSingleQuoted) {
      if (character === "'" && content[index + 1] === "'") index += 1;
      else if (character === "'") inSingleQuoted = false;
      continue;
    }
    if (character === '"') inDoubleQuoted = true;
    else if (character === "'") inSingleQuoted = true;
    else if (
      character === "#" &&
      (index === 0 || /[ \t]/u.test(content[index - 1]!))
    ) {
      commentOffset = index;
      break;
    } else structuralOffsets.add(index);
  }
  return {
    code: content.slice(0, commentOffset).trimEnd(),
    structuralOffsets,
  };
}

function yamlLineCollectionOffsets(
  lexical: YamlLineLexical,
): readonly number[] {
  const withoutComment = lexical.code;
  const offsets: number[] = [];
  let cursor = 0;
  while (
    withoutComment[cursor] === "-" &&
    (cursor + 1 === withoutComment.length ||
      /[ \t]/u.test(withoutComment[cursor + 1] ?? ""))
  ) {
    offsets.push(cursor);
    cursor += 1;
    while (withoutComment[cursor] === " ") cursor += 1;
  }
  const remainder = withoutComment.slice(cursor);
  if (/^(?:[^:]+|"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'):\s*$/u.test(remainder)) {
    offsets.push(cursor);
  }
  return offsets;
}

function yamlPreflight(text: string): YamlPreflightFailure | undefined {
  let flowDepth = 0;
  const blockIndents: number[] = [];
  let index = 0;
  while (index < text.length) {
    const lineStart = index;
    let lineEnd = index;
    while (
      lineEnd < text.length &&
      text[lineEnd] !== "\r" &&
      text[lineEnd] !== "\n"
    ) {
      lineEnd += 1;
    }
    let contentStart = lineStart;
    while (contentStart < lineEnd && text[contentStart] === " ") {
      contentStart += 1;
    }
    if (text[contentStart] === "\t") {
      return { kind: "indentation-tab", offset: contentStart };
    }
    const content = text.slice(contentStart, lineEnd);
    const lexical = yamlLineLexical(content);
    const significant = lexical.code.trim();
    if (significant !== "" && !significant.startsWith("#")) {
      const indentation = contentStart - lineStart;
      while (
        blockIndents.length > 0 &&
        indentation <= Math.floor(blockIndents.at(-1)!)
      ) {
        blockIndents.pop();
      }
      const collectionOffsets = yamlLineCollectionOffsets(lexical);
      for (const collectionOffset of collectionOffsets) {
        blockIndents.push(indentation + collectionOffset / 1_000);
        if (blockIndents.length + flowDepth > YAML_NESTING_LIMIT) {
          return {
            kind: "nesting",
            offset: contentStart + collectionOffset,
          };
        }
      }
    }

    for (const relativeOffset of lexical.structuralOffsets) {
      const character = content[relativeOffset]!;
      const cursor = contentStart + relativeOffset;
      if (
        character === "*" &&
        (relativeOffset === 0 ||
          /[\s[{,:?-]/u.test(content[relativeOffset - 1]!)) &&
        !jsonWhitespace(content[relativeOffset + 1])
      ) {
        return { kind: "alias", offset: cursor };
      }
      if (character === "[" || character === "{") {
        flowDepth += 1;
        if (blockIndents.length + flowDepth > YAML_NESTING_LIMIT) {
          return { kind: "nesting", offset: cursor };
        }
      } else if (character === "]" || character === "}") {
        flowDepth = Math.max(0, flowDepth - 1);
      }
    }
    index = lineEnd;
    if (text[index] === "\r" && text[index + 1] === "\n") index += 2;
    else if (index < text.length) index += 1;
  }
  return undefined;
}

export function extractATier(input: ExtractATierInput): ExtractATierResult {
  const sourceFileResult = SourceFileSchema.safeParse(input.sourceFile);
  if (
    !sourceFileResult.success ||
    input.sourceFile.size !== input.bytes.byteLength
  ) {
    return malformedStructure("Invalid extraction input: source file");
  }
  if (
    createHash("sha256").update(input.bytes).digest("hex") !==
    input.sourceFile.sha256
  ) {
    return malformedStructure("Invalid extraction input: source file bytes");
  }
  if (!Number.isSafeInteger(input.version) || input.version <= 0) {
    return malformedStructure(
      "Invalid extraction input: representation version",
    );
  }

  const canonicalMediaType = input.sourceFile.mediaType
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  const kind = MEDIA_KINDS.get(canonicalMediaType);
  if (!kind) {
    return {
      ok: false,
      code: "UNSUPPORTED_MEDIA",
      message: `Unsupported A-tier media type: ${input.sourceFile.mediaType}`,
    };
  }

  if (kind === "yaml" && input.bytes.byteLength > YAML_MAX_BYTES) {
    return {
      ok: false,
      code: "MALFORMED_STRUCTURE",
      message: "Malformed YAML structure: size limit exceeded",
      location: { byteOffset: YAML_MAX_BYTES, line: 1, column: 1 },
    };
  }

  const malformedOffset = malformedUtf8Offset(input.bytes);
  if (malformedOffset !== undefined) {
    const location = byteLocation(input.bytes, malformedOffset);
    return {
      ok: false,
      code: "MALFORMED_ENCODING",
      message: `Malformed UTF-8 at byte ${location.byteOffset} (line ${location.line}, column ${location.column})`,
      location,
    };
  }
  const hasBom =
    input.bytes[0] === 0xef &&
    input.bytes[1] === 0xbb &&
    input.bytes[2] === 0xbf;
  const initialByteOffset = hasBom ? 3 : 0;
  const decoded = new TextDecoder().decode(
    input.bytes.subarray(initialByteOffset),
  );
  const warnings: ExtractionWarning[] = hasBom
    ? [
        {
          code: "UTF8_BOM_REMOVED",
          message: "UTF-8 BOM removed from normalized text",
          location: {
            byteStart: 0,
            byteEnd: 3,
            lineStart: 1,
            columnStart: 1,
            lineEnd: 1,
            columnEnd: 1,
          },
        },
      ]
    : [];

  if (kind === "json") {
    try {
      JSON.parse(decoded);
    } catch (error) {
      const utf16Offset = jsonErrorUtf16Offset(decoded, error);
      const byteOffset =
        initialByteOffset + Buffer.byteLength(decoded.slice(0, utf16Offset));
      return {
        ok: false,
        code: "MALFORMED_STRUCTURE",
        message: "Malformed JSON structure",
        location: byteLocation(input.bytes, byteOffset),
      };
    }
  }
  if (kind === "yaml") {
    const preflightFailure = yamlPreflight(decoded);
    if (preflightFailure) {
      const byteOffset =
        initialByteOffset +
        Buffer.byteLength(decoded.slice(0, preflightFailure.offset));
      return {
        ok: false,
        code: "MALFORMED_STRUCTURE",
        message:
          preflightFailure.kind === "alias"
            ? "Malformed YAML structure: aliases are disabled"
            : preflightFailure.kind === "indentation-tab"
              ? "Malformed YAML structure: tabs in indentation"
              : "Malformed YAML structure: nesting limit exceeded",
        location: byteLocation(input.bytes, byteOffset),
      };
    }
    let document;
    try {
      document = parseDocument(decoded, {
        customTags: [],
        merge: false,
        prettyErrors: false,
        resolveKnownTags: false,
        schema: "core",
        strict: true,
        uniqueKeys: true,
      });
    } catch {
      return {
        ok: false,
        code: "MALFORMED_STRUCTURE",
        message: "Malformed YAML structure",
        location: byteLocation(input.bytes, initialByteOffset),
      };
    }
    const problem = document.errors[0] ?? document.warnings[0];
    if (problem) {
      const utf16Offset = problem.pos[0];
      const byteOffset =
        initialByteOffset + Buffer.byteLength(decoded.slice(0, utf16Offset));
      return {
        ok: false,
        code: "MALFORMED_STRUCTURE",
        message: "Malformed YAML structure",
        location: byteLocation(input.bytes, byteOffset),
      };
    }
  }

  const lines = sourceLines(decoded, initialByteOffset);
  let normalizedText = "";
  let locatorMap: LocatorSpan[] = [];
  if (kind === "csv") {
    const positions = coordinateTable(decoded, initialByteOffset);
    const parsed = csvLocators(decoded, positions);
    if ("failure" in parsed) {
      const position = positions[parsed.failure.offset]!;
      return {
        ok: false,
        code: "MALFORMED_STRUCTURE",
        message: parsed.failure.unterminated
          ? "Malformed CSV structure: unterminated quoted field"
          : "Malformed CSV structure",
        location: {
          byteOffset: position.byte,
          line: position.line,
          column: position.column,
        },
      };
    }
    normalizedText = decoded.replace(/\r\n|\r/gu, "\n");
    locatorMap = parsed.locators;
  }
  for (const line of kind === "csv" ? [] : lines) {
    const normalizedStart = normalizedText.length;
    normalizedText += line.text;
    if (line.byteEnd < input.bytes.length) normalizedText += "\n";
    locatorMap.push({
      kind: "line",
      normalized: {
        utf16Start: normalizedStart,
        utf16End: normalizedStart + line.text.length,
        lineStart: line.line,
        columnStart: 1,
        lineEnd: line.line,
        columnEnd: line.text.length + 1,
      },
      original: {
        byteStart: line.byteStart,
        byteEnd: line.byteEnd,
        lineStart: line.line,
        columnStart: 1,
        lineEnd: line.line,
        columnEnd: line.text.length + 1,
      },
    });
  }

  let derivedId: SourceRepresentationId;
  try {
    derivedId = input.identities.derive({
      sourceFileId: input.sourceFile.id,
      version: input.version,
      kind,
    });
  } catch {
    return malformedStructure(
      "Invalid extraction configuration: representation identity",
    );
  }
  const idResult = SourceRepresentationIdSchema.safeParse(derivedId);
  if (!idResult.success) {
    return malformedStructure(
      "Invalid extraction configuration: representation identity",
    );
  }
  const representationResult = SourceRepresentationSchema.safeParse({
    schemaVersion: 1,
    id: idResult.data,
    sourceFileId: input.sourceFile.id,
    version: input.version,
    kind,
    normalizedText,
    locatorMap,
    warnings,
  });
  if (!representationResult.success) {
    return malformedStructure("Invalid extraction output");
  }
  return {
    ok: true,
    value: freezeRepresentation(
      representationResult.data as SourceRepresentation,
    ),
  };
}
