import type { SourceFileId, SourceRepresentationId } from "./types.js";

export type SourceRepresentationKind =
  "markdown" | "text" | "code" | "json" | "yaml" | "csv";

/**
 * Coordinates are half-open. Byte offsets are zero-based and address the
 * original UTF-8 byte stream. Lines and columns are 1-based; columns count
 * JavaScript UTF-16 code units. Normalized offsets are zero-based JavaScript
 * UTF-16 code units. Line/cell spans exclude line endings and CSV delimiters.
 */
export interface LocatorSpan {
  readonly kind: "line" | "cell" | "span";
  readonly normalized: {
    readonly utf16Start: number;
    readonly utf16End: number;
    readonly lineStart: number;
    readonly columnStart: number;
    readonly lineEnd: number;
    readonly columnEnd: number;
  };
  readonly original: {
    readonly byteStart: number;
    readonly byteEnd: number;
    readonly lineStart: number;
    readonly columnStart: number;
    readonly lineEnd: number;
    readonly columnEnd: number;
  };
  readonly cell?: {
    readonly row: number;
    readonly column: number;
  };
}

export interface ExtractionWarning {
  readonly code: string;
  readonly message: string;
  readonly location: LocatorSpan["original"];
}

export interface SourceRepresentation {
  readonly schemaVersion: 1;
  readonly id: SourceRepresentationId;
  readonly sourceFileId: SourceFileId;
  readonly version: number;
  readonly kind: SourceRepresentationKind;
  readonly normalizedText: string;
  readonly locatorMap: readonly LocatorSpan[];
  readonly warnings: readonly ExtractionWarning[];
}
