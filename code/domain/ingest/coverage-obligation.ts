import { z } from "zod";

import type { ObligationId, QuestionId } from "./types.js";

const ULID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";
const QuestionIdSchema = z
  .string()
  .regex(new RegExp(`^q-${ULID_PATTERN}$`))
  .transform((value) => value as QuestionId);
const ObligationIdSchema = z
  .string()
  .regex(new RegExp(`^obl-${ULID_PATTERN}$`))
  .transform((value) => value as ObligationId);

export const COVERAGE_OBLIGATION_TERMINAL_STATUSES = [
  "satisfied",
  "terminal_gap",
  "excluded",
  "deferred",
  "revoked",
] as const;

export const ObligationStatusSchema = z.enum([
  "open",
  "assigned",
  "satisfied",
  "terminal_gap",
  "excluded",
  "deferred",
  "blocked",
  "transferred",
  "revoked",
]);
export type ObligationStatus = z.infer<typeof ObligationStatusSchema>;
export type TerminalObligationStatus =
  (typeof COVERAGE_OBLIGATION_TERMINAL_STATUSES)[number];

export const CoverageObligationRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: ObligationIdSchema,
    questionId: QuestionIdSchema,
    trigger: z.string().trim().min(1),
    ownerQuestionId: QuestionIdSchema.nullable(),
    status: ObligationStatusSchema,
    version: z.number().int().positive(),
  })
  .strict();
export type CoverageObligation = z.infer<typeof CoverageObligationRecordSchema>;

export const CoverageObligationEventTypeSchema = z.enum([
  "created",
  "assigned",
  "transferred",
  "resolved",
]);
export type CoverageObligationEventType = z.infer<
  typeof CoverageObligationEventTypeSchema
>;

export const CoverageObligationEventSchema = z
  .object({
    obligationId: ObligationIdSchema,
    idempotencyKey: z.string().trim().min(1),
    type: CoverageObligationEventTypeSchema,
    version: z.number().int().positive(),
    previousStatus: ObligationStatusSchema.nullable(),
    status: ObligationStatusSchema,
    ownerQuestionId: QuestionIdSchema.nullable(),
    obligation: CoverageObligationRecordSchema,
  })
  .strict();
export type CoverageObligationEvent = z.infer<
  typeof CoverageObligationEventSchema
>;

export interface AppendCoverageObligationEventCommand {
  readonly obligationId: ObligationId;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  /**
   * Atomically rejects the append when another unresolved obligation already
   * names this owner. The current obligation is excluded from the check.
   */
  readonly claimUnresolvedOwnerQuestionId?: QuestionId;
  readonly event: CoverageObligationEvent;
}

export type AppendCoverageObligationEventResult =
  | { readonly status: "appended"; readonly event: CoverageObligationEvent }
  | { readonly status: "idempotent"; readonly event: CoverageObligationEvent }
  | { readonly status: "version_conflict"; readonly currentVersion: number }
  | {
      readonly status: "ownership_conflict";
      readonly ownerQuestionId: QuestionId;
    };

export interface CoverageObligationEventWriter {
  append(
    command: AppendCoverageObligationEventCommand,
  ): Promise<AppendCoverageObligationEventResult>;
  read(obligationId: ObligationId): Promise<readonly unknown[]>;
  readAll(): Promise<readonly unknown[]>;
}

export function isTerminalObligationStatus(
  status: ObligationStatus,
): status is TerminalObligationStatus {
  return (COVERAGE_OBLIGATION_TERMINAL_STATUSES as readonly string[]).includes(
    status,
  );
}
