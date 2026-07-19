/**
 * T-31-01 — Evidence Critic contract (isolated, schema-forbidden from children).
 *
 * Orthogonal to transcript Critic (scaffold/agents/critic). This role judges
 * evidence packets only — never proposes child questions (N1/C9).
 *
 * Fail closed:
 * - UNEVALUATED_REFERENCE if any packet.references[].unitId lacks a classification
 * - UNEVALUATED_FACET if any required facet lacks a state
 * - FACET_NOT_SATISFIED / INVALID_VERDICT if verdict=accepted with non-satisfied facets
 * - QUALIFIER_DROPPED if necessary_qualifying unitId is not in packet.references
 *   (re-derived from packet + classifications; never trust agent prose)
 *
 * depthFindings is intentionally ABSENT — free-text findings would smuggle
 * child questions. Reasons on classifications/states are length-bounded
 * justifications only; this validator never interprets them as instructions
 * or questions (downstream consumers may surface them to humans/agents).
 *
 * B003: free-text reason / whyCurrentPacketFails become UntrustedProse after
 * successful validation so consumers cannot silently pass them into model
 * paths. See domain/ingest/untrusted-prose.ts — brand is COMPILE-TIME only.
 * Consumers that need to feed prose to a model must call
 * deliberatelyExposeUntrustedProseToModel (grep-auditable).
 */
import { z } from "zod";

import {
  EvidencePacketSchema,
  type EvidencePacket,
} from "../../domain/ingest/evidence-packet.js";
import {
  FacetStateSchema,
  ReferenceClassificationSchema,
  TerminalVerdictSchema,
  type FacetStateValue,
  type ReferenceClassification,
  type TerminalVerdict,
} from "../../domain/ingest/evidence-verdict.js";
import {
  QuestionIdSchema,
  SourceUnitIdSchema,
} from "../../domain/ingest/id-schemas.js";
import type { IngestResult, SourceUnitId } from "../../domain/ingest/types.js";
import {
  markUntrustedProse,
  type UntrustedProse,
} from "../../domain/ingest/untrusted-prose.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const EVIDENCE_CRITIC_LIMITS = Object.freeze({
  maxReasonChars: 2_000,
  maxClassifications: 1_000,
  maxFacetStates: 256,
  maxQuestionChars: 8_000,
  maxFacets: 64,
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type EvidenceCriticError =
  | "INVALID_INPUT"
  | "INVALID_PROPOSAL"
  | "CHILD_PROPOSAL_FORBIDDEN"
  | "UNEVALUATED_REFERENCE"
  | "UNEVALUATED_FACET"
  | "FACET_NOT_SATISFIED"
  | "INVALID_VERDICT"
  | "QUALIFIER_DROPPED"
  | "PROPOSER_FAILED";

const FIXED_MESSAGES: Record<EvidenceCriticError, string> = {
  INVALID_INPUT: "Evidence critic input is invalid.",
  INVALID_PROPOSAL: "Evidence critic proposal failed schema validation.",
  CHILD_PROPOSAL_FORBIDDEN:
    "Evidence critic must not propose child or deferred questions.",
  UNEVALUATED_REFERENCE:
    "Every material packet reference must be classified.",
  UNEVALUATED_FACET: "Every required facet must have a facet state.",
  FACET_NOT_SATISFIED:
    "accepted requires every required facet state to be satisfied.",
  INVALID_VERDICT: "Verdict is inconsistent with facet and reference states.",
  QUALIFIER_DROPPED:
    "necessary_qualifying reference is missing from the packet.",
  PROPOSER_FAILED: "Evidence critic proposer failed.",
};

// ---------------------------------------------------------------------------
// Schema — no depthFindings, no child* keys
// ---------------------------------------------------------------------------

const ReasonSchema = z
  .string()
  .min(1)
  .max(EVIDENCE_CRITIC_LIMITS.maxReasonChars);

export const EvidenceCriticReferenceClassificationSchema = z
  .object({
    unitId: SourceUnitIdSchema,
    classification: ReferenceClassificationSchema,
    reason: ReasonSchema,
  })
  .strict();

export const EvidenceCriticFacetStateSchema = z
  .object({
    facetId: z.string().min(1).max(128),
    state: FacetStateSchema,
    reason: ReasonSchema,
    sourceUnitIds: z.array(SourceUnitIdSchema).max(256).optional(),
  })
  .strict();

/**
 * Agent output schema. additionalProperties false via .strict().
 * Forbidden: childQuestions, deferredQuestions, spawnedQuestions, answer,
 * depthFindings (free-text child smuggling), prose.
 */
export const EvidenceCriticProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    questionId: QuestionIdSchema,
    packetId: z.string().min(1).max(128),
    referenceClassifications: z
      .array(EvidenceCriticReferenceClassificationSchema)
      .min(1)
      .max(EVIDENCE_CRITIC_LIMITS.maxClassifications),
    facetStates: z
      .array(EvidenceCriticFacetStateSchema)
      .min(1)
      .max(EVIDENCE_CRITIC_LIMITS.maxFacetStates),
    verdict: TerminalVerdictSchema,
    refinement: z
      .object({
        missingFacetIds: z.array(z.string().min(1).max(128)).max(64),
        whyCurrentPacketFails: z.string().min(1).max(2_000),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export type EvidenceCriticProposal = {
  readonly schemaVersion: 1;
  readonly questionId: string;
  readonly packetId: string;
  readonly referenceClassifications: readonly {
    readonly unitId: SourceUnitId;
    readonly classification: ReferenceClassification;
    readonly reason: UntrustedProse;
  }[];
  readonly facetStates: readonly {
    readonly facetId: string;
    readonly state: FacetStateValue;
    readonly reason: UntrustedProse;
    readonly sourceUnitIds?: readonly SourceUnitId[];
  }[];
  readonly verdict: TerminalVerdict;
  readonly refinement?: {
    readonly missingFacetIds: readonly string[];
    readonly whyCurrentPacketFails: UntrustedProse;
  } | null;
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
  code: EvidenceCriticError,
): IngestResult<never, EvidenceCriticError> {
  return Object.freeze({
    ok: false as const,
    code,
    message: FIXED_MESSAGES[code],
  });
}

function success(
  value: EvidenceCriticProposal,
): IngestResult<EvidenceCriticProposal, EvidenceCriticError> {
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

function ownData(
  object: object,
  key: string,
):
  | { ok: true; present: false }
  | { ok: true; present: true; value: unknown }
  | { ok: false } {
  if (!Reflect.ownKeys(object).includes(key)) {
    return { ok: true, present: false };
  }
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    return { ok: false };
  }
  return { ok: true, present: true, value: descriptor.value };
}

const CHILD_SMUGGLING_KEYS = [
  "childQuestions",
  "deferredQuestions",
  "spawnedQuestions",
  "depthFindings",
  "answer",
  "finalAnswer",
  "prose",
] as const;

/**
 * Exhaustive facet-state check for accepted: only "satisfied" is allowed.
 * Unknown / future states fail closed via the never check path in callers
 * that parse through FacetStateSchema first.
 */
function facetStateAllowsAccepted(state: FacetStateValue): boolean {
  switch (state) {
    case "satisfied":
      return true;
    case "partial":
    case "missing":
    case "conflicting":
    case "ambiguous_scope":
    case "unsupported_in_snapshot":
    case "not_applicable":
      return false;
    default: {
      const _exhaustive: never = state;
      void _exhaustive;
      return false;
    }
  }
}

export interface ValidateEvidenceCriticOptions {
  readonly packet: unknown;
  readonly requiredFacetIds: readonly string[];
}

/**
 * Validate agent proposal against schema + packet-authoritative completeness.
 */
export function validateEvidenceCriticProposal(
  input: unknown,
  options: ValidateEvidenceCriticOptions,
): IngestResult<EvidenceCriticProposal, EvidenceCriticError> {
  if (!isPlainObject(input)) return failure("INVALID_PROPOSAL");

  // Structural child / free-text finding smuggling
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key === "symbol") return failure("INVALID_PROPOSAL");
    if ((CHILD_SMUGGLING_KEYS as readonly string[]).includes(key)) {
      return failure("CHILD_PROPOSAL_FORBIDDEN");
    }
  }

  const packetParsed = EvidencePacketSchema.safeParse(options.packet);
  if (!packetParsed.success) return failure("INVALID_INPUT");
  const packet = packetParsed.data as EvidencePacket;

  if (
    !Array.isArray(options.requiredFacetIds) ||
    options.requiredFacetIds.length < 1 ||
    options.requiredFacetIds.length > EVIDENCE_CRITIC_LIMITS.maxFacets
  ) {
    return failure("INVALID_INPUT");
  }
  for (const id of options.requiredFacetIds) {
    if (typeof id !== "string" || id.length < 1 || id.length > 128) {
      return failure("INVALID_INPUT");
    }
  }

  const parsed = EvidenceCriticProposalSchema.safeParse(input);
  if (!parsed.success) return failure("INVALID_PROPOSAL");
  // Zod output keeps plain strings; brand only on the success path return type.
  const raw = parsed.data;

  // Every material packet reference must be classified
  const classified = new Set(
    raw.referenceClassifications.map((c) => c.unitId as string),
  );
  for (const ref of packet.references) {
    if (!classified.has(ref.unitId as string)) {
      return failure("UNEVALUATED_REFERENCE");
    }
  }

  // Every required facet must have a state
  const stated = new Set(raw.facetStates.map((f) => f.facetId));
  for (const facetId of options.requiredFacetIds) {
    if (!stated.has(facetId)) return failure("UNEVALUATED_FACET");
  }

  // accepted is narrowest
  if (raw.verdict === "accepted") {
    for (const facet of raw.facetStates) {
      if (options.requiredFacetIds.includes(facet.facetId)) {
        if (!facetStateAllowsAccepted(facet.state as FacetStateValue)) {
          return failure("FACET_NOT_SATISFIED");
        }
      }
    }

    // QUALIFIER_DROPPED: re-derive from packet + classifications
    const packetUnits = new Set(
      packet.references.map((r) => r.unitId as string),
    );
    for (const c of raw.referenceClassifications) {
      if (c.classification === "necessary_qualifying") {
        if (!packetUnits.has(c.unitId as string)) {
          return failure("QUALIFIER_DROPPED");
        }
      }
    }
  }

  // B003: free-text justification fields travel branded (compile-time control).
  const branded: EvidenceCriticProposal = {
    schemaVersion: 1,
    questionId: raw.questionId,
    packetId: raw.packetId,
    referenceClassifications: raw.referenceClassifications.map((c) => ({
      unitId: c.unitId as SourceUnitId,
      classification: c.classification as ReferenceClassification,
      reason: markUntrustedProse(c.reason),
    })),
    facetStates: raw.facetStates.map((f) => {
      const state: {
        facetId: string;
        state: FacetStateValue;
        reason: UntrustedProse;
        sourceUnitIds?: readonly SourceUnitId[];
      } = {
        facetId: f.facetId,
        state: f.state as FacetStateValue,
        reason: markUntrustedProse(f.reason),
      };
      if (f.sourceUnitIds !== undefined) {
        state.sourceUnitIds = f.sourceUnitIds as readonly SourceUnitId[];
      }
      return state;
    }),
    verdict: raw.verdict as TerminalVerdict,
    refinement:
      raw.refinement === undefined || raw.refinement === null
        ? null
        : {
            missingFacetIds: raw.refinement.missingFacetIds,
            whyCurrentPacketFails: markUntrustedProse(
              raw.refinement.whyCurrentPacketFails,
            ),
          },
  };
  return success(branded);
}

// ---------------------------------------------------------------------------
// Agent factory
// ---------------------------------------------------------------------------

export interface EvidenceCriticProposeContext {
  readonly questionId: string;
  readonly question: string;
  readonly facets: readonly string[];
  readonly packet: unknown;
}

export type EvidenceCriticPropose = (
  context: EvidenceCriticProposeContext,
) => Promise<unknown>;

export interface EvidenceCriticAgent {
  runEvidenceCritic(
    input: unknown,
  ): Promise<IngestResult<EvidenceCriticProposal, EvidenceCriticError>>;
}

export interface CreateEvidenceCriticAgentOptions {
  readonly propose: EvidenceCriticPropose;
}

function parseRunInput(input: unknown):
  | {
      ok: true;
      questionId: string;
      question: string;
      facets: readonly string[];
      packet: unknown;
    }
  | { ok: false } {
  if (!isPlainObject(input)) return { ok: false };
  const allowed = new Set([
    "questionId",
    "question",
    "facets",
    "packet",
    "goals",
    "documentation",
  ]);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key === "symbol") return { ok: false };
    if (!allowed.has(key)) return { ok: false };
  }
  const qid = ownData(input, "questionId");
  const q = ownData(input, "question");
  const facetsSlot = ownData(input, "facets");
  const packetSlot = ownData(input, "packet");
  if (!qid.ok || !q.ok || !facetsSlot.ok || !packetSlot.ok) return { ok: false };
  if (!qid.present || !q.present || !facetsSlot.present || !packetSlot.present) {
    return { ok: false };
  }
  if (typeof qid.value !== "string" || typeof q.value !== "string") {
    return { ok: false };
  }
  if (!Array.isArray(facetsSlot.value)) return { ok: false };
  const facets = facetsSlot.value.filter(
    (f): f is string => typeof f === "string" && f.length > 0,
  );
  if (facets.length < 1) return { ok: false };
  return {
    ok: true,
    questionId: qid.value,
    question: q.value,
    facets,
    packet: packetSlot.value,
  };
}

export function createEvidenceCriticAgent(
  options: CreateEvidenceCriticAgentOptions,
): EvidenceCriticAgent {
  if (!options || typeof options.propose !== "function") {
    throw new Error("Evidence critic agent requires a propose function.");
  }
  const { propose } = options;
  return {
    async runEvidenceCritic(input) {
      const parsed = parseRunInput(input);
      if (!parsed.ok) return failure("INVALID_INPUT");
      let draft: unknown;
      try {
        draft = await propose({
          questionId: parsed.questionId,
          question: parsed.question,
          facets: parsed.facets,
          packet: parsed.packet,
        });
      } catch {
        return failure("PROPOSER_FAILED");
      }
      return validateEvidenceCriticProposal(draft, {
        packet: parsed.packet,
        requiredFacetIds: parsed.facets,
      });
    },
  };
}

export async function runEvidenceCritic(
  input: unknown,
  options: CreateEvidenceCriticAgentOptions,
): Promise<IngestResult<EvidenceCriticProposal, EvidenceCriticError>> {
  return createEvidenceCriticAgent(options).runEvidenceCritic(input);
}
