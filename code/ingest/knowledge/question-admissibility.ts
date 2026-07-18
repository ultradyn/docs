import { z } from "zod";

import {
  CoverageObligationRecordSchema,
  IngestionQuestionLinkSchema,
  isTerminalObligationStatus,
  type CoverageObligation,
  type IngestionQuestionLink,
  type ObligationId,
  type QuestionId,
} from "../../domain/ingest/index.js";

export const MIN_CONCRETE_TOKENS = 3;
export const DUPLICATE_SIMILARITY = 0.8;

export const ADMISSION_REASON_ORDER = Object.freeze([
  "INVALID_PROPOSAL",
  "GENERIC_WORDING",
  "MISSING_TRIGGER",
  "OBLIGATION_NOT_FOUND",
  "OBLIGATION_NOT_FOR_QUESTION",
  "OBLIGATION_NOT_SELF_OWNED",
  "OBLIGATION_RESOLVED",
  "OBLIGATION_NOT_NOVEL",
  "DUPLICATE_WORDING",
] as const);

export type AdmissionReason = (typeof ADMISSION_REASON_ORDER)[number];

export interface AdmittedGeneratedQuestionFact {
  readonly link: IngestionQuestionLink;
  readonly wording: string;
  readonly obligationId: ObligationId;
}

export interface QuestionProposalInput {
  readonly link: IngestionQuestionLink;
  readonly wording: string;
  readonly obligationId?: ObligationId | undefined;
  readonly obligations: readonly CoverageObligation[];
  readonly admitted: readonly AdmittedGeneratedQuestionFact[];
  readonly lexicalCandidates: readonly QuestionId[];
}

export interface AdmissionDecision {
  readonly admitted: boolean;
  readonly kind: "demand" | "generated";
  readonly reasons: readonly AdmissionReason[];
  readonly triggerSourceUnitIds: readonly string[];
  readonly duplicateOf: readonly QuestionId[];
  readonly maxSimilarity: number;
  readonly routing: {
    readonly candidateQuestionIds: readonly QuestionId[];
    readonly authoritative: false;
  };
}

const ULID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";
const QuestionIdSchema = z
  .string()
  .regex(new RegExp(`^q-${ULID_PATTERN}$`))
  .transform((value) => value as QuestionId);
const ObligationIdSchema = z
  .string()
  .regex(new RegExp(`^obl-${ULID_PATTERN}$`))
  .transform((value) => value as ObligationId);

const AdmittedGeneratedQuestionFactSchema = z
  .object({
    link: IngestionQuestionLinkSchema,
    wording: z.string().trim().min(1),
    obligationId: ObligationIdSchema,
  })
  .strict()
  .refine((fact) => fact.link.origin === "ingestion-generated", {
    path: ["link", "origin"],
    message: "Admitted generated facts require ingestion-generated links.",
  });

// Routing hints are deliberately accepted as unknown here. They are sanitised
// independently and can never invalidate the proposal's authoritative facts.
const QuestionProposalInputSchema = z
  .object({
    link: IngestionQuestionLinkSchema,
    wording: z.string().trim().min(1),
    obligationId: ObligationIdSchema.optional(),
    obligations: z.array(CoverageObligationRecordSchema),
    admitted: z.array(AdmittedGeneratedQuestionFactSchema),
    lexicalCandidates: z.unknown(),
  })
  .strict();

// Closed and source-visible: generic vocabulary is auditable policy, not
// incidental stemming or fuzzy-library behavior.
const GENERIC_TOKENS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "can",
  "could",
  "do",
  "does",
  "else",
  "from",
  "how",
  "in",
  "information",
  "is",
  "it",
  "missing",
  "of",
  "or",
  "other",
  "should",
  "that",
  "the",
  "this",
  "to",
  "unclear",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
]);

const UnknownEnvelopeSchema = z
  .object({
    link: z.unknown().optional(),
    wording: z.unknown().optional(),
    obligationId: z.unknown().optional(),
    obligations: z.unknown().optional(),
    admitted: z.unknown().optional(),
    lexicalCandidates: z.unknown().optional(),
  })
  .passthrough();
const UnknownLinkSchema = z
  .object({
    origin: z.unknown().optional(),
    questionId: z.unknown().optional(),
    sourceUnitIds: z.unknown().optional(),
  })
  .passthrough();

function normalizeTokens(wording: string): readonly string[] {
  const normalized = wording
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
  return normalized === "" ? [] : normalized.split(/\s+/u);
}

function jaccard(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function sanitiseTriggers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(
    value.flatMap((candidate) => {
      if (typeof candidate !== "string") return [];
      const trimmed = candidate.trim();
      return trimmed === "" ? [] : [trimmed];
    }),
  );
}

function sanitiseCandidates(value: unknown): QuestionId[] {
  if (!Array.isArray(value)) return [];
  return unique(
    value.flatMap((candidate) => {
      const parsed = QuestionIdSchema.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    }),
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function assessQuestionProposal(input: unknown): AdmissionDecision {
  const envelopeResult = UnknownEnvelopeSchema.safeParse(input);
  const envelope = envelopeResult.success ? envelopeResult.data : {};
  const linkResult = UnknownLinkSchema.safeParse(envelope.link);
  const rawLink = linkResult.success ? linkResult.data : {};
  const parsed = QuestionProposalInputSchema.safeParse(input);

  const wording = typeof envelope.wording === "string" ? envelope.wording : "";
  const parsedQuestionId = QuestionIdSchema.safeParse(rawLink.questionId);
  const questionId = parsedQuestionId.success
    ? parsedQuestionId.data
    : undefined;
  const triggerSourceUnitIds = sanitiseTriggers(rawLink.sourceUnitIds);
  const candidateQuestionIds = sanitiseCandidates(envelope.lexicalCandidates);
  const routing = {
    candidateQuestionIds,
    authoritative: false as const,
  };

  if (parsed.success && parsed.data.link.origin === "human") {
    return deepFreeze({
      admitted: true,
      kind: "demand" as const,
      reasons: [],
      triggerSourceUnitIds,
      duplicateOf: [],
      maxSimilarity: 0,
      routing,
    });
  }

  const detected = new Set<AdmissionReason>();
  if (!parsed.success || parsed.data.link.origin !== "ingestion-generated") {
    detected.add("INVALID_PROPOSAL");
  }

  const wordingTokens = new Set(normalizeTokens(wording));
  const concreteTokens = [...wordingTokens].filter(
    (token) => !GENERIC_TOKENS.has(token),
  );
  if (concreteTokens.length < MIN_CONCRETE_TOKENS) {
    detected.add("GENERIC_WORDING");
  }
  if (triggerSourceUnitIds.length === 0) {
    detected.add("MISSING_TRIGGER");
  }

  const obligationIdResult = ObligationIdSchema.safeParse(
    envelope.obligationId,
  );
  const obligationId = obligationIdResult.success
    ? obligationIdResult.data
    : undefined;
  const obligations = Array.isArray(envelope.obligations)
    ? envelope.obligations.flatMap((value) => {
        const obligation = CoverageObligationRecordSchema.safeParse(value);
        return obligation.success ? [obligation.data] : [];
      })
    : [];
  const citedObligation = obligationId
    ? obligations.find((obligation) => obligation.id === obligationId)
    : undefined;

  if (!citedObligation) {
    detected.add("OBLIGATION_NOT_FOUND");
  } else {
    if (citedObligation.questionId !== questionId) {
      detected.add("OBLIGATION_NOT_FOR_QUESTION");
    } else if (citedObligation.ownerQuestionId !== questionId) {
      detected.add("OBLIGATION_NOT_SELF_OWNED");
    }
    if (isTerminalObligationStatus(citedObligation.status)) {
      detected.add("OBLIGATION_RESOLVED");
    }
  }

  const admittedFacts = Array.isArray(envelope.admitted)
    ? envelope.admitted.flatMap((value) => {
        const fact = AdmittedGeneratedQuestionFactSchema.safeParse(value);
        return fact.success ? [fact.data] : [];
      })
    : [];
  if (
    obligationId !== undefined &&
    admittedFacts.some((fact) => fact.obligationId === obligationId)
  ) {
    detected.add("OBLIGATION_NOT_NOVEL");
  }

  let maxSimilarity = 0;
  const duplicateOf: QuestionId[] = [];
  for (const fact of admittedFacts) {
    const factQuestionId = QuestionIdSchema.safeParse(fact.link.questionId);
    const similarity = jaccard(
      wordingTokens,
      new Set(normalizeTokens(fact.wording)),
    );
    maxSimilarity = Math.max(maxSimilarity, similarity);
    if (similarity >= DUPLICATE_SIMILARITY && factQuestionId.success) {
      duplicateOf.push(factQuestionId.data);
    }
  }
  if (duplicateOf.length > 0) {
    detected.add("DUPLICATE_WORDING");
  }

  const reasons = ADMISSION_REASON_ORDER.filter((reason) =>
    detected.has(reason),
  );
  return deepFreeze({
    admitted: reasons.length === 0,
    kind: "generated" as const,
    reasons,
    triggerSourceUnitIds,
    duplicateOf,
    maxSimilarity,
    routing,
  });
}
