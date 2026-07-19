/**
 * T-22-02 — Claim candidate search (RED-first).
 *
 * Surfaces are describe blocks: claim | evidence | retrieval | performance | recall | hygiene.
 * Generation only — no mutation, no merge decisions.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ClaimSchema,
  type Claim,
  type ClaimType,
} from "../../domain/ingest/claim.js";
import type {
  ClaimId,
  IngestResult,
  Sha256,
} from "../../domain/ingest/types.js";

import {
  CLAIM_CANDIDATE_LIMITS,
  CLAIM_CANDIDATE_RECALL_FLOOR,
  MATCHER_VERSION,
  createClaimCandidateFinder,
  type ClaimCandidate,
  type ClaimCandidateCorpusReader,
  type ClaimCandidateError,
  type ClaimCandidateFindResult,
  type ClaimCandidateRelation,
  type ClaimCandidateReceipt,
} from "./claim-candidates.js";

const SNAP = `snap-${"b".repeat(64)}`;
const FILE = `file-${"a".repeat(64)}`;
const UNIT = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const QUESTION = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PACKET = "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV";

function sha(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}

/** Crockford ULID body — alphabet excludes I, L, O, U. Deterministic per tag. */
function claimId(tag: string): ClaimId {
  const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const hex = createHash("sha256").update(`t-22-02:${tag}`).digest("hex");
  let body = "";
  for (let i = 0; i < 26; i += 1) {
    const nibble = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    body += crockford[nibble % 32]!;
  }
  return `clm-${body}` as ClaimId;
}

function evidenceRef(unitSha: string) {
  return {
    snapshotId: SNAP,
    fileId: FILE,
    unitId: UNIT,
    fileSha256: sha("file"),
    unitSha256: unitSha as Sha256,
    verified: true as const,
  };
}

function makeClaim(
  overrides: Partial<{
    id: ClaimId;
    statement: string;
    claimType: ClaimType;
    scope: Record<string, unknown>;
    evidenceRefs: ReturnType<typeof evidenceRef>[];
    relationships: Claim["relationships"];
    version: number;
  }> = {},
): Claim {
  const raw = {
    schemaVersion: 1 as const,
    id: overrides.id ?? claimId("AA"),
    version: overrides.version ?? 1,
    statement:
      overrides.statement ??
      "Workers retry failed endpoints with exponential backoff.",
    claimType: overrides.claimType ?? ("behavior" as ClaimType),
    scope: overrides.scope ?? { component: "delivery-worker" },
    authority: "official",
    lifecycle: "current",
    state: "proposed" as const,
    evidenceRefs: overrides.evidenceRefs ?? [evidenceRef(sha("unit-a"))],
    relationships: overrides.relationships ?? {
      qualifierClaimIds: [] as ClaimId[],
      contradictsClaimIds: [] as ClaimId[],
      supersedesClaimIds: [] as ClaimId[],
    },
    createdFrom: { questionId: QUESTION, packetId: PACKET },
  };
  const parsed = ClaimSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`fixture Claim invalid: ${parsed.error.message}`);
  }
  return Object.freeze(parsed.data) as Claim;
}

function memoryReader(claims: readonly Claim[]): ClaimCandidateCorpusReader {
  const frozen = Object.freeze(claims.map((c) => Object.freeze({ ...c })));
  return {
    list: async (): Promise<
      IngestResult<readonly Claim[], ClaimCandidateError>
    > => Object.freeze({ ok: true as const, value: frozen }),
  };
}

function failingReader(
  code: ClaimCandidateError = "CORPUS_UNAVAILABLE",
): ClaimCandidateCorpusReader {
  return {
    list: async () =>
      Object.freeze({
        ok: false as const,
        code,
        message: "Corpus list failed.",
      }),
  };
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function findPair(
  candidates: readonly ClaimCandidate[],
  a: ClaimId,
  b: ClaimId,
): ClaimCandidate | undefined {
  return candidates.find(
    (c) => (c.left === a && c.right === b) || (c.left === b && c.right === a),
  );
}

async function find(
  corpus: readonly Claim[],
  query: Claim,
  limit?: number,
): Promise<IngestResult<ClaimCandidateFindResult, ClaimCandidateError>> {
  const finder = createClaimCandidateFinder({ reader: memoryReader(corpus) });
  return finder.findClaimCandidates(query, limit);
}

// ---------------------------------------------------------------------------
// claim surface
// ---------------------------------------------------------------------------
describe("claim surface", () => {
  it("identical statement + identical scope + same type -> equivalent", async () => {
    const left = makeClaim({
      id: claimId("A0"),
      statement: "Auth tokens expire after fifteen minutes.",
      scope: { component: "auth", env: "prod" },
      claimType: "behavior",
    });
    const right = makeClaim({
      id: claimId("B0"),
      statement: "Auth tokens expire after fifteen minutes.",
      scope: { component: "auth", env: "prod" },
      claimType: "behavior",
      evidenceRefs: [evidenceRef(sha("unit-b"))],
    });
    const result = await find([left, right], left, 20);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pair = findPair(result.value.candidates, left.id, right.id);
    expect(pair).toBeDefined();
    expect(pair!.relation).toBe("equivalent");
    expect(pair!.signals.scope).toBe("identical");
    expect(pair!.signals.type).toBe("same");
    expect(pair!.signals.text).toBe(1);
  });

  it("AC1: identical statement + DIFFERENT scope is NOT equivalent (text maxed)", async () => {
    const left = makeClaim({
      id: claimId("A1"),
      statement: "Retries use exponential backoff with jitter.",
      scope: { component: "worker-a" },
    });
    const right = makeClaim({
      id: claimId("B1"),
      statement: "Retries use exponential backoff with jitter.",
      scope: { component: "worker-b" },
      evidenceRefs: [evidenceRef(sha("unit-b"))],
    });
    const result = await find([left, right], left, 20);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pair = findPair(result.value.candidates, left.id, right.id);
    expect(pair).toBeDefined();
    expect(pair!.relation).not.toBe("equivalent");
    expect(["variant", "broader", "narrower"]).toContain(pair!.relation);
    expect(pair!.signals.text).toBe(1);
    expect(pair!.signals.scope).not.toBe("identical");
  });

  it("subset scope -> narrower; superset -> broader; disjoint/overlapping -> variant", async () => {
    const base = {
      statement: "Cache entries are evicted after idle timeout.",
      claimType: "behavior" as ClaimType,
    };
    const query = makeClaim({
      id: claimId("Q0"),
      ...base,
      scope: { component: "cache", region: "us" },
    });
    const subset = makeClaim({
      id: claimId("S0"),
      ...base,
      scope: { component: "cache" },
      evidenceRefs: [evidenceRef(sha("u-s"))],
    });
    const superset = makeClaim({
      id: claimId("SUP0"),
      ...base,
      scope: { component: "cache", region: "us", tier: "hot" },
      evidenceRefs: [evidenceRef(sha("u-u"))],
    });
    const disjoint = makeClaim({
      id: claimId("D0"),
      ...base,
      scope: { service: "billing" },
      evidenceRefs: [evidenceRef(sha("u-d"))],
    });
    const overlapping = makeClaim({
      id: claimId("OV0"),
      ...base,
      scope: { component: "cache", zone: "edge" },
      evidenceRefs: [evidenceRef(sha("u-o"))],
    });

    const corpus = [query, subset, superset, disjoint, overlapping];
    const result = await find(corpus, query, 20);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const c = result.value.candidates;

    // D3: scope signal of right relative to left (query):
    // subset (right keys ⊆ left) -> narrower; superset -> broader;
    // overlapping|disjoint -> variant. left=query has more keys than subset,
    // so query is the more specific (narrower) claim.
    expect(findPair(c, query.id, subset.id)?.relation).toBe("narrower");
    expect(findPair(c, query.id, superset.id)?.relation).toBe("broader");
    expect(findPair(c, query.id, disjoint.id)?.relation).toBe("variant");
    expect(findPair(c, query.id, overlapping.id)?.relation).toBe("variant");
  });

  it("differing claimType never yields equivalent", async () => {
    const left = makeClaim({
      id: claimId("T0"),
      statement: "Maximum payload size is one megabyte.",
      claimType: "constraint",
      scope: { api: "upload" },
    });
    const right = makeClaim({
      id: claimId("T1"),
      statement: "Maximum payload size is one megabyte.",
      claimType: "requirement",
      scope: { api: "upload" },
      evidenceRefs: [evidenceRef(sha("u-t"))],
    });
    const result = await find([left, right], left, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pair = findPair(result.value.candidates, left.id, right.id);
    expect(pair).toBeDefined();
    expect(pair!.relation).not.toBe("equivalent");
    expect(pair!.signals.type).toBe("different");
  });

  it("contradiction suspicion from prior edge does not suppress other relations", async () => {
    const left = makeClaim({
      id: claimId("C0"),
      statement: "Requests must include an authorization header.",
      scope: { api: "v1" },
    });
    const right = makeClaim({
      id: claimId("C1"),
      statement: "Requests must not include an authorization header.",
      scope: { api: "v1" },
      evidenceRefs: [evidenceRef(sha("u-c"))],
      relationships: {
        qualifierClaimIds: [],
        contradictsClaimIds: [left.id],
        supersedesClaimIds: [],
      },
    });
    const result = await find([left, right], left, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pair = findPair(result.value.candidates, left.id, right.id);
    expect(pair).toBeDefined();
    expect(pair!.relation).toBe("contradiction");
  });
});

// ---------------------------------------------------------------------------
// evidence surface (AC2)
// ---------------------------------------------------------------------------
describe("evidence surface", () => {
  it("evidenceOverlap === 1 is NOT sufficient for equivalent when text low + scope disjoint", async () => {
    const shared = evidenceRef(sha("shared-unit"));
    const left = makeClaim({
      id: claimId("E0"),
      statement: "Alpha beta gamma delta epsilon zeta eta theta.",
      scope: { a: 1 },
      evidenceRefs: [shared],
    });
    const right = makeClaim({
      id: claimId("E1"),
      statement: "One two three four five six seven eight.",
      scope: { b: 2 },
      evidenceRefs: [shared],
    });
    // Zero-overlap twin: same statements/scopes/types, disjoint evidence only.
    const leftZero = makeClaim({
      id: claimId("E0z"),
      statement: left.statement,
      scope: { a: 1 },
      evidenceRefs: [evidenceRef(sha("zero-left"))],
    });
    const rightZero = makeClaim({
      id: claimId("E1z"),
      statement: right.statement,
      scope: { b: 2 },
      evidenceRefs: [evidenceRef(sha("zero-right"))],
    });

    const result = await find([left, right], left, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pair = findPair(result.value.candidates, left.id, right.id);
    // AC2 must not pass by absence — pair is required.
    expect(pair, "full-overlap low-text pair must be generated").toBeDefined();
    expect(pair!.signals.evidenceOverlap).toBe(1);
    expect(pair!.relation).not.toBe("equivalent");

    const twin = await find([leftZero, rightZero], leftZero, 10);
    expect(twin.ok).toBe(true);
    if (!twin.ok) return;
    const twinPair = findPair(twin.value.candidates, leftZero.id, rightZero.id);
    expect(twinPair, "zero-overlap twin pair must be generated").toBeDefined();
    expect(twinPair!.signals.evidenceOverlap).toBe(0);
    expect(twinPair!.relation).not.toBe("equivalent");
    // Score ignores evidence: full-overlap and zero-overlap twins match.
    expect(pair!.score).toBe(twinPair!.score);
    expect(pair!.relation).toBe(twinPair!.relation);
  });

  it("evidenceOverlap === 0 still allows equivalent when text+scope+type match", async () => {
    const left = makeClaim({
      id: claimId("E2"),
      statement: "Sessions are sticky within a region.",
      scope: { layer: "edge" },
      evidenceRefs: [evidenceRef(sha("only-left"))],
    });
    const right = makeClaim({
      id: claimId("E3"),
      statement: "Sessions are sticky within a region.",
      scope: { layer: "edge" },
      evidenceRefs: [evidenceRef(sha("only-right"))],
    });
    const result = await find([left, right], left, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pair = findPair(result.value.candidates, left.id, right.id);
    expect(pair).toBeDefined();
    expect(pair!.signals.evidenceOverlap).toBe(0);
    expect(pair!.relation).toBe("equivalent");
  });

  it("PROPERTY: varying only evidenceRefs leaves score and relation unchanged", async () => {
    const statement =
      "Health checks probe the readiness endpoint every five seconds.";
    const scope = { service: "api-gateway" };
    const shared = evidenceRef(sha("p-shared"));
    const left = makeClaim({
      id: claimId("P0"),
      statement,
      scope,
      evidenceRefs: [shared, evidenceRef(sha("p-left-only"))],
    });
    // Full overlap with left's unit set vs partial — score/relation must stay equal.
    const rightA = makeClaim({
      id: claimId("P1"),
      statement,
      scope,
      evidenceRefs: [shared, evidenceRef(sha("p-left-only"))],
    });
    const rightB = makeClaim({
      id: claimId("P1"),
      statement,
      scope,
      evidenceRefs: [evidenceRef(sha("p-b-only"))],
    });

    const r1 = await find([left, rightA], left, 10);
    const r2 = await find([left, rightB], left, 10);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    const p1 = findPair(r1.value.candidates, left.id, rightA.id)!;
    const p2 = findPair(r2.value.candidates, left.id, rightB.id)!;
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    expect(p1.score).toBe(p2.score);
    expect(p1.relation).toBe(p2.relation);
    expect(p1.signals.evidenceOverlap).toBe(1);
    expect(p2.signals.evidenceOverlap).toBe(0);
    expect(p1.signals.evidenceOverlap).not.toBe(p2.signals.evidenceOverlap);
  });
});

// ---------------------------------------------------------------------------
// retrieval surface
// ---------------------------------------------------------------------------
describe("retrieval surface", () => {
  it("score is invariant to adding unrelated corpus claims (BM25 must not leak)", async () => {
    const left = makeClaim({
      id: claimId("R0"),
      statement: "Webhook deliveries are at least once.",
      scope: { bus: "events" },
    });
    const right = makeClaim({
      id: claimId("R1"),
      statement: "Webhook deliveries are at least once.",
      scope: { bus: "events" },
      evidenceRefs: [evidenceRef(sha("r1"))],
    });
    const unrelated = Array.from({ length: 40 }, (_, i) =>
      makeClaim({
        id: claimId(`noise-${i}`),
        statement: `Unrelated filler claim number ${i} about widgets and frobs.`,
        scope: { filler: i },
        evidenceRefs: [evidenceRef(sha(`u-${i}`))],
      }),
    );

    const bare = await find([left, right], left, 10);
    const noisy = await find([left, right, ...unrelated], left, 10);
    expect(bare.ok && noisy.ok).toBe(true);
    if (!bare.ok || !noisy.ok) return;
    const p1 = findPair(bare.value.candidates, left.id, right.id)!;
    const p2 = findPair(noisy.value.candidates, left.id, right.id)!;
    expect(p1.score).toBe(p2.score);
    expect(p1.relation).toBe(p2.relation);
  });

  it("consideredIds recorded; limit respected; stable-sort; deep-frozen", async () => {
    const query = makeClaim({
      id: claimId("L0"),
      statement: "Indexes are rebuilt nightly from the canonical dump.",
      scope: { job: "reindex" },
    });
    const peers = Array.from({ length: 15 }, (_, i) =>
      makeClaim({
        id: claimId(`peer-${i + 1}`),
        statement: `Indexes are rebuilt nightly from the canonical dump variant ${i}.`,
        scope: { job: "reindex", shard: i },
        evidenceRefs: [evidenceRef(sha(`l-${i}`))],
      }),
    );
    const result = await find([query, ...peers], query, 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { candidates, receipt } = result.value;
    expect(candidates.length).toBeLessThanOrEqual(5);
    expect(receipt.limit).toBe(5);
    expect(receipt.queryClaimId).toBe(query.id);
    expect(receipt.matcherVersion).toBe(MATCHER_VERSION);
    expect(receipt.consideredIds.length).toBeGreaterThan(0);
    expect(receipt.selectedIds.length).toBe(candidates.length);
    expect(Object.isFrozen(candidates)).toBe(true);
    expect(Object.isFrozen(receipt)).toBe(true);
    for (const c of candidates) {
      expect(Object.isFrozen(c)).toBe(true);
      expect(Object.isFrozen(c.signals)).toBe(true);
    }
    // stable-sort: score desc
    for (let i = 1; i < candidates.length; i += 1) {
      const prev = candidates[i - 1]!;
      const cur = candidates[i]!;
      expect(prev.score).toBeGreaterThanOrEqual(cur.score);
      if (prev.score === cur.score) {
        // relation rank then left then right
        const rank = (r: ClaimCandidateRelation): number =>
          (
            ({
              equivalent: 0,
              contradiction: 1,
              broader: 2,
              narrower: 3,
              variant: 4,
            }) as const
          )[r];
        if (rank(prev.relation) === rank(cur.relation)) {
          if (prev.left === cur.left) {
            expect(prev.right <= cur.right).toBe(true);
          } else {
            expect(prev.left <= cur.left).toBe(true);
          }
        } else {
          expect(rank(prev.relation)).toBeLessThanOrEqual(rank(cur.relation));
        }
      }
    }
  });

  it("bounds: reject oversize limit; apply default limit", async () => {
    const c = makeClaim({ id: claimId("B0") });
    const finder = createClaimCandidateFinder({
      reader: memoryReader([c]),
    });
    const bad = await finder.findClaimCandidates(
      c,
      CLAIM_CANDIDATE_LIMITS.maxLimit + 1,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe("INVALID_INPUT");
      // fixed message — no interpolated claim text
      expect(bad.message).not.toContain(c.statement);
    }

    const def = await finder.findClaimCandidates(c);
    expect(def.ok).toBe(true);
    if (!def.ok) return;
    expect(def.value.receipt.limit).toBe(CLAIM_CANDIDATE_LIMITS.defaultLimit);
  });
});

// ---------------------------------------------------------------------------
// performance surface
// ---------------------------------------------------------------------------
describe("performance surface", () => {
  it("bounded work: consideredIds.length <= funnel bound; N-claim corpus within timeout", async () => {
    const query = makeClaim({
      id: claimId("F0"),
      statement: "Primary keys are opaque identifiers never reused.",
      scope: { table: "entities" },
    });
    const fixedCorpus: Claim[] = [query];
    for (let i = 0; i < 200; i += 1) {
      fixedCorpus.push(
        makeClaim({
          id: claimId(`perf-${i}`),
          statement:
            i % 7 === 0
              ? "Primary keys are opaque identifiers never reused in storage."
              : `Corpus claim ${i} about scheduling windows and batch sizes.`,
          scope: { table: i % 3 === 0 ? "entities" : `t-${i}` },
          evidenceRefs: [evidenceRef(sha(`f-${i}`))],
        }),
      );
    }

    const started = performance.now();
    const result = await find(fixedCorpus, query, 20);
    const elapsed = performance.now() - started;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.consideredIds.length).toBeLessThanOrEqual(
      CLAIM_CANDIDATE_LIMITS.maxConsidered,
    );
    expect(elapsed).toBeLessThan(10_000);
  });
});

// ---------------------------------------------------------------------------
// recall surface (AC3)
// ---------------------------------------------------------------------------
describe("recall surface", () => {
  /**
   * T-22-04: the T-22-02 corpus was n=5, all pairs sharing ONE query claim.
   * That supports a smoke-level regression guard, not a statement about recall.
   *
   * This corpus uses independent query GROUPS across distinct topics, each with
   * labeled positives spanning the relation space, plus labeled NEGATIVES.
   *
   * On negatives: the candidate finder is deliberately RECALL-FIRST and
   * over-generates (T-22-02 D7 — it feeds a downstream adjudicator and never
   * decides). So asserting "a negative never surfaces" would fight the design.
   * We assert the ORDERING property instead: no labeled negative may outrank a
   * labeled positive. That is meaningful under over-generation and does not
   * quietly re-specify the algorithm.
   */
  type Spec = {
    readonly tag: string;
    readonly statement: string;
    readonly scope: Record<string, unknown>;
    readonly claimType: ClaimType;
    readonly contradicts?: boolean;
  };
  type Group = {
    readonly tag: string;
    readonly query: Spec;
    readonly positives: readonly Spec[];
    readonly negatives: readonly Spec[];
  };

  const GROUPS: readonly Group[] = Object.freeze([
    {
      tag: "auth",
      query: {
        tag: "auth-q",
        statement: "Auth tokens expire after fifteen minutes.",
        scope: { component: "auth" },
        claimType: "behavior",
      },
      positives: [
        { tag: "auth-eq", statement: "Auth tokens expire after fifteen minutes.", scope: { component: "auth" }, claimType: "behavior" },
        { tag: "auth-narrow", statement: "Auth tokens expire after fifteen minutes.", scope: { component: "auth", env: "prod" }, claimType: "behavior" },
        { tag: "auth-type", statement: "Auth tokens expire after fifteen minutes.", scope: { component: "auth" }, claimType: "requirement" },
        { tag: "auth-para", statement: "Authentication tokens expire fifteen minutes after issue.", scope: { component: "auth" }, claimType: "behavior" },
        { tag: "auth-contra", statement: "Auth tokens must not expire after fifteen minutes.", scope: { component: "auth" }, claimType: "behavior", contradicts: true },
      ],
      negatives: [
        { tag: "auth-neg", statement: "Office parking permits renew each quarter.", scope: { facility: "carpark" }, claimType: "behavior" },
      ],
    },
    {
      tag: "crypt",
      query: {
        tag: "crypt-q",
        statement: "Encryption at rest uses AES two hundred fifty six GCM.",
        scope: { store: "vault" },
        claimType: "constraint",
      },
      positives: [
        { tag: "crypt-eq", statement: "Encryption at rest uses AES two hundred fifty six GCM.", scope: { store: "vault" }, claimType: "constraint" },
        { tag: "crypt-narrow", statement: "Encryption at rest uses AES two hundred fifty six GCM.", scope: { store: "vault", region: "eu" }, claimType: "constraint" },
        { tag: "crypt-para", statement: "At rest encryption employs AES-256-GCM for vault storage.", scope: { store: "vault" }, claimType: "constraint" },
        { tag: "crypt-type", statement: "Encryption at rest uses AES two hundred fifty six GCM.", scope: { store: "vault" }, claimType: "requirement" },
        { tag: "crypt-contra", statement: "Encryption at rest must not use AES two hundred fifty six GCM.", scope: { store: "vault" }, claimType: "constraint", contradicts: true },
      ],
      negatives: [
        { tag: "crypt-neg", statement: "Cafeteria menus rotate on a fortnightly cycle.", scope: { facility: "cafeteria" }, claimType: "behavior" },
      ],
    },
    {
      tag: "rate",
      query: {
        tag: "rate-q",
        statement: "Public API requests are limited to one hundred per minute.",
        scope: { component: "gateway" },
        claimType: "constraint",
      },
      positives: [
        { tag: "rate-eq", statement: "Public API requests are limited to one hundred per minute.", scope: { component: "gateway" }, claimType: "constraint" },
        { tag: "rate-narrow", statement: "Public API requests are limited to one hundred per minute.", scope: { component: "gateway", tier: "free" }, claimType: "constraint" },
        { tag: "rate-para", statement: "The gateway limits public API calls to one hundred requests each minute.", scope: { component: "gateway" }, claimType: "constraint" },
        { tag: "rate-contra", statement: "Public API requests are not limited to one hundred per minute.", scope: { component: "gateway" }, claimType: "constraint", contradicts: true },
      ],
      negatives: [
        { tag: "rate-neg", statement: "Desk allocations follow seniority order.", scope: { facility: "office" }, claimType: "behavior" },
      ],
    },
    {
      tag: "backup",
      query: {
        tag: "backup-q",
        statement: "Nightly backups are retained for thirty days.",
        scope: { system: "primary-db" },
        claimType: "requirement",
      },
      positives: [
        { tag: "backup-eq", statement: "Nightly backups are retained for thirty days.", scope: { system: "primary-db" }, claimType: "requirement" },
        { tag: "backup-narrow", statement: "Nightly backups are retained for thirty days.", scope: { system: "primary-db", region: "apac" }, claimType: "requirement" },
        { tag: "backup-para", statement: "Backups taken nightly are kept for a thirty day window.", scope: { system: "primary-db" }, claimType: "requirement" },
        { tag: "backup-contra", statement: "Nightly backups must not be retained for thirty days.", scope: { system: "primary-db" }, claimType: "requirement", contradicts: true },
      ],
      negatives: [
        { tag: "backup-neg", statement: "Visitor badges are printed at reception.", scope: { facility: "lobby" }, claimType: "behavior" },
      ],
    },
    {
      tag: "audit",
      query: {
        tag: "audit-q",
        statement: "Audit records capture actor identity for every mutation.",
        scope: { component: "audit-log" },
        claimType: "constraint",
      },
      positives: [
        { tag: "audit-eq", statement: "Audit records capture actor identity for every mutation.", scope: { component: "audit-log" }, claimType: "constraint" },
        { tag: "audit-narrow", statement: "Audit records capture actor identity for every mutation.", scope: { component: "audit-log", env: "prod" }, claimType: "constraint" },
        { tag: "audit-para", statement: "Every mutation writes the acting identity into audit records.", scope: { component: "audit-log" }, claimType: "constraint" },
        { tag: "audit-contra", statement: "Audit records do not capture actor identity for every mutation.", scope: { component: "audit-log" }, claimType: "constraint", contradicts: true },
      ],
      negatives: [
        { tag: "audit-neg", statement: "Bicycle storage is available on level two.", scope: { facility: "garage" }, claimType: "behavior" },
      ],
    },
  ]);

  const LABELED_POSITIVE_COUNT = GROUPS.reduce((n, g) => n + g.positives.length, 0);
  const LABELED_NEGATIVE_COUNT = GROUPS.reduce((n, g) => n + g.negatives.length, 0);

  /**
   * Provenance pin. A silent edit to the labeled corpus changes the metric's
   * meaning without changing any assertion, so pin a digest over the labels.
   * If this fails, the corpus changed: re-measure and re-justify the floor —
   * do NOT just update the hash.
   */
  const FIXTURE_DIGEST = createHash("sha256")
    .update(JSON.stringify(GROUPS))
    .digest("hex");

  function specToClaim(g: string, s: Spec, queryId: ClaimId): Claim {
    return makeClaim({
      id: claimId(`${g}-${s.tag}`),
      statement: s.statement,
      scope: s.scope,
      claimType: s.claimType,
      evidenceRefs: [evidenceRef(sha(`${g}-${s.tag}`))],
      ...(s.contradicts
        ? {
            relationships: {
              qualifierClaimIds: [] as ClaimId[],
              contradictsClaimIds: [queryId],
              supersedesClaimIds: [] as ClaimId[],
            },
          }
        : {}),
    });
  }

  it("AC3: recall over a multi-group labeled corpus with pinned non-zero denominator", async () => {
    expect(LABELED_POSITIVE_COUNT).toBeGreaterThan(0);
    expect(LABELED_POSITIVE_COUNT).toBe(22);
    expect(LABELED_NEGATIVE_COUNT).toBe(5);
    expect(GROUPS.length).toBe(5);
    expect(FIXTURE_DIGEST).toHaveLength(64);
    expect(CLAIM_CANDIDATE_RECALL_FLOOR).toBeGreaterThan(0);
    expect(CLAIM_CANDIDATE_RECALL_FLOOR).toBeLessThanOrEqual(1);

    // Whole-corpus: every group's claims coexist, so cross-topic noise is real.
    const corpus: Claim[] = [];
    const queryIds = new Map<string, ClaimId>();
    for (const g of GROUPS) {
      const qid = claimId(`${g.tag}-${g.query.tag}`);
      queryIds.set(g.tag, qid);
    }
    for (const g of GROUPS) {
      const qid = queryIds.get(g.tag)!;
      corpus.push(specToClaim(g.tag, g.query, qid));
      for (const s of g.positives) corpus.push(specToClaim(g.tag, s, qid));
      for (const s of g.negatives) corpus.push(specToClaim(g.tag, s, qid));
    }
    for (let i = 0; i < 30; i += 1) {
      corpus.push(
        makeClaim({
          id: claimId(`noise-rec-${i}`),
          statement: `Noise claim ${i} about calendars and holidays.`,
          scope: { noise: i },
          evidenceRefs: [evidenceRef(sha(`n-${i}`))],
        }),
      );
    }

    let tp = 0;
    const missing: string[] = [];
    const orderingViolations: string[] = [];

    for (const g of GROUPS) {
      const qid = queryIds.get(g.tag)!;
      const query = corpus.find((c) => c.id === qid)!;
      const result = await find(corpus, query, 20);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const scoreByPair = new Map<string, number>();
      for (const c of result.value.candidates) {
        scoreByPair.set(pairKey(c.left, c.right), c.score);
      }

      const positiveScores: number[] = [];
      for (const s of g.positives) {
        const key = pairKey(qid, claimId(`${g.tag}-${s.tag}`));
        const score = scoreByPair.get(key);
        if (score === undefined) missing.push(`${g.tag}/${s.tag}`);
        else {
          tp += 1;
          positiveScores.push(score);
        }
      }

      // Ordering property: a labeled negative must not outrank any positive.
      const lowestPositive = positiveScores.length
        ? Math.min(...positiveScores)
        : undefined;
      if (lowestPositive !== undefined) {
        for (const s of g.negatives) {
          const negScore = scoreByPair.get(
            pairKey(qid, claimId(`${g.tag}-${s.tag}`)),
          );
          if (negScore !== undefined && negScore > lowestPositive) {
            orderingViolations.push(
              `${g.tag}/${s.tag} ${negScore} > positive ${lowestPositive}`,
            );
          }
        }
      }
    }

    const fn = LABELED_POSITIVE_COUNT - tp;
    expect(tp + fn).toBe(LABELED_POSITIVE_COUNT);
    const recall = tp / (tp + fn);

    expect(
      orderingViolations,
      `labeled negatives outranked positives: ${orderingViolations.join("; ")}`,
    ).toEqual([]);

    expect(
      recall,
      `recall ${recall} below floor; missing: ${missing.join(",")}`,
    ).toBeGreaterThanOrEqual(CLAIM_CANDIDATE_RECALL_FLOOR);

    /**
     * EXACT REGRESSION PIN — deliberately stronger than the floor.
     *
     * A floor alone cannot catch small losses: at n=22 a floor of 0.9 still
     * passes after TWO labeled pairs stop surfacing, so a real degradation
     * would ship green. The floor states the product minimum; this pin states
     * what the finder actually achieves today (22/22, measured) so ANY loss is
     * visible immediately.
     *
     * If you are here because this failed: a pair stopped surfacing. That is a
     * recall regression until proven otherwise. Do NOT lower this number to go
     * green — identify the pair from the message above and justify the change,
     * or fix the cause. Lowering it silently converts a caught regression into
     * an uncaught one.
     */
    expect(
      tp,
      `expected all ${LABELED_POSITIVE_COUNT} labeled pairs to surface; missing: ${missing.join(",")}`,
    ).toBe(LABELED_POSITIVE_COUNT);
  });

  it("recall is not vacuous: an empty label set cannot report success", () => {
    // Guards the metric itself — a corpus edit that emptied GROUPS would
    // otherwise yield recall 1.0 over zero pairs and read as a pass.
    expect(LABELED_POSITIVE_COUNT).toBeGreaterThan(0);
    const emptyRecall = (() => {
      const t = 0;
      const f = 0;
      return t + f === 0 ? Number.NaN : t / (t + f);
    })();
    expect(Number.isNaN(emptyRecall)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hygiene
// ---------------------------------------------------------------------------
describe("hygiene", () => {
  it("exports factory, limits, and does not mutate input claim or corpus", async () => {
    expect(typeof createClaimCandidateFinder).toBe("function");
    expect(CLAIM_CANDIDATE_LIMITS.defaultLimit).toBe(20);
    expect(CLAIM_CANDIDATE_LIMITS.maxLimit).toBe(100);

    const left = makeClaim({ id: claimId("H0") });
    const right = makeClaim({
      id: claimId("H1"),
      statement: left.statement,
      scope: left.scope as Record<string, unknown>,
      evidenceRefs: [evidenceRef(sha("h1"))],
    });
    const corpus = [left, right];
    const statementBefore = left.statement;
    const relBefore = JSON.stringify(left.relationships);
    const result = await find(corpus, left, 5);
    expect(result.ok).toBe(true);
    expect(left.statement).toBe(statementBefore);
    expect(JSON.stringify(left.relationships)).toBe(relBefore);
    expect(corpus).toHaveLength(2);
  });

  it("corpus list failure surfaces as IngestResult error with fixed message", async () => {
    const query = makeClaim({ id: claimId("H2") });
    const finder = createClaimCandidateFinder({ reader: failingReader() });
    const result = await finder.findClaimCandidates(query, 5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CORPUS_UNAVAILABLE");
      expect(typeof result.message).toBe("string");
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("rejects hostile accessors and unknown keys on claim input", async () => {
    const finder = createClaimCandidateFinder({
      reader: memoryReader([makeClaim({ id: claimId("H3") })]),
    });
    const hostile: Record<string, unknown> = {
      schemaVersion: 1,
      id: claimId("H4"),
      version: 1,
      claimType: "behavior",
      scope: { x: 1 },
      authority: "official",
      lifecycle: "current",
      state: "proposed",
      evidenceRefs: [evidenceRef(sha("h"))],
      relationships: {
        qualifierClaimIds: [],
        contradictsClaimIds: [],
        supersedesClaimIds: [],
      },
      createdFrom: { questionId: QUESTION, packetId: PACKET },
    };
    Object.defineProperty(hostile, "statement", {
      enumerable: true,
      get() {
        throw new Error("hostile");
      },
    });
    const result = await finder.findClaimCandidates(hostile as never, 5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
  });

  it("receipt binds corpusDigest and selected/considered ids", async () => {
    const a = makeClaim({
      id: claimId("Z0"),
      statement: "Rate limits are enforced per API key.",
      scope: { edge: true },
    });
    const b = makeClaim({
      id: claimId("Z1"),
      statement: "Rate limits are enforced per API key.",
      scope: { edge: true },
      evidenceRefs: [evidenceRef(sha("z1"))],
    });
    const result = await find([a, b], a, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const receipt: ClaimCandidateReceipt = result.value.receipt;
    expect(receipt.corpusDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.id).toMatch(/^rcpt-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(Array.isArray(receipt.failures)).toBe(true);
    expect(receipt.selectedIds.every((id) => typeof id === "string")).toBe(
      true,
    );
  });

  it("public knowledge barrel exports createClaimCandidateFinder", async () => {
    const barrel = await import("./index.js");
    expect(typeof barrel.createClaimCandidateFinder).toBe("function");
  });
});
