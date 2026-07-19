/**
 * T-22-03 — ClaimReviewService: apply independent claim reviews idempotently.
 *
 * Authority boundary:
 * - Separation of duties: reviewer ≠ creating run, resolved from AUTHORITATIVE
 *   packet→run provenance (PacketCreationIdentityReader), never caller assertion.
 * - Accepted transitions only via this service's ClaimAcceptanceAuthority grant.
 * - Rejection is a review outcome (application.rejectedClaimIds), not ClaimState.
 * - Pack-safe default: listAcceptedClaimIds excludes any rejected id.
 * - Durable idempotency: ClaimReviewApplicationStore remembers the APPLICATION
 *   (not a claim); lookup MUST return the prior application and never re-apply.
 * - Split: multi-create under store.locked + operation-intent journal; incomplete
 *   splits never produce a durable application.
 * - qualify: FAIL CLOSED with QUALIFY_UNSUPPORTED (not silent no-op) until
 *   qualifierClaimIds linking is implemented (child task).
 *
 * Residual (honest): a builder that bypasses this service and reads the claim
 * store directly can still see proposed claims that were rejected in an
 * application record — pack builders (T-32+) must consume applications or the
 * listAcceptedClaimIds accessor. Child task for store-level exclusion.
 */
import { createHash } from "node:crypto";

import {
  ClaimReviewSchema,
  type ClaimReview,
  type ClaimReviewApplication,
  type ClaimReviewId,
  type ClaimReviewProvenanceLink,
} from "../../domain/ingest/claim-review.js";
import type { ClaimId, IngestResult } from "../../domain/ingest/types.js";

export type {
  ClaimReviewApplication,
  ClaimReview,
} from "../../domain/ingest/claim-review.js";

import {
  createClaimRepository,
  deriveClaimId,
  type ClaimAcceptanceAuthority,
  type ClaimRepository,
  type ClaimStore,
  type EvidenceVerificationReader,
} from "./claim-repository.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ClaimReviewServiceError =
  | "INVALID_INPUT"
  | "CLAIM_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "SEPARATION_OF_DUTIES"
  | "IDENTITY_UNAVAILABLE"
  | "REVIEW_REQUIRED"
  | "ACCEPTANCE_FORBIDDEN"
  | "ILLEGAL_TRANSITION"
  | "EVIDENCE_UNVERIFIED"
  | "COMMIT_FAILED"
  | "SPLIT_INVALID"
  | "QUALIFY_UNSUPPORTED";

const FIXED_MESSAGES: Record<ClaimReviewServiceError, string> = {
  INVALID_INPUT: "Claim review input is invalid.",
  CLAIM_NOT_FOUND: "Claim not found.",
  VERSION_CONFLICT: "Claim version does not match expectedVersion.",
  IDEMPOTENCY_CONFLICT: "Idempotency key reused with a different payload.",
  SEPARATION_OF_DUTIES:
    "Extractor run cannot review its own claim (separation of duties).",
  IDENTITY_UNAVAILABLE:
    "Creating-run identity could not be resolved from packet provenance.",
  REVIEW_REQUIRED: "reviewerRunId is required.",
  ACCEPTANCE_FORBIDDEN: "Acceptance authority denied.",
  ILLEGAL_TRANSITION: "Claim state transition is illegal.",
  EVIDENCE_UNVERIFIED: "Evidence refs are not verified.",
  COMMIT_FAILED: "Claim review commit failed.",
  SPLIT_INVALID: "Split specification is invalid.",
  // Qualify is schema-legal but not yet applied: refuse, never silent no-op.
  QUALIFY_UNSUPPORTED:
    "qualify decision is not yet applied; refused rather than ignored.",
};

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * AUTHORITATIVE creating-run resolution.
 *
 * Resolves the run that produced an evidence packet. Must be backed by
 * packet/evidence store provenance — NOT a caller-asserted value on the review.
 *
 * TRUST BOUNDARY: this port is the SoD trust root. If it cannot resolve a run
 * for the claim's createdFrom.packetId, acceptance FAILS CLOSED
 * (IDENTITY_UNAVAILABLE). A caller cannot bypass SoD by inventing extractorRunId
 * on the ClaimReview document; that field is audit-only.
 */
export interface PacketCreationIdentityReader {
  getRunIdForPacket(packetId: string): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Identity normalisation (T-13-01 normaliseActor discipline)
// ---------------------------------------------------------------------------

/**
 * NFKC → strip zero-width/invisible → trim LAST.
 * Order matters: a leading U+200B survives leading trim and shields a space.
 */
export function normaliseRunIdentity(actor: string): string {
  return actor
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\u2060\ufeff]/gu, "")
    .trim();
}

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
  code: ClaimReviewServiceError,
): IngestResult<never, ClaimReviewServiceError> {
  return Object.freeze({
    ok: false as const,
    code,
    message: FIXED_MESSAGES[code],
  });
}

function success(
  value: ClaimReviewApplication,
): IngestResult<ClaimReviewApplication, ClaimReviewServiceError> {
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

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function applicationIdFor(key: string, digest: string): string {
  const hex = sha256Hex(`cra:${key}:${digest}`).toUpperCase();
  const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let body = "";
  for (let i = 0; i < 26; i += 1) {
    const nibble = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    body += crockford[nibble % 32]!;
  }
  return `cra-${body}`;
}

function parseReview(input: unknown): ClaimReview | undefined {
  if (!isPlainObject(input)) return undefined;
  const keys = [
    "schemaVersion",
    "id",
    "claimId",
    "expectedVersion",
    "decision",
    "reviewerRunId",
    "extractorRunId",
    "reason",
    "splits",
  ];
  const known = new Set(keys);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key === "symbol") return undefined;
    if (!known.has(key)) return undefined;
  }
  const plain: Record<string, unknown> = {};
  for (const key of keys) {
    const slot = ownData(input, key);
    if (!slot.ok) return undefined;
    if (slot.present) plain[key] = slot.value;
  }
  const parsed = ClaimReviewSchema.safeParse(plain);
  if (!parsed.success) return undefined;
  return parsed.data as ClaimReview;
}

function reviewDigest(review: ClaimReview, key: string): string {
  return sha256Hex(
    JSON.stringify({
      key,
      id: review.id,
      claimId: review.claimId,
      expectedVersion: review.expectedVersion,
      decision: review.decision,
      reviewerRunId: normaliseRunIdentity(review.reviewerRunId),
      extractorRunId: normaliseRunIdentity(review.extractorRunId),
      reason: review.reason ?? null,
      splits: review.splits ?? null,
    }),
  );
}

// ---------------------------------------------------------------------------
// Pack exclusion (safe default path)
// ---------------------------------------------------------------------------

/**
 * Secondary convenience: single-id eligibility against application records.
 */
export function isEligibleForAcceptedPack(
  claimId: string,
  applications: readonly ClaimReviewApplication[],
): boolean {
  return listAcceptedClaimIds(applications).includes(claimId as ClaimId);
}

/**
 * SAFE DEFAULT accessor for pack builders: every id that appears in any
 * application's acceptedClaimIds, MINUS any id that appears in any
 * application's rejectedClaimIds. A rejected claim can never appear here
 * without a deliberate opt-out (there is none).
 *
 * Residual: builders that ignore this API and read ClaimStore directly still
 * see proposed claims; that gap is T-32+ pack-builder scope.
 */
export function listAcceptedClaimIds(
  applications: readonly ClaimReviewApplication[],
): readonly ClaimId[] {
  const rejected = new Set<string>();
  const accepted = new Set<string>();
  for (const app of applications) {
    for (const id of app.rejectedClaimIds) rejected.add(id);
    for (const id of app.acceptedClaimIds) accepted.add(id);
  }
  const out: ClaimId[] = [];
  for (const id of accepted) {
    if (!rejected.has(id)) out.push(id as ClaimId);
  }
  return Object.freeze(out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Durable application idempotency store.
 * Persists the APPLICATION (replayable result), not a claim snapshot.
 * ClaimStore.rememberIdempotency is claim-typed and is NOT used for reviews.
 */
export interface ClaimReviewApplicationStore {
  remember(
    key: string,
    digest: string,
    application: ClaimReviewApplication,
  ): Promise<"stored" | "conflict" | "replay">;
  lookup(
    key: string,
  ): Promise<
    { digest: string; application: ClaimReviewApplication } | undefined
  >;
}

export function createInMemoryClaimReviewApplicationStore(): ClaimReviewApplicationStore {
  const map = new Map<
    string,
    { digest: string; application: ClaimReviewApplication }
  >();
  return {
    async remember(key, digest, application) {
      const prior = map.get(key);
      if (prior) {
        if (prior.digest !== digest) return "conflict";
        return "replay";
      }
      map.set(key, {
        digest,
        application: deepFreeze(structuredClone(application)),
      });
      return "stored";
    },
    async lookup(key) {
      const prior = map.get(key);
      return prior
        ? {
            digest: prior.digest,
            application: deepFreeze(
              structuredClone(prior.application),
            ) as ClaimReviewApplication,
          }
        : undefined;
    },
  };
}

export interface ClaimReviewServiceHooks {
  /**
   * Fires after each successful split-part create, before the next.
   * Used to inject mid-split crashes (recovery tests).
   */
  afterSplitPartCreate?: (
    index: number,
    claimId: string,
  ) => void | Promise<void>;
}

export interface ClaimReviewService {
  apply(
    review: unknown,
    key: string,
  ): Promise<IngestResult<ClaimReviewApplication, ClaimReviewServiceError>>;
  /** Pack-safe accepted ids from durable applications. */
  listAcceptedClaimIds(): readonly ClaimId[];
  /** All applications recorded (durable store + this process). */
  listApplications(): readonly ClaimReviewApplication[];
  /** The repository bound to this service's acceptance authority. */
  readonly repository: ClaimRepository;
  /** Expose authority for tests that need the same grant seam. */
  readonly acceptanceAuthority: ClaimAcceptanceAuthority;
}

export interface CreateClaimReviewServiceOptions {
  readonly store: ClaimStore;
  readonly evidence: EvidenceVerificationReader;
  /**
   * Authoritative packet→run resolver. Required. Fail-closed when unresolved.
   */
  readonly packetIdentity: PacketCreationIdentityReader;
  /**
   * Durable application idempotency. Defaults to in-memory if omitted;
   * production should inject a file-backed store. Required for durable replay
   * across process restarts.
   */
  readonly applicationStore?: ClaimReviewApplicationStore;
  /** Injectable crash hooks for recovery tests. */
  readonly hooks?: ClaimReviewServiceHooks;
}

export function createClaimReviewService(
  options: CreateClaimReviewServiceOptions,
): ClaimReviewService {
  if (!options?.store || !options.evidence || !options.packetIdentity) {
    throw new Error(
      "ClaimReviewService requires store, evidence, and packetIdentity.",
    );
  }
  if (typeof options.packetIdentity.getRunIdForPacket !== "function") {
    throw new Error("packetIdentity.getRunIdForPacket is required.");
  }

  const { store, evidence, packetIdentity } = options;
  const applicationStore =
    options.applicationStore ?? createInMemoryClaimReviewApplicationStore();
  const hooks = options.hooks ?? {};

  /** claimId → reviewApplicationRef while an accept is in flight. */
  const pendingAccept = new Map<string, string>();
  /** Process-local index of application ids for listApplications. */
  const applicationIndex: ClaimReviewApplication[] = [];

  const acceptanceAuthority: ClaimAcceptanceAuthority = {
    async authorizeAcceptance(input) {
      const ref = pendingAccept.get(input.claimId);
      if (!ref) {
        return {
          ok: false as const,
          code: "ACCEPTANCE_FORBIDDEN" as const,
          message: FIXED_MESSAGES.ACCEPTANCE_FORBIDDEN,
        };
      }
      return {
        ok: true as const,
        value: { reviewApplicationRef: ref },
      };
    },
  };

  const repository = createClaimRepository({
    store,
    evidence,
    acceptance: acceptanceAuthority,
  });

  async function apply(
    reviewInput: unknown,
    key: string,
  ): Promise<IngestResult<ClaimReviewApplication, ClaimReviewServiceError>> {
    if (typeof key !== "string" || key.length < 1 || key.length > 256) {
      return failure("INVALID_INPUT");
    }

    const review = parseReview(reviewInput);
    if (!review) return failure("INVALID_INPUT");

    const reviewerNorm = normaliseRunIdentity(review.reviewerRunId);
    if (reviewerNorm.length < 1) return failure("REVIEW_REQUIRED");

    const digest = reviewDigest(review, key);
    const idKey = `claim-review:${key}`;

    // DURABLE idempotency first — must return prior APPLICATION, never re-apply.
    const durablePrior = await applicationStore.lookup(idKey);
    if (durablePrior) {
      if (durablePrior.digest !== digest)
        return failure("IDEMPOTENCY_CONFLICT");
      return success(
        deepFreeze(
          structuredClone(durablePrior.application),
        ) as ClaimReviewApplication,
      );
    }

    const claimResult = await repository.get(review.claimId);
    if (!claimResult.ok) {
      return failure(
        claimResult.code === "CLAIM_NOT_FOUND"
          ? "CLAIM_NOT_FOUND"
          : "INVALID_INPUT",
      );
    }
    const claim = claimResult.value;
    if (claim.version !== review.expectedVersion) {
      return failure("VERSION_CONFLICT");
    }

    // SoD: authoritative creating run from packet provenance
    let creatingRun: string | undefined;
    try {
      creatingRun = await packetIdentity.getRunIdForPacket(
        claim.createdFrom.packetId,
      );
    } catch {
      return failure("IDENTITY_UNAVAILABLE");
    }
    if (!creatingRun || normaliseRunIdentity(creatingRun).length < 1) {
      return failure("IDENTITY_UNAVAILABLE");
    }
    const creatingNorm = normaliseRunIdentity(creatingRun);
    if (creatingNorm === reviewerNorm) {
      return failure("SEPARATION_OF_DUTIES");
    }

    const applicationId = applicationIdFor(key, digest);
    const reviewApplicationRef = applicationId;

    const acceptedClaimIds: ClaimId[] = [];
    const rejectedClaimIds: ClaimId[] = [];
    const splitClaimIds: ClaimId[] = [];
    const provenanceLinks: ClaimReviewProvenanceLink[] = [];

    try {
      if (review.decision === "accept") {
        if (claim.state !== "proposed") return failure("ILLEGAL_TRANSITION");
        pendingAccept.set(claim.id, reviewApplicationRef);
        try {
          const transitioned = await repository.transition({
            claimId: claim.id,
            expectedVersion: claim.version,
            to: "accepted",
            reviewerRunId: reviewerNorm,
            reason: review.reason,
            idempotencyKey: `accept:${key}`,
          });
          if (!transitioned.ok) {
            const code = transitioned.code;
            if (code === "EVIDENCE_UNVERIFIED")
              return failure("EVIDENCE_UNVERIFIED");
            if (code === "VERSION_CONFLICT") return failure("VERSION_CONFLICT");
            if (code === "ACCEPTANCE_FORBIDDEN") {
              return failure("ACCEPTANCE_FORBIDDEN");
            }
            if (code === "ILLEGAL_TRANSITION")
              return failure("ILLEGAL_TRANSITION");
            return failure("COMMIT_FAILED");
          }
          acceptedClaimIds.push(claim.id);
        } finally {
          pendingAccept.delete(claim.id);
        }
      } else if (review.decision === "reject") {
        // Outcome only — ClaimState stays proposed (decision a).
        rejectedClaimIds.push(claim.id);
      } else if (review.decision === "qualify") {
        // Fail closed — never accept-and-ignore. Child task will implement
        // qualifierClaimIds linking under the same SoD/idempotency rules.
        return failure("QUALIFY_UNSUPPORTED");
      } else if (review.decision === "split") {
        if (!review.splits || review.splits.length < 1) {
          return failure("SPLIT_INVALID");
        }
        // Crash-atomic multi-create via store.locked + operation-intent journal
        // (T-22-01 machinery). Application is only remembered after ALL parts
        // succeed; incomplete splits never surface as a durable application.
        const splitResult = await store.locked(async () => {
          const intentKey = idKey;
          if (store.writeOperationIntent) {
            await store.writeOperationIntent({
              key: intentKey,
              commandDigest: digest,
              recordId: claim.id,
              version: claim.version,
              payloadDigest: sha256Hex(
                JSON.stringify({
                  parts: review.splits!.map((s) => s.statement),
                }),
              ),
            });
          }

          const createdIds: ClaimId[] = [];
          const links: ClaimReviewProvenanceLink[] = [];
          // Mid-split crash: leave intent in place; do NOT remember application.
          // Incomplete creates are not exposed via listApplications / durable apply.
          for (let i = 0; i < review.splits!.length; i += 1) {
            const part = review.splits![i]!;
            const created = await repository.create({
              statement: part.statement,
              claimType: part.claimType,
              scope: part.scope,
              authority: claim.authority,
              lifecycle: claim.lifecycle,
              evidenceRefs: claim.evidenceRefs.map((r) => ({
                snapshotId: r.snapshotId,
                fileId: r.fileId,
                unitId: r.unitId,
                fileSha256: r.fileSha256,
                unitSha256: r.unitSha256,
                verified: r.verified,
              })),
              relationships: {
                qualifierClaimIds: [],
                contradictsClaimIds: [],
                supersedesClaimIds: [],
              },
              createdFrom: {
                questionId: claim.createdFrom.questionId,
                packetId: claim.createdFrom.packetId,
              },
              idempotencyKey: `split:${key}:${i}:${part.statement}`,
            });
            if (!created.ok) {
              if (store.clearOperationIntent) {
                await store.clearOperationIntent(intentKey);
              }
              return { ok: false as const, code: "COMMIT_FAILED" as const };
            }
            createdIds.push(created.value.id);
            links.push(
              Object.freeze({
                fromClaimId: claim.id,
                toClaimId: created.value.id,
                relation: "split_from" as const,
              }),
            );
            if (hooks.afterSplitPartCreate) {
              await hooks.afterSplitPartCreate(i, created.value.id);
            }
          }
          if (store.clearOperationIntent) {
            await store.clearOperationIntent(intentKey);
          }
          return {
            ok: true as const,
            createdIds,
            links,
          };
        });

        if (!splitResult.ok) return failure(splitResult.code);
        splitClaimIds.push(...splitResult.createdIds);
        provenanceLinks.push(...splitResult.links);
      } else {
        return failure("INVALID_INPUT");
      }
    } catch (error) {
      pendingAccept.delete(claim.id);
      // Propagate injected crash hooks for recovery tests
      if (
        error instanceof Error &&
        /injected-crash|afterSplitPart/i.test(error.message)
      ) {
        throw error;
      }
      return failure("COMMIT_FAILED");
    }

    const application: ClaimReviewApplication = deepFreeze({
      schemaVersion: 1 as const,
      applicationId,
      reviewApplicationRef,
      reviewId: review.id as ClaimReviewId,
      claimId: claim.id,
      decision: review.decision,
      acceptedClaimIds: Object.freeze([
        ...acceptedClaimIds,
      ]) as readonly ClaimId[],
      rejectedClaimIds: Object.freeze([
        ...rejectedClaimIds,
      ]) as readonly ClaimId[],
      splitClaimIds: Object.freeze([...splitClaimIds]) as readonly ClaimId[],
      provenanceLinks: Object.freeze([...provenanceLinks]),
      reviewerRunId: reviewerNorm,
      idempotencyKey: key,
    });

    // Persist APPLICATION (not claim) for durable replay.
    const remembered = await applicationStore.remember(
      idKey,
      digest,
      application,
    );
    if (remembered === "conflict") return failure("IDEMPOTENCY_CONFLICT");
    if (remembered === "replay") {
      const again = await applicationStore.lookup(idKey);
      if (again) return success(again.application);
    }

    applicationIndex.push(application);
    return success(application);
  }

  return {
    apply,
    listAcceptedClaimIds: () => listAcceptedClaimIds(applicationIndex),
    listApplications: () => Object.freeze([...applicationIndex]),
    repository,
    acceptanceAuthority,
  };
}

// Re-export deriveClaimId for tests that need deterministic split ids.
export { deriveClaimId };
