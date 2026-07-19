/**
 * Testing-only fakes for T-30-01 source tools.
 * Never re-export from the retrieval package barrel.
 */
import type { SnapshotId, SourceUnitId } from "../../domain/ingest/index.js";
import type {
  DeniedUnit,
  FilteredSearchResponse,
  PolicyGate,
  PolicyGateFailure,
  UnitAccessRecord,
  UnitAccessResolver,
  UnitPreview,
} from "../policy/policy-gate.js";
import type { SearchHit, SearchResponse } from "./lexical-index.js";
import type { SearchReceipt } from "../../domain/ingest/search-receipt.js";

export interface FakeUnitRecord {
  readonly unitId: SourceUnitId;
  readonly textSha256: string;
  readonly text: string;
}

export interface UnitStore {
  get(
    unitId: string,
    expectedHash: string,
  ): Promise<
    | { ok: true; value: FakeUnitRecord }
    | { ok: false; code: "UNIT_NOT_FOUND" | "HASH_MISMATCH" }
  >;
}

export function createFakeUnitStore(
  units: Record<string, FakeUnitRecord> = {},
): UnitStore {
  return {
    async get(unitId, expectedHash) {
      const unit = units[unitId];
      if (!unit) return { ok: false, code: "UNIT_NOT_FOUND" };
      if (unit.textSha256 !== expectedHash) {
        return { ok: false, code: "HASH_MISMATCH" };
      }
      return { ok: true, value: unit };
    },
  };
}

export function createFakeUnitAccessResolver(
  options: {
    allowed?: Record<string, boolean>;
  } = {},
): UnitAccessResolver {
  const allowed = options.allowed ?? {};
  return {
    async resolve(unitId: string) {
      if (allowed[unitId] === false) {
        return { ok: false as const, code: "UNIT_NOT_FOUND" as const };
      }
      const value: UnitAccessRecord = {
        snapshotId: `snap-${"a".repeat(64)}` as SnapshotId,
        policyId: "policy-docs",
        logicalPath: `docs/${unitId}.md`,
      };
      return { ok: true as const, value };
    },
  };
}

export interface FakeSearchBackend {
  search(query: string): Promise<SearchResponse>;
}

function emptyReceipt(snapshotId: SnapshotId): SearchReceipt {
  return {
    schemaVersion: 1,
    id: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV" as SearchReceipt["id"],
    snapshotId,
    indexVersion: "fake-v1",
    indexedRepresentationsSha256: "0".repeat(64) as never,
    query: "",
    filters: {},
    candidateIds: [],
    selectedIds: [],
    failures: [],
  };
}

export function createFakeExactMap(options: {
  hits: Array<{ unitId: SourceUnitId; score: number }>;
}): FakeSearchBackend {
  const snapshotId = `snap-${"a".repeat(64)}` as SnapshotId;
  return {
    async search(query: string) {
      void query;
      const hits: SearchHit[] = options.hits.map((h) => ({
        unitId: h.unitId,
        score: h.score,
      }));
      const ids = options.hits.map((h) => h.unitId);
      return {
        hits,
        candidateIds: ids,
        selectedIds: ids,
        receipt: emptyReceipt(snapshotId),
      };
    },
  };
}

export function createFakeLexicalIndex(options: {
  hits: Array<{ unitId: SourceUnitId; score: number }>;
}): FakeSearchBackend {
  return createFakeExactMap(options);
}

export function createFakePolicyGate(
  options: {
    allow?: SourceUnitId[];
    deny?: SourceUnitId[];
    track?: boolean;
  } = {},
): PolicyGate & {
  filterCalls: Array<Record<string, unknown>>;
} {
  const allow = new Set(options.allow ?? []);
  const deny = new Set(options.deny ?? []);
  const filterCalls: Array<Record<string, unknown>> = [];
  const snapshotId = `snap-${"a".repeat(64)}` as SnapshotId;

  const gate = {
    filterCalls,
    async filterRetrieval(input: {
      response: SearchResponse;
      profileId: string;
      principalId: string;
    }) {
      filterCalls.push({
        profileId: input.profileId,
        principalId: input.principalId,
      });
      const response = input.response;
      const selected: SourceUnitId[] = [];
      const denied: DeniedUnit[] = [];
      const candidateIds = [
        ...(response.selectedIds ?? response.candidateIds ?? []),
      ];
      for (const id of candidateIds) {
        if (deny.has(id) || (allow.size > 0 && !allow.has(id))) {
          denied.push({ unitId: id, reason: "unit-unknown" });
        } else {
          selected.push(id);
        }
      }
      const filtered: FilteredSearchResponse = {
        selectedIds: Object.freeze(selected),
        candidateIds: Object.freeze([
          ...(response.candidateIds ?? candidateIds),
        ]),
        hits: Object.freeze(
          (response.hits ?? []).filter((h) => selected.includes(h.unitId)),
        ),
        deniedIds: Object.freeze(denied),
        policy: Object.freeze({
          profileId: input.profileId,
          profileSha256: "0".repeat(64),
          principalId: input.principalId,
          snapshotId,
        }),
      };
      return { ok: true as const, value: filtered };
    },
    async authoriseModel() {
      return {
        ok: false as const,
        code: "ACCESS_DENIED" as PolicyGateFailure,
        message: "Not used by source tools.",
      };
    },
    async policyNamespace() {
      return { ok: true as const, value: "ns-test" };
    },
    async projectUnitPreview(input: {
      profileId: string;
      principalId: string;
      unitId: SourceUnitId;
      text?: string;
    }) {
      if (
        deny.has(input.unitId) ||
        (allow.size > 0 && !allow.has(input.unitId))
      ) {
        return {
          ok: false as const,
          code: "ACCESS_DENIED" as PolicyGateFailure,
          message: "Unit access denied.",
        };
      }
      const preview: UnitPreview = {
        unitId: input.unitId,
        snapshotId,
        policyId: input.profileId,
        quote: input.text ?? "",
      };
      return { ok: true as const, value: preview };
    },
  };
  return gate as unknown as PolicyGate & {
    filterCalls: Array<Record<string, unknown>>;
  };
}
