/**
 * T004 — Apply validated Claim Extractor proposals via ClaimRepository.create.
 *
 * HONESTY (binding):
 * - ID minting: REUSE deriveClaimId(questionId, packetId, statement) only —
 *   pure over content; no wall-clock, no random. Statement-only identity is
 *   ClaimRepository behaviour; apply inherits deliberately (widening the hash
 *   is a repository change, not this task).
 * - Intra-batch id collision (same statement text → same id): whole-batch
 *   refuse BEFORE any write (ID_COLLISION) — never silently collapse two
 *   proposals into one durable claim.
 * - Evidence: unitIds only, mapped from authoritative packet references.
 *   Never accept agent full evidenceRef shapes — apply never reads an
 *   evidenceRefs field from proposals.
 * - candidateRelationships: free strings at proposal time; apply re-resolves
 *   against list() ∪ batch-derived ids, DROPS unknown targets, and REPORTS
 *   them on the success result (not silent).
 * - State stays proposed; only ClaimRepository.create; no accept/transition.
 * - Whole-batch fail-closed on unsupported evidence; assert store absence.
 */
import { createHash } from "node:crypto";

import {
  ClaimIdSchema,
  type Claim,
  type ClaimEvidenceRef,
  type ClaimId,
  type ClaimRelationships,
} from "../../domain/ingest/claim.js";
import {
  EvidencePacketSchema,
  type EvidencePacket,
} from "../../domain/ingest/evidence-packet.js";
import type { IngestResult } from "../../domain/ingest/types.js";

import {
  validateClaimExtractorProposal,
  type ClaimProposal,
} from "../agents/claim-extractor-agent.js";
import {
  deriveClaimId,
  type ClaimRepository,
} from "./claim-repository.js";

export type ApplyClaimProposalsError =
  | "INVALID_INPUT"
  | "VERDICT_NOT_ACCEPTED"
  | "INVALID_PROPOSAL"
  | "UNSUPPORTED_EVIDENCE"
  | "ID_COLLISION"
  | "IDEMPOTENCY_CONFLICT"
  | "COMMIT_FAILED";

export type ApplyClaimProposalsSuccess = {
  readonly claimIds: readonly ClaimId[];
  readonly claims: readonly Claim[];
  /** Relationship target ids that were candidates but not authoritative. */
  readonly droppedRelationshipTargets: readonly string[];
};

export type ApplyClaimProposalsInput = {
  readonly questionId: string;
  readonly packet: unknown;
  readonly verdictAccepted: boolean;
  readonly proposals: unknown;
  readonly repository: ClaimRepository;
};

const FIXED: Record<ApplyClaimProposalsError, string> = {
  INVALID_INPUT: "Apply claim proposals input is invalid.",
  VERDICT_NOT_ACCEPTED: "Claim apply requires an accepted evidence verdict.",
  INVALID_PROPOSAL: "Claim proposals failed validation.",
  UNSUPPORTED_EVIDENCE:
    "A claim references evidence not present in the accepted packet.",
  ID_COLLISION:
    "Two proposals in the batch derive the same claim id (same statement text).",
  IDEMPOTENCY_CONFLICT:
    "An existing claim id was re-applied with different content.",
  COMMIT_FAILED: "Claim apply could not commit durable claims.",
};

function fail(
  code: ApplyClaimProposalsError,
): IngestResult<never, ApplyClaimProposalsError> {
  return Object.freeze({ ok: false as const, code, message: FIXED[code] });
}

function ok(
  value: ApplyClaimProposalsSuccess,
): IngestResult<ApplyClaimProposalsSuccess, ApplyClaimProposalsError> {
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

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Map unitIds → full evidence refs from the packet only (structural). */
function mapEvidenceRefs(
  proposal: ClaimProposal,
  packet: EvidencePacket,
): ClaimEvidenceRef[] | undefined {
  const byUnit = new Map(
    packet.references.map((ref) => [ref.unitId as string, ref] as const),
  );
  const out: ClaimEvidenceRef[] = [];
  for (const unitId of proposal.evidenceReferenceIds) {
    const ref = byUnit.get(unitId as string);
    if (!ref) return undefined;
    out.push({
      snapshotId: ref.snapshotId,
      fileId: ref.fileId,
      unitId: ref.unitId,
      fileSha256: ref.fileSha256,
      unitSha256: ref.unitSha256,
    });
  }
  return out;
}

function resolveRelationships(
  candidates: ClaimProposal["candidateRelationships"],
  authoritative: ReadonlySet<string>,
): { relationships: ClaimRelationships; dropped: string[] } {
  const dropped: string[] = [];
  const pick = (ids: readonly string[] | undefined): ClaimId[] => {
    const kept: ClaimId[] = [];
    for (const raw of ids ?? []) {
      const parsed = ClaimIdSchema.safeParse(raw);
      if (parsed.success && authoritative.has(parsed.data)) {
        kept.push(parsed.data);
      } else {
        dropped.push(raw);
      }
    }
    return kept;
  };
  return {
    relationships: {
      qualifierClaimIds: pick(candidates.qualifierClaimIds),
      contradictsClaimIds: pick(candidates.contradictsClaimIds),
      supersedesClaimIds: pick(candidates.supersedesClaimIds),
    },
    dropped,
  };
}

function sameEssentialContent(
  existing: Claim,
  expected: {
    statement: string;
    claimType: string;
    scope: Readonly<Record<string, string>>;
    authority: string;
    lifecycle: string;
    evidenceRefs: readonly ClaimEvidenceRef[];
    relationships: ClaimRelationships;
  },
): boolean {
  if (existing.statement !== expected.statement) return false;
  if (existing.claimType !== expected.claimType) return false;
  if (existing.authority !== expected.authority) return false;
  if (existing.lifecycle !== expected.lifecycle) return false;
  if (JSON.stringify(existing.scope) !== JSON.stringify(expected.scope)) {
    return false;
  }
  const unitSet = (refs: readonly ClaimEvidenceRef[]) =>
    [...refs.map((r) => `${r.unitId}:${r.unitSha256}`)].sort().join("|");
  if (unitSet(existing.evidenceRefs) !== unitSet(expected.evidenceRefs)) {
    return false;
  }
  const relKey = (r: ClaimRelationships) =>
    JSON.stringify({
      q: [...r.qualifierClaimIds].sort(),
      c: [...r.contradictsClaimIds].sort(),
      s: [...r.supersedesClaimIds].sort(),
    });
  return relKey(existing.relationships) === relKey(expected.relationships);
}

function canonicalClaimKey(proposal: ClaimProposal, packetId: string): string {
  return sha256Hex(
    JSON.stringify({
      packetId,
      text: proposal.text,
      type: proposal.type,
      scope: proposal.scope,
      authority: proposal.authority,
      lifecycle: proposal.lifecycle,
      evidenceReferenceIds: proposal.evidenceReferenceIds,
      candidateRelationships: proposal.candidateRelationships,
    }),
  );
}

export async function applyClaimProposals(
  input: ApplyClaimProposalsInput,
): Promise<
  IngestResult<ApplyClaimProposalsSuccess, ApplyClaimProposalsError>
> {
  if (
    input == null ||
    typeof input !== "object" ||
    typeof input.questionId !== "string" ||
    input.questionId.length === 0 ||
    input.repository == null ||
    typeof input.repository.create !== "function"
  ) {
    return fail("INVALID_INPUT");
  }

  // Reuse T-32-01 fabrication gate — do not reimplement.
  const validated = validateClaimExtractorProposal(input.proposals, {
    packet: input.packet,
    verdictAccepted: input.verdictAccepted,
  });
  if (!validated.ok) {
    if (validated.code === "VERDICT_NOT_ACCEPTED") {
      return fail("VERDICT_NOT_ACCEPTED");
    }
    if (validated.code === "UNSUPPORTED_EVIDENCE") {
      return fail("UNSUPPORTED_EVIDENCE");
    }
    if (validated.code === "INVALID_INPUT") {
      return fail("INVALID_INPUT");
    }
    return fail("INVALID_PROPOSAL");
  }

  const packetParsed = EvidencePacketSchema.safeParse(input.packet);
  if (!packetParsed.success) {
    return fail("INVALID_INPUT");
  }
  const packet = packetParsed.data;
  const proposals = validated.value;

  // Pre-map ALL evidence before any write.
  const mapped: Array<{
    proposal: ClaimProposal;
    evidenceRefs: ClaimEvidenceRef[];
    claimId: ClaimId;
  }> = [];
  const seenIds = new Map<string, string>(); // claimId → first statement
  for (const proposal of proposals) {
    const evidenceRefs = mapEvidenceRefs(proposal, packet);
    if (!evidenceRefs) {
      return fail("UNSUPPORTED_EVIDENCE");
    }
    const claimId = deriveClaimId(
      input.questionId,
      packet.id,
      proposal.text,
    );
    if (seenIds.has(claimId)) {
      return fail("ID_COLLISION");
    }
    seenIds.set(claimId, proposal.text);
    mapped.push({ proposal, evidenceRefs, claimId });
  }

  // Authoritative relationship targets: existing store ∪ batch-derived ids.
  const listed = await input.repository.list();
  if (!listed.ok) {
    return fail("COMMIT_FAILED");
  }
  const authoritative = new Set<string>([
    ...listed.value.map((c) => c.id as string),
    ...mapped.map((m) => m.claimId as string),
  ]);

  const allDropped: string[] = [];
  const prepared: Array<{
    claimId: ClaimId;
    proposal: ClaimProposal;
    evidenceRefs: ClaimEvidenceRef[];
    relationships: ClaimRelationships;
  }> = [];
  for (const row of mapped) {
    const { relationships, dropped } = resolveRelationships(
      row.proposal.candidateRelationships,
      authoritative,
    );
    allDropped.push(...dropped);
    prepared.push({
      claimId: row.claimId,
      proposal: row.proposal,
      evidenceRefs: row.evidenceRefs,
      relationships,
    });
  }

  // Stable unique dropped list.
  const droppedRelationshipTargets = Object.freeze(
    [...new Set(allDropped)].sort(),
  );

  const claims: Claim[] = [];
  const claimIds: ClaimId[] = [];

  for (const row of prepared) {
    const existing = await input.repository.get(row.claimId);
    if (existing.ok) {
      if (
        !sameEssentialContent(existing.value, {
          statement: row.proposal.text,
          claimType: row.proposal.type,
          scope: row.proposal.scope,
          authority: row.proposal.authority,
          lifecycle: row.proposal.lifecycle,
          evidenceRefs: row.evidenceRefs,
          relationships: row.relationships,
        })
      ) {
        return fail("IDEMPOTENCY_CONFLICT");
      }
      claims.push(existing.value);
      claimIds.push(existing.value.id);
      continue;
    }

    const idempotencyKey = `apply:${packet.id}:${canonicalClaimKey(row.proposal, packet.id)}`;
    const created = await input.repository.create({
      statement: row.proposal.text,
      claimType: row.proposal.type,
      scope: { ...row.proposal.scope },
      authority: row.proposal.authority,
      lifecycle: row.proposal.lifecycle,
      evidenceRefs: row.evidenceRefs.map((r) => ({ ...r })),
      relationships: {
        qualifierClaimIds: [...row.relationships.qualifierClaimIds],
        contradictsClaimIds: [...row.relationships.contradictsClaimIds],
        supersedesClaimIds: [...row.relationships.supersedesClaimIds],
      },
      createdFrom: {
        questionId: input.questionId,
        packetId: packet.id,
      },
      idempotencyKey,
    });
    if (!created.ok) {
      // Re-get: create may have raced to OVERWRITE_DENIED with same content.
      const again = await input.repository.get(row.claimId);
      if (
        again.ok &&
        sameEssentialContent(again.value, {
          statement: row.proposal.text,
          claimType: row.proposal.type,
          scope: row.proposal.scope,
          authority: row.proposal.authority,
          lifecycle: row.proposal.lifecycle,
          evidenceRefs: row.evidenceRefs,
          relationships: row.relationships,
        })
      ) {
        claims.push(again.value);
        claimIds.push(again.value.id);
        continue;
      }
      return fail("COMMIT_FAILED");
    }
    claims.push(created.value);
    claimIds.push(created.value.id);
  }

  return ok(
    deepFreeze({
      claimIds,
      claims,
      droppedRelationshipTargets,
    }),
  );
}
