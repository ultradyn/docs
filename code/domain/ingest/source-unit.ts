import { z } from "zod";

import {
  SnapshotIdSchema,
  SourceFileIdSchema,
  SourceRepresentationIdSchema,
  SourceUnitIdSchema,
} from "./id-schemas.js";
import type {
  Sha256,
  SnapshotId,
  SourceFileId,
  SourceRepresentationId,
  SourceUnitId,
} from "./types.js";

export const SourceUnitKindSchema = z.enum([
  "document",
  "section",
  "paragraph",
  "list",
  "table",
  "code",
]);
export type SourceUnitKind = z.infer<typeof SourceUnitKindSchema>;

function positionIsOrdered(value: {
  readonly lineStart: number;
  readonly columnStart: number;
  readonly lineEnd: number;
  readonly columnEnd: number;
}): boolean {
  return (
    value.lineStart < value.lineEnd ||
    (value.lineStart === value.lineEnd && value.columnStart <= value.columnEnd)
  );
}

export const SourceUnitLocatorSchema = z
  .object({
    utf16Start: z.number().safe().int().nonnegative(),
    utf16End: z.number().safe().int().nonnegative(),
    lineStart: z.number().safe().int().positive(),
    columnStart: z.number().safe().int().positive(),
    lineEnd: z.number().safe().int().positive(),
    columnEnd: z.number().safe().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.utf16Start > value.utf16End) {
      context.addIssue({
        code: "custom",
        path: ["utf16Start"],
        message: "must not exceed utf16End",
      });
    }
    if (!positionIsOrdered(value)) {
      context.addIssue({
        code: "custom",
        path: ["lineStart"],
        message: "start position must not follow end position",
      });
    }
  });

export interface SourceUnitLocator {
  readonly utf16Start: number;
  readonly utf16End: number;
  readonly lineStart: number;
  readonly columnStart: number;
  readonly lineEnd: number;
  readonly columnEnd: number;
}

export const SourceUnitOriginalLocatorSchema = z
  .object({
    byteStart: z.number().safe().int().nonnegative(),
    byteEnd: z.number().safe().int().nonnegative(),
    lineStart: z.number().safe().int().positive(),
    columnStart: z.number().safe().int().positive(),
    lineEnd: z.number().safe().int().positive(),
    columnEnd: z.number().safe().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.byteStart > value.byteEnd) {
      context.addIssue({
        code: "custom",
        path: ["byteStart"],
        message: "must not exceed byteEnd",
      });
    }
    if (!positionIsOrdered(value)) {
      context.addIssue({
        code: "custom",
        path: ["lineStart"],
        message: "start position must not follow end position",
      });
    }
  });

export interface SourceUnitOriginalLocator {
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineStart: number;
  readonly columnStart: number;
  readonly lineEnd: number;
  readonly columnEnd: number;
}

const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "must be 64 lowercase hex characters")
  .transform((value) => value as Sha256);

export const SourceUnitSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SourceUnitIdSchema,
    snapshotId: SnapshotIdSchema,
    sourceFileId: SourceFileIdSchema,
    representationId: SourceRepresentationIdSchema,
    kind: SourceUnitKindSchema,
    parentId: SourceUnitIdSchema.optional(),
    headingPath: z.array(z.string().min(1)),
    normalizedLocator: SourceUnitLocatorSchema,
    originalLocator: SourceUnitOriginalLocatorSchema,
    textSha256: Sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.parentId === value.id) {
      context.addIssue({
        code: "custom",
        path: ["parentId"],
        message: "must not equal id",
      });
    }
  });

export interface SourceUnit {
  readonly schemaVersion: 1;
  readonly id: SourceUnitId;
  readonly snapshotId: SnapshotId;
  readonly sourceFileId: SourceFileId;
  readonly representationId: SourceRepresentationId;
  readonly kind: SourceUnitKind;
  readonly parentId?: SourceUnitId;
  readonly headingPath: readonly string[];
  readonly normalizedLocator: SourceUnitLocator;
  readonly originalLocator: SourceUnitOriginalLocator;
  readonly textSha256: Sha256;
}
