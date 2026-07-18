import type {
  ExtractionWarning,
  IngestResult,
  LocatorSpan,
  SourceFile,
  SourceRepresentation,
  SourceRepresentationId,
  SourceRepresentationKind,
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
  readonly line: number;
  readonly column: number;
}

function coordinates(text: string): readonly Coordinate[] {
  const result: Coordinate[] = [];
  let byte = 0;
  let line = 1;
  let column = 1;
  for (let index = 0; index < text.length;) {
    result[index] = { byte, line, column };
    if (text[index] === "\r" && text[index + 1] === "\n") {
      byte += 1;
      result[index + 1] = { byte, line, column: column + 1 };
      byte += 1;
      index += 2;
      line += 1;
      column = 1;
      continue;
    }
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const value = String.fromCodePoint(codePoint);
    const width = value.length;
    if (width === 2) {
      result[index + 1] = { byte, line, column: column + 1 };
    }
    byte += Buffer.byteLength(value);
    index += width;
    if (value === "\n" || value === "\r") {
      line += 1;
      column = 1;
    } else {
      column += width;
    }
  }
  result[text.length] = { byte, line, column };
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

function jsonErrorUtf16Offset(text: string): number {
  let index = 0;
  const whitespace = /\s/u;
  const parseValue = (): void => {
    while (whitespace.test(text[index] ?? "")) index += 1;
    const character = text[index];
    if (character === '"') {
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") index += 2;
        else if (text[index] === '"') {
          index += 1;
          return;
        } else index += 1;
      }
      return;
    }
    if (character === "{") {
      index += 1;
      while (true) {
        while (whitespace.test(text[index] ?? "")) index += 1;
        if (text[index] === "}") {
          index += 1;
          return;
        }
        parseValue();
        while (whitespace.test(text[index] ?? "")) index += 1;
        if (text[index] !== ":") throw new Error(String(index));
        index += 1;
        parseValue();
        while (whitespace.test(text[index] ?? "")) index += 1;
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") throw new Error(String(index));
        index += 1;
      }
    }
    if (character === "[") {
      index += 1;
      while (true) {
        while (whitespace.test(text[index] ?? "")) index += 1;
        if (text[index] === "]") {
          index += 1;
          return;
        }
        parseValue();
        while (whitespace.test(text[index] ?? "")) index += 1;
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") throw new Error(String(index));
        index += 1;
      }
    }
    const match =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(
        text.slice(index),
      );
    if (!match) throw new Error(String(index));
    index += match[0].length;
  };
  try {
    parseValue();
    while (whitespace.test(text[index] ?? "")) index += 1;
    return index;
  } catch (error) {
    return Number(error instanceof Error ? error.message : index);
  }
}

function normalizedOffset(text: string, sourceOffset: number): number {
  return text.slice(0, sourceOffset).replace(/\r\n|\r/gu, "\n").length;
}

function csvLocators(
  text: string,
  initialByteOffset: number,
): LocatorSpan[] | undefined {
  const positions = coordinates(text).map((coordinate) => ({
    ...coordinate,
    byte: coordinate.byte + initialByteOffset,
  }));
  const locators: LocatorSpan[] = [];
  let row = 1;
  let column = 1;
  let fieldStart = 0;
  let index = 0;
  let quoted = false;
  let closedQuote = false;
  let expectedColumns: number | undefined;

  const emit = (fieldEnd: number): void => {
    const start = positions[fieldStart]!;
    const end = positions[fieldEnd]!;
    const normalizedStart = normalizedOffset(text, fieldStart);
    const normalizedEnd = normalizedOffset(text, fieldEnd);
    locators.push({
      kind: "cell",
      cell: { row, column },
      normalized: {
        utf16Start: normalizedStart,
        utf16End: normalizedEnd,
        lineStart: positions[fieldStart]!.line,
        columnStart:
          normalizedStart -
          normalizedOffset(text, text.lastIndexOf("\n", fieldStart - 1) + 1) +
          1,
        columnEnd: positions[fieldEnd]!.column,
        lineEnd: positions[fieldEnd]!.line,
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

  const endRecord = (): boolean => {
    if (expectedColumns === undefined) expectedColumns = column;
    else if (column !== expectedColumns) return false;
    row += 1;
    column = 1;
    return true;
  };

  while (index < text.length) {
    const character = text[index];
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
    if (
      closedQuote &&
      character !== "," &&
      character !== "\r" &&
      character !== "\n"
    ) {
      return undefined;
    }
    if (character === ",") {
      emit(index);
      column += 1;
      index += 1;
      fieldStart = index;
      closedQuote = false;
      continue;
    }
    if (character === "\r" || character === "\n") {
      emit(index);
      if (!endRecord()) return undefined;
      if (character === "\r" && text[index + 1] === "\n") index += 2;
      else index += 1;
      fieldStart = index;
      closedQuote = false;
      continue;
    }
    index += 1;
  }
  if (quoted) return undefined;
  if (fieldStart < text.length || text.endsWith(",")) {
    emit(text.length);
    if (!endRecord()) return undefined;
  }
  return locators;
}

export function extractATier(input: ExtractATierInput): ExtractATierResult {
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
    } catch {
      const utf16Offset = jsonErrorUtf16Offset(decoded);
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
    const document = parseDocument(decoded, {
      prettyErrors: false,
      strict: true,
    });
    if (document.errors.length > 0) {
      const utf16Offset = document.errors[0]!.pos[0]!;
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
    const parsed = csvLocators(decoded, initialByteOffset);
    if (!parsed) {
      const lastRecord = Math.max(
        decoded.lastIndexOf("\n", decoded.length - 2),
        decoded.lastIndexOf("\r", decoded.length - 2),
      );
      const utf16Offset = lastRecord < 0 ? 0 : lastRecord + 1;
      const byteOffset =
        initialByteOffset + Buffer.byteLength(decoded.slice(0, utf16Offset));
      return {
        ok: false,
        code: "MALFORMED_STRUCTURE",
        message: "Malformed CSV structure",
        location: byteLocation(input.bytes, byteOffset),
      };
    }
    normalizedText = decoded.replace(/\r\n|\r/gu, "\n");
    locatorMap = parsed;
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

  return {
    ok: true,
    value: freezeRepresentation({
      schemaVersion: 1,
      id: input.identities.derive({
        sourceFileId: input.sourceFile.id,
        version: input.version,
        kind,
      }),
      sourceFileId: input.sourceFile.id,
      version: input.version,
      kind,
      normalizedText,
      locatorMap,
      warnings,
    }),
  };
}
