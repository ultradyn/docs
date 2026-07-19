/**
 * T-60-03 — Answer citation/validity review (pure knowledge service, not an agent).
 *
 * NAIL 1: promotable is a POSITIVE WHITELIST conjunction defaulting FALSE:
 *   promotable =
 *     packSupported && revisionMatch && packHashMatch && depsCurrent
 *     && !insufficient_pack
 *
 * NAIL 3: getClaim is a LIVE re-read (B001 dual-gate). Pack snapshot may still
 * show accepted claims; validity must surface state!==accepted as staleDependencies.
 *
 * packHashMatch is separate from staleDependencies (claim ids only in stale list).
 */
import type { AnswerComposition } from "../../domain/ingest/answer-composition.js";
import type { Claim } from "../../domain/ingest/claim.js";
import type { SealedClaimPack } from "../../domain/ingest/sealed-claim-pack.js";
import type { ClaimId, GraphRevision } from "../../domain/ingest/types.js";

export type AnswerValidity = {
  readonly promotable: boolean;
  readonly packSupported: boolean;
  readonly revisionMatch: boolean;
  readonly packHashMatch: boolean;
  readonly depsCurrent: boolean;
  readonly unsupportedSentenceIds: readonly number[];
  readonly staleDependencies: readonly string[];
};

export type ReviewAnswerCompositionInput = {
  readonly composition: AnswerComposition;
  readonly pack: SealedClaimPack;
  readonly currentGraphRevision: GraphRevision;
  /** LIVE claim re-read — not the sealed pack snapshot. */
  readonly getClaim: (claimId: ClaimId) => Claim | null;
};

function collectUnsupportedSentenceIds(
  composition: AnswerComposition,
  packIds: ReadonlySet<string>,
): number[] {
  const unsupported: number[] = [];
  for (const sentence of composition.sentenceClaims) {
    for (const id of sentence.claimIds) {
      if (!packIds.has(id as string)) {
        unsupported.push(sentence.sentenceIndex);
        break;
      }
    }
  }
  return unsupported;
}

function membershipOk(
  composition: AnswerComposition,
  pack: SealedClaimPack,
  packIds: ReadonlySet<string>,
): boolean {
  for (const id of composition.claimOrder) {
    if (!packIds.has(id as string)) return false;
  }
  const packCitationKeys = new Set(
    pack.citations.map((c) => `${c.claimId as string}\0${c.unitId}`),
  );
  for (const cit of composition.citations) {
    if (!packIds.has(cit.claimId as string)) return false;
    if (!packCitationKeys.has(`${cit.claimId as string}\0${cit.unitId}`)) {
      return false;
    }
  }
  for (const g of composition.goalCoverage) {
    for (const id of g.claimIds) {
      if (!packIds.has(id as string)) return false;
    }
  }
  return true;
}

/**
 * Positive whitelist: promotable only when ALL conjuncts hold.
 * Never compute promotable as "!hasProblem".
 */
export function reviewAnswerComposition(
  input: ReviewAnswerCompositionInput,
): AnswerValidity {
  const { composition, pack, currentGraphRevision, getClaim } = input;

  const packHashMatch = composition.claimPackHash === pack.hash;

  const revisionMatch =
    composition.graphRevision === pack.graphRevision &&
    composition.graphRevision === (currentGraphRevision as number) &&
    pack.graphRevision === (currentGraphRevision as number);

  const packIds = new Set(pack.claimIds.map((id) => id as string));
  const unsupportedSentenceIds = collectUnsupportedSentenceIds(
    composition,
    packIds,
  );

  const insufficient = composition.state === "insufficient_pack";
  const packSupported =
    !insufficient &&
    unsupportedSentenceIds.length === 0 &&
    membershipOk(composition, pack, packIds);

  // LIVE getClaim re-read for every pack claim id ∪ claimOrder
  const idsToCheck = new Set<string>([
    ...pack.claimIds.map((id) => id as string),
    ...composition.claimOrder.map((id) => id as string),
  ]);
  const staleDependencies: string[] = [];
  for (const id of idsToCheck) {
    const live = getClaim(id as ClaimId);
    if (live == null) {
      staleDependencies.push(`missing:${id}`);
      continue;
    }
    if (live.state !== "accepted") {
      staleDependencies.push(id);
    }
  }
  const depsCurrent = staleDependencies.length === 0;

  // NAIL 1 — positive conjunction; default false if any conjunct fails
  const promotable =
    packSupported &&
    revisionMatch &&
    packHashMatch &&
    depsCurrent &&
    !insufficient;

  return Object.freeze({
    promotable,
    packSupported,
    revisionMatch,
    packHashMatch,
    depsCurrent,
    unsupportedSentenceIds: Object.freeze(unsupportedSentenceIds),
    staleDependencies: Object.freeze(staleDependencies),
  });
}
