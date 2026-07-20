import { createHash } from "node:crypto";

import MiniSearch from "minisearch";

import { processLexicalTerm } from "./stem-term.js";
import type {
  IngestResult,
  SnapshotId,
  SourceFile,
  SourceRepresentation,
  SourceUnit,
  SourceUnitId,
} from "../../domain/ingest/index.js";
import { SnapshotIdSchema } from "../../domain/ingest/index.js";
import {
  SEARCH_FILTER_LIMITS,
  canonicalizeSearchFilters,
  computeIndexedRepresentationsSha256,
  type IndexedRepresentationBinding,
  type SearchFilters,
  type SearchReceipt,
  type SearchReceiptId,
} from "../../domain/ingest/search-receipt.js";
import {
  buildExactMap,
  type ExactMapFailure,
  type ExactMapInput,
  type ExactMapProjection,
} from "./exact-map.js";

export type LexicalBuildInput = ExactMapInput;

export type LexicalBuildFailure = ExactMapFailure;

export const LEXICAL_INDEX_VERSION = "lexical-v1";

export const LEXICAL_LIMITS = Object.freeze({
  maxQueryChars: 2_048,
  maxLimit: 100,
  defaultLimit: 20,
});

export interface SearchRequest {
  readonly query: string;
  readonly filters?: SearchFilters;
  readonly limit?: number;
}

export interface SearchHit {
  readonly unitId: SourceUnitId;
  readonly score: number;
}

export interface SearchResponse {
  readonly selectedIds: readonly SourceUnitId[];
  readonly candidateIds: readonly SourceUnitId[];
  readonly hits: readonly SearchHit[];
  readonly receipt: SearchReceipt;
}

export interface LexicalIndex {
  build(
    snapshotId: SnapshotId,
    input: LexicalBuildInput,
  ): Promise<IngestResult<void, LexicalBuildFailure>>;
  search(
    request: SearchRequest,
  ): Promise<IngestResult<SearchResponse, "INDEX_UNAVAILABLE">>;
  discard(): void;
}

interface IndexedUnit {
  readonly id: string;
  readonly unitId: SourceUnitId;
  readonly content: string;
  readonly kind: string;
  readonly heading: string;
  readonly path: string;
  readonly sourceFileId: string;
  readonly representationId: string;
}

interface BuiltState {
  readonly snapshotId: SnapshotId;
  readonly unitsById: ReadonlyMap<string, SourceUnit>;
  readonly filesById: ReadonlyMap<string, SourceFile>;
  readonly representationIds: readonly string[];
  readonly corpusDigest: ReturnType<typeof computeIndexedRepresentationsSha256>;
  readonly exactMap: ExactMapProjection;
  readonly mini: MiniSearch<IndexedUnit>;
  readonly documents: readonly IndexedUnit[];
}

function failure(
  code: LexicalBuildFailure,
  message: string,
): IngestResult<never, LexicalBuildFailure> {
  return { ok: false, code, message };
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

function sortIds(ids: readonly SourceUnitId[]): SourceUnitId[] {
  return [...ids].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
    return Object.freeze(value) as T;
  }
  for (const child of Object.values(value as object)) freezeDeep(child);
  return Object.freeze(value);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function crockfordFromHex(hex: string): SearchReceiptId {
  const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let body = "";
  for (let index = 0; index < 26; index += 1) {
    const nibble = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    body += crockford[nibble % 32]!;
  }
  return `rcpt-${body}` as SearchReceiptId;
}

/**
 * Receipt id binds every result-defining field. Canonical filters so order of
 * scope/unitKinds does not change the id; different limits/result sets do.
 */
export function receiptIdFor(parts: {
  readonly snapshotId: SnapshotId;
  readonly indexVersion: string;
  readonly corpusDigest: string;
  readonly query: string;
  readonly filters: SearchFilters;
  readonly limit: number;
  readonly failures: readonly string[];
  readonly candidateIds: readonly SourceUnitId[];
  readonly selectedIds: readonly SourceUnitId[];
}): SearchReceiptId {
  const material = JSON.stringify({
    snapshotId: parts.snapshotId,
    indexVersion: parts.indexVersion,
    corpusDigest: parts.corpusDigest,
    query: parts.query,
    filters: canonicalizeSearchFilters(parts.filters),
    limit: parts.limit,
    failures: [...parts.failures],
    candidateIds: [...parts.candidateIds],
    selectedIds: [...parts.selectedIds],
  });
  return crockfordFromHex(
    createHash("sha256").update(material).digest("hex").toUpperCase(),
  );
}

/**
 * Directory-boundary scope: `docs` matches `docs/x` and `docs`, not `docs-old/x`.
 * Trailing-slash prefixes match as literal path prefixes.
 */
export function matchesScope(
  path: string,
  scope: readonly string[] | undefined,
): boolean {
  if (!scope || scope.length === 0) return true;
  return scope.some((prefix) => {
    if (path === prefix) return true;
    if (prefix.endsWith("/")) return path.startsWith(prefix);
    return path.startsWith(`${prefix}/`);
  });
}

export function matchesUnitKinds(
  kind: string,
  unitKinds: readonly string[] | undefined,
): boolean {
  if (!unitKinds || unitKinds.length === 0) return true;
  return unitKinds.includes(kind);
}

/**
 * Read a property by descriptor only — never triggers getters/proxies.
 * Missing key → { present:false }. Accessor/non-enumerable/data-less → invalid.
 */
function ownDataProp(
  object: object,
  key: string,
):
  | { readonly ok: true; readonly present: false }
  | { readonly ok: true; readonly present: true; readonly value: unknown }
  | { readonly ok: false } {
  if (!Reflect.ownKeys(object).includes(key)) {
    return { ok: true, present: false };
  }
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    return { ok: false };
  }
  return { ok: true, present: true, value: descriptor.value };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isPlainArray(value: unknown): value is readonly unknown[] {
  return (
    Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  );
}

interface ParsedSearchRequest {
  readonly query: string;
  readonly filters: SearchFilters;
  readonly limit: number;
  readonly failures: readonly string[];
  readonly skipSearch: boolean;
}

/**
 * Strict search ingress: descriptor-only reads, bounds before work, no throw.
 * Malformed requests produce a schema-valid healthy empty receipt with failures.
 */
function parseSearchRequest(request: unknown): ParsedSearchRequest {
  const failures: string[] = [];
  let query = "";
  let filters: SearchFilters = {};
  let limit: number = LEXICAL_LIMITS.defaultLimit;
  let skipSearch = false;

  if (request === null || request === undefined) {
    return {
      query: "",
      filters: {},
      limit,
      failures: ["INVALID_REQUEST"],
      skipSearch: true,
    };
  }
  if (!isPlainObject(request)) {
    return {
      query: "",
      filters: {},
      limit,
      failures: ["INVALID_REQUEST"],
      skipSearch: true,
    };
  }

  const keys = Reflect.ownKeys(request);
  for (const key of keys) {
    if (typeof key === "symbol") {
      failures.push("INVALID_REQUEST");
      skipSearch = true;
      break;
    }
    if (key !== "query" && key !== "filters" && key !== "limit") {
      failures.push("INVALID_REQUEST");
      skipSearch = true;
      break;
    }
  }

  const queryProp = ownDataProp(request, "query");
  if (!queryProp.ok || !queryProp.present) {
    failures.push("INVALID_REQUEST");
    skipSearch = true;
  } else if (typeof queryProp.value !== "string") {
    failures.push("INVALID_REQUEST");
    skipSearch = true;
  } else {
    query = queryProp.value;
    if (query.length > LEXICAL_LIMITS.maxQueryChars) {
      failures.push("QUERY_TOO_LONG");
      skipSearch = true;
    }
  }

  const limitProp = ownDataProp(request, "limit");
  if (!limitProp.ok) {
    failures.push("INVALID_REQUEST");
    skipSearch = true;
  } else if (limitProp.present) {
    const rawLimit = limitProp.value;
    if (
      typeof rawLimit !== "number" ||
      !Number.isFinite(rawLimit) ||
      !Number.isInteger(rawLimit) ||
      rawLimit < 0
    ) {
      failures.push("INVALID_REQUEST");
      skipSearch = true;
    } else {
      limit = Math.min(rawLimit, LEXICAL_LIMITS.maxLimit);
    }
  }

  const filtersProp = ownDataProp(request, "filters");
  if (!filtersProp.ok) {
    failures.push("INVALID_REQUEST");
    skipSearch = true;
  } else if (filtersProp.present) {
    const parsed = parseFiltersStrict(filtersProp.value);
    if (!parsed.ok) {
      failures.push("INVALID_REQUEST");
      skipSearch = true;
    } else {
      filters = canonicalizeSearchFilters(parsed.filters);
    }
  }

  return {
    query,
    filters,
    limit,
    failures: [...new Set(failures)],
    skipSearch,
  };
}

function parseFiltersStrict(
  value: unknown,
): { ok: true; filters: SearchFilters } | { ok: false } {
  if (!isPlainObject(value)) return { ok: false };
  const allowed = new Set(["snapshotId", "scope", "unitKinds"]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol" || !allowed.has(key)) return { ok: false };
  }

  let snapshotId: SnapshotId | undefined;
  let scope: string[] | undefined;
  let unitKinds:
    | ReadonlyArray<
        "document" | "section" | "paragraph" | "list" | "table" | "code"
      >
    | undefined;

  const snapshotProp = ownDataProp(value, "snapshotId");
  if (!snapshotProp.ok) return { ok: false };
  if (snapshotProp.present) {
    const parsed = SnapshotIdSchema.safeParse(snapshotProp.value);
    if (!parsed.success) return { ok: false };
    snapshotId = parsed.data;
  }

  const scopeProp = ownDataProp(value, "scope");
  if (!scopeProp.ok) return { ok: false };
  if (scopeProp.present) {
    const scopeRaw = scopeProp.value;
    if (!isPlainArray(scopeRaw)) return { ok: false };
    if (scopeRaw.length > SEARCH_FILTER_LIMITS.maxArrayItems)
      return { ok: false };
    const parsedScope: string[] = [];
    for (let index = 0; index < scopeRaw.length; index += 1) {
      const itemProp = ownDataProp(scopeRaw as object, String(index));
      if (!itemProp.ok || !itemProp.present) return { ok: false };
      const item = itemProp.value;
      if (
        typeof item !== "string" ||
        item.length === 0 ||
        item.length > SEARCH_FILTER_LIMITS.maxStringChars
      ) {
        return { ok: false };
      }
      parsedScope.push(item);
    }
    scope = parsedScope;
  }

  const kindsProp = ownDataProp(value, "unitKinds");
  if (!kindsProp.ok) return { ok: false };
  if (kindsProp.present) {
    const kindsRaw = kindsProp.value;
    if (!isPlainArray(kindsRaw)) return { ok: false };
    if (kindsRaw.length > SEARCH_FILTER_LIMITS.maxArrayItems)
      return { ok: false };
    const kinds: Array<
      "document" | "section" | "paragraph" | "list" | "table" | "code"
    > = [];
    const allowedKinds = new Set([
      "document",
      "section",
      "paragraph",
      "list",
      "table",
      "code",
    ] as const);
    for (let index = 0; index < kindsRaw.length; index += 1) {
      const itemProp = ownDataProp(kindsRaw as object, String(index));
      if (!itemProp.ok || !itemProp.present) return { ok: false };
      const item = itemProp.value;
      if (
        typeof item !== "string" ||
        !allowedKinds.has(item as (typeof kinds)[number])
      ) {
        return { ok: false };
      }
      kinds.push(item as (typeof kinds)[number]);
    }
    unitKinds = kinds;
  }

  return {
    ok: true,
    filters: {
      ...(snapshotId !== undefined ? { snapshotId } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(unitKinds !== undefined ? { unitKinds } : {}),
    },
  };
}

function buildState(
  snapshotId: SnapshotId,
  input: LexicalBuildInput,
): IngestResult<BuiltState, LexicalBuildFailure> {
  try {
    const snapshotParsed = SnapshotIdSchema.safeParse(snapshotId);
    if (!snapshotParsed.success) {
      return failure("INVALID_INPUT", "A strict SnapshotId is required.");
    }
    const boundSnapshot = snapshotParsed.data;

    // Reuse T-12-02 qualification for duplicates, rebinding, locator, text hash.
    const mapResult = buildExactMap(input);
    if (!mapResult.ok) return mapResult;

    const units = input.units.map((unit) => structuredClone(unit));
    const files = input.files.map((file) => structuredClone(file));
    const representations = input.representations.map((representation) =>
      structuredClone(representation),
    );

    // Bind build snapshotId to corpus records that carry snapshotId.
    for (const unit of units) {
      if (unit.snapshotId !== boundSnapshot) {
        return failure(
          "INVALID_INPUT",
          "Source unit snapshotId must match the build snapshotId.",
        );
      }
    }
    for (const file of files) {
      if (file.snapshotId !== boundSnapshot) {
        return failure(
          "INVALID_INPUT",
          "Source file snapshotId must match the build snapshotId.",
        );
      }
    }

    const representationByFile = new Map<string, string>();
    for (const representation of representations) {
      const prior = representationByFile.get(representation.sourceFileId);
      if (prior !== undefined && prior !== representation.id) {
        return failure(
          "DUPLICATE_CONTEXT",
          "At most one representation version is allowed per source file.",
        );
      }
      representationByFile.set(representation.sourceFileId, representation.id);
    }

    const unitsById = new Map<string, SourceUnit>();
    for (const unit of units) unitsById.set(unit.id, unit);
    const filesById = new Map<string, SourceFile>();
    for (const file of files) filesById.set(file.id, file);
    const representationsById = new Map<string, SourceRepresentation>();
    for (const representation of representations) {
      representationsById.set(representation.id, representation);
    }

    const documents: IndexedUnit[] = [];
    const bindings: IndexedRepresentationBinding[] = [];
    for (const representation of representations) {
      bindings.push({
        id: representation.id,
        version: representation.version,
        sourceFileId: representation.sourceFileId,
        normalizedTextSha256: sha256Hex(representation.normalizedText),
      });
    }

    for (const unit of units) {
      const file = filesById.get(unit.sourceFileId);
      const representation = representationsById.get(unit.representationId);
      if (!file || !representation) {
        return failure(
          "UNRESOLVED_REFERENCE",
          "A source unit does not resolve during lexical indexing.",
        );
      }
      const text = selectedText(unit, representation);
      if (text === undefined) {
        return failure(
          "UNRESOLVED_REFERENCE",
          "A source unit locator exceeds its canonical representation.",
        );
      }
      documents.push({
        id: unit.id,
        unitId: unit.id,
        content: text,
        kind: unit.kind,
        heading: unit.headingPath.join("/"),
        path: file.logicalPath,
        sourceFileId: file.id,
        representationId: representation.id,
      });
    }

    documents.sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );

    // B005: processTerm stems at index time; MiniSearch reuses it for queries
    // (symmetric). Asymmetric stemming would not recover morphology matches.
    const mini = new MiniSearch<IndexedUnit>({
      fields: ["content", "heading", "path", "kind", "unitId"],
      storeFields: [
        "unitId",
        "kind",
        "heading",
        "path",
        "sourceFileId",
        "representationId",
      ],
      processTerm: processLexicalTerm,
      searchOptions: {
        boost: { unitId: 10, path: 4, heading: 3, content: 1, kind: 0.5 },
        prefix: true,
        fuzzy: 0.2,
      },
    });
    mini.addAll(documents);

    const corpusDigest = computeIndexedRepresentationsSha256(bindings);
    const representationIds = representations.map(
      (representation) => representation.id,
    );

    return {
      ok: true,
      value: {
        snapshotId: boundSnapshot,
        unitsById,
        filesById,
        representationIds: Object.freeze([...representationIds].sort()),
        corpusDigest,
        exactMap: mapResult.value,
        mini,
        documents: Object.freeze(documents),
      },
    };
  } catch {
    return failure(
      "INVALID_INPUT",
      "Canonical lexical-index input is required.",
    );
  }
}

function makeReceipt(parts: {
  readonly snapshotId: SnapshotId;
  readonly corpusDigest: ReturnType<typeof computeIndexedRepresentationsSha256>;
  readonly query: string;
  readonly filters: SearchFilters;
  readonly limit: number;
  readonly failures: readonly string[];
  readonly candidateIds: readonly SourceUnitId[];
  readonly selectedIds: readonly SourceUnitId[];
}): SearchReceipt {
  return {
    schemaVersion: 1,
    id: receiptIdFor({
      snapshotId: parts.snapshotId,
      indexVersion: LEXICAL_INDEX_VERSION,
      corpusDigest: parts.corpusDigest,
      query: parts.query,
      filters: parts.filters,
      limit: parts.limit,
      failures: parts.failures,
      candidateIds: parts.candidateIds,
      selectedIds: parts.selectedIds,
    }),
    snapshotId: parts.snapshotId,
    indexVersion: LEXICAL_INDEX_VERSION,
    indexedRepresentationsSha256: parts.corpusDigest,
    query: parts.query,
    filters: canonicalizeSearchFilters(parts.filters),
    candidateIds: parts.candidateIds,
    selectedIds: parts.selectedIds,
    failures: [...parts.failures],
  };
}

export function createLexicalIndex(): LexicalIndex {
  let state: BuiltState | undefined;

  return {
    async build(snapshotId, input) {
      const built = buildState(snapshotId, input);
      if (!built.ok) return built;
      state = built.value;
      return { ok: true, value: undefined };
    },

    async search(request) {
      if (!state) {
        return {
          ok: false,
          code: "INDEX_UNAVAILABLE",
          message: "No lexical index has been built.",
        };
      }
      const current = state;
      const parsed = parseSearchRequest(request);

      // Snapshot filter mismatch or invalid/skip => healthy empty + failures.
      if (
        parsed.skipSearch ||
        (parsed.filters.snapshotId !== undefined &&
          parsed.filters.snapshotId !== current.snapshotId)
      ) {
        const receipt = makeReceipt({
          snapshotId: current.snapshotId,
          corpusDigest: current.corpusDigest,
          query: parsed.query,
          filters: parsed.filters,
          limit: parsed.limit,
          failures: parsed.failures,
          candidateIds: [],
          selectedIds: [],
        });
        return {
          ok: true,
          value: freezeDeep({
            selectedIds: [],
            candidateIds: [],
            hits: [],
            receipt,
          }),
        };
      }

      const eligible = new Set<string>();
      for (const document of current.documents) {
        if (!matchesScope(document.path, parsed.filters.scope)) continue;
        if (!matchesUnitKinds(document.kind, parsed.filters.unitKinds))
          continue;
        eligible.add(document.id);
      }

      const scored = new Map<string, number>();
      if (parsed.query.length > 0 && eligible.size > 0) {
        for (const hit of current.mini.search(parsed.query)) {
          if (!eligible.has(String(hit.id))) continue;
          scored.set(String(hit.id), hit.score);
        }
        const aliasHit = current.exactMap.lookup(parsed.query);
        if (aliasHit.kind === "unique" && eligible.has(aliasHit.unit)) {
          const prior = scored.get(aliasHit.unit) ?? 0;
          scored.set(aliasHit.unit, Math.max(prior, 1_000));
        }
      }

      const ranked = [...scored.entries()]
        .map(([unitId, score]) => ({
          unitId: unitId as SourceUnitId,
          score,
        }))
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          return left.unitId < right.unitId
            ? -1
            : left.unitId > right.unitId
              ? 1
              : 0;
        });

      const limited = ranked.slice(0, parsed.limit);
      const selectedIds = limited.map((hit) => hit.unitId);
      const candidateIds = sortIds(ranked.map((hit) => hit.unitId));
      const receiptSelected = sortIds(selectedIds);

      const receipt = makeReceipt({
        snapshotId: current.snapshotId,
        corpusDigest: current.corpusDigest,
        query: parsed.query,
        filters: parsed.filters,
        limit: parsed.limit,
        failures: parsed.failures,
        candidateIds,
        selectedIds: receiptSelected,
      });

      return {
        ok: true,
        value: freezeDeep({
          selectedIds,
          candidateIds,
          hits: limited,
          receipt,
        }),
      };
    },

    discard() {
      state = undefined;
    },
  };
}
