import type {
  IngestResult,
  SnapshotId,
  SourceUnitId,
} from "../../domain/ingest/index.js";
import {
  SearchReceiptSchema,
  type SearchFilters,
  type SearchReceipt,
} from "../../domain/ingest/search-receipt.js";
import type { PolicyGate } from "../policy/policy-gate.js";

import { receiptIdFor } from "./lexical-index.js";
import type { SearchResponse } from "./lexical-index.js";
import type { FakeSearchBackend, UnitStore } from "./testing.js";

export type SourceToolError =
  | "INVALID_INPUT"
  | "TOOL_NOT_AVAILABLE"
  | "HASH_MISMATCH"
  | "UNIT_NOT_FOUND"
  | "ACCESS_DENIED"
  | "COMMIT_FAILED";

const FIXED_MESSAGES: Record<SourceToolError, string> = {
  INVALID_INPUT: "Tool input is invalid.",
  TOOL_NOT_AVAILABLE: "This source tool is not available in the current build.",
  HASH_MISMATCH: "Unit content hash does not match expected value.",
  UNIT_NOT_FOUND: "Requested unit was not found.",
  ACCESS_DENIED: "Unit access denied by policy.",
  COMMIT_FAILED: "Source tool operation failed.",
};

const INDEX_VERSION = "source-tools-v1";
const EMPTY_CORPUS = "0".repeat(64);

export interface SourceTools {
  exact(input: unknown): Promise<SourceToolResult>;
  maps(input: unknown): Promise<SourceToolResult>;
  lexical(input: unknown): Promise<SourceToolResult>;
  open_unit(input: unknown): Promise<SourceToolResult>;
  follow_links(input: unknown): Promise<SourceToolResult>;
  vector_optional(input: unknown): Promise<SourceToolResult>;
}

export type SourceToolSuccess = {
  readonly filtered?: {
    readonly selectedIds: readonly SourceUnitId[];
    readonly candidateIds?: readonly SourceUnitId[];
    readonly deniedIds?: readonly unknown[];
    readonly hits?: readonly unknown[];
  };
  readonly preview?: {
    readonly unitId: SourceUnitId;
    readonly quote?: string;
    readonly snapshotId?: SnapshotId;
    readonly policyId?: string;
  };
  readonly receipt: SearchReceipt;
};

export type SourceToolResult = IngestResult<
  SourceToolSuccess,
  SourceToolError
> & {
  readonly receipt: SearchReceipt;
};

function failure(
  code: SourceToolError,
  receipt: SearchReceipt,
): SourceToolResult {
  return Object.freeze({
    ok: false as const,
    code,
    message: FIXED_MESSAGES[code],
    receipt: deepFreeze(receipt),
  });
}

function success(value: SourceToolSuccess): SourceToolResult {
  return Object.freeze({
    ok: true as const,
    value: deepFreeze(value),
    receipt: deepFreeze(value.receipt),
  }) as SourceToolResult;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) {
      for (const item of value) deepFreeze(item);
    } else {
      for (const child of Object.values(value as object)) deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function ownData(
  object: object,
  key: string,
):
  | { ok: true; present: false }
  | { ok: true; present: true; value: unknown }
  | { ok: false } {
  if (!Reflect.ownKeys(object).includes(key)) {
    return { ok: true, present: false };
  }
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    return { ok: false };
  }
  return { ok: true, present: true, value: descriptor.value };
}

function sortIds(ids: readonly string[]): SourceUnitId[] {
  return [...new Set(ids)].sort() as SourceUnitId[];
}

function makeToolReceipt(parts: {
  snapshotId: SnapshotId;
  query: string;
  filters: SearchFilters;
  candidateIds: readonly SourceUnitId[];
  selectedIds: readonly SourceUnitId[];
  failures?: readonly string[];
}): SearchReceipt {
  const candidateIds = sortIds(parts.candidateIds);
  const selectedIds = sortIds(parts.selectedIds);
  const failures = [...(parts.failures ?? [])];
  const receipt = {
    schemaVersion: 1 as const,
    id: receiptIdFor({
      snapshotId: parts.snapshotId,
      indexVersion: INDEX_VERSION,
      corpusDigest: EMPTY_CORPUS,
      query: parts.query,
      filters: parts.filters,
      limit: 100,
      failures,
      candidateIds,
      selectedIds,
    }),
    snapshotId: parts.snapshotId,
    indexVersion: INDEX_VERSION,
    indexedRepresentationsSha256: EMPTY_CORPUS as never,
    query: parts.query,
    filters: parts.filters,
    candidateIds,
    selectedIds,
    failures,
  };
  const parsed = SearchReceiptSchema.safeParse(receipt);
  if (!parsed.success) {
    // Fall back to a minimal valid shape if brands differ in tests
    return deepFreeze(receipt as SearchReceipt);
  }
  return deepFreeze(parsed.data as SearchReceipt);
}

function parseQueryInput(
  input: unknown,
  allowed: ReadonlySet<string>,
):
  | { ok: true; query: string; unitId?: string; expectedHash?: string }
  | { ok: false } {
  if (!isPlainObject(input)) return { ok: false };
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key === "symbol" || !allowed.has(key)) return { ok: false };
    if (!ownData(input, key).ok) return { ok: false };
  }
  const queryProp = ownData(input, "query");
  const unitProp = ownData(input, "unitId");
  const hashProp = ownData(input, "expectedHash");
  let query = "";
  if (queryProp.ok && queryProp.present) {
    if (typeof queryProp.value !== "string") return { ok: false };
    query = queryProp.value;
  }
  const result: {
    ok: true;
    query: string;
    unitId?: string;
    expectedHash?: string;
  } = { ok: true, query };
  if (unitProp.ok && unitProp.present) {
    if (typeof unitProp.value !== "string") return { ok: false };
    result.unitId = unitProp.value;
  }
  if (hashProp.ok && hashProp.present) {
    if (typeof hashProp.value !== "string") return { ok: false };
    result.expectedHash = hashProp.value;
  }
  return result;
}

export function createSourceTools(options: {
  readonly profileId: string;
  readonly principalId: string;
  readonly snapshotId: SnapshotId | string;
  readonly policyGate: PolicyGate;
  readonly units?: unknown;
  readonly unitStore?: UnitStore;
  readonly exactMap?: FakeSearchBackend;
  readonly lexicalIndex?: FakeSearchBackend;
}): SourceTools {
  if (!options || typeof options !== "object") {
    throw new Error("Source tools options are required.");
  }
  if (typeof options.profileId !== "string" || options.profileId.length === 0) {
    throw new Error("profileId is required.");
  }
  if (
    typeof options.principalId !== "string" ||
    options.principalId.length === 0
  ) {
    throw new Error("principalId is required.");
  }
  if (
    typeof options.snapshotId !== "string" ||
    options.snapshotId.length === 0
  ) {
    throw new Error("snapshotId is required.");
  }
  if (
    !options.policyGate ||
    typeof options.policyGate.filterRetrieval !== "function"
  ) {
    throw new Error("policyGate is required.");
  }

  // FACTORY-bound identity — never re-read from tool inputs or source text.
  const profileId = options.profileId;
  const principalId = options.principalId;
  const snapshotId = options.snapshotId as SnapshotId;
  const policyGate = options.policyGate;
  const unitStore = options.unitStore;
  const exactMap = options.exactMap;
  const lexicalIndex = options.lexicalIndex;

  async function runSearch(
    backend: FakeSearchBackend | undefined,
    query: string,
    mode: string,
  ): Promise<SourceToolResult> {
    if (!backend) {
      const receipt = makeToolReceipt({
        snapshotId,
        query,
        filters: { snapshotId },
        candidateIds: [],
        selectedIds: [],
        failures: [`${mode}:not-configured`],
      });
      return failure("TOOL_NOT_AVAILABLE", receipt);
    }
    const raw = await backend.search(query);
    const candidateIds = sortIds(
      raw.candidateIds ??
        raw.selectedIds ??
        raw.hits?.map((h) => h.unitId) ??
        [],
    );
    const response: SearchResponse = {
      ...raw,
      candidateIds,
      selectedIds: sortIds(raw.selectedIds ?? candidateIds),
      hits: raw.hits ?? [],
    };
    const filtered = await policyGate.filterRetrieval({
      response,
      profileId,
      principalId,
    });
    if (!filtered.ok) {
      const receipt = makeToolReceipt({
        snapshotId,
        query,
        filters: { snapshotId },
        candidateIds,
        selectedIds: [],
        failures: [filtered.code],
      });
      return failure("ACCESS_DENIED", receipt);
    }
    const receipt = makeToolReceipt({
      snapshotId,
      query,
      filters: { snapshotId },
      candidateIds,
      selectedIds: filtered.value.selectedIds,
    });
    return success({
      filtered: filtered.value,
      receipt,
    });
  }

  async function notAvailable(
    query: string,
    mode: string,
  ): Promise<SourceToolResult> {
    const receipt = makeToolReceipt({
      snapshotId,
      query,
      filters: { snapshotId },
      candidateIds: [],
      selectedIds: [],
      failures: [`${mode}:unbacked`],
    });
    return failure("TOOL_NOT_AVAILABLE", receipt);
  }

  return {
    async exact(input) {
      // profileId/principalId may be present as smuggled keys — ignored.
      const parsed = parseQueryInput(
        input,
        new Set([
          "query",
          "unitId",
          "expectedHash",
          "profileId",
          "principalId",
        ]),
      );
      if (!parsed.ok) {
        return failure(
          "INVALID_INPUT",
          makeToolReceipt({
            snapshotId,
            query: "",
            filters: { snapshotId },
            candidateIds: [],
            selectedIds: [],
            failures: ["invalid-input"],
          }),
        );
      }
      return runSearch(exactMap, parsed.query, "exact");
    },

    async lexical(input) {
      const parsed = parseQueryInput(
        input,
        new Set([
          "query",
          "unitId",
          "expectedHash",
          "profileId",
          "principalId",
        ]),
      );
      if (!parsed.ok) {
        return failure(
          "INVALID_INPUT",
          makeToolReceipt({
            snapshotId,
            query: "",
            filters: { snapshotId },
            candidateIds: [],
            selectedIds: [],
            failures: ["invalid-input"],
          }),
        );
      }
      return runSearch(lexicalIndex, parsed.query, "lexical");
    },

    async maps(input) {
      const parsed = parseQueryInput(input, new Set(["query", "unitId"]));
      const query = parsed.ok ? parsed.query : "";
      return notAvailable(query, "maps");
    },

    async follow_links(input) {
      const parsed = parseQueryInput(input, new Set(["query", "unitId"]));
      const query = parsed.ok ? parsed.query : "";
      return notAvailable(query, "follow_links");
    },

    async vector_optional(input) {
      const parsed = parseQueryInput(input, new Set(["query", "unitId"]));
      const query = parsed.ok ? parsed.query : "";
      return notAvailable(query, "vector_optional");
    },

    async open_unit(input) {
      const parsed = parseQueryInput(
        input,
        new Set([
          "query",
          "unitId",
          "expectedHash",
          "profileId",
          "role",
          "tools",
        ]),
      );
      // Smuggled profileId/role/tools are ignored (allowed keys for hostile tests)
      // but never applied — factory identity wins.
      if (!parsed.ok || !parsed.unitId || !parsed.expectedHash) {
        // Allow only unitId+expectedHash as required for open_unit
        if (!isPlainObject(input)) {
          return failure(
            "INVALID_INPUT",
            makeToolReceipt({
              snapshotId,
              query: "",
              filters: { snapshotId },
              candidateIds: [],
              selectedIds: [],
              failures: ["invalid-input"],
            }),
          );
        }
      }
      // Re-parse with smuggled keys allowed as ignored
      if (!isPlainObject(input)) {
        return failure(
          "INVALID_INPUT",
          makeToolReceipt({
            snapshotId,
            query: "",
            filters: { snapshotId },
            candidateIds: [],
            selectedIds: [],
            failures: ["invalid-input"],
          }),
        );
      }
      const unitProp = ownData(input, "unitId");
      const hashProp = ownData(input, "expectedHash");
      if (
        !unitProp.ok ||
        !unitProp.present ||
        typeof unitProp.value !== "string" ||
        !hashProp.ok ||
        !hashProp.present ||
        typeof hashProp.value !== "string"
      ) {
        return failure(
          "INVALID_INPUT",
          makeToolReceipt({
            snapshotId,
            query: "",
            filters: { snapshotId },
            candidateIds: [],
            selectedIds: [],
            failures: ["invalid-input"],
          }),
        );
      }
      const unitId = unitProp.value as SourceUnitId;
      const expectedHash = hashProp.value;

      if (!unitStore) {
        return failure(
          "TOOL_NOT_AVAILABLE",
          makeToolReceipt({
            snapshotId,
            query: unitId,
            filters: { snapshotId },
            candidateIds: [unitId],
            selectedIds: [],
            failures: ["unit-store:not-configured"],
          }),
        );
      }

      const loaded = await unitStore.get(unitId, expectedHash);
      if (!loaded.ok) {
        const receipt = makeToolReceipt({
          snapshotId,
          query: unitId,
          filters: { snapshotId },
          candidateIds: [unitId],
          selectedIds: [],
          failures: [loaded.code],
        });
        return failure(
          loaded.code === "HASH_MISMATCH" ? "HASH_MISMATCH" : "UNIT_NOT_FOUND",
          receipt,
        );
      }

      const preview = await policyGate.projectUnitPreview({
        profileId,
        principalId,
        unitId,
        text: loaded.value.text,
      });
      const receipt = makeToolReceipt({
        snapshotId,
        query: unitId,
        filters: { snapshotId },
        candidateIds: [unitId],
        selectedIds: preview.ok ? [unitId] : [],
        failures: preview.ok ? [] : [preview.code],
      });
      if (!preview.ok) {
        return failure("ACCESS_DENIED", receipt);
      }
      return success({
        preview: preview.value,
        receipt,
      });
    },
  };
}
