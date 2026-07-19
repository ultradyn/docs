/**
 * T-22-02 — Claim relationship candidate search (pure read).
 *
 * Generates review candidates only. Never mutates claims, never writes
 * relationships, never decides merges (downstream adjudicator: T-22-03).
 *
 * Scope comparison is KEY-SET CONTAINMENT only over canonical sorted-key deep
 * equality — value ranges (e.g. ver:">=2" vs ver:"2.1") are NOT understood.
 *
 * Contradiction markers are crude English-only suspicion signals for candidates,
 * never decisions: must/must not, never/always, is/is not (and close variants).
 *
 * MiniSearch is a recall funnel only; scores come from deterministic token
 * Jaccard over normalizeAlias (NFKC + lowercase + non-alphanumeric collapse).
 *
 * Plan: docs/specs/automatic-ingestion-v3/r0-r1-implementation-plan.md L942-961.
 */
import { createHash } from "node:crypto";

import MiniSearch from "minisearch";

import { ClaimSchema, type Claim } from "../../domain/ingest/claim.js";
import type {
  ClaimId,
  IngestResult,
  Sha256,
} from "../../domain/ingest/types.js";
import { normalizeAlias } from "../retrieval/exact-map.js";

// ---------------------------------------------------------------------------
// Limits + versions
// ---------------------------------------------------------------------------

export const MATCHER_VERSION = "claim-candidates-v1" as const;

/** Absolute generation-recall floor (labeled pairs surfaced / labeled total). */
export const CLAIM_CANDIDATE_RECALL_FLOOR = 0.8 as const;

export const CLAIM_CANDIDATE_LIMITS = Object.freeze({
  maxCorpusClaims: 5_000,
  maxStatementChars: 8_000,
  maxScopeKeys: 64,
  defaultLimit: 20,
  maxLimit: 100,
  /** MiniSearch funnel bound (consideredIds). */
  maxConsidered: 200,
  funnelMultiplier: 5,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClaimCandidateRelation =
  "equivalent" | "variant" | "broader" | "narrower" | "contradiction";

export type ScopeSignal =
  "identical" | "subset" | "superset" | "overlapping" | "disjoint";

export type TypeSignal = "same" | "different";

export type ClaimCandidateError =
  | "INVALID_INPUT"
  | "CORPUS_UNAVAILABLE"
  | "CORPUS_TOO_LARGE"
  | "RECEIPT_INVALID";

export interface ClaimCandidateSignals {
  readonly text: number;
  readonly scope: ScopeSignal;
  readonly type: TypeSignal;
  readonly evidenceOverlap: number;
}

export interface ClaimCandidate {
  readonly left: ClaimId;
  readonly right: ClaimId;
  readonly relation: ClaimCandidateRelation;
  readonly signals: ClaimCandidateSignals;
  readonly score: number;
}

export type ClaimCandidateReceiptId = string & {
  readonly __brand: "ClaimCandidateReceiptId";
};

export interface ClaimCandidateReceipt {
  readonly schemaVersion: 1;
  readonly id: ClaimCandidateReceiptId;
  readonly matcherVersion: typeof MATCHER_VERSION;
  readonly corpusDigest: Sha256;
  readonly queryClaimId: ClaimId;
  readonly limit: number;
  readonly consideredIds: readonly ClaimId[];
  readonly selectedIds: readonly ClaimId[];
  readonly failures: readonly string[];
}

export interface ClaimCandidateFindResult {
  readonly candidates: readonly ClaimCandidate[];
  readonly receipt: ClaimCandidateReceipt;
}

/** Narrow read-only corpus port (satisfied by ClaimRepository.list()). */
export interface ClaimCandidateCorpusReader {
  list(): Promise<IngestResult<readonly Claim[], string>>;
}

export interface ClaimCandidateFinder {
  findClaimCandidates(
    claim: unknown,
    limit?: number,
  ): Promise<IngestResult<ClaimCandidateFindResult, ClaimCandidateError>>;
}

// ---------------------------------------------------------------------------
// Fixed messages (no interpolation of untrusted claim text)
// ---------------------------------------------------------------------------

const FIXED_MESSAGES: Record<ClaimCandidateError, string> = {
  INVALID_INPUT: "Claim candidate input is invalid.",
  CORPUS_UNAVAILABLE: "Claim corpus could not be listed.",
  CORPUS_TOO_LARGE: "Claim corpus exceeds candidate-search bounds.",
  RECEIPT_INVALID: "Claim candidate receipt could not be constructed.",
};

// Relation sort rank (lower first when scores tie)
const RELATION_RANK: ReadonlyMap<ClaimCandidateRelation, number> = new Map([
  ["equivalent", 0],
  ["contradiction", 1],
  ["broader", 2],
  ["narrower", 3],
  ["variant", 4],
]);

/**
 * Crude English-only normative polarity markers for contradiction *suspicion*.
 * Candidate-only; never a decision. Pairs are opposing forms.
 */
const POLARITY_PAIRS: readonly (readonly [RegExp, RegExp])[] = Object.freeze([
  [/\bmust\s+not\b/u, /\bmust\b/u],
  [/\bshall\s+not\b/u, /\bshall\b/u],
  [/\bnever\b/u, /\balways\b/u],
  [/\bis\s+not\b/u, /\bis\b/u],
  [/\bare\s+not\b/u, /\bare\b/u],
  [/\bdo\s+not\b/u, /\bdo\b/u],
  [/\bdoes\s+not\b/u, /\bdoes\b/u],
  [/\bcannot\b/u, /\bcan\b/u],
  [/\bmay\s+not\b/u, /\bmay\b/u],
]);

const HIGH_TEXT_FOR_CONTRADICTION = 0.55;

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
  code: ClaimCandidateError,
): IngestResult<never, ClaimCandidateError> {
  return Object.freeze({
    ok: false as const,
    code,
    message: FIXED_MESSAGES[code],
  });
}

function success(
  value: ClaimCandidateFindResult,
): IngestResult<ClaimCandidateFindResult, ClaimCandidateError> {
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

function sha256Hex(value: string): Sha256 {
  return createHash("sha256").update(value).digest("hex") as Sha256;
}

function crockfordFromHex(hex: string): ClaimCandidateReceiptId {
  const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let body = "";
  for (let index = 0; index < 26; index += 1) {
    const nibble = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    body += crockford[nibble % 32]!;
  }
  return `rcpt-${body}` as ClaimCandidateReceiptId;
}

function receiptIdFor(parts: {
  readonly matcherVersion: string;
  readonly corpusDigest: string;
  readonly queryClaimId: string;
  readonly limit: number;
  readonly consideredIds: readonly string[];
  readonly selectedIds: readonly string[];
  readonly failures: readonly string[];
}): ClaimCandidateReceiptId {
  const material = JSON.stringify({
    matcherVersion: parts.matcherVersion,
    corpusDigest: parts.corpusDigest,
    queryClaimId: parts.queryClaimId,
    limit: parts.limit,
    consideredIds: [...parts.consideredIds],
    selectedIds: [...parts.selectedIds],
    failures: [...parts.failures],
  });
  return crockfordFromHex(
    createHash("sha256").update(material).digest("hex").toUpperCase(),
  );
}

/** Parse query claim without evaluating hostile accessors mid-flight. */
function parseQueryClaim(input: unknown): Claim | undefined {
  if (!isPlainObject(input)) return undefined;
  const keys = [
    "schemaVersion",
    "id",
    "version",
    "statement",
    "claimType",
    "scope",
    "authority",
    "lifecycle",
    "state",
    "evidenceRefs",
    "relationships",
    "createdFrom",
    "reviewerRunId",
    "supersederId",
    "reason",
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
  const parsed = ClaimSchema.safeParse(plain);
  if (!parsed.success) return undefined;
  return parsed.data as Claim;
}

function parseLimit(limit: unknown): number | undefined {
  if (limit === undefined) return CLAIM_CANDIDATE_LIMITS.defaultLimit;
  if (typeof limit !== "number" || !Number.isInteger(limit)) return undefined;
  if (limit < 1 || limit > CLAIM_CANDIDATE_LIMITS.maxLimit) return undefined;
  return limit;
}

// ---------------------------------------------------------------------------
// Text similarity (deterministic; MiniSearch never feeds score)
// ---------------------------------------------------------------------------

function statementTokens(statement: string): readonly string[] {
  const normalized = normalizeAlias(statement);
  if (normalized.length === 0) return Object.freeze([]);
  return Object.freeze(normalized.split("-").filter((t) => t.length > 0));
}

function tokenSet(tokens: readonly string[]): ReadonlySet<string> {
  return new Set(tokens);
}

/** Jaccard over token sets, in [0, 1]. */
export function textSimilarity(left: string, right: string): number {
  const a = tokenSet(statementTokens(left));
  const b = tokenSet(statementTokens(right));
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Scope: key-set containment + deep equality of values for shared keys
// ---------------------------------------------------------------------------

function canonicalScopeEntries(
  scope: Readonly<Record<string, unknown>>,
): readonly (readonly [string, string])[] {
  const keys = Object.keys(scope).sort();
  return keys.map((key) => {
    let serialized: string;
    try {
      serialized = JSON.stringify(scope[key], (_k, v) =>
        typeof v === "bigint" ? String(v) : v,
      );
      if (serialized === undefined) serialized = "null";
    } catch {
      serialized = '"[unserializable]"';
    }
    return [key, serialized] as const;
  });
}

/**
 * Key-set containment over canonical (sorted-key, deep-equality) scope.
 * Does NOT interpret value ranges.
 *
 * Returns signal of `right` relative to `left`:
 * - identical: same key set + equal values
 * - subset: right keys ⊆ left keys and shared values equal
 * - superset: left keys ⊆ right keys and shared values equal
 * - overlapping: non-empty key intersection, not subset/superset, shared equal
 * - disjoint: no shared keys OR a shared key with unequal values
 */
export function compareScope(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): ScopeSignal {
  const leftEntries = canonicalScopeEntries(left);
  const rightEntries = canonicalScopeEntries(right);
  if (leftEntries.length > CLAIM_CANDIDATE_LIMITS.maxScopeKeys) {
    return "disjoint";
  }
  if (rightEntries.length > CLAIM_CANDIDATE_LIMITS.maxScopeKeys) {
    return "disjoint";
  }

  const leftMap = new Map(leftEntries);
  const rightMap = new Map(rightEntries);

  let sharedEqual = 0;
  let sharedConflict = 0;
  for (const [key, value] of leftMap) {
    if (!rightMap.has(key)) continue;
    if (rightMap.get(key) === value) sharedEqual += 1;
    else sharedConflict += 1;
  }

  if (sharedConflict > 0) return "disjoint";

  const leftOnly = leftMap.size - sharedEqual;
  const rightOnly = rightMap.size - sharedEqual;

  if (leftOnly === 0 && rightOnly === 0) return "identical";
  if (rightOnly === 0 && leftOnly > 0 && sharedEqual === rightMap.size) {
    // right ⊆ left
    return "subset";
  }
  if (leftOnly === 0 && rightOnly > 0 && sharedEqual === leftMap.size) {
    // left ⊆ right → right is superset of left
    return "superset";
  }
  if (sharedEqual > 0) return "overlapping";
  return "disjoint";
}

// ---------------------------------------------------------------------------
// Evidence Jaccard over unitSha256 (reported only; never score/relation input)
// ---------------------------------------------------------------------------

function evidenceOverlap(left: Claim, right: Claim): number {
  const a = new Set(left.evidenceRefs.map((r) => r.unitSha256));
  const b = new Set(right.evidenceRefs.map((r) => r.unitSha256));
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const h of a) {
    if (b.has(h)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Contradiction suspicion (never a decision)
// ---------------------------------------------------------------------------

function hasContradictsEdge(left: Claim, right: Claim): boolean {
  if (left.relationships.contradictsClaimIds.includes(right.id)) return true;
  if (right.relationships.contradictsClaimIds.includes(left.id)) return true;
  return false;
}

function hasOpposingPolarity(
  leftStatement: string,
  rightStatement: string,
): boolean {
  const l = leftStatement.toLowerCase();
  const r = rightStatement.toLowerCase();
  for (const [neg, pos] of POLARITY_PAIRS) {
    const leftNeg = neg.test(l);
    const rightNeg = neg.test(r);
    const leftPos = pos.test(l) && !leftNeg;
    const rightPos = pos.test(r) && !rightNeg;
    if ((leftNeg && rightPos) || (rightNeg && leftPos)) return true;
  }
  return false;
}

function isContradictionSuspicion(
  left: Claim,
  right: Claim,
  text: number,
  scope: ScopeSignal,
): boolean {
  if (hasContradictsEdge(left, right)) return true;
  if (
    text >= HIGH_TEXT_FOR_CONTRADICTION &&
    scope === "identical" &&
    hasOpposingPolarity(left.statement, right.statement)
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Relation from gates (scope + type); evidence never participates
// ---------------------------------------------------------------------------

function relationFromSignals(
  left: Claim,
  right: Claim,
  text: number,
  scope: ScopeSignal,
  type: TypeSignal,
): ClaimCandidateRelation {
  if (isContradictionSuspicion(left, right, text, scope)) {
    return "contradiction";
  }
  if (type === "different") {
    // Never equivalent when types differ
    if (scope === "subset") return "narrower";
    if (scope === "superset") return "broader";
    return "variant";
  }
  // type === same
  if (scope === "identical") {
    // equivalent requires identical scope AND same type (AC1)
    return "equivalent";
  }
  if (scope === "subset") return "narrower";
  if (scope === "superset") return "broader";
  return "variant";
}

/**
 * Score is pure text similarity (deterministic). Scope/type/evidence are
 * gates/reports only — not score terms (AC1/AC2).
 */
function scoreFromText(text: number): number {
  return text;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

function candidateOrder(a: ClaimCandidate, b: ClaimCandidate): number {
  if (a.score !== b.score) return b.score - a.score;
  const rankA = RELATION_RANK.get(a.relation) ?? 99;
  const rankB = RELATION_RANK.get(b.relation) ?? 99;
  if (rankA !== rankB) return rankA - rankB;
  if (a.left !== b.left) return a.left < b.left ? -1 : 1;
  if (a.right !== b.right) return a.right < b.right ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Corpus digest + MiniSearch funnel
// ---------------------------------------------------------------------------

function corpusDigestFor(claims: readonly Claim[]): Sha256 {
  const parts = claims
    .map((c) => `${c.id}@${c.version}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(parts.join("\n"));
}

interface IndexedClaim {
  readonly id: string;
  readonly claimId: string;
  readonly content: string;
}

function buildFunnel(
  query: Claim,
  corpus: readonly Claim[],
  consideredBound: number,
): readonly ClaimId[] {
  const others = corpus.filter((c) => c.id !== query.id);
  if (others.length === 0) return Object.freeze([]);

  // Small corpora: consider everyone (still bounds by maxConsidered)
  if (others.length <= consideredBound) {
    return Object.freeze(
      [...others.map((c) => c.id)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }

  const documents: IndexedClaim[] = others.map((c) => ({
    id: c.id,
    claimId: c.id,
    content: c.statement.slice(0, CLAIM_CANDIDATE_LIMITS.maxStatementChars),
  }));
  documents.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const mini = new MiniSearch<IndexedClaim>({
    fields: ["content", "claimId"],
    storeFields: ["claimId"],
    searchOptions: {
      boost: { claimId: 2, content: 1 },
      prefix: true,
      fuzzy: 0.2,
    },
  });
  mini.addAll(documents);

  const hits = mini.search(
    query.statement.slice(0, CLAIM_CANDIDATE_LIMITS.maxStatementChars),
    { prefix: true, fuzzy: 0.2 },
  );

  const considered: ClaimId[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const id = String(hit.id);
    if (seen.has(id)) continue;
    seen.add(id);
    considered.push(id as ClaimId);
    if (considered.length >= consideredBound) break;
  }

  // If MiniSearch under-fills (very short queries), pad deterministically by id
  if (considered.length < consideredBound) {
    const byId = [...others].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    for (const c of byId) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      considered.push(c.id);
      if (considered.length >= consideredBound) break;
    }
  }

  return Object.freeze(considered);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createClaimCandidateFinder(options: {
  readonly reader: ClaimCandidateCorpusReader;
}): ClaimCandidateFinder {
  if (!options || typeof options !== "object" || !options.reader) {
    throw new Error("Claim candidate finder requires a corpus reader.");
  }
  if (typeof options.reader.list !== "function") {
    throw new Error("Claim candidate finder requires reader.list().");
  }
  const { reader } = options;

  return {
    async findClaimCandidates(claimInput, limitInput) {
      const limit = parseLimit(limitInput);
      if (limit === undefined) return failure("INVALID_INPUT");

      const query = parseQueryClaim(claimInput);
      if (!query) return failure("INVALID_INPUT");
      if (query.statement.length > CLAIM_CANDIDATE_LIMITS.maxStatementChars) {
        return failure("INVALID_INPUT");
      }

      let listed: IngestResult<readonly Claim[], string>;
      try {
        listed = await reader.list();
      } catch {
        return failure("CORPUS_UNAVAILABLE");
      }
      if (!listed.ok) return failure("CORPUS_UNAVAILABLE");

      const corpus = listed.value;
      if (!Array.isArray(corpus)) return failure("CORPUS_UNAVAILABLE");
      if (corpus.length > CLAIM_CANDIDATE_LIMITS.maxCorpusClaims) {
        return failure("CORPUS_TOO_LARGE");
      }

      // Ensure query is visible in digest even if not listed
      const byId = new Map<string, Claim>();
      for (const c of corpus) {
        if (!c || typeof c !== "object" || typeof c.id !== "string") {
          return failure("INVALID_INPUT");
        }
        byId.set(c.id, c);
      }
      if (!byId.has(query.id)) {
        byId.set(query.id, query);
      }

      const allClaims = [...byId.values()];
      const digest = corpusDigestFor(allClaims);

      const consideredBound = Math.min(
        CLAIM_CANDIDATE_LIMITS.maxConsidered,
        Math.max(limit * CLAIM_CANDIDATE_LIMITS.funnelMultiplier, limit),
      );
      const consideredIds = buildFunnel(query, allClaims, consideredBound);

      const failures: string[] = [];
      const candidates: ClaimCandidate[] = [];

      for (const rightId of consideredIds) {
        const right = byId.get(rightId);
        if (!right) {
          failures.push("MISSING_CLAIM");
          continue;
        }
        if (right.id === query.id) continue;

        const text = textSimilarity(query.statement, right.statement);
        const scope = compareScope(query.scope, right.scope);
        const type: TypeSignal =
          query.claimType === right.claimType ? "same" : "different";
        const overlap = evidenceOverlap(query, right);
        const relation = relationFromSignals(query, right, text, scope, type);
        const score = scoreFromText(text);

        candidates.push(
          Object.freeze({
            left: query.id,
            right: right.id,
            relation,
            signals: Object.freeze({
              text,
              scope,
              type,
              evidenceOverlap: overlap,
            }),
            score,
          }),
        );
      }

      candidates.sort(candidateOrder);
      const selected = candidates.slice(0, limit);
      const selectedIds = Object.freeze(
        selected.map((c) => c.right),
      ) as readonly ClaimId[];

      const sortedConsidered = Object.freeze(
        [...consideredIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      const sortedFailures = Object.freeze([...failures].sort());

      const receipt: ClaimCandidateReceipt = {
        schemaVersion: 1,
        id: receiptIdFor({
          matcherVersion: MATCHER_VERSION,
          corpusDigest: digest,
          queryClaimId: query.id,
          limit,
          consideredIds: [...sortedConsidered],
          selectedIds: [...selectedIds],
          failures: [...sortedFailures],
        }),
        matcherVersion: MATCHER_VERSION,
        corpusDigest: digest,
        queryClaimId: query.id,
        limit,
        consideredIds: sortedConsidered,
        selectedIds,
        failures: sortedFailures,
      };

      return success({
        candidates: Object.freeze(selected),
        receipt,
      });
    },
  };
}
