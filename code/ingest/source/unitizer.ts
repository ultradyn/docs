import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  IngestResult,
  RepresentationAudit,
  Sha256,
  SourceFile,
  SourceRepresentation,
  SourceUnit,
  SourceUnitId,
  SourceUnitKind,
} from "../../domain/ingest/index.js";
import {
  RepresentationAuditSchema,
  SourceFileSchema,
  SourceRepresentationSchema,
  SourceUnitIdSchema,
  SourceUnitSchema,
} from "../../domain/ingest/index.js";
import {
  auditRepresentation,
  capabilityFor,
} from "./representation-auditor.js";

export interface UnitizeRepresentationInput {
  readonly sourceFile: SourceFile;
  readonly representation: SourceRepresentation;
  readonly audit: RepresentationAudit;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function sha256(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}

function unitId(input: {
  readonly logicalPath: string;
  readonly anchor: readonly {
    readonly heading: string;
    readonly occurrence: number;
  }[];
  readonly kind: SourceUnitKind;
  readonly textSha256: Sha256;
  readonly duplicateOrdinal: number;
}): SourceUnitId {
  const key = JSON.stringify({
    logicalPath: input.logicalPath,
    anchor: input.anchor,
    kind: input.kind,
    textSha256: input.textSha256,
    duplicateOrdinal: input.duplicateOrdinal,
  });
  const bytes = createHash("sha256").update(key).digest().subarray(0, 16);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD[Number(value & 31n)]! + encoded;
    value >>= 5n;
  }
  return SourceUnitIdSchema.parse(`unit-${encoded}`);
}

function isPlainDataGraph(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const pending: object[] = [input];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (pending.length > 0) {
    const value = pending.pop()!;
    if (seen.has(value)) return false;
    seen.add(value);
    visited += 1;
    if (visited > 1_000_000) return false;
    const array = Array.isArray(value);
    if (
      Object.getPrototypeOf(value) !==
      (array ? Array.prototype : Object.prototype)
    ) {
      return false;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") return false;
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        return false;
      }
      const child: unknown = descriptor.value;
      if (typeof child === "object" && child !== null) pending.push(child);
    }
  }
  return true;
}

function qualificationFailure(
  message: string,
): IngestResult<never, "AUDIT_REQUIRED"> {
  return { ok: false, code: "AUDIT_REQUIRED", message };
}

function textDropped(message: string): IngestResult<never, "TEXT_DROPPED"> {
  return { ok: false, code: "TEXT_DROPPED", message };
}

interface UnitDraft {
  readonly kind: SourceUnitKind;
  readonly headingPath: readonly string[];
  readonly anchor: readonly {
    readonly heading: string;
    readonly occurrence: number;
  }[];
  readonly firstLocator: number;
  readonly lastLocator: number;
  readonly parentDraft?: number;
}

function textEndPosition(text: string): {
  readonly line: number;
  readonly column: number;
} {
  let line = 1;
  let column = 1;
  for (const character of text) {
    if (character === "\n") {
      line += 1;
      column = 1;
    } else column += character.length;
  }
  return { line, column };
}

function composedUnit(
  input: UnitizeRepresentationInput,
  draft: UnitDraft,
  parentId: SourceUnitId | undefined,
  duplicateOrdinal: number,
  documentEnd: { readonly line: number; readonly column: number },
): SourceUnit {
  const first = input.representation.locatorMap[draft.firstLocator]!;
  const last = input.representation.locatorMap[draft.lastLocator]!;
  const document = draft.kind === "document";
  const normalizedLocator = document
    ? {
        utf16Start: 0,
        utf16End: input.representation.normalizedText.length,
        lineStart: 1,
        columnStart: 1,
        lineEnd: documentEnd.line,
        columnEnd: documentEnd.column,
      }
    : {
        utf16Start: first.normalized.utf16Start,
        utf16End: last.normalized.utf16End,
        lineStart: first.normalized.lineStart,
        columnStart: first.normalized.columnStart,
        lineEnd: last.normalized.lineEnd,
        columnEnd: last.normalized.columnEnd,
      };
  const originalLocator = document
    ? {
        byteStart: first.original.byteStart,
        byteEnd: last.original.byteEnd,
        lineStart: first.original.lineStart,
        columnStart: first.original.columnStart,
        lineEnd: last.original.lineEnd,
        columnEnd: last.original.columnEnd,
      }
    : {
        byteStart: first.original.byteStart,
        byteEnd: last.original.byteEnd,
        lineStart: first.original.lineStart,
        columnStart: first.original.columnStart,
        lineEnd: last.original.lineEnd,
        columnEnd: last.original.columnEnd,
      };
  const selected = input.representation.normalizedText.slice(
    normalizedLocator.utf16Start,
    normalizedLocator.utf16End,
  );
  const textSha256 = sha256(selected);
  return SourceUnitSchema.parse({
    schemaVersion: 1,
    id: unitId({
      logicalPath: input.sourceFile.logicalPath,
      anchor: draft.anchor,
      kind: draft.kind,
      textSha256,
      duplicateOrdinal,
    }),
    snapshotId: input.sourceFile.snapshotId,
    sourceFileId: input.sourceFile.id,
    representationId: input.representation.id,
    kind: draft.kind,
    ...(parentId === undefined ? {} : { parentId }),
    headingPath: [...draft.headingPath],
    normalizedLocator,
    originalLocator,
    textSha256,
  }) as SourceUnit;
}

function textDrafts(representation: SourceRepresentation): UnitDraft[] {
  const drafts: UnitDraft[] = [];
  let start: number | undefined;
  for (const [index, locator] of representation.locatorMap.entries()) {
    const text = representation.normalizedText.slice(
      locator.normalized.utf16Start,
      locator.normalized.utf16End,
    );
    if (text.trim() === "") {
      if (start !== undefined) {
        drafts.push({
          kind: "paragraph",
          headingPath: [],
          anchor: [],
          firstLocator: start,
          lastLocator: index - 1,
          parentDraft: 0,
        });
        start = undefined;
      }
    } else if (start === undefined) start = index;
  }
  if (start !== undefined) {
    drafts.push({
      kind: "paragraph",
      headingPath: [],
      anchor: [],
      firstLocator: start,
      lastLocator: representation.locatorMap.length - 1,
      parentDraft: 0,
    });
  }
  return drafts;
}

function lineText(
  representation: SourceRepresentation,
  locatorIndex: number,
): string {
  const locator = representation.locatorMap[locatorIndex]!;
  return representation.normalizedText.slice(
    locator.normalized.utf16Start,
    locator.normalized.utf16End,
  );
}

interface SectionState {
  readonly depth: number;
  readonly draftIndex: number;
  readonly headingPath: readonly string[];
  readonly anchor: readonly {
    readonly heading: string;
    readonly occurrence: number;
  }[];
}

function markdownHeading(
  text: string,
): { readonly depth: number; readonly heading: string } | undefined {
  const match = /^(#{1,6})[\t ]+(.+?)\s*$/u.exec(text);
  if (!match) return undefined;
  const heading = match[2]!.replace(/[\t ]+#+[\t ]*$/u, "").trim();
  return heading === "" ? undefined : { depth: match[1]!.length, heading };
}

function listLine(text: string): boolean {
  return /^ {0,3}(?:[-+*]|\d+[.)])[\t ]+\S/u.test(text);
}

function tableDelimiter(text: string): boolean {
  const cells = text.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|");
  return (
    cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell))
  );
}

function tableStart(
  representation: SourceRepresentation,
  index: number,
): boolean {
  return (
    lineText(representation, index).includes("|") &&
    index + 1 < representation.locatorMap.length &&
    tableDelimiter(lineText(representation, index + 1))
  );
}

function markdownDrafts(
  representation: SourceRepresentation,
): IngestResult<readonly UnitDraft[], "TEXT_DROPPED"> {
  const drafts: UnitDraft[] = [];
  const sections: SectionState[] = [];
  const headingOccurrences = new Map<string, number>();
  let index = 0;

  const append = (
    kind: SourceUnitKind,
    firstLocator: number,
    lastLocator: number,
  ): void => {
    const section = sections.at(-1);
    drafts.push({
      kind,
      headingPath: section?.headingPath ?? [],
      anchor: section?.anchor ?? [],
      firstLocator,
      lastLocator,
      parentDraft: section?.draftIndex ?? 0,
    });
  };

  while (index < representation.locatorMap.length) {
    const text = lineText(representation, index);
    if (text.trim() === "") {
      index += 1;
      continue;
    }

    const fence = /^ {0,3}(`{3,}|~{3,})/u.exec(text)?.[1];
    if (fence) {
      const marker = fence[0]!;
      const minimum = fence.length;
      let closing = index + 1;
      while (closing < representation.locatorMap.length) {
        const candidate = lineText(representation, closing);
        const closingMatch = /^ {0,3}(`+|~+)\s*$/u.exec(candidate)?.[1];
        if (
          closingMatch &&
          closingMatch[0] === marker &&
          closingMatch.length >= minimum
        ) {
          break;
        }
        closing += 1;
      }
      if (closing >= representation.locatorMap.length) {
        return textDropped("Markdown fenced code block is not closed.");
      }
      append("code", index, closing);
      index = closing + 1;
      continue;
    }

    const heading = markdownHeading(text);
    if (heading) {
      while (
        sections.at(-1)?.depth !== undefined &&
        sections.at(-1)!.depth >= heading.depth
      ) {
        sections.pop();
      }
      const parent = sections.at(-1);
      const parentDraft = parent?.draftIndex ?? 0;
      const occurrenceKey = JSON.stringify([parentDraft, heading.heading]);
      const occurrence = (headingOccurrences.get(occurrenceKey) ?? 0) + 1;
      headingOccurrences.set(occurrenceKey, occurrence);
      const headingPath = [...(parent?.headingPath ?? []), heading.heading];
      const anchor = [
        ...(parent?.anchor ?? []),
        { heading: heading.heading, occurrence },
      ];
      const draftIndex = drafts.length + 1;
      drafts.push({
        kind: "section",
        headingPath,
        anchor,
        firstLocator: index,
        lastLocator: index,
        parentDraft,
      });
      sections.push({
        depth: heading.depth,
        draftIndex,
        headingPath,
        anchor,
      });
      index += 1;
      continue;
    }

    if (tableStart(representation, index)) {
      let end = index + 1;
      while (
        end + 1 < representation.locatorMap.length &&
        lineText(representation, end + 1).includes("|") &&
        lineText(representation, end + 1).trim() !== ""
      ) {
        end += 1;
      }
      append("table", index, end);
      index = end + 1;
      continue;
    }

    if (listLine(text)) {
      let end = index;
      while (end + 1 < representation.locatorMap.length) {
        const next = lineText(representation, end + 1);
        if (listLine(next) || /^\s{2,}\S/u.test(next)) end += 1;
        else break;
      }
      append("list", index, end);
      index = end + 1;
      continue;
    }

    let end = index;
    while (end + 1 < representation.locatorMap.length) {
      const nextIndex = end + 1;
      const next = lineText(representation, nextIndex);
      if (
        next.trim() === "" ||
        markdownHeading(next) ||
        /^ {0,3}(`{3,}|~{3,})/u.test(next) ||
        listLine(next) ||
        tableStart(representation, nextIndex)
      ) {
        break;
      }
      end += 1;
    }
    append("paragraph", index, end);
    index = end + 1;
  }

  return { ok: true, value: drafts };
}

function wholeRepresentationDraft(kind: "code" | "table"): UnitDraft[] {
  return [
    {
      kind,
      headingPath: [],
      anchor: [],
      firstLocator: 0,
      lastLocator: Number.MAX_SAFE_INTEGER,
      parentDraft: 0,
    },
  ];
}

function coveragePass(
  representation: SourceRepresentation,
  units: readonly SourceUnit[],
): boolean {
  const covered = new Uint8Array(representation.normalizedText.length);
  for (const unit of units) {
    if (unit.kind === "document") continue;
    for (
      let offset = unit.normalizedLocator.utf16Start;
      offset < unit.normalizedLocator.utf16End;
      offset += 1
    ) {
      if (!/\s/u.test(representation.normalizedText[offset]!)) {
        if (covered[offset] !== 0) return false;
        covered[offset] = 1;
      }
    }
  }
  for (
    let offset = 0;
    offset < representation.normalizedText.length;
    offset += 1
  ) {
    if (
      !/\s/u.test(representation.normalizedText[offset]!) &&
      covered[offset] !== 1
    ) {
      return false;
    }
  }
  return true;
}

function buildUnits(
  input: UnitizeRepresentationInput,
  atomicDrafts: readonly UnitDraft[],
): IngestResult<readonly SourceUnit[], "TEXT_DROPPED"> {
  const drafts: UnitDraft[] = [
    {
      kind: "document",
      headingPath: [],
      anchor: [],
      firstLocator: 0,
      lastLocator: input.representation.locatorMap.length - 1,
    },
    ...atomicDrafts,
  ];
  const units: SourceUnit[] = [];
  const duplicateCounts = new Map<string, number>();
  const documentEnd = textEndPosition(input.representation.normalizedText);
  for (const draft of drafts) {
    const parentId =
      draft.parentDraft === undefined
        ? undefined
        : units[draft.parentDraft]?.id;
    if (draft.parentDraft !== undefined && parentId === undefined) {
      return textDropped("Structural unit parent does not precede its child.");
    }
    const lastLocator =
      draft.lastLocator === Number.MAX_SAFE_INTEGER
        ? input.representation.locatorMap.length - 1
        : draft.lastLocator;
    const resolvedDraft = { ...draft, lastLocator };
    const first = input.representation.locatorMap[resolvedDraft.firstLocator];
    const last = input.representation.locatorMap[resolvedDraft.lastLocator];
    if (!first || !last) {
      return textDropped("Structural locator composition failed.");
    }
    if (
      first.original.byteStart > input.sourceFile.size ||
      first.original.byteEnd > input.sourceFile.size ||
      last.original.byteStart > input.sourceFile.size ||
      last.original.byteEnd > input.sourceFile.size
    ) {
      return textDropped(
        "Structural original locator exceeds source-file bytes.",
      );
    }
    const selected =
      draft.kind === "document"
        ? input.representation.normalizedText
        : input.representation.normalizedText.slice(
            first.normalized.utf16Start,
            last.normalized.utf16End,
          );
    const duplicateKey = JSON.stringify({
      parentId,
      anchor: draft.anchor,
      kind: draft.kind,
      textSha256: sha256(selected),
    });
    const ordinal = (duplicateCounts.get(duplicateKey) ?? 0) + 1;
    duplicateCounts.set(duplicateKey, ordinal);
    units.push(
      composedUnit(input, resolvedDraft, parentId, ordinal, documentEnd),
    );
  }
  if (new Set(units.map((unit) => unit.id)).size !== units.length) {
    return textDropped("Structural unit identities collide.");
  }
  if (!coveragePass(input.representation, units)) {
    return textDropped("Selected source text is not covered exactly once.");
  }
  return { ok: true, value: freezeUnits(units) };
}

function freezeUnits(units: readonly SourceUnit[]): readonly SourceUnit[] {
  for (const unit of units) {
    Object.freeze(unit.headingPath);
    Object.freeze(unit.normalizedLocator);
    Object.freeze(unit.originalLocator);
    Object.freeze(unit);
  }
  return Object.freeze(units);
}

export function unitizeRepresentation(
  input: UnitizeRepresentationInput,
): IngestResult<readonly SourceUnit[], "AUDIT_REQUIRED" | "TEXT_DROPPED"> {
  if (!isPlainDataGraph(input)) {
    return qualificationFailure("Canonical plain data input is required.");
  }

  const sourceFileResult = SourceFileSchema.safeParse(input.sourceFile);
  const representationResult = SourceRepresentationSchema.safeParse(
    input.representation,
  );
  const auditResult = RepresentationAuditSchema.safeParse(input.audit);
  if (
    !sourceFileResult.success ||
    !representationResult.success ||
    !auditResult.success
  ) {
    return qualificationFailure(
      "Canonical source-file, representation, and audit records are required.",
    );
  }
  const sourceFile = sourceFileResult.data as SourceFile;
  const representation = representationResult.data as SourceRepresentation;
  const audit = auditResult.data as RepresentationAudit;
  const capability = capabilityFor(representation.kind);
  if (
    sourceFile.id !== representation.sourceFileId ||
    audit.representationId !== representation.id ||
    capability === undefined ||
    audit.capability.status !== "resolved" ||
    audit.capability.id !== capability.id ||
    audit.capability.version !== capability.version ||
    audit.tier !== "A" ||
    !audit.structuralPass ||
    !audit.mappingPass ||
    !audit.claimEligible
  ) {
    return qualificationFailure(
      "A matching eligible built-in representation audit is required.",
    );
  }
  if (
    sourceFile.size > 0 &&
    (representation.normalizedText === "" ||
      representation.locatorMap.length === 0)
  ) {
    return qualificationFailure(
      "A qualifying mapped representation is required for non-empty source bytes.",
    );
  }
  const currentAudit = auditRepresentation(representation);
  if (!currentAudit.ok || !isDeepStrictEqual(currentAudit.value, audit)) {
    return qualificationFailure(
      "The representation no longer matches its audit.",
    );
  }

  if (
    sourceFile.size !== 0 ||
    representation.normalizedText !== "" ||
    representation.locatorMap.length !== 0
  ) {
    if (representation.locatorMap.length === 0) {
      return textDropped(
        "Structural units cannot account for text without locators.",
      );
    }
    const markdown =
      representation.kind === "markdown"
        ? markdownDrafts(representation)
        : undefined;
    if (markdown && !markdown.ok) return markdown;
    const drafts =
      markdown?.value ??
      (representation.kind === "text"
        ? textDrafts(representation)
        : representation.kind === "csv"
          ? wholeRepresentationDraft("table")
          : ["code", "json", "yaml"].includes(representation.kind)
            ? wholeRepresentationDraft("code")
            : undefined);
    if (!drafts) {
      return textDropped(
        "Structural adapter is not available for this qualified kind.",
      );
    }
    return buildUnits({ sourceFile, representation, audit }, drafts);
  }

  const textSha256 = sha256("");
  const parsedUnit = SourceUnitSchema.parse({
    schemaVersion: 1,
    id: unitId({
      logicalPath: sourceFile.logicalPath,
      anchor: [],
      kind: "document",
      textSha256,
      duplicateOrdinal: 1,
    }),
    snapshotId: sourceFile.snapshotId,
    sourceFileId: sourceFile.id,
    representationId: representation.id,
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
    textSha256,
  }) as SourceUnit;

  return { ok: true, value: freezeUnits([parsedUnit]) };
}
