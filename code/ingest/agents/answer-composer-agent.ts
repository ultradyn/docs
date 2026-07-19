/**
 * T-60-02 — Answer Composer (deterministic pack→answer; no LLM).
 *
 * RED STUB — full implementation after Claude GREEN release.
 *
 * HONESTY (binding):
 * - THE COMPOSER AUTHORS NO PROSE. It selects and orders claim statements that
 *   already exist in the sealed pack. The answer carries no assertion not
 *   already in a reviewed claim — and is only as trustworthy as those claims.
 *   It is not an independent generation step. A composed answer is the end of
 *   the provenance chain, not a new link in it.
 * - Pack-only: no retrieval tools (allowlist empty). No LLM propose path in v1.
 * - validateAnswerComposition independently enforces UNMAPPED_ASSERTION /
 *   PACK_HASH_MISMATCH / INVENTED_PROSE even though pure compose cannot emit them.
 * - insufficient_pack: empty answer, zero sentenceClaims, limitations list.
 */
import type { AnswerComposition } from "../../domain/ingest/answer-composition.js";
import type { SealedClaimPack } from "../../domain/ingest/sealed-claim-pack.js";
import type { IngestResult } from "../../domain/ingest/types.js";

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

/** Pure deterministic assembler — no LLM. RED stub. */
export function composeAnswerFromPack(
  _input: ComposeAnswerFromPackInput,
): IngestResult<AnswerComposition, AnswerComposerError> {
  return fail("INVALID_PROPOSAL");
}

/** Independent validation boundary (belt for future non-deterministic callers). */
export function validateAnswerComposition(
  _input: unknown,
  _options: ValidateAnswerCompositionOptions,
): IngestResult<AnswerComposition, AnswerComposerError> {
  return fail("INVALID_PROPOSAL");
}

export type StructuredAnswerContext = {
  readonly structuredAnswerLabel: "transcript_context";
  readonly text: string;
};

/** Read-only labelled context — never writes AnswerComposition. */
export const StructuredAnswerCompatibility = {
  async readQuestionContext(
    _questionId: string,
  ): Promise<StructuredAnswerContext | null> {
    return null;
  },
};
