import { createHash } from "node:crypto";

import { z } from "zod";

import {
  QuestionIdSchema,
  SnapshotIdSchema,
  SourceFileIdSchema,
  SourceUnitIdSchema,
  ULID_PATTERN,
} from "./id-schemas.js";
import {
  SearchReceiptIdSchema,
  type SearchReceiptId,
} from "./search-receipt.js";
import type {
  EvidencePacketId,
  QuestionId,
  Sha256,
  SnapshotId,
  SourceFileId,
  SourceUnitId,
} from "./types.js";

/** Closed minimal role set per Standards review (plan underspecified). */
export type EvidenceReferenceRole = "primary" | "supporting";

export const EvidenceReferenceRoleSchema = z.enum(["primary", "supporting"]);

const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "must be 64 lowercase hex characters")
  .transform((value) => value as Sha256);

/** Packet id brand: pkt- + Crockford ULID body (26). epkt- rejects. */
export const EvidencePacketIdSchema = z
  .string()
  .regex(new RegExp(`^pkt-${ULID_PATTERN}$`))
  .transform((value) => value as EvidencePacketId);

export const EvidenceReferenceSchema = z
  .object({
    snapshotId: SnapshotIdSchema,
    fileId: SourceFileIdSchema,
    unitId: SourceUnitIdSchema,
    fileSha256: Sha256Schema,
    unitSha256: Sha256Schema,
    role: EvidenceReferenceRoleSchema,
    facetIds: z.array(z.string().min(1).max(128)).max(64),
  })
  .strict();

export type EvidenceReference = {
  readonly snapshotId: SnapshotId;
  readonly fileId: SourceFileId;
  readonly unitId: SourceUnitId;
  readonly fileSha256: Sha256;
  readonly unitSha256: Sha256;
  readonly role: EvidenceReferenceRole;
  readonly facetIds: readonly string[];
};

export const EvidencePacketLimitsSchema = z
  .object({
    maxReferences: z.number().int().positive().max(10_000),
    maxFacetsPerReference: z.number().int().positive().max(64),
  })
  .strict();

export type EvidencePacketLimits = z.infer<typeof EvidencePacketLimitsSchema>;

export const DEFAULT_EVIDENCE_PACKET_LIMITS = Object.freeze({
  maxReferences: 256,
  maxFacetsPerReference: 32,
} satisfies EvidencePacketLimits);

export const EvidencePacketSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: EvidencePacketIdSchema,
    questionId: QuestionIdSchema,
    version: z.number().int().positive(),
    references: z.array(EvidenceReferenceSchema).max(10_000),
    receiptId: SearchReceiptIdSchema,
    /** Required content binding for the linked SearchReceipt. */
    receiptDigest: Sha256Schema,
    limits: EvidencePacketLimitsSchema,
  })
  .strict();

export type EvidencePacket = {
  readonly schemaVersion: 1;
  readonly id: EvidencePacketId;
  readonly questionId: QuestionId;
  readonly version: number;
  readonly references: readonly EvidenceReference[];
  readonly receiptId: SearchReceiptId;
  readonly receiptDigest: Sha256;
  readonly limits: EvidencePacketLimits;
};

/**
 * Canonical fixed-field packet payload digest (key order fixed; not object insert order).
 */
export function canonicalPacketPayloadDigest(input: {
  readonly questionId: string;
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly references: readonly EvidenceReference[];
}): Sha256 {
  const refs = [...input.references]
    .map((reference) => ({
      snapshotId: reference.snapshotId,
      fileId: reference.fileId,
      unitId: reference.unitId,
      fileSha256: reference.fileSha256,
      unitSha256: reference.unitSha256,
      role: reference.role,
      facetIds: [...new Set(reference.facetIds)].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    }))
    .sort((left, right) =>
      left.unitId < right.unitId ? -1 : left.unitId > right.unitId ? 1 : 0,
    );
  // Fixed field order — never rely on object key enumeration order.
  const material = [
    ["questionId", input.questionId],
    ["receiptId", input.receiptId],
    ["receiptDigest", input.receiptDigest],
    ["references", refs],
  ] as const;
  return createHashHex(JSON.stringify(material));
}

function createHashHex(value: string): Sha256 {
  return createHash("sha256").update(value).digest("hex") as Sha256;
}
