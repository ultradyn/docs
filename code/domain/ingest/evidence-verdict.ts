import { createHash } from "node:crypto";

import { z } from "zod";

import { EvidencePacketIdSchema } from "./evidence-packet.js";
import {
  QuestionIdSchema,
  SourceUnitIdSchema,
  ULID_PATTERN,
} from "./id-schemas.js";
import type {
  EvidencePacketId,
  EvidenceVerdictId,
  QuestionId,
  Sha256,
  SourceUnitId,
} from "./types.js";

/** Protocol §3 reference classifications (not plan-draft material/supporting). */
export const ReferenceClassificationSchema = z.enum([
  "necessary_primary",
  "necessary_qualifying",
  "useful_example",
  "context_only",
  "redundant",
  "irrelevant",
  "wrong_scope",
  "deprecated_for_scope",
  "conflicting",
  "unverifiable",
]);

export type ReferenceClassification = z.infer<
  typeof ReferenceClassificationSchema
>;

export const FacetStateSchema = z.enum([
  "satisfied",
  "partial",
  "missing",
  "conflicting",
  "ambiguous_scope",
  "unsupported_in_snapshot",
  "not_applicable",
]);

export type FacetStateValue = z.infer<typeof FacetStateSchema>;

export const TerminalVerdictSchema = z.enum([
  "accepted",
  "needs_more_evidence",
  "ambiguous_scope",
  "conflicting_or_deprecated",
  "no_supported_answer",
  "human_authority_required",
  "source_processing_blocked",
  "search_incomplete",
]);

export type TerminalVerdict = z.infer<typeof TerminalVerdictSchema>;

export const EvidenceVerdictIdSchema = z
  .string()
  .regex(new RegExp(`^evv-${ULID_PATTERN}$`))
  .transform((value) => value as EvidenceVerdictId);

const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "must be 64 lowercase hex characters")
  .transform((value) => value as Sha256);

const ReasonSchema = z.string().min(1).max(2_000);

export const ReferenceReviewSchema = z
  .object({
    unitId: SourceUnitIdSchema,
    classification: ReferenceClassificationSchema,
    reason: ReasonSchema,
  })
  .strict();

export type ReferenceReview = {
  readonly unitId: SourceUnitId;
  readonly classification: ReferenceClassification;
  readonly reason: string;
};

export const FacetStateRecordSchema = z
  .object({
    facetId: z.string().min(1).max(128),
    state: FacetStateSchema,
    sourceUnitIds: z.array(SourceUnitIdSchema).max(256).optional(),
    reason: ReasonSchema,
  })
  .strict();

export type FacetStateRecord = {
  readonly facetId: string;
  readonly state: FacetStateValue;
  readonly sourceUnitIds?: readonly SourceUnitId[];
  readonly reason: string;
};

export const BoundedFollowUpSchema = z
  .object({
    missingFacetIds: z.array(z.string().min(1).max(128)).max(64),
    requiredSearch: z
      .object({
        subject: z.string().min(1).max(512),
        scope: z.string().min(1).max(512).optional(),
        exclusions: z.array(z.string().min(1).max(512)).max(64).optional(),
      })
      .strict()
      .optional(),
    whyCurrentPacketFails: z.string().min(1).max(2_000),
  })
  .strict();

export type BoundedFollowUp = {
  readonly missingFacetIds: readonly string[];
  readonly requiredSearch?: {
    readonly subject: string;
    readonly scope?: string;
    readonly exclusions?: readonly string[];
  };
  readonly whyCurrentPacketFails: string;
};

export const EvidenceVerdictSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: EvidenceVerdictIdSchema,
    questionId: QuestionIdSchema,
    packetId: EvidencePacketIdSchema,
    packetVersion: z.number().int().positive(),
    version: z.number().int().positive(),
    referenceReviews: z.array(ReferenceReviewSchema).max(1_000),
    facetStates: z.array(FacetStateRecordSchema).max(256),
    verdict: TerminalVerdictSchema,
    criticisms: z.array(z.string().min(1).max(2_000)).max(64),
    followUpRequest: BoundedFollowUpSchema.nullable(),
    packetDigest: Sha256Schema,
  })
  .strict();

export type EvidenceVerdict = {
  readonly schemaVersion: 1;
  readonly id: EvidenceVerdictId;
  readonly questionId: QuestionId;
  readonly packetId: EvidencePacketId;
  readonly packetVersion: number;
  readonly version: number;
  readonly referenceReviews: readonly ReferenceReview[];
  readonly facetStates: readonly FacetStateRecord[];
  readonly verdict: TerminalVerdict;
  readonly criticisms: readonly string[];
  readonly followUpRequest: BoundedFollowUp | null;
  readonly packetDigest: Sha256;
};

/**
 * Fixed-field canonical digest (not object key-order sensitive).
 * Set-semantic arrays are sorted; field order is fixed.
 */
export function canonicalVerdictPayloadDigest(input: {
  readonly questionId: string;
  readonly packetId: string;
  readonly packetVersion: number;
  readonly packetDigest: string;
  readonly referenceReviews: readonly {
    readonly unitId: string;
    readonly classification: string;
    readonly reason: string;
  }[];
  readonly facetStates: readonly {
    readonly facetId: string;
    readonly state: string;
    readonly sourceUnitIds?: readonly string[];
    readonly reason: string;
  }[];
  readonly verdict: string;
  readonly criticisms: readonly string[];
  readonly followUpRequest: BoundedFollowUp | null;
}): Sha256 {
  const reviews = [...input.referenceReviews]
    .map((review) => ({
      unitId: review.unitId,
      classification: review.classification,
      reason: review.reason,
    }))
    .sort((left, right) =>
      left.unitId < right.unitId ? -1 : left.unitId > right.unitId ? 1 : 0,
    );
  const facets = [...input.facetStates]
    .map((facet) => ({
      facetId: facet.facetId,
      state: facet.state,
      sourceUnitIds: facet.sourceUnitIds
        ? [...facet.sourceUnitIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        : [],
      reason: facet.reason,
    }))
    .sort((left, right) =>
      left.facetId < right.facetId ? -1 : left.facetId > right.facetId ? 1 : 0,
    );
  const followUp =
    input.followUpRequest === null
      ? null
      : {
          missingFacetIds: [...input.followUpRequest.missingFacetIds].sort(
            (a, b) => (a < b ? -1 : a > b ? 1 : 0),
          ),
          requiredSearch: input.followUpRequest.requiredSearch
            ? {
                subject: input.followUpRequest.requiredSearch.subject,
                scope: input.followUpRequest.requiredSearch.scope ?? null,
                exclusions: [
                  ...(input.followUpRequest.requiredSearch.exclusions ?? []),
                ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
              }
            : null,
          whyCurrentPacketFails: input.followUpRequest.whyCurrentPacketFails,
        };
  const material = [
    ["questionId", input.questionId],
    ["packetId", input.packetId],
    ["packetVersion", input.packetVersion],
    ["packetDigest", input.packetDigest],
    ["referenceReviews", reviews],
    ["facetStates", facets],
    ["verdict", input.verdict],
    ["criticisms", [...input.criticisms]],
    ["followUpRequest", followUp],
  ] as const;
  return createHash("sha256")
    .update(JSON.stringify(material))
    .digest("hex") as Sha256;
}
