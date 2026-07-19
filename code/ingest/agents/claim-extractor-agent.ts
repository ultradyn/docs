/**
 * T-32-01 — Claim Extractor (proposal agent only).
 *
 * HONESTY (binding):
 * - PROPOSES ONLY. Never accepts, never transitions ClaimState, never mints claim
 *   ids. T-22-01 froze the five-set; T-22-03 owns acceptance. Persistence is a
 *   follow-up (ClaimRepository.create) — this module is VALIDATE-ONLY per plan
 *   file list; follow-up apply task must be filed with the RED checkpoint.
 * - Fabrication gate: every evidenceReferenceIds unitId is re-checked against
 *   the supplied packet.references in code — never trusted from agent prose.
 * - Whole-batch fail closed: if any claim has unsupported refs, the entire
 *   proposal set is refused (not silently filtered). Partial success is the
 *   T-13-03 fail-open shape.
 * - Free-text claim text is untrusted LLM output. UntrustedProse (B003) is
 *   adopted when present on main; until then plain string + this residual —
 *   do not feed proposal text into a model path without an explicit expose.
 * - Agent supplies unit IDs only; full evidenceRefs (snapshot/hash/locator)
 *   would be mapped from the packet at apply time (follow-up).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Ajv, type ValidateFunction } from "ajv";
import { z } from "zod";

import {
  ClaimTypeSchema,
  type ClaimType,
} from "../../domain/ingest/claim.js";
import {
  EvidencePacketSchema,
  type EvidencePacket,
} from "../../domain/ingest/evidence-packet.js";
import { SourceUnitIdSchema } from "../../domain/ingest/id-schemas.js";
import type { IngestResult, SourceUnitId } from "../../domain/ingest/types.js";

// ---------------------------------------------------------------------------
// Limits + errors
// ---------------------------------------------------------------------------

export const CLAIM_EXTRACTOR_LIMITS = Object.freeze({
  maxClaims: 32,
  maxTextChars: 8_000,
  maxEvidenceRefsPerClaim: 32,
  maxScopeKeys: 32,
  maxScopeValueChars: 256,
  maxAuthorityChars: 256,
  maxLifecycleChars: 256,
  maxRelationshipIds: 64,
});

export type ClaimExtractorError =
  | "INVALID_INPUT"
  | "INVALID_PROPOSAL"
  | "UNSUPPORTED_EVIDENCE"
  | "VERDICT_NOT_ACCEPTED"
  | "PROPOSER_FAILED"
  | "SCHEMA_LOAD_FAILED";

const FIXED_MESSAGES: Record<ClaimExtractorError, string> = {
  INVALID_INPUT: "Claim extractor input is invalid.",
  INVALID_PROPOSAL: "Claim extractor proposal failed schema validation.",
  UNSUPPORTED_EVIDENCE:
    "A claim references evidence not present in the accepted packet.",
  VERDICT_NOT_ACCEPTED:
    "Claim extraction requires an accepted evidence verdict.",
  PROPOSER_FAILED: "Claim extractor proposer failed.",
  SCHEMA_LOAD_FAILED: "Claim extractor output schema could not be loaded.",
};

// ---------------------------------------------------------------------------
// Schema — strict, no id/state/accept/child keys
// ---------------------------------------------------------------------------

const CandidateRelationshipsSchema = z
  .object({
    qualifierClaimIds: z
      .array(z.string().min(1).max(64))
      .max(CLAIM_EXTRACTOR_LIMITS.maxRelationshipIds)
      .optional(),
    contradictsClaimIds: z
      .array(z.string().min(1).max(64))
      .max(CLAIM_EXTRACTOR_LIMITS.maxRelationshipIds)
      .optional(),
    supersedesClaimIds: z
      .array(z.string().min(1).max(64))
      .max(CLAIM_EXTRACTOR_LIMITS.maxRelationshipIds)
      .optional(),
  })
  .strict();

export const ClaimProposalSchema = z
  .object({
    text: z.string().trim().min(1).max(CLAIM_EXTRACTOR_LIMITS.maxTextChars),
    type: ClaimTypeSchema,
    scope: z
      .record(z.string().min(1).max(CLAIM_EXTRACTOR_LIMITS.maxScopeValueChars))
      .refine(
        (obj) => Object.keys(obj).length <= CLAIM_EXTRACTOR_LIMITS.maxScopeKeys,
        "too many scope keys",
      ),
    authority: z
      .string()
      .trim()
      .min(1)
      .max(CLAIM_EXTRACTOR_LIMITS.maxAuthorityChars),
    lifecycle: z
      .string()
      .trim()
      .min(1)
      .max(CLAIM_EXTRACTOR_LIMITS.maxLifecycleChars),
    evidenceReferenceIds: z
      .array(SourceUnitIdSchema)
      .min(1)
      .max(CLAIM_EXTRACTOR_LIMITS.maxEvidenceRefsPerClaim),
    candidateRelationships: CandidateRelationshipsSchema.default({}),
  })
  .strict();

export type ClaimProposal = {
  readonly text: string;
  readonly type: ClaimType;
  readonly scope: Readonly<Record<string, string>>;
  readonly authority: string;
  readonly lifecycle: string;
  readonly evidenceReferenceIds: readonly SourceUnitId[];
  readonly candidateRelationships: {
    readonly qualifierClaimIds?: readonly string[];
    readonly contradictsClaimIds?: readonly string[];
    readonly supersedesClaimIds?: readonly string[];
  };
};

export const ClaimExtractorOutputSchema = z
  .object({
    claims: z.array(ClaimProposalSchema).min(1).max(CLAIM_EXTRACTOR_LIMITS.maxClaims),
  })
  .strict();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failure(
  code: ClaimExtractorError,
): IngestResult<never, ClaimExtractorError> {
  return Object.freeze({
    ok: false as const,
    code,
    message: FIXED_MESSAGES[code],
  });
}

function success(
  value: readonly ClaimProposal[],
): IngestResult<readonly ClaimProposal[], ClaimExtractorError> {
  return Object.freeze({ ok: true as const, value: Object.freeze([...value]) });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) for (const item of value) deepFreeze(item);
    else for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function packetUnitIds(packet: EvidencePacket): Set<string> {
  return new Set(packet.references.map((r) => r.unitId as string));
}

const OVERGENERAL_TYPES = new Set<ClaimType>([
  "definition",
  "requirement",
  "constraint",
  "behavior",
  "interface_contract",
]);

const UNIVERSAL_RE =
  /\b(all|always|every|never|must for all|universally|in all cases)\b/i;

/**
 * Fixture-driven overgeneralisation: example-backed universal language on a
 * strong claim type with a single evidence unit is refused.
 */
function isOvergeneralisation(claim: ClaimProposal): boolean {
  // Inferred intent labelled as documented rationale
  if (
    claim.type === "rationale_documented" &&
    /\b(I think|we believe|seems|apparently|presumably|intended)\b/i.test(
      claim.text,
    )
  ) {
    return true;
  }
  // Universal claim language on a strong type with a single evidence unit
  if (!OVERGENERAL_TYPES.has(claim.type)) return false;
  if (claim.evidenceReferenceIds.length !== 1) return false;
  return UNIVERSAL_RE.test(claim.text);
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export type ValidateClaimExtractorOptions = {
  readonly packet: unknown;
  /** Structural gate: only accepted verdicts may drive extraction. */
  readonly verdictAccepted: boolean;
};

export function validateClaimExtractorProposal(
  input: unknown,
  options: ValidateClaimExtractorOptions,
): IngestResult<readonly ClaimProposal[], ClaimExtractorError> {
  if (!options.verdictAccepted) {
    return failure("VERDICT_NOT_ACCEPTED");
  }

  const packetParsed = EvidencePacketSchema.safeParse(options.packet);
  if (!packetParsed.success) {
    return failure("INVALID_INPUT");
  }
  const packet = packetParsed.data;
  const allowed = packetUnitIds(packet);

  const parsed = ClaimExtractorOutputSchema.safeParse(input);
  if (!parsed.success) {
    return failure("INVALID_PROPOSAL");
  }

  const claims = parsed.data.claims as ClaimProposal[];

  // Whole-batch: any unsupported ref fails the entire set.
  for (const claim of claims) {
    for (const unitId of claim.evidenceReferenceIds) {
      if (!allowed.has(unitId as string)) {
        return failure("UNSUPPORTED_EVIDENCE");
      }
    }
    if (isOvergeneralisation(claim)) {
      return failure("INVALID_PROPOSAL");
    }
  }

  return success(deepFreeze(claims));
}

// ---------------------------------------------------------------------------
// Scaffold schema loader
// ---------------------------------------------------------------------------

export async function loadClaimExtractorOutputSchema(
  scaffoldDirectory: string,
): Promise<Record<string, unknown>> {
  const raw = await readFile(join(scaffoldDirectory, "schema.json"), "utf8");
  const schema = JSON.parse(raw) as Record<string, unknown>;
  const ajv = new Ajv({ allErrors: true, strict: true });
  if (!ajv.validateSchema(schema)) {
    throw new Error(FIXED_MESSAGES.SCHEMA_LOAD_FAILED);
  }
  return schema;
}

export function compileClaimExtractorOutputSchema(
  schema: Record<string, unknown>,
): ValidateFunction {
  return new Ajv({ allErrors: true, strict: true }).compile(schema);
}

// ---------------------------------------------------------------------------
// Agent runtime
// ---------------------------------------------------------------------------

export type ClaimExtractorProposeContext = {
  readonly questionId: string;
  readonly packet: unknown;
  readonly verdictAccepted: boolean;
  readonly candidates?: readonly unknown[];
};

export type ClaimExtractorPropose = (
  context: ClaimExtractorProposeContext,
) => Promise<unknown>;

export interface ClaimExtractorAgent {
  runClaimExtractor(
    input: ClaimExtractorProposeContext,
  ): Promise<
    IngestResult<readonly ClaimProposal[], ClaimExtractorError>
  >;
}

export type CreateClaimExtractorAgentOptions = {
  readonly propose: ClaimExtractorPropose;
};

export function createClaimExtractorAgent(
  options: CreateClaimExtractorAgentOptions,
): ClaimExtractorAgent {
  if (typeof options?.propose !== "function") {
    throw new Error("createClaimExtractorAgent requires propose.");
  }
  return {
    async runClaimExtractor(input) {
      if (input == null || typeof input !== "object") {
        return failure("INVALID_INPUT");
      }
      try {
        const draft = await options.propose({
          questionId: input.questionId,
          packet: input.packet,
          verdictAccepted: input.verdictAccepted,
          candidates: input.candidates,
        });
        return validateClaimExtractorProposal(draft, {
          packet: input.packet,
          verdictAccepted: input.verdictAccepted,
        });
      } catch {
        return failure("PROPOSER_FAILED");
      }
    },
  };
}
