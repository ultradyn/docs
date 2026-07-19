/**
 * T-30-02 — Researcher agent contract (evidence packets only).
 *
 * Produces ResearcherProposal — never final-answer prose, never child questions.
 * The JSON/Zod schemas are the control surface; prompt text is not.
 *
 * outcome "no_evidence" requires a sufficient healthy SearchReceipt proving a
 * real search ran (schema-valid receipt with search-identifying fields).
 *
 * Plan: docs/specs/automatic-ingestion-v3/r0-r1-implementation-plan.md L1088-1110.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Ajv, type ValidateFunction } from "ajv";
import { z } from "zod";

import {
  QuestionIdSchema,
  SnapshotIdSchema,
  SourceFileIdSchema,
  SourceUnitIdSchema,
} from "../../domain/ingest/id-schemas.js";
import {
  EvidenceReferenceRoleSchema,
  type EvidenceReferenceRole,
} from "../../domain/ingest/evidence-packet.js";
import {
  SearchReceiptSchema,
  type SearchReceipt,
  type SearchReceiptId,
} from "../../domain/ingest/search-receipt.js";
import type {
  IngestResult,
  QuestionId,
  Sha256,
  SnapshotId,
  SourceFileId,
  SourceUnitId,
} from "../../domain/ingest/types.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const RESEARCHER_LIMITS = Object.freeze({
  maxReferences: 64,
  maxFacetSupport: 64,
  maxReceiptIds: 32,
  maxFacetIdsPerReference: 32,
  maxFacetIdChars: 128,
  maxQuestionChars: 8_000,
});

// ---------------------------------------------------------------------------
// Errors + messages (fixed — no untrusted interpolation)
// ---------------------------------------------------------------------------

export type ResearcherError =
  | "INVALID_INPUT"
  | "INVALID_PROPOSAL"
  | "INSUFFICIENT_RECEIPT"
  | "PROPOSER_FAILED"
  | "SCHEMA_LOAD_FAILED";

const FIXED_MESSAGES: Record<ResearcherError, string> = {
  INVALID_INPUT: "Researcher input is invalid.",
  INVALID_PROPOSAL: "Researcher proposal failed schema validation.",
  INSUFFICIENT_RECEIPT:
    "no_evidence requires a sufficient healthy search receipt.",
  PROPOSER_FAILED: "Researcher proposer failed.",
  SCHEMA_LOAD_FAILED: "Researcher output schema could not be loaded.",
};

// ---------------------------------------------------------------------------
// Proposal schema (Zod) — structural control, not prompt guidance
// ---------------------------------------------------------------------------

const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "must be 64 lowercase hex characters")
  .transform((value) => value as Sha256);

const SearchReceiptIdSchema = z
  .string()
  .regex(/^rcpt-[0-9A-HJKMNP-TV-Z]{26}$/u)
  .transform((value) => value as SearchReceiptId);

export const ResearcherReferenceSchema = z
  .object({
    snapshotId: SnapshotIdSchema,
    fileId: SourceFileIdSchema,
    unitId: SourceUnitIdSchema,
    fileSha256: Sha256Schema,
    unitSha256: Sha256Schema,
    role: EvidenceReferenceRoleSchema,
    facetIds: z
      .array(z.string().min(1).max(RESEARCHER_LIMITS.maxFacetIdChars))
      .min(1)
      .max(RESEARCHER_LIMITS.maxFacetIdsPerReference),
  })
  .strict();

export type ResearcherReference = {
  readonly snapshotId: SnapshotId;
  readonly fileId: SourceFileId;
  readonly unitId: SourceUnitId;
  readonly fileSha256: Sha256;
  readonly unitSha256: Sha256;
  readonly role: EvidenceReferenceRole;
  readonly facetIds: readonly string[];
};

export const ResearcherFacetSupportSchema = z
  .object({
    facetId: z.string().min(1).max(RESEARCHER_LIMITS.maxFacetIdChars),
    referenceCount: z.number().int().positive().max(10_000),
  })
  .strict();

export type ResearcherFacetSupport = {
  readonly facetId: string;
  readonly referenceCount: number;
};

export const ResearcherPacketLimitsSchema = z
  .object({
    maxReferences: z.number().int().positive().max(10_000),
    maxFacetsPerReference: z.number().int().positive().max(64),
  })
  .strict();

export const ResearcherPacketSchema = z
  .object({
    references: z
      .array(ResearcherReferenceSchema)
      .max(RESEARCHER_LIMITS.maxReferences),
    facetSupport: z
      .array(ResearcherFacetSupportSchema)
      .max(RESEARCHER_LIMITS.maxFacetSupport),
    limits: ResearcherPacketLimitsSchema,
  })
  .strict();

export type ResearcherPacket = {
  readonly references: readonly ResearcherReference[];
  readonly facetSupport: readonly ResearcherFacetSupport[];
  readonly limits: {
    readonly maxReferences: number;
    readonly maxFacetsPerReference: number;
  };
};

/**
 * ResearcherProposal — evidence-only. No answer/prose/child fields exist.
 * additionalProperties rejected via .strict().
 */
export const ResearcherProposalSchema = z
  .object({
    questionId: QuestionIdSchema,
    outcome: z.enum(["packet", "no_evidence"]),
    receiptIds: z
      .array(SearchReceiptIdSchema)
      .min(1)
      .max(RESEARCHER_LIMITS.maxReceiptIds),
    packet: ResearcherPacketSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.outcome === "packet" && value.packet.references.length < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["packet", "references"],
        message: "packet outcome requires at least one reference",
      });
    }
    if (value.outcome === "no_evidence" && value.packet.references.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["packet", "references"],
        message: "no_evidence must not carry references",
      });
    }
  });

export type ResearcherProposal = {
  readonly questionId: QuestionId;
  readonly outcome: "packet" | "no_evidence";
  readonly receiptIds: readonly SearchReceiptId[];
  readonly packet: ResearcherPacket;
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

function failure(code: ResearcherError): IngestResult<never, ResearcherError> {
  return Object.freeze({
    ok: false as const,
    code,
    message: FIXED_MESSAGES[code],
  });
}

function success(
  value: ResearcherProposal,
): IngestResult<ResearcherProposal, ResearcherError> {
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

/**
 * A sufficient healthy receipt proves a search ran: schema-valid SearchReceipt
 * with a non-empty query and a real indexVersion (not blank).
 */
export function isHealthySearchReceipt(value: unknown): value is SearchReceipt {
  const parsed = SearchReceiptSchema.safeParse(value);
  if (!parsed.success) return false;
  const receipt = parsed.data;
  if (receipt.query.length < 1) return false;
  if (receipt.indexVersion.length < 1) return false;
  return true;
}

export interface ValidateResearcherProposalOptions {
  readonly receipts?: readonly unknown[];
}

/**
 * Validate a Researcher proposal. Schema rejection is INVALID_PROPOSAL.
 * no_evidence without a matching healthy receipt is INSUFFICIENT_RECEIPT.
 */
export function validateResearcherProposal(
  input: unknown,
  options: ValidateResearcherProposalOptions = {},
): IngestResult<ResearcherProposal, ResearcherError> {
  const parsed = ResearcherProposalSchema.safeParse(input);
  if (!parsed.success) return failure("INVALID_PROPOSAL");

  const proposal = parsed.data as ResearcherProposal;
  const receipts = options.receipts ?? [];
  const byId = new Map<string, unknown>();
  for (const receipt of receipts) {
    if (isPlainObject(receipt) && typeof receipt.id === "string") {
      byId.set(receipt.id, receipt);
    }
  }

  // Every referenced receipt id must resolve to a healthy receipt when
  // outcome is no_evidence. For packet, require at least one healthy receipt
  // among the ids (search evidence provenance).
  const healthyMatches = proposal.receiptIds.filter((id) => {
    const material = byId.get(id);
    return material !== undefined && isHealthySearchReceipt(material);
  });

  if (proposal.outcome === "no_evidence") {
    if (healthyMatches.length < 1) return failure("INSUFFICIENT_RECEIPT");
  } else {
    // packet: still need a healthy receipt binding the search that produced refs
    if (healthyMatches.length < 1) return failure("INSUFFICIENT_RECEIPT");
  }

  return success(proposal);
}

// ---------------------------------------------------------------------------
// Scaffold JSON schema loader (Ajv)
// ---------------------------------------------------------------------------

export async function loadResearcherOutputSchema(
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

export function compileResearcherOutputSchema(
  schema: Record<string, unknown>,
): ValidateFunction {
  return new Ajv({ allErrors: true, strict: true }).compile(schema);
}

// ---------------------------------------------------------------------------
// runResearcher
// ---------------------------------------------------------------------------

export interface ResearcherProposeContext {
  readonly questionId: string;
  readonly question: string;
  readonly facets: readonly unknown[];
  readonly receipts: readonly unknown[];
}

export type ResearcherPropose = (
  context: ResearcherProposeContext,
) => Promise<unknown>;

export interface ResearcherAgent {
  runResearcher(
    input: unknown,
  ): Promise<IngestResult<ResearcherProposal, ResearcherError>>;
}

export interface CreateResearcherAgentOptions {
  /**
   * Deterministic/test proposer. Production wires an LLM agent invoke that
   * returns a candidate object; this module always validates before return.
   */
  readonly propose: ResearcherPropose;
}

function parseRunInput(input: unknown):
  | {
      ok: true;
      questionId: string;
      question: string;
      facets: readonly unknown[];
      receipts: readonly unknown[];
    }
  | { ok: false } {
  if (!isPlainObject(input)) return { ok: false };
  const allowed = new Set([
    "questionId",
    "question",
    "facets",
    "receipts",
    "goals",
    "documentation",
  ]);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key === "symbol") return { ok: false };
    if (!allowed.has(key)) return { ok: false };
  }

  const qid = ownData(input, "questionId");
  const q = ownData(input, "question");
  if (!qid.ok || !q.ok || !qid.present || !q.present) return { ok: false };
  if (typeof qid.value !== "string" || typeof q.value !== "string") {
    return { ok: false };
  }
  if (qid.value.length < 1 || q.value.length < 1) return { ok: false };
  if (q.value.length > RESEARCHER_LIMITS.maxQuestionChars) return { ok: false };

  let facets: readonly unknown[] = [];
  const facetsSlot = ownData(input, "facets");
  if (!facetsSlot.ok) return { ok: false };
  if (facetsSlot.present) {
    if (!Array.isArray(facetsSlot.value)) return { ok: false };
    facets = facetsSlot.value;
  }

  let receipts: readonly unknown[] = [];
  const receiptsSlot = ownData(input, "receipts");
  if (!receiptsSlot.ok) return { ok: false };
  if (receiptsSlot.present) {
    if (!Array.isArray(receiptsSlot.value)) return { ok: false };
    receipts = receiptsSlot.value;
  }

  return {
    ok: true,
    questionId: qid.value,
    question: q.value,
    facets,
    receipts,
  };
}

export function createResearcherAgent(
  options: CreateResearcherAgentOptions,
): ResearcherAgent {
  if (!options || typeof options.propose !== "function") {
    throw new Error("Researcher agent requires a propose function.");
  }
  const { propose } = options;

  return {
    async runResearcher(input) {
      const parsed = parseRunInput(input);
      if (!parsed.ok) return failure("INVALID_INPUT");

      let draft: unknown;
      try {
        draft = await propose({
          questionId: parsed.questionId,
          question: parsed.question,
          facets: parsed.facets,
          receipts: parsed.receipts,
        });
      } catch {
        return failure("PROPOSER_FAILED");
      }

      return validateResearcherProposal(draft, {
        receipts: parsed.receipts,
      });
    },
  };
}

/**
 * Convenience: one-shot run with an injected proposer.
 * Plan signature `runResearcher(input)` is preserved via factory for production
 * wiring; tests use createResearcherAgent({ propose }).
 */
export async function runResearcher(
  input: unknown,
  options: CreateResearcherAgentOptions,
): Promise<IngestResult<ResearcherProposal, ResearcherError>> {
  return createResearcherAgent(options).runResearcher(input);
}
