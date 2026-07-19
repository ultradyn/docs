/**
 * T-32-02 — Claim Reviewer (proposal agent only).
 *
 * HONESTY (binding):
 * - PROPOSES ONLY. Never calls ClaimReviewService.apply; never grants
 *   ClaimAcceptanceAuthority; never transitions ClaimState. Exactly one
 *   acceptance path exists and T-22-03 owns it.
 * - Agent-layer SoD (reviewerRunId ≠ extractorRunId after normaliseRunIdentity)
 *   is CALLER-TRUSTED: both ids arrive in the INPUT. A dishonest caller that
 *   lies about either passes the pin. Authoritative SoD is packet→run
 *   provenance on ClaimReviewService.apply (T-22-03). This pin catches an
 *   honest mistake, NOT a dishonest caller.
 * - authorityEligible is an AGENT ASSERTION (LLM boolean), never a permission
 *   grant and never sufficient for durable acceptance. Only
 *   ClaimAcceptanceAuthority on apply grants acceptance.
 * - Free-text reason → UntrustedProse after validate (B003).
 * - Fresh context is STRUCTURAL for NAMED TOP-LEVEL SLOTS only:
 *   ProposeContext has no extractorMessages / chat / transcript field, and
 *   runClaimReviewer refuses those keys (and symbols) at the top level before
 *   propose. packet is unknown and claims is readonly unknown[] — both are
 *   passed to propose RAW. Nested extractor transcript inside packet or a claim
 *   record is NOT scanned; that depends on the caller (mistake-catching class,
 *   not adversary-proof). Do not read this as "reviewer cannot see extractor
 *   context" in absolute terms.
 * - Whole-batch fail closed: UNEVALUATED_CLAIM / UNSUPPORTED_EVIDENCE refuse
 *   the entire proposal set (silence is never approval).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Ajv, type ValidateFunction } from "ajv";
import { z } from "zod";

import {
  ClaimIdSchema,
  type ClaimType,
} from "../../domain/ingest/claim.js";
import {
  ClaimReviewDecisionSchema,
  ClaimSplitSpecSchema,
  type ClaimReviewDecision,
  type ClaimSplitSpec,
} from "../../domain/ingest/claim-review.js";
import {
  EvidencePacketSchema,
  type EvidencePacket,
} from "../../domain/ingest/evidence-packet.js";
import { SourceUnitIdSchema } from "../../domain/ingest/id-schemas.js";
import type {
  ClaimId,
  IngestResult,
  SourceUnitId,
} from "../../domain/ingest/types.js";
import {
  markUntrustedProse,
  type UntrustedProse,
} from "../../domain/ingest/untrusted-prose.js";
import { normaliseRunIdentity } from "../knowledge/claim-review-service.js";

// ---------------------------------------------------------------------------
// Limits + errors
// ---------------------------------------------------------------------------

export const CLAIM_REVIEWER_LIMITS = Object.freeze({
  maxReviews: 64,
  maxReasonChars: 2_000,
  maxSplits: 32,
  maxQualifierIds: 32,
  maxEvidenceUnitIds: 32,
  maxRunIdChars: 128,
});

export type ClaimReviewerError =
  | "INVALID_INPUT"
  | "INVALID_PROPOSAL"
  | "UNEVALUATED_CLAIM"
  | "UNSUPPORTED_EVIDENCE"
  | "SEPARATION_OF_DUTIES"
  | "PROPOSER_FAILED"
  | "SCHEMA_LOAD_FAILED";

const FIXED_MESSAGES: Record<ClaimReviewerError, string> = {
  INVALID_INPUT: "Claim reviewer input is invalid.",
  INVALID_PROPOSAL: "Claim reviewer proposal failed schema or axis validation.",
  UNEVALUATED_CLAIM:
    "Every subject claim must receive a review decision (silence is not approval).",
  UNSUPPORTED_EVIDENCE:
    "A review cites evidence not present in the authoritative packet.",
  SEPARATION_OF_DUTIES:
    "Reviewer run id must not equal extractor run id after normalisation (caller-trusted pin).",
  PROPOSER_FAILED: "Claim reviewer proposer failed.",
  SCHEMA_LOAD_FAILED: "Claim reviewer output schema could not be loaded.",
};

// ---------------------------------------------------------------------------
// Axes + schema
// ---------------------------------------------------------------------------

const EntailmentSchema = z.enum(["entailed", "not_entailed", "ambiguous"]);
const AtomicitySchema = z.enum(["atomic", "overbroad", "fragmented"]);
const ScopeAxisSchema = z.enum(["compatible", "wrong_scope", "ambiguous"]);
const QualifiersSchema = z.enum(["complete", "missing", "n/a"]);

const ReviewRowSchema = z
  .object({
    claimId: ClaimIdSchema,
    expectedVersion: z.number().int().positive().max(1_000_000),
    decision: ClaimReviewDecisionSchema,
    entailment: EntailmentSchema,
    atomicity: AtomicitySchema,
    scope: ScopeAxisSchema,
    qualifiers: QualifiersSchema,
    /**
     * Agent assertion only — NOT ClaimAcceptanceAuthority.
     * Necessary for a proposed accept; never sufficient for durable accept.
     */
    authorityEligible: z.boolean(),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(CLAIM_REVIEWER_LIMITS.maxReasonChars)
      .optional(),
    splits: z
      .array(ClaimSplitSpecSchema)
      .min(1)
      .max(CLAIM_REVIEWER_LIMITS.maxSplits)
      .optional(),
    qualifierClaimIds: z
      .array(ClaimIdSchema)
      .min(1)
      .max(CLAIM_REVIEWER_LIMITS.maxQualifierIds)
      .optional(),
    evidenceUnitIds: z
      .array(SourceUnitIdSchema)
      .max(CLAIM_REVIEWER_LIMITS.maxEvidenceUnitIds)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === "split") {
      if (!value.splits || value.splits.length < 1) {
        ctx.addIssue({
          code: "custom",
          path: ["splits"],
          message: "split decision requires splits",
        });
      }
    } else if (value.splits !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["splits"],
        message: "splits only allowed for split decision",
      });
    }
    if (value.decision === "qualify") {
      if (!value.qualifierClaimIds || value.qualifierClaimIds.length < 1) {
        ctx.addIssue({
          code: "custom",
          path: ["qualifierClaimIds"],
          message: "qualify decision requires qualifierClaimIds",
        });
      }
    } else if (value.qualifierClaimIds !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["qualifierClaimIds"],
        message: "qualifierClaimIds only allowed for qualify decision",
      });
    }
  });

export const ClaimReviewerOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    packetId: z.string().min(1).max(128),
    reviewerRunId: z
      .string()
      .min(1)
      .max(CLAIM_REVIEWER_LIMITS.maxRunIdChars),
    extractorRunId: z
      .string()
      .min(1)
      .max(CLAIM_REVIEWER_LIMITS.maxRunIdChars),
    reviews: z
      .array(ReviewRowSchema)
      .min(1)
      .max(CLAIM_REVIEWER_LIMITS.maxReviews),
  })
  .strict();

export type ClaimReviewerReviewRow = {
  readonly claimId: ClaimId;
  readonly expectedVersion: number;
  readonly decision: ClaimReviewDecision;
  readonly entailment: z.infer<typeof EntailmentSchema>;
  readonly atomicity: z.infer<typeof AtomicitySchema>;
  readonly scope: z.infer<typeof ScopeAxisSchema>;
  readonly qualifiers: z.infer<typeof QualifiersSchema>;
  /** Agent assertion — not an authority grant. */
  readonly authorityEligible: boolean;
  readonly reason?: UntrustedProse;
  readonly splits?: readonly ClaimSplitSpec[];
  readonly qualifierClaimIds?: readonly ClaimId[];
  readonly evidenceUnitIds?: readonly SourceUnitId[];
};

export type ClaimReviewerProposal = {
  readonly schemaVersion: 1;
  readonly packetId: string;
  readonly reviewerRunId: string;
  readonly extractorRunId: string;
  readonly reviews: readonly ClaimReviewerReviewRow[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) {
      for (const item of value) deepFreeze(item);
    } else {
      for (const child of Object.values(value as object)) deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function failure(
  code: ClaimReviewerError,
): IngestResult<never, ClaimReviewerError> {
  return Object.freeze({
    ok: false as const,
    code,
    message: FIXED_MESSAGES[code],
  });
}

function success(
  value: ClaimReviewerProposal,
): IngestResult<ClaimReviewerProposal, ClaimReviewerError> {
  return Object.freeze({ ok: true as const, value: deepFreeze(value) });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

const CHILD_SMUGGLING_KEYS = [
  "childQuestions",
  "deferredQuestions",
  "spawnedQuestions",
  "depthFindings",
  "answer",
  "finalAnswer",
  "acceptedClaimIds",
  "rejectedClaimIds",
] as const;

const OVERGENERAL_TYPES = new Set<ClaimType>([
  "definition",
  "requirement",
  "constraint",
  "behavior",
  "interface_contract",
]);

const UNIVERSAL_RE =
  /\b(all|always|every|never|must for all|universally|in all cases|forever)\b/i;

function isOvergeneralStatement(
  statement: string,
  claimType: string | undefined,
): boolean {
  if (!claimType || !OVERGENERAL_TYPES.has(claimType as ClaimType)) {
    // Still refuse universal language when type missing but statement screams universal
    return UNIVERSAL_RE.test(statement);
  }
  return UNIVERSAL_RE.test(statement);
}

function acceptAxesReady(row: {
  entailment: string;
  atomicity: string;
  scope: string;
  qualifiers: string;
  authorityEligible: boolean;
}): boolean {
  return (
    row.entailment === "entailed" &&
    row.atomicity === "atomic" &&
    row.scope === "compatible" &&
    // Whitelist (not `!== "missing"`): future enum values must fail closed.
    (row.qualifiers === "complete" || row.qualifiers === "n/a") &&
    row.authorityEligible === true
  );
}

function subjectClaimIds(
  claims: readonly unknown[],
): IngestResult<ReadonlyMap<string, { statement: string; claimType?: string }>, ClaimReviewerError> {
  const map = new Map<string, { statement: string; claimType?: string }>();
  for (const c of claims) {
    if (!isPlainObject(c)) return failure("INVALID_INPUT");
    const id = c.id;
    if (typeof id !== "string" || !ClaimIdSchema.safeParse(id).success) {
      return failure("INVALID_INPUT");
    }
    const statement =
      typeof c.statement === "string"
        ? c.statement
        : typeof c.text === "string"
          ? c.text
          : "";
    if (statement.length < 1) return failure("INVALID_INPUT");
    const claimType =
      typeof c.claimType === "string"
        ? c.claimType
        : typeof c.type === "string"
          ? c.type
          : undefined;
    if (map.has(id)) return failure("INVALID_INPUT");
    if (claimType !== undefined) {
      map.set(id, { statement, claimType });
    } else {
      map.set(id, { statement });
    }
  }
  if (map.size < 1) return failure("INVALID_INPUT");
  return Object.freeze({ ok: true as const, value: map });
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export type ValidateClaimReviewerOptions = {
  readonly packet: unknown;
  readonly claims: readonly unknown[];
  readonly reviewerRunId: string;
  readonly extractorRunId: string;
};

export function validateClaimReviewerProposal(
  input: unknown,
  options: ValidateClaimReviewerOptions,
): IngestResult<ClaimReviewerProposal, ClaimReviewerError> {
  if (
    options == null ||
    typeof options.reviewerRunId !== "string" ||
    typeof options.extractorRunId !== "string" ||
    !Array.isArray(options.claims)
  ) {
    return failure("INVALID_INPUT");
  }

  // Caller-trusted SoD pin (not authoritative — see module header).
  const reviewerNorm = normaliseRunIdentity(options.reviewerRunId);
  const extractorNorm = normaliseRunIdentity(options.extractorRunId);
  if (reviewerNorm.length < 1 || extractorNorm.length < 1) {
    return failure("INVALID_INPUT");
  }
  if (reviewerNorm === extractorNorm) {
    return failure("SEPARATION_OF_DUTIES");
  }

  const subjectsResult = subjectClaimIds(options.claims);
  if (!subjectsResult.ok) return failure(subjectsResult.code);
  const subjects = subjectsResult.value;

  const packetParsed = EvidencePacketSchema.safeParse(options.packet);
  if (!packetParsed.success) return failure("INVALID_INPUT");
  const packet = packetParsed.data as EvidencePacket;
  const packetUnits = new Set(
    packet.references.map((r) => r.unitId as string),
  );

  if (!isPlainObject(input)) return failure("INVALID_PROPOSAL");
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") return failure("INVALID_PROPOSAL");
    if ((CHILD_SMUGGLING_KEYS as readonly string[]).includes(key)) {
      return failure("INVALID_PROPOSAL");
    }
  }

  const parsed = ClaimReviewerOutputSchema.safeParse(input);
  if (!parsed.success) return failure("INVALID_PROPOSAL");
  const raw = parsed.data;

  // Output run ids must match the fresh-context input (caller-declared).
  if (
    normaliseRunIdentity(raw.reviewerRunId) !== reviewerNorm ||
    normaliseRunIdentity(raw.extractorRunId) !== extractorNorm
  ) {
    return failure("INVALID_PROPOSAL");
  }
  if (raw.packetId !== (packet.id as string)) {
    return failure("INVALID_PROPOSAL");
  }

  // UNEVALUATED_CLAIM — every subject must appear exactly once
  const reviewed = new Map<string, (typeof raw.reviews)[number]>();
  for (const row of raw.reviews) {
    const id = row.claimId as string;
    if (reviewed.has(id)) return failure("INVALID_PROPOSAL");
    if (!subjects.has(id)) return failure("INVALID_PROPOSAL");
    reviewed.set(id, row);
  }
  for (const id of subjects.keys()) {
    if (!reviewed.has(id)) return failure("UNEVALUATED_CLAIM");
  }

  // Fabrication gate + axis consistency + overgeneralisation on accept
  for (const row of raw.reviews) {
    const evidenceUnits = row.evidenceUnitIds;
    if (evidenceUnits !== undefined) {
      for (const unitId of evidenceUnits) {
        if (!packetUnits.has(unitId as string)) {
          return failure("UNSUPPORTED_EVIDENCE");
        }
      }
    }

    if (row.decision === "accept") {
      if (!acceptAxesReady(row)) return failure("INVALID_PROPOSAL");
      const subject = subjects.get(row.claimId as string);
      if (!subject) return failure("INVALID_PROPOSAL");
      if (isOvergeneralStatement(subject.statement, subject.claimType)) {
        return failure("INVALID_PROPOSAL");
      }
    }

    if (row.decision === "split") {
      if (row.atomicity !== "overbroad" && row.atomicity !== "fragmented") {
        // allow split only when atomicity signals overbreadth
        if (row.atomicity === "atomic") return failure("INVALID_PROPOSAL");
      }
    }
  }

  const branded: ClaimReviewerProposal = {
    schemaVersion: 1,
    packetId: raw.packetId,
    reviewerRunId: raw.reviewerRunId,
    extractorRunId: raw.extractorRunId,
    reviews: raw.reviews.map((row) => {
      const out: ClaimReviewerReviewRow = {
        claimId: row.claimId as ClaimId,
        expectedVersion: row.expectedVersion,
        decision: row.decision as ClaimReviewDecision,
        entailment: row.entailment,
        atomicity: row.atomicity,
        scope: row.scope,
        qualifiers: row.qualifiers,
        authorityEligible: row.authorityEligible,
        ...(row.reason !== undefined
          ? { reason: markUntrustedProse(row.reason) }
          : {}),
        ...(row.splits !== undefined
          ? { splits: row.splits as ClaimSplitSpec[] }
          : {}),
        ...(row.qualifierClaimIds !== undefined
          ? { qualifierClaimIds: row.qualifierClaimIds as ClaimId[] }
          : {}),
        ...(row.evidenceUnitIds !== undefined
          ? { evidenceUnitIds: row.evidenceUnitIds as SourceUnitId[] }
          : {}),
      };
      return out;
    }),
  };
  return success(branded);
}

// ---------------------------------------------------------------------------
// Scaffold schema
// ---------------------------------------------------------------------------

export async function loadClaimReviewerOutputSchema(
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

export function compileClaimReviewerOutputSchema(
  schema: Record<string, unknown>,
): ValidateFunction {
  return new Ajv({ allErrors: true, strict: true }).compile(schema);
}

// ---------------------------------------------------------------------------
// Agent runtime
// ---------------------------------------------------------------------------

/**
 * Fresh-context propose input. STRUCTURAL: no extractorMessages / chat /
 * transcript fields — the untrusted party cannot supply extractor private context.
 */
export type ClaimReviewerProposeContext = {
  readonly packet: unknown;
  readonly claims: readonly unknown[];
  readonly reviewerRunId: string;
  readonly extractorRunId: string;
};

export type ClaimReviewerPropose = (
  context: ClaimReviewerProposeContext,
) => Promise<unknown>;

export interface ClaimReviewerAgent {
  runClaimReviewer(
    input: ClaimReviewerProposeContext,
  ): Promise<IngestResult<ClaimReviewerProposal, ClaimReviewerError>>;
}

export type CreateClaimReviewerAgentOptions = {
  readonly propose: ClaimReviewerPropose;
};

export function createClaimReviewerAgent(
  options: CreateClaimReviewerAgentOptions,
): ClaimReviewerAgent {
  if (typeof options?.propose !== "function") {
    throw new Error("createClaimReviewerAgent requires propose.");
  }
  return {
    async runClaimReviewer(input) {
      if (input == null || typeof input !== "object") {
        return failure("INVALID_INPUT");
      }
      // Reject smuggled extractor context keys at the run boundary.
      if (isPlainObject(input)) {
        for (const key of Reflect.ownKeys(input)) {
          if (typeof key === "symbol") return failure("INVALID_INPUT");
          if (
            key === "extractorMessages" ||
            key === "chat" ||
            key === "transcript"
          ) {
            return failure("INVALID_INPUT");
          }
        }
      }
      try {
        const draft = await options.propose({
          packet: input.packet,
          claims: input.claims,
          reviewerRunId: input.reviewerRunId,
          extractorRunId: input.extractorRunId,
        });
        return validateClaimReviewerProposal(draft, {
          packet: input.packet,
          claims: input.claims,
          reviewerRunId: input.reviewerRunId,
          extractorRunId: input.extractorRunId,
        });
      } catch {
        return failure("PROPOSER_FAILED");
      }
    },
  };
}
