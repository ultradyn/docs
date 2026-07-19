/**
 * Production seams for Researcher source tools.
 * Fakes live in testing.ts only.
 */
import type { Sha256, SourceUnitId } from "../../domain/ingest/index.js";
import type { SearchResponse } from "./lexical-index.js";

export interface UnitStoreRecord {
  readonly unitId: SourceUnitId;
  readonly textSha256: string;
  readonly text: string;
}

export interface UnitStore {
  get(
    unitId: string,
    expectedHash: string,
  ): Promise<
    | { ok: true; value: UnitStoreRecord }
    | { ok: false; code: "UNIT_NOT_FOUND" | "HASH_MISMATCH" }
  >;
}

/** Index identity recorded on every tool SearchReceipt. */
export interface SearchBackendIdentity {
  readonly indexVersion: string;
  readonly indexedRepresentationsSha256: Sha256;
}

/**
 * Production search backend contract for exact/lexical tools.
 * Implementations must return a SearchResponse whose receipt carries the
 * real index identity (or the backend exposes identity alongside search).
 */
export interface SearchBackend {
  readonly identity: SearchBackendIdentity;
  search(query: string): Promise<SearchResponse>;
}
