import { z } from "zod";

import {
  CoverageObligationRecordSchema,
  IngestionQuestionLinkSchema,
  isTerminalObligationStatus,
  type CoverageObligation,
  type IngestionQuestionLink,
} from "../../domain/ingest/index.js";

export const MIN_CONCRETE_TOKENS = 3;
export const DUPLICATE_SIMILARITY = 0.8;

export const ADMISSION_REASON_ORDER = [
  "INVALID_PROPOSAL",
  "GENERIC_WORDING",
  "MISSING_TRIGGER",
  "OBLIGATION_NOT_FOUND",
  "OBLIGATION_NOT_FOR_QUESTION",
  "OBLIGATION_NOT_SELF_OWNED",
  "OBLIGATION_RESOLVED",
  "OBLIGATION_NOT_NOVEL",
  "DUPLICATE_WORDING",
] as const;

export type AdmissionReason = (typeof ADMISSION_REASON_ORDER)[number];

export interface AdmittedGeneratedQuestionFact {
  readonly link: IngestionQuestionLink;
  readonly wording: string;
  readonly obligationId: string;
}

export interface QuestionProposalInput {
  readonly link: IngestionQuestionLink;
  readonly wording: string;
  readonly obligationId?: string | undefined;
  readonly obligations: readonly CoverageObligation[];
  readonly admitted: readonly AdmittedGeneratedQuestionFact[];
  readonly lexicalCandidates: readonly string[];
}

export interface AdmissionDecision {
  readonly admitted: boolean;
  readonly kind: "demand" | "generated";
  readonly reasons: readonly AdmissionReason[];
  readonly triggerSourceUnitIds: readonly string[];
  readonly duplicateOf: readonly string[];
  readonly maxSimilarity: number;
  readonly routing: {
    readonly candidateQuestionIds: readonly string[];
    readonly authoritative: false;
  };
}

const ULID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";
const QuestionIdSchema = z.string().regex(new RegExp(`^q-${ULID_PATTERN}$`));
const ObligationIdSchema = z
  .string()
  .regex(new RegExp(`^obl-${ULID_PATTERN}$`));

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

const QuestionProposalInputSchema = z
  .object({
    link: IngestionQuestionLinkSchema,
    wording: z.string().trim().min(1),
    obligationId: ObligationIdSchema.optional(),
    obligations: z.array(CoverageObligationRecordSchema),
    admitted: z.array(AdmittedGeneratedQuestionFactSchema),
    lexicalCandidates: z.array(QuestionIdSchema),
  })
  .strict();

// Deliberately closed and source-visible: changing what counts as generic is a
// policy change, not an incidental consequence of a stemming or fuzzy library.
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

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function objectValue(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {};
}

export function assessQuestionProposal(
  input: QuestionProposalInput,
): AdmissionDecision {
  const parsed = QuestionProposalInputSchema.safeParse(input);
  const raw = objectValue(input);
  const rawLink = objectValue(raw.link);

  const link = parsed.success ? parsed.data.link : rawLink;
  const wording =
    typeof raw.wording === "string"
      ? raw.wording
      : parsed.success
        ? parsed.data.wording
        : "";
  const questionId = typeof link.questionId === "string" ? link.questionId : "";
  const origin = link.origin;
  const sourceUnitIds = Array.isArray(link.sourceUnitIds)
    ? link.sourceUnitIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const triggerSourceUnitIds = unique(sourceUnitIds);
  const lexicalCandidates = Array.isArray(raw.lexicalCandidates)
    ? raw.lexicalCandidates.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const routing = {
    candidateQuestionIds: [...lexicalCandidates],
    authoritative: false as const,
  };

  if (parsed.success && origin === "human") {
    return {
      admitted: true,
      kind: "demand",
      reasons: [],
      triggerSourceUnitIds,
      duplicateOf: [],
      maxSimilarity: 0,
      routing,
    };
  }

  const detected = new Set<AdmissionReason>();
  if (!parsed.success || origin !== "ingestion-generated") {
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

  const obligationId =
    typeof raw.obligationId === "string" ? raw.obligationId : undefined;
  const obligations = Array.isArray(raw.obligations) ? raw.obligations : [];
  const citedObligation = obligationId
    ? obligations
        .map(objectValue)
        .find((obligation) => obligation.id === obligationId)
    : undefined;

  if (!citedObligation) {
    detected.add("OBLIGATION_NOT_FOUND");
  } else {
    if (citedObligation.questionId !== questionId) {
      detected.add("OBLIGATION_NOT_FOR_QUESTION");
    } else if (citedObligation.ownerQuestionId !== questionId) {
      detected.add("OBLIGATION_NOT_SELF_OWNED");
    }
    if (
      typeof citedObligation.status === "string" &&
      isTerminalObligationStatus(
        citedObligation.status as CoverageObligation["status"],
      )
    ) {
      detected.add("OBLIGATION_RESOLVED");
    }
  }

  const admittedFacts = Array.isArray(raw.admitted) ? raw.admitted : [];
  if (
    obligationId !== undefined &&
    admittedFacts
      .map(objectValue)
      .some((fact) => fact.obligationId === obligationId)
  ) {
    detected.add("OBLIGATION_NOT_NOVEL");
  }

  let maxSimilarity = admittedFacts.length === 0 ? 0 : -1;
  const duplicateOf: string[] = [];
  for (const rawFact of admittedFacts) {
    const fact = objectValue(rawFact);
    const factWording = typeof fact.wording === "string" ? fact.wording : "";
    const factLink = objectValue(fact.link);
    const similarity = jaccard(
      wordingTokens,
      new Set(normalizeTokens(factWording)),
    );
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
    }
    if (
      similarity >= DUPLICATE_SIMILARITY &&
      typeof factLink.questionId === "string"
    ) {
      duplicateOf.push(factLink.questionId);
    }
  }
  if (duplicateOf.length > 0) {
    detected.add("DUPLICATE_WORDING");
  }

  const reasons = ADMISSION_REASON_ORDER.filter((reason) =>
    detected.has(reason),
  );
  return {
    admitted: reasons.length === 0,
    kind: "generated",
    reasons,
    triggerSourceUnitIds,
    duplicateOf,
    maxSimilarity,
    routing,
  };
}
