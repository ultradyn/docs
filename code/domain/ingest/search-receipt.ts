import { createHash } from "node:crypto";

import { z } from "zod";

import {
  SnapshotIdSchema,
  SourceUnitIdSchema,
  ULID_PATTERN,
} from "./id-schemas.js";
import { SourceUnitKindSchema } from "./source-unit.js";
import type { Sha256, SnapshotId, SourceUnitId } from "./types.js";

export type SearchReceiptId = string & { readonly __brand: "SearchReceiptId" };

export const SearchReceiptIdSchema = z
  .string()
  .regex(new RegExp(`^rcpt-${ULID_PATTERN}$`))
  .transform((value) => value as SearchReceiptId);

const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "must be 64 lowercase hex characters")
  .transform((value) => value as Sha256);

const INDEX_VERSION_MAX = 256;

/** Bounds for filter arrays and strings (shared with search ingress). */
export const SEARCH_FILTER_LIMITS = Object.freeze({
  maxArrayItems: 64,
  maxStringChars: 512,
});

export const SearchFiltersSchema = z
  .object({
    snapshotId: SnapshotIdSchema.optional(),
    scope: z
      .array(z.string().min(1).max(SEARCH_FILTER_LIMITS.maxStringChars))
      .max(SEARCH_FILTER_LIMITS.maxArrayItems)
      .optional(),
    // unitKinds (not lifecycle "status") — SourceUnit.kind only.
    unitKinds: z
      .array(SourceUnitKindSchema)
      .max(SEARCH_FILTER_LIMITS.maxArrayItems)
      .optional(),
  })
  .strict();

export type SourceUnitKindFilter = z.infer<typeof SourceUnitKindSchema>;

export type SearchFilters = {
  readonly snapshotId?: SnapshotId;
  readonly scope?: readonly string[];
  readonly unitKinds?: readonly SourceUnitKindFilter[];
};

export const SearchReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SearchReceiptIdSchema,
    snapshotId: SnapshotIdSchema,
    indexVersion: z.string().min(1).max(INDEX_VERSION_MAX),
    indexedRepresentationsSha256: Sha256Schema,
    query: z.string(),
    filters: SearchFiltersSchema,
    candidateIds: z.array(SourceUnitIdSchema),
    selectedIds: z.array(SourceUnitIdSchema),
    failures: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((receipt, context) => {
    const candidates = receipt.candidateIds;
    for (let index = 1; index < candidates.length; index += 1) {
      if (candidates[index - 1]! >= candidates[index]!) {
        context.addIssue({
          code: "custom",
          path: ["candidateIds"],
          message: "must be sorted ascending and unique",
        });
        break;
      }
    }
    const selected = receipt.selectedIds;
    for (let index = 1; index < selected.length; index += 1) {
      if (selected[index - 1]! >= selected[index]!) {
        context.addIssue({
          code: "custom",
          path: ["selectedIds"],
          message: "must be sorted ascending and unique",
        });
        break;
      }
    }
    const candidateSet = new Set<string>(candidates);
    for (const id of selected) {
      if (!candidateSet.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["selectedIds"],
          message: "must be a subset of candidateIds",
        });
        break;
      }
    }
  });

export type SearchReceipt = {
  readonly schemaVersion: 1;
  readonly id: SearchReceiptId;
  readonly snapshotId: SnapshotId;
  readonly indexVersion: string;
  readonly indexedRepresentationsSha256: Sha256;
  readonly query: string;
  readonly filters: SearchFilters;
  readonly candidateIds: readonly SourceUnitId[];
  readonly selectedIds: readonly SourceUnitId[];
  readonly failures: readonly string[];
};

/**
 * Canonical binding for one indexed representation. Corpus digest hashes these
 * records (not bare ids) so a reused id with changed content/version differs.
 */
export interface IndexedRepresentationBinding {
  readonly id: string;
  readonly version: number;
  readonly sourceFileId: string;
  /** SHA-256 of normalizedText — never the text itself. */
  readonly normalizedTextSha256: string;
}

function compareBindings(
  left: IndexedRepresentationBinding,
  right: IndexedRepresentationBinding,
): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  if (left.version !== right.version) return left.version - right.version;
  if (left.sourceFileId < right.sourceFileId) return -1;
  if (left.sourceFileId > right.sourceFileId) return 1;
  if (left.normalizedTextSha256 < right.normalizedTextSha256) return -1;
  if (left.normalizedTextSha256 > right.normalizedTextSha256) return 1;
  return 0;
}

/**
 * SHA-256 of the canonical JSON encoding of sorted unique representation
 * bindings (id, version, sourceFileId, normalizedTextSha256).
 */
export function computeIndexedRepresentationsSha256(
  bindings: readonly IndexedRepresentationBinding[],
): Sha256 {
  const byId = new Map<string, IndexedRepresentationBinding>();
  for (const binding of bindings) {
    byId.set(binding.id, {
      id: binding.id,
      version: binding.version,
      sourceFileId: binding.sourceFileId,
      normalizedTextSha256: binding.normalizedTextSha256,
    });
  }
  const sorted = [...byId.values()].sort(compareBindings);
  return createHash("sha256")
    .update(JSON.stringify(sorted))
    .digest("hex") as Sha256;
}

/** Canonical filter form: sorted/deduped scope and unitKinds. */
export function canonicalizeSearchFilters(
  filters: SearchFilters,
): SearchFilters {
  const out: SearchFilters = {
    ...(filters.snapshotId !== undefined
      ? { snapshotId: filters.snapshotId }
      : {}),
    ...(filters.scope !== undefined
      ? {
          scope: [...new Set(filters.scope)].sort((a, b) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        }
      : {}),
    ...(filters.unitKinds !== undefined
      ? {
          unitKinds: [...new Set(filters.unitKinds)].sort((a, b) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        }
      : {}),
  };
  return out;
}
