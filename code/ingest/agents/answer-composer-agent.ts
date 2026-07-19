/**
 * T-60-02 — Answer Composer (deterministic pack→answer; no LLM).
 *
 * HONESTY (binding):
 * - THE COMPOSER AUTHORS NO PROSE. It selects and orders claim statements that
 *   already exist in the sealed pack. The answer carries no assertion not
 *   already in a reviewed claim — and is only as trustworthy as those claims.
 *   It is not an independent generation step. A composed answer is the end of
 *   the provenance chain, not a new link in it.
 * - Pack-only: no retrieval tools (allowlist empty). No LLM propose path in v1.
 * - validateAnswerComposition independently enforces UNMAPPED_ASSERTION /
 *   PACK_HASH_MISMATCH / INVENTED_PROSE even though pure compose cannot emit them
 *   on the happy path (belt + braces).
 * - insufficient_pack: empty answer, zero sentenceClaims, limitations list.
 * - Composition id: pure hash(questionId|pack.hash|goalsCanonical).
 */
import { createHash } from "node:crypto";

import type {
  AnswerComposition,
  GoalCoverage,
  SentenceClaimBinding,
} from "../../domain/ingest/answer-composition.js";
import { AnswerCompositionSchema } from "../../domain/ingest/answer-composition.js";
import {
  SealedClaimPackSchema,
  type SealedClaimPack,
} from "../../domain/ingest/sealed-claim-pack.js";
import type {
  ClaimId,
  GraphRevision,
  IngestResult,
  Sha256,
} from "../../domain/ingest/types.js";

export type AnswerComposerError =
  | "INVALID_INPUT"
  | "PACK_HASH_MISMATCH"
  | "UNMAPPED_ASSERTION"
  | "INVENTED_PROSE"
  | "INVALID_PROPOSAL";

export type AnswerComposerGoal = {
  readonly goalId: string;
  readonly text: string;
};

export type ComposeAnswerFromPackInput = {
  readonly questionId: string;
  readonly pack: SealedClaimPack;
  readonly goals: readonly AnswerComposerGoal[];
};

export type ValidateAnswerCompositionOptions = {
  readonly pack: SealedClaimPack;
  readonly goals: readonly AnswerComposerGoal[];
};

const FIXED: Record<AnswerComposerError, string> = {
  INVALID_INPUT: "Answer composer input is invalid.",
  PACK_HASH_MISMATCH: "Composition claimPackHash does not match sealed pack.",
  UNMAPPED_ASSERTION:
    "A sentence or citation references a claim not in the sealed pack.",
  INVENTED_PROSE:
    "insufficient_pack compositions must not invent answer prose.",
  INVALID_PROPOSAL: "Answer composition failed validation.",
};

function fail(
  code: AnswerComposerError,
): IngestResult<never, AnswerComposerError> {
  return Object.freeze({ ok: false as const, code, message: FIXED[code] });
}

function ok(
  value: AnswerComposition,
): IngestResult<AnswerComposition, AnswerComposerError> {
  return Object.freeze({ ok: true as const, value: Object.freeze(value) });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) for (const item of value) deepFreeze(item);
    else for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function goalsCanonical(goals: readonly AnswerComposerGoal[]): string {
  return JSON.stringify(
    [...goals]
      .map((g) => ({ goalId: g.goalId, text: g.text }))
      .sort((a, b) =>
        a.goalId < b.goalId ? -1 : a.goalId > b.goalId ? 1 : 0,
      ),
  );
}

export function deriveAnswerCompositionId(
  questionId: string,
  packHash: string,
  goals: readonly AnswerComposerGoal[],
): string {
  const hex = sha256Hex(
    `answer-composition:${questionId}:${packHash}:${goalsCanonical(goals)}`,
  );
  return `ans-${hex.slice(0, 32)}`;
}

/** Token overlap heuristic for goal coverage (deterministic, no LLM). */
function claimSupportsGoal(
  statement: string,
  goalText: string,
): boolean {
  const tokens = goalText
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length >= 4);
  if (tokens.length === 0) return false;
  const hay = statement.toLowerCase();
  // One significant shared token is enough for v1 pack assembly; insufficient_pack
  // is reserved for goals with no lexical overlap against any pack statement.
  for (const t of tokens) {
    if (hay.includes(t)) return true;
  }
  return false;
}

/** Pure deterministic assembler — no LLM. */
export function composeAnswerFromPack(
  input: ComposeAnswerFromPackInput,
): IngestResult<AnswerComposition, AnswerComposerError> {
  if (
    input == null ||
    typeof input.questionId !== "string" ||
    input.questionId.length < 1 ||
    !Array.isArray(input.goals)
  ) {
    return fail("INVALID_INPUT");
  }
  const packParsed = SealedClaimPackSchema.safeParse(input.pack);
  if (!packParsed.success) return fail("INVALID_INPUT");
  const pack = packParsed.data;

  const packIdSet = new Set(pack.claimIds.map((id) => id as string));
  const claimById = new Map(
    pack.claims.map((c) => [c.id as string, c] as const),
  );

  const goalCoverage: GoalCoverage[] = [];
  const selectedClaims: { goalId: string; claimId: ClaimId; statement: string }[] =
    [];

  for (const goal of [...input.goals].sort((a, b) =>
    a.goalId < b.goalId ? -1 : a.goalId > b.goalId ? 1 : 0,
  )) {
    const matched: ClaimId[] = [];
    for (const claim of pack.claims) {
      if (claimSupportsGoal(claim.statement, goal.text)) {
        matched.push(claim.id);
        selectedClaims.push({
          goalId: goal.goalId,
          claimId: claim.id,
          statement: claim.statement,
        });
      }
    }
    goalCoverage.push({
      goalId: goal.goalId,
      covered: matched.length > 0,
      claimIds: Object.freeze(matched),
    });
  }

  const anyCovered = goalCoverage.some((g) => g.covered);
  if (!anyCovered) {
    const limitations = goalCoverage.map(
      (g) => `Goal ${g.goalId} has no supporting claim in the sealed pack.`,
    );
    const composition: AnswerComposition = deepFreeze({
      schemaVersion: 1 as const,
      id: deriveAnswerCompositionId(input.questionId, pack.hash, input.goals),
      questionId: input.questionId,
      claimPackHash: pack.hash as Sha256,
      graphRevision: pack.graphRevision as GraphRevision,
      answer: "",
      claimOrder: Object.freeze([]),
      sentenceClaims: Object.freeze([]),
      citations: Object.freeze([]),
      goalCoverage: Object.freeze(goalCoverage),
      limitations: Object.freeze(limitations),
      state: "insufficient_pack" as const,
    });
    return ok(composition);
  }

  // Deduplicate claim order while preserving first-use order.
  const claimOrder: ClaimId[] = [];
  const seen = new Set<string>();
  const sentenceClaims: SentenceClaimBinding[] = [];
  const answerParts: string[] = [];
  let sentenceIndex = 0;
  for (const row of selectedClaims) {
    if (!seen.has(row.claimId as string)) {
      seen.add(row.claimId as string);
      claimOrder.push(row.claimId);
    }
    answerParts.push(row.statement);
    sentenceClaims.push({
      sentenceIndex,
      claimIds: Object.freeze([row.claimId]),
    });
    sentenceIndex += 1;
  }

  const citations = [];
  for (const id of claimOrder) {
    const c = claimById.get(id as string);
    if (!c) continue;
    for (const ref of c.evidenceRefs) {
      citations.push({ claimId: id, unitId: ref.unitId });
    }
  }

  // Ensure every pack id referenced is in pack (compose cannot violate).
  for (const id of claimOrder) {
    if (!packIdSet.has(id as string)) return fail("UNMAPPED_ASSERTION");
  }

  const composition: AnswerComposition = deepFreeze({
    schemaVersion: 1 as const,
    id: deriveAnswerCompositionId(input.questionId, pack.hash, input.goals),
    questionId: input.questionId,
    claimPackHash: pack.hash as Sha256,
    graphRevision: pack.graphRevision as GraphRevision,
    answer: answerParts.join(" "),
    claimOrder: Object.freeze(claimOrder),
    sentenceClaims: Object.freeze(sentenceClaims),
    citations: Object.freeze(citations),
    goalCoverage: Object.freeze(goalCoverage),
    limitations: Object.freeze(
      goalCoverage
        .filter((g) => !g.covered)
        .map(
          (g) =>
            `Goal ${g.goalId} has no supporting claim in the sealed pack.`,
        ),
    ),
    state: "proposed" as const,
  });
  return ok(composition);
}

/** Independent validation boundary (belt for future non-deterministic callers). */
export function validateAnswerComposition(
  input: unknown,
  options: ValidateAnswerCompositionOptions,
): IngestResult<AnswerComposition, AnswerComposerError> {
  if (options == null || !Array.isArray(options.goals)) {
    return fail("INVALID_INPUT");
  }
  const packParsed = SealedClaimPackSchema.safeParse(options.pack);
  if (!packParsed.success) return fail("INVALID_INPUT");
  const pack = packParsed.data;

  const parsed = AnswerCompositionSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_PROPOSAL");
  const composition = parsed.data;

  if (composition.claimPackHash !== pack.hash) {
    return fail("PACK_HASH_MISMATCH");
  }

  // Do not trust producer-supplied composition ids — re-derive pure material.
  const expectedId = deriveAnswerCompositionId(
    composition.questionId,
    pack.hash,
    options.goals,
  );
  if (composition.id !== expectedId) {
    return fail("INVALID_INPUT");
  }

  if (
    composition.state === "insufficient_pack" &&
    composition.answer.trim().length > 0
  ) {
    return fail("INVENTED_PROSE");
  }

  const packIds = new Set(pack.claimIds.map((id) => id as string));
  // Sealed pack citations are the only legal (claimId, unitId) pairs.
  const packCitationKeys = new Set(
    pack.citations.map((c) => `${c.claimId as string}\0${c.unitId}`),
  );

  for (const id of composition.claimOrder) {
    if (!packIds.has(id as string)) return fail("UNMAPPED_ASSERTION");
  }
  for (const sentence of composition.sentenceClaims) {
    if (sentence.claimIds.length < 1) return fail("INVALID_PROPOSAL");
    for (const id of sentence.claimIds) {
      if (!packIds.has(id as string)) return fail("UNMAPPED_ASSERTION");
    }
  }
  for (const cit of composition.citations) {
    if (!packIds.has(cit.claimId as string)) return fail("UNMAPPED_ASSERTION");
    if (!packCitationKeys.has(`${cit.claimId as string}\0${cit.unitId}`)) {
      return fail("UNMAPPED_ASSERTION");
    }
  }
  for (const g of composition.goalCoverage) {
    for (const id of g.claimIds) {
      if (!packIds.has(id as string)) return fail("UNMAPPED_ASSERTION");
    }
  }

  return ok(
    deepFreeze({
      ...composition,
      graphRevision: composition.graphRevision as GraphRevision,
      claimPackHash: composition.claimPackHash as Sha256,
    } as AnswerComposition),
  );
}

export type StructuredAnswerContext = {
  readonly structuredAnswerLabel: "transcript_context";
  readonly text: string;
};

/** Read-only labelled context — never writes AnswerComposition. */
export const StructuredAnswerCompatibility = {
  async readQuestionContext(
    questionId: string,
  ): Promise<StructuredAnswerContext | null> {
    void questionId;
    // v1: no filesystem/transcript load; labelled context only when provided.
    return null;
  },
};
