import { z } from "zod";

import type {
  ObligationId,
  QuestionId,
  SnapshotId,
  SourceFileId,
  SourceRepresentationId,
  SourceUnitId,
} from "./types.js";

export const ULID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";

function prefixedUlid<Name extends string>(prefix: Name) {
  return z.string().regex(new RegExp(`^${prefix}-${ULID_PATTERN}$`));
}

export const QuestionIdSchema = prefixedUlid("q").transform(
  (value) => value as QuestionId,
);
// Raw artifacts have a canonical format but no canonical brand in the domain.
export const RawArtifactIdSchema = prefixedUlid("art");
export const ObligationIdSchema = prefixedUlid("obl").transform(
  (value) => value as ObligationId,
);
export const SnapshotIdSchema = z
  .string()
  .regex(/^snap-[a-f0-9]{64}$/u)
  .transform((value) => value as SnapshotId);
export const SourceFileIdSchema = z
  .string()
  .regex(/^file-[a-f0-9]{64}$/u)
  .transform((value) => value as SourceFileId);
// The current IdGenerator has no representation kind; keep this injected
// identity strict and branded without inventing a second allocation scheme.
export const SourceRepresentationIdSchema = z
  .string()
  .regex(new RegExp(`^repr-${ULID_PATTERN}$`))
  .transform((value) => value as SourceRepresentationId);
export const SourceUnitIdSchema = prefixedUlid("unit").transform(
  (value) => value as SourceUnitId,
);
