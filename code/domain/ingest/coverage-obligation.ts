import { z } from "zod";

import { ObligationIdSchema, QuestionIdSchema } from "./id-schemas.js";
import type { ObligationId, QuestionId } from "./types.js";

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

export function isCoherentObligationOwner(
  status: ObligationStatus,
  ownerQuestionId: QuestionId | null,
): boolean {
  if (status === "open") return ownerQuestionId === null;
  if (["assigned", "transferred", "blocked"].includes(status)) {
    return ownerQuestionId !== null;
  }
  return true;
}

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
  .strict()
  .superRefine((record, context) => {
    if (!isCoherentObligationOwner(record.status, record.ownerQuestionId)) {
      context.addIssue({
        code: "custom",
        path: ["ownerQuestionId"],
        message: `Status ${record.status} has an invalid owner relationship.`,
      });
    }
  });
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

export interface ReserveCoverageObligationCreateCommand {
  readonly idempotencyKey: string;
  readonly commandDigest: string;
  /** Invoked only by the globally winning reservation while under the writer's lock. */
  readonly allocateObligationId: () => ObligationId;
}

export type ReserveCoverageObligationCreateResult =
  | {
      readonly status: "reserved" | "idempotent";
      readonly obligationId: ObligationId;
    }
  | { readonly status: "idempotency_conflict" };

export interface AppendCoverageObligationEventCommand {
  readonly obligationId: ObligationId;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  /** Canonical payload digest bound by the global operation-key record. */
  readonly commandDigest: string;
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
  | { readonly status: "idempotency_conflict" }
  | {
      readonly status: "ownership_conflict";
      readonly ownerQuestionId: QuestionId;
    };

export interface CoverageObligationEventWriter {
  reserveCreate(
    command: ReserveCoverageObligationCreateCommand,
  ): Promise<ReserveCoverageObligationCreateResult>;
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
