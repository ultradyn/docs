/**
 * T-60-02 — AnswerComposition domain (claim-derived answer; not structured.md).
 *
 * Distinct from transcript-derived Structured answer (answers/structured.md).
 */
import { z } from "zod";

import { ClaimIdSchema } from "./claim.js";
import { QuestionIdSchema } from "./id-schemas.js";
import type { ClaimId, GraphRevision, Sha256 } from "./types.js";

const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .transform((v) => v as Sha256);

export const AnswerCompositionStateSchema = z.enum([
  "proposed",
  "insufficient_pack",
]);
export type AnswerCompositionState = z.infer<
  typeof AnswerCompositionStateSchema
>;

export const SentenceClaimBindingSchema = z
  .object({
    sentenceIndex: z.number().int().nonnegative(),
    claimIds: z.array(ClaimIdSchema).min(1).max(64),
  })
  .strict();

export type SentenceClaimBinding = {
  readonly sentenceIndex: number;
  readonly claimIds: readonly ClaimId[];
};

export const GoalCoverageSchema = z
  .object({
    goalId: z.string().min(1).max(128),
    covered: z.boolean(),
    claimIds: z.array(ClaimIdSchema).max(64),
  })
  .strict();

export type GoalCoverage = {
  readonly goalId: string;
  readonly covered: boolean;
  readonly claimIds: readonly ClaimId[];
};

export const AnswerCompositionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(128),
    questionId: QuestionIdSchema,
    claimPackHash: Sha256Schema,
    graphRevision: z.number().int().nonnegative(),
    answer: z.string().max(32_000),
    claimOrder: z.array(ClaimIdSchema).max(10_000),
    sentenceClaims: z.array(SentenceClaimBindingSchema).max(10_000),
    citations: z
      .array(
        z
          .object({
            claimId: ClaimIdSchema,
            unitId: z.string().min(1),
          })
          .strict(),
      )
      .max(50_000),
    goalCoverage: z.array(GoalCoverageSchema).max(1_024),
    limitations: z.array(z.string().min(1).max(2_000)).max(256),
    state: AnswerCompositionStateSchema,
  })
  .strict();

export type AnswerComposition = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly questionId: string;
  readonly claimPackHash: Sha256;
  readonly graphRevision: GraphRevision;
  readonly answer: string;
  readonly claimOrder: readonly ClaimId[];
  readonly sentenceClaims: readonly SentenceClaimBinding[];
  readonly citations: readonly { readonly claimId: ClaimId; readonly unitId: string }[];
  readonly goalCoverage: readonly GoalCoverage[];
  readonly limitations: readonly string[];
  readonly state: AnswerCompositionState;
};
