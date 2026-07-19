import { createHash } from "node:crypto";

import { z } from "zod";

import {
  SnapshotIdSchema,
  SourceUnitIdSchema,
  ULID_PATTERN,
} from "./id-schemas.js";
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

export const SearchFiltersSchema = z
  .object({
    snapshotId: SnapshotIdSchema.optional(),
    scope: z.array(z.string().min(1)).optional(),
    status: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type SearchFilters = z.infer<typeof SearchFiltersSchema>;

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
 * SHA-256 over the canonical JSON encoding of the sorted unique representation
 * ID set. Same snapshot + a repaired representation set yields a new digest.
 */
export function computeIndexedRepresentationsSha256(
  representationIds: readonly string[],
): Sha256 {
  const unique = [...new Set(representationIds)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return createHash("sha256")
    .update(JSON.stringify(unique))
    .digest("hex") as Sha256;
}
