import { createHash } from "node:crypto";

import MiniSearch from "minisearch";

import type {
  IngestResult,
  SnapshotId,
  SourceFile,
  SourceRepresentation,
  SourceUnit,
  SourceUnitId,
} from "../../domain/ingest/index.js";
import {
  computeIndexedRepresentationsSha256,
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

function receiptIdFor(
  snapshotId: SnapshotId,
  query: string,
  filters: SearchFilters,
): SearchReceiptId {
  const material = JSON.stringify({
    snapshotId,
    query,
    filters,
  });
  const hex = createHash("sha256").update(material).digest("hex").toUpperCase();
  // Crockford base32 alphabet is uppercase; ULID body is 26 chars from a hash.
  const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let body = "";
  for (let index = 0; index < 26; index += 1) {
    const nibble = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    body += crockford[nibble % 32]!;
  }
  return `rcpt-${body}` as SearchReceiptId;
}

function matchesScope(
  path: string,
  scope: readonly string[] | undefined,
): boolean {
  if (!scope || scope.length === 0) return true;
  return scope.some((prefix) => path === prefix || path.startsWith(prefix));
}

function matchesStatus(
  kind: string,
  status: readonly string[] | undefined,
): boolean {
  if (!status || status.length === 0) return true;
  return status.includes(kind);
}

function buildState(
  snapshotId: SnapshotId,
  input: LexicalBuildInput,
): IngestResult<BuiltState, LexicalBuildFailure> {
  try {
    // Reuse T-12-02 qualification for duplicates, rebinding, locator, text hash.
    // Run before the one-rep-per-file rule so cross-bound / unresolved cases
    // keep their more specific failure codes.
    const mapResult = buildExactMap(input);
    if (!mapResult.ok) return mapResult;

    // Copy arrays so later caller mutation cannot affect the index.
    const units = input.units.map((unit) => structuredClone(unit));
    const files = input.files.map((file) => structuredClone(file));
    const representations = input.representations.map((representation) =>
      structuredClone(representation),
    );

    // At most one representation version per source file (after exact-map ok).
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

    // Stable document order by unit id so MiniSearch rebuilds deterministically.
    documents.sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );

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
      searchOptions: {
        boost: { unitId: 10, path: 4, heading: 3, content: 1, kind: 0.5 },
        prefix: true,
        fuzzy: 0.2,
      },
    });
    mini.addAll(documents);

    const representationIds = representations.map(
      (representation) => representation.id,
    );
    const corpusDigest = computeIndexedRepresentationsSha256(representationIds);

    return {
      ok: true,
      value: {
        snapshotId,
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

export function createLexicalIndex(): LexicalIndex {
  let state: BuiltState | undefined;

  return {
    async build(snapshotId, input) {
      if (typeof snapshotId !== "string" || snapshotId.length === 0) {
        return failure("INVALID_INPUT", "A snapshot id is required.");
      }
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
      const query = typeof request?.query === "string" ? request.query : "";
      const filters: SearchFilters =
        request?.filters && typeof request.filters === "object"
          ? {
              ...(request.filters.snapshotId !== undefined
                ? { snapshotId: request.filters.snapshotId }
                : {}),
              ...(request.filters.scope !== undefined
                ? { scope: [...request.filters.scope] }
                : {}),
              ...(request.filters.status !== undefined
                ? { status: [...request.filters.status] }
                : {}),
            }
          : {};
      const rawLimit =
        typeof request?.limit === "number" && Number.isFinite(request.limit)
          ? Math.trunc(request.limit)
          : LEXICAL_LIMITS.defaultLimit;
      const limit = Math.min(Math.max(rawLimit, 0), LEXICAL_LIMITS.maxLimit);

      const failures: string[] = [];
      if (query.length > LEXICAL_LIMITS.maxQueryChars) {
        failures.push("QUERY_TOO_LONG");
      }

      // Snapshot filter before any selection: mismatch => healthy empty.
      if (
        filters.snapshotId !== undefined &&
        filters.snapshotId !== current.snapshotId
      ) {
        return {
          ok: true,
          value: freezeDeep(emptyResponse(current, query, filters, failures)),
        };
      }

      const eligible = new Set<string>();
      for (const document of current.documents) {
        if (!matchesScope(document.path, filters.scope)) continue;
        if (!matchesStatus(document.kind, filters.status)) continue;
        eligible.add(document.id);
      }

      const scored = new Map<string, number>();

      if (
        query.length > 0 &&
        query.length <= LEXICAL_LIMITS.maxQueryChars &&
        eligible.size > 0
      ) {
        for (const hit of current.mini.search(query)) {
          if (!eligible.has(String(hit.id))) continue;
          scored.set(String(hit.id), hit.score);
        }

        // Exact-map alias integration: unique alias resolves into candidates.
        const aliasHit = current.exactMap.lookup(query);
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

      const limited = ranked.slice(0, limit);
      const selectedIds = limited.map((hit) => hit.unitId);
      // Candidates: all scored matches (pre-limit), sorted for the portable receipt.
      const candidateIds = sortIds(ranked.map((hit) => hit.unitId));
      const receiptSelected = sortIds(selectedIds);

      const receipt: SearchReceipt = {
        schemaVersion: 1,
        id: receiptIdFor(current.snapshotId, query, filters),
        snapshotId: current.snapshotId,
        indexVersion: LEXICAL_INDEX_VERSION,
        indexedRepresentationsSha256: current.corpusDigest,
        query,
        filters,
        candidateIds,
        selectedIds: receiptSelected,
        failures,
      };

      const response: SearchResponse = {
        selectedIds,
        candidateIds,
        hits: limited,
        receipt,
      };
      return { ok: true, value: freezeDeep(response) };
    },

    discard() {
      state = undefined;
    },
  };
}

function emptyResponse(
  current: BuiltState,
  query: string,
  filters: SearchFilters,
  failures: readonly string[],
): SearchResponse {
  const receipt: SearchReceipt = {
    schemaVersion: 1,
    id: receiptIdFor(current.snapshotId, query, filters),
    snapshotId: current.snapshotId,
    indexVersion: LEXICAL_INDEX_VERSION,
    indexedRepresentationsSha256: current.corpusDigest,
    query,
    filters,
    candidateIds: [],
    selectedIds: [],
    failures: [...failures],
  };
  return {
    selectedIds: [],
    candidateIds: [],
    hits: [],
    receipt,
  };
}
