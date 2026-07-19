import { createHash } from "node:crypto";

import type {
  IngestResult,
  SourceFile,
  SourceRepresentation,
  SourceUnit,
  SourceUnitId,
} from "../../domain/ingest/index.js";
import {
  SourceFileSchema,
  SourceRepresentationSchema,
  SourceUnitSchema,
} from "../../domain/ingest/index.js";

export const ALIAS_CLASS_ORDER = Object.freeze([
  "id",
  "path",
  "title",
  "heading",
  "acronym",
  "error-code",
] as const);

export type AliasClass = (typeof ALIAS_CLASS_ORDER)[number];

export interface ExactMapInput {
  readonly units: readonly SourceUnit[];
  readonly files: readonly SourceFile[];
  readonly representations: readonly SourceRepresentation[];
}

export type ExactMapLookup =
  | { readonly kind: "unique"; readonly unit: SourceUnitId }
  | {
      readonly kind: "ambiguous";
      readonly candidates: readonly {
        readonly unit: SourceUnitId;
        readonly reason: AliasClass;
      }[];
    }
  | { readonly kind: "missing" };

export interface ExactMapProjection {
  lookup(alias: string): ExactMapLookup;
  serialize(): string;
}

export type ExactMapFailure =
  | "INVALID_INPUT"
  | "DUPLICATE_UNIT"
  | "DUPLICATE_CONTEXT"
  | "UNRESOLVED_REFERENCE"
  | "TEXT_MISMATCH";

interface AliasCandidate {
  readonly unit: SourceUnitId;
  readonly reason: AliasClass;
}

const ALIAS_RANK = new Map<AliasClass, number>(
  ALIAS_CLASS_ORDER.map((aliasClass, index) => [aliasClass, index]),
);

const ERROR_CODE_CANDIDATE = /[A-Z][A-Z0-9_-]*/gu;
const SEGMENTED_ERROR_CODE = /^[A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+)+$/u;
const NUMBERED_ERROR_CODE = /^[A-Z][A-Z0-9]*\d[A-Z0-9]*$/u;
const HEADING_WORD = /\p{L}[\p{L}\p{N}]*/gu;

function failure(
  code: ExactMapFailure,
  message: string,
): IngestResult<never, ExactMapFailure> {
  return { ok: false, code, message };
}

/** The sole deterministic normalization rule for stored and queried aliases. */
export function normalizeAlias(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
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
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        return false;
      }
      const child: unknown = descriptor.value;
      if (typeof child === "object" && child !== null) pending.push(child);
    }
  }
  return true;
}

function readInputArrays(input: unknown):
  | {
      readonly units: readonly unknown[];
      readonly files: readonly unknown[];
      readonly representations: readonly unknown[];
    }
  | undefined {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    return undefined;
  }
  const expected = new Set(["units", "files", "representations"]);
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== expected.size ||
    keys.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    return undefined;
  }
  const values: Record<string, readonly unknown[]> = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      !Array.isArray(descriptor.value) ||
      Object.getPrototypeOf(descriptor.value) !== Array.prototype
    ) {
      return undefined;
    }
    values[key] = descriptor.value as readonly unknown[];
  }
  return {
    units: values.units!,
    files: values.files!,
    representations: values.representations!,
  };
}

function parseRecords<T>(
  values: readonly unknown[],
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
): readonly T[] | undefined {
  const parsed: T[] = [];
  for (const value of values) {
    if (!isPlainDataGraph(value)) return undefined;
    const result = schema.safeParse(value);
    if (!result.success) return undefined;
    parsed.push(result.data as T);
  }
  return parsed;
}

function selectedText(
  unit: SourceUnit,
  representation: SourceRepresentation,
): string | undefined {
  const { utf16Start, utf16End } = unit.normalizedLocator;
  if (
    utf16Start > utf16End ||
    utf16Start > representation.normalizedText.length ||
    utf16End > representation.normalizedText.length
  ) {
    return undefined;
  }
  return unit.kind === "document"
    ? representation.normalizedText
    : representation.normalizedText.slice(utf16Start, utf16End);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function acronym(heading: string): string | undefined {
  const words = heading.match(HEADING_WORD) ?? [];
  if (words.length < 2) return undefined;
  return words.map((word) => [...word][0]!).join("");
}

function errorCodes(text: string): readonly string[] {
  const codes = new Set<string>();
  for (const match of text.matchAll(ERROR_CODE_CANDIDATE)) {
    const candidate = match[0];
    if (
      SEGMENTED_ERROR_CODE.test(candidate) ||
      NUMBERED_ERROR_CODE.test(candidate)
    ) {
      codes.add(candidate);
    }
  }
  return [...codes];
}

function candidateOrder(left: AliasCandidate, right: AliasCandidate): number {
  const classOrder =
    ALIAS_RANK.get(left.reason)! - ALIAS_RANK.get(right.reason)!;
  if (classOrder !== 0) return classOrder;
  return left.unit < right.unit ? -1 : left.unit > right.unit ? 1 : 0;
}

function freezeCandidates(
  candidates: readonly AliasCandidate[],
): readonly AliasCandidate[] {
  return Object.freeze(
    candidates.map((candidate) =>
      Object.freeze({ unit: candidate.unit, reason: candidate.reason }),
    ),
  );
}

function canonicalSerialization(
  aliases: ReadonlyMap<string, readonly AliasCandidate[]>,
): string {
  const entries = [...aliases.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries
    .map(
      ([alias, candidates]) =>
        `${JSON.stringify(alias)}:${JSON.stringify(candidates)}`,
    )
    .join(",")}}`;
}

export function buildExactMap(
  input: ExactMapInput,
): IngestResult<ExactMapProjection, ExactMapFailure> {
  try {
    const arrays = readInputArrays(input);
    if (!arrays)
      return failure("INVALID_INPUT", "Canonical exact-map input is required.");

    const units = parseRecords<SourceUnit>(arrays.units, SourceUnitSchema);
    const files = parseRecords<SourceFile>(arrays.files, SourceFileSchema);
    const representations = parseRecords<SourceRepresentation>(
      arrays.representations,
      SourceRepresentationSchema,
    );
    if (!units || !files || !representations) {
      return failure(
        "INVALID_INPUT",
        "Canonical source units, files, and representations are required.",
      );
    }

    const unitIds = new Set<string>();
    for (const unit of units) {
      if (unitIds.has(unit.id)) {
        return failure(
          "DUPLICATE_UNIT",
          "Source unit identities must be unique.",
        );
      }
      unitIds.add(unit.id);
    }

    const filesById = new Map<string, SourceFile>();
    for (const file of files) {
      if (filesById.has(file.id)) {
        return failure(
          "DUPLICATE_CONTEXT",
          "Source file identities must be unique.",
        );
      }
      filesById.set(file.id, file);
    }
    const representationsById = new Map<string, SourceRepresentation>();
    for (const representation of representations) {
      if (representationsById.has(representation.id)) {
        return failure(
          "DUPLICATE_CONTEXT",
          "Source representation identities must be unique.",
        );
      }
      representationsById.set(representation.id, representation);
    }

    const mutableAliases = new Map<string, Map<string, AliasCandidate>>();
    const addAlias = (
      rawAlias: string,
      unit: SourceUnitId,
      reason: AliasClass,
    ): void => {
      const alias = normalizeAlias(rawAlias);
      if (alias === "") return;
      let candidates = mutableAliases.get(alias);
      if (!candidates) {
        candidates = new Map();
        mutableAliases.set(alias, candidates);
      }
      candidates.set(`${unit}\u0000${reason}`, { unit, reason });
    };

    for (const unit of units) {
      const file = filesById.get(unit.sourceFileId);
      const representation = representationsById.get(unit.representationId);
      if (
        !file ||
        !representation ||
        file.snapshotId !== unit.snapshotId ||
        representation.sourceFileId !== unit.sourceFileId
      ) {
        return failure(
          "UNRESOLVED_REFERENCE",
          "A source unit does not resolve to its canonical file and representation.",
        );
      }
      const text = selectedText(unit, representation);
      if (text === undefined) {
        return failure(
          "UNRESOLVED_REFERENCE",
          "A source unit locator exceeds its canonical representation.",
        );
      }
      if (sha256(text) !== unit.textSha256) {
        return failure(
          "TEXT_MISMATCH",
          "A source unit no longer matches its canonical representation text.",
        );
      }

      addAlias(unit.id, unit.id, "id");
      if (unit.kind === "document") addAlias(file.logicalPath, unit.id, "path");
      if (unit.kind === "section") {
        const heading = unit.headingPath.at(-1);
        if (heading !== undefined) {
          addAlias(unit.headingPath.join("/"), unit.id, "title");
          addAlias(heading, unit.id, "heading");
          const short = acronym(heading);
          if (short !== undefined) addAlias(short, unit.id, "acronym");
        }
      }
      if (unit.kind !== "document") {
        for (const code of errorCodes(text))
          addAlias(code, unit.id, "error-code");
      }
    }

    const aliases = new Map<string, readonly AliasCandidate[]>();
    for (const [alias, candidates] of mutableAliases) {
      aliases.set(
        alias,
        freezeCandidates([...candidates.values()].sort(candidateOrder)),
      );
    }
    const serialized = canonicalSerialization(aliases);
    const missing = Object.freeze({ kind: "missing" as const });
    const lookup = Object.freeze((alias: string): ExactMapLookup => {
      if (typeof alias !== "string") return missing;
      const candidates = aliases.get(normalizeAlias(alias));
      if (!candidates) return missing;
      const unitsForAlias = new Set(
        candidates.map((candidate) => candidate.unit),
      );
      if (unitsForAlias.size === 1) {
        return Object.freeze({ kind: "unique", unit: candidates[0]!.unit });
      }
      return Object.freeze({ kind: "ambiguous", candidates });
    });
    const serialize = Object.freeze((): string => serialized);
    const projection: ExactMapProjection = { lookup, serialize };
    return { ok: true, value: Object.freeze(projection) };
  } catch {
    return failure("INVALID_INPUT", "Canonical exact-map input is required.");
  }
}
