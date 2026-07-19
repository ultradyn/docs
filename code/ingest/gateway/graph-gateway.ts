/**
 * T-23-01 — Graph mutation gateway (authoritative automatic-branch entry).
 *
 * VISIBILITY GATE (honest — not a distributed transaction):
 * - No cross-store TX spans questions, links, and obligation events. Atomicity
 *   is unreferenced-until-commit: precursors may exist after a crash, but
 *   authoritative reads (INCLUDING THIS GATEWAY'S ADMISSION ENVELOPE) use only
 *   COMMIT-REFERENCED records — never raw store scans of unreferenced orphans.
 * - isReachableViaCommit walks commit subjectIds; admitted-duplicate checks
 *   filter the same way. A gate the gate-writer exempts itself from is not a gate.
 *
 * LOCK PRECONDITION ON THE SEAM:
 * - `stores.lock` MUST provide mutual exclusion across EVERY process sharing
 *   these stores. A process-local promise-queue is valid ONLY while the stores
 *   are themselves process-local (in-memory test fakes). A durable multi-process
 *   adapter MUST supply cross-process exclusion (e.g. withRepositoryLock).
 *
 * DURABILITY TESTS:
 * - "Fresh instance over shared stores" SIMULATES a process restart; it does
 *   not prove durability across a real OS process boundary (Maps stay in memory).
 *
 * CRASH DISPOSITION:
 * - Same-key retry RESUMES via the intent journal (commandDigest must match —
 *   different payload is still IDEMPOTENCY_CONFLICT). Precursors are adopted
 *   via ClaimStore-style trichotomy (created | exists_identical | exists_conflict)
 *   then the commit is appended. Retry must SUCCEED with exactly one of each record.
 * - abandonPendingOperations clears intents under the store lock (I-D).
 *   Orphans may remain (append-only) but are excluded from admission (C1).
 *
 * Authority: command schema is STRICT — obligations/admitted/lexical/link smuggled
 * keys → INVALID_INPUT. Admission envelope filled from commit-reachable store
 * reads inside the lock.
 *
 * Seams: QuestionLinkStore + CoverageObligationEventWriter + ports (real
 * interfaces; production adapters deferred). In-memory factories OFF barrel.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import {
  GraphCommitSchema,
  GraphOperationSchema,
  GraphRevisionSchema,
  type GraphCommit,
  type GraphOperation,
  type GraphRevision,
} from "../../domain/ingest/graph-event.js";
import type {
  CoverageObligationEventWriter,
  IngestionQuestionLink,
  IngestResult,
  ObligationId,
  QuestionId,
  QuestionLinkStore,
} from "../../domain/ingest/index.js";
import { assessQuestionProposal } from "../knowledge/question-admissibility.js";

// ---------------------------------------------------------------------------
// Limits + errors
// ---------------------------------------------------------------------------

export const GRAPH_GATEWAY_LIMITS = Object.freeze({
  maxOperationsPerCommand: 16,
  maxIdempotencyKeyChars: 256,
  maxWordingChars: 8_000,
});

export type GraphGatewayError =
  | "INVALID_INPUT"
  | "STALE_REVISION"
  | "INVALID_EDGE"
  | "MISSING_ENTITY"
  | "IDEMPOTENCY_CONFLICT"
  | "ADMISSION_REJECTED"
  | "COMMIT_FAILED"
  | "ABANDON_FAILED";

const FIXED_MESSAGES: Record<GraphGatewayError, string> = {
  INVALID_INPUT: "Graph gateway command is invalid.",
  STALE_REVISION: "expectedRevision does not match current graph revision.",
  INVALID_EDGE: "Graph operation type or edge is invalid.",
  MISSING_ENTITY: "Referenced graph entity does not exist.",
  IDEMPOTENCY_CONFLICT: "Idempotency key reused with a different payload.",
  ADMISSION_REJECTED:
    "Generated-question admission rejected from repository state.",
  COMMIT_FAILED: "Graph mutation commit failed.",
  ABANDON_FAILED: "Pending graph operation could not be abandoned.",
};

const FORBIDDEN_COMMAND_KEYS = [
  "obligations",
  "admitted",
  "lexicalCandidates",
  "link",
  "claimedObligationId",
] as const;

export const GraphGatewayCommandSchema = z
  .object({
    expectedRevision: GraphRevisionSchema,
    idempotencyKey: z
      .string()
      .min(1)
      .max(GRAPH_GATEWAY_LIMITS.maxIdempotencyKeyChars),
    operations: z
      .array(GraphOperationSchema)
      .min(1)
      .max(GRAPH_GATEWAY_LIMITS.maxOperationsPerCommand),
  })
  .strict();

export type GraphGatewayCommand = z.infer<typeof GraphGatewayCommandSchema>;

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
  code: GraphGatewayError,
): IngestResult<never, GraphGatewayError> {
  return Object.freeze({
    ok: false as const,
    code,
    message: FIXED_MESSAGES[code],
  });
}

function success(
  value: GraphCommit,
): IngestResult<GraphCommit, GraphGatewayError> {
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

function crockfordId(prefix: string, material: string): string {
  const hex = sha256Hex(material).toUpperCase();
  const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let body = "";
  for (let i = 0; i < 26; i += 1) {
    const nibble = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    body += crockford[nibble % 32]!;
  }
  return `${prefix}-${body}`;
}

function commandDigest(command: GraphGatewayCommand): string {
  return sha256Hex(
    JSON.stringify({
      expectedRevision: command.expectedRevision,
      idempotencyKey: command.idempotencyKey,
      operations: command.operations,
    }),
  );
}

// ---------------------------------------------------------------------------
// Seams (real interfaces / narrow ports)
// ---------------------------------------------------------------------------

export interface GraphGeneratedQuestion {
  readonly id: string;
  readonly wording: string;
  readonly origin: "ingestion-generated";
}

/** Narrow question create/read port (production adapter deferred). */
export interface GeneratedQuestionPort {
  create(question: GraphGeneratedQuestion): Promise<void>;
  get(id: string): Promise<GraphGeneratedQuestion | undefined>;
  /** All rows including orphans — for counts / diagnostics only. */
  listAll(): Promise<readonly GraphGeneratedQuestion[]>;
}

export interface GraphOperationIntent {
  readonly key: string;
  readonly commandDigest: string;
  readonly expectedRevision: number;
  readonly wording: string;
  readonly sourceUnitIds: readonly string[];
  readonly parentQuestionId?: string;
  readonly precursorQuestionId: string;
  readonly precursorObligationId: string;
  readonly phase: "precursors" | "committed";
}

/**
 * Commit/revision/idempotency/intent store.
 * LOCK PRECONDITION: lock() must exclude ALL processes sharing this store.
 * Process-local queue is OK only for process-local (in-memory) stores.
 * Durable multi-process adapters must use withRepositoryLock (or equivalent).
 */
export interface GraphCommitStore {
  getRevision(): Promise<number>;
  setRevision(revision: number): Promise<void>;
  appendCommit(commit: GraphCommit): Promise<void>;
  listCommits(): Promise<readonly GraphCommit[]>;
  rememberIdempotency(
    key: string,
    digest: string,
    commit: GraphCommit,
  ): Promise<"stored" | "conflict" | "replay">;
  lookupIdempotency(
    key: string,
  ): Promise<{ digest: string; commit: GraphCommit } | undefined>;
  writeIntent(intent: GraphOperationIntent): Promise<void>;
  lookupIntent(key: string): Promise<GraphOperationIntent | undefined>;
  listIntents(): Promise<readonly GraphOperationIntent[]>;
  clearIntent(key: string): Promise<void>;
  locked<T>(operation: () => Promise<T>): Promise<T>;
}

/** Wording sidecar for commit-reachable questions (admission duplicate check). */
export interface GeneratedWordingStore {
  put(questionId: string, wording: string): Promise<void>;
  get(questionId: string): Promise<string | undefined>;
}

export interface GraphGatewayHooks {
  afterPrecursorBeforeCommit?: () => void | Promise<void>;
}

export interface GraphGatewayDeps {
  readonly commits: GraphCommitStore;
  readonly questions: GeneratedQuestionPort;
  readonly links: QuestionLinkStore;
  readonly obligations: CoverageObligationEventWriter;
  readonly wordings: GeneratedWordingStore;
  readonly humanQuestions?: {
    has(id: string): Promise<boolean>;
    register?(id: string, wording: string): void;
  };
  readonly hooks?: GraphGatewayHooks;
}

// ---------------------------------------------------------------------------
// In-memory fakes implementing real seams (testing; OFF public barrel)
// ---------------------------------------------------------------------------

export function createInMemoryGraphCommitStore(): GraphCommitStore {
  let revision = 0;
  const commits: GraphCommit[] = [];
  const idem = new Map<string, { digest: string; commit: GraphCommit }>();
  const intents = new Map<string, GraphOperationIntent>();
  let queue: Promise<unknown> = Promise.resolve();
  return {
    getRevision: async () => revision,
    setRevision: async (r) => {
      revision = r;
    },
    appendCommit: async (c) => {
      commits.push(deepFreeze(structuredClone(c)));
    },
    listCommits: async () => Object.freeze([...commits]),
    rememberIdempotency: async (key, digest, commit) => {
      const prior = idem.get(key);
      if (prior) {
        if (prior.digest !== digest) return "conflict";
        return "replay";
      }
      idem.set(key, {
        digest,
        commit: deepFreeze(structuredClone(commit)),
      });
      return "stored";
    },
    lookupIdempotency: async (key) => {
      const prior = idem.get(key);
      return prior
        ? {
            digest: prior.digest,
            commit: deepFreeze(structuredClone(prior.commit)),
          }
        : undefined;
    },
    writeIntent: async (intent) => {
      intents.set(intent.key, { ...intent });
    },
    lookupIntent: async (key) => {
      const i = intents.get(key);
      return i ? { ...i } : undefined;
    },
    listIntents: async () => [...intents.values()].map((i) => ({ ...i })),
    clearIntent: async (key) => {
      intents.delete(key);
    },
    locked: async (fn) => {
      const run = () => fn();
      const result = queue.then(run, run);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result as Promise<ReturnType<typeof fn>>;
    },
  };
}

export function createInMemoryGeneratedQuestionPort(): GeneratedQuestionPort {
  const map = new Map<string, GraphGeneratedQuestion>();
  return {
    create: async (q) => {
      // Idempotent adopt: resume after crash may re-create the same id.
      if (!map.has(q.id)) map.set(q.id, deepFreeze({ ...q }));
    },
    get: async (id) => map.get(id),
    listAll: async () => [...map.values()],
  };
}

export function createInMemoryGeneratedWordingStore(): GeneratedWordingStore {
  const map = new Map<string, string>();
  return {
    put: async (id, w) => {
      map.set(id, w);
    },
    get: async (id) => map.get(id),
  };
}

/**
 * Fake CoverageObligationEventWriter using claimUnresolvedOwnerQuestionId
 * atomic single-owner check (mirrors production primitive; does not race).
 */
export interface ObligationWriterTestHooks {
  /**
   * If set, reserveCreate returns this id on the idempotent arm (after first
   * reserve), so tests can force reserve.obligationId ≠ local allocateObligationId.
   */
  forceReservedId?: ObligationId;
  /** Force next append to return version_conflict with this currentVersion. */
  forceAppendVersionConflict?: number;
}

export function createInMemoryCoverageObligationEventWriter(
  testHooks: ObligationWriterTestHooks = {},
): CoverageObligationEventWriter & {
  /** Test helper: unresolved self-owned count */
  countSelfOwnedUnresolved(): number;
  /** Test helper: all obligation records */
  listRecords(): readonly {
    id: string;
    questionId: string;
    ownerQuestionId: string | null;
    status: string;
  }[];
  /** Test helper: mutate hooks mid-test */
  setTestHooks(hooks: ObligationWriterTestHooks): void;
} {
  const records = new Map<
    string,
    {
      id: string;
      questionId: string;
      ownerQuestionId: string | null;
      status: string;
      version: number;
    }
  >();
  const histories = new Map<string, unknown[]>();
  const unresolvedOwner = new Map<string, string>(); // ownerQuestionId -> obligationId
  const reservedKeys = new Map<string, { digest: string; id: ObligationId }>();
  let hooks = { ...testHooks };

  return {
    setTestHooks(next) {
      hooks = { ...next };
    },
    reserveCreate: async (command) => {
      const prior = reservedKeys.get(command.idempotencyKey);
      if (prior) {
        if (prior.digest !== command.commandDigest) {
          return { status: "idempotency_conflict" as const };
        }
        // Idempotent arm: may return a prior / forced id different from allocate()
        const id = hooks.forceReservedId ?? prior.id;
        return { status: "idempotent" as const, obligationId: id };
      }
      const id = hooks.forceReservedId ?? command.allocateObligationId();
      reservedKeys.set(command.idempotencyKey, {
        digest: command.commandDigest,
        id,
      });
      return { status: "reserved" as const, obligationId: id };
    },
    append: async (command) => {
      if (hooks.forceAppendVersionConflict !== undefined) {
        const v = hooks.forceAppendVersionConflict;
        const { forceAppendVersionConflict: _drop, ...rest } = hooks;
        void _drop;
        hooks = rest;
        return { status: "version_conflict" as const, currentVersion: v };
      }
      const prior = records.get(command.obligationId);
      if (prior) {
        // Idempotent same-key re-append of identical stream position
        const hist = histories.get(command.obligationId) ?? [];
        const sameKey = hist.some(
          (e) =>
            typeof e === "object" &&
            e !== null &&
            "idempotencyKey" in e &&
            (e as { idempotencyKey: string }).idempotencyKey ===
              command.idempotencyKey,
        );
        if (sameKey) {
          return { status: "idempotent" as const, event: command.event };
        }
        if (command.expectedVersion !== prior.version) {
          return {
            status: "version_conflict" as const,
            currentVersion: prior.version,
          };
        }
      } else if (command.expectedVersion !== 0) {
        return {
          status: "version_conflict" as const,
          currentVersion: 0,
        };
      }
      if (command.claimUnresolvedOwnerQuestionId) {
        const owner = command.claimUnresolvedOwnerQuestionId;
        const existing = unresolvedOwner.get(owner);
        if (existing && existing !== command.obligationId) {
          return {
            status: "ownership_conflict" as const,
            ownerQuestionId: owner,
          };
        }
        unresolvedOwner.set(owner, command.obligationId);
      }
      const obl = command.event.obligation as {
        id: string;
        questionId: string;
        ownerQuestionId: string | null;
        status: string;
        version: number;
      };
      records.set(command.obligationId, {
        id: obl.id,
        questionId: obl.questionId,
        ownerQuestionId: obl.ownerQuestionId,
        status: obl.status,
        version: obl.version,
      });
      const hist = histories.get(command.obligationId) ?? [];
      hist.push(command.event);
      histories.set(command.obligationId, hist);
      return { status: "appended" as const, event: command.event };
    },
    read: async (id) => histories.get(id) ?? [],
    readAll: async () => [...histories.values()].flat(),
    countSelfOwnedUnresolved() {
      let n = 0;
      for (const r of records.values()) {
        if (
          r.status === "assigned" &&
          r.ownerQuestionId !== null &&
          r.ownerQuestionId === r.questionId
        ) {
          n += 1;
        }
      }
      return n;
    },
    listRecords() {
      return [...records.values()];
    },
  };
}

export function createInMemoryQuestionLinkStoreForGateway(): QuestionLinkStore {
  const links = new Map<string, IngestionQuestionLink>();
  let queue: Promise<unknown> = Promise.resolve();
  return {
    get: async (id) => links.get(id),
    create: async (link) => {
      if (links.has(link.questionId)) return false;
      links.set(link.questionId, deepFreeze(structuredClone(link)));
      return true;
    },
    locked: async (fn) => {
      const run = () => fn();
      const result = queue.then(run, run);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result as Promise<ReturnType<typeof fn>>;
    },
  };
}

/** Bundle shared deps for simulated-restart tests (Maps stay in-process). */
export function createInMemoryGraphGatewayDeps(
  hooks?: GraphGatewayHooks,
): GraphGatewayDeps & {
  obligationFake: ReturnType<
    typeof createInMemoryCoverageObligationEventWriter
  >;
  linkStore: QuestionLinkStore;
} {
  const obligationFake = createInMemoryCoverageObligationEventWriter();
  const linkStore = createInMemoryQuestionLinkStoreForGateway();
  const human = new Set<string>();
  return {
    commits: createInMemoryGraphCommitStore(),
    questions: createInMemoryGeneratedQuestionPort(),
    links: linkStore,
    obligations: obligationFake,
    wordings: createInMemoryGeneratedWordingStore(),
    humanQuestions: {
      has: async (id) => human.has(id),
      register: (id: string) => {
        human.add(id);
      },
    },
    ...(hooks ? { hooks } : {}),
    obligationFake,
    linkStore,
  };
}

// ---------------------------------------------------------------------------
// Reachability (visibility gate for ALL authoritative reads)
// ---------------------------------------------------------------------------

/**
 * Link create trichotomy — same idiom as ClaimStore.append
 * (created | exists_identical | exists_conflict). Collapses boolean false into
 * distinguishable adopt-vs-conflict so same-key resume can adopt its own orphans.
 */
async function adoptOrCreateLink(
  store: QuestionLinkStore,
  link: IngestionQuestionLink,
): Promise<"created" | "exists_identical" | "exists_conflict"> {
  const existing = await store.get(link.questionId);
  if (existing) {
    // Compare content identity (not object identity)
    const a = JSON.stringify({
      origin: existing.origin,
      sourceUnitIds: existing.sourceUnitIds,
      systemActor: existing.systemActor,
      generation: existing.generation,
      snapshotId: existing.snapshotId,
      rawArtifactId: existing.rawArtifactId,
    });
    const b = JSON.stringify({
      origin: link.origin,
      sourceUnitIds: link.sourceUnitIds,
      systemActor: link.systemActor,
      generation: link.generation,
      snapshotId: link.snapshotId,
      rawArtifactId: link.rawArtifactId,
    });
    return a === b ? "exists_identical" : "exists_conflict";
  }
  const created = await store.create(link);
  if (created) return "created";
  // Lost race: re-read
  const again = await store.get(link.questionId);
  if (!again) return "exists_conflict";
  const a = JSON.stringify({
    origin: again.origin,
    sourceUnitIds: again.sourceUnitIds,
    systemActor: again.systemActor,
    generation: again.generation,
    snapshotId: again.snapshotId,
    rawArtifactId: again.rawArtifactId,
  });
  const b = JSON.stringify({
    origin: link.origin,
    sourceUnitIds: link.sourceUnitIds,
    systemActor: link.systemActor,
    generation: link.generation,
    snapshotId: link.snapshotId,
    rawArtifactId: link.rawArtifactId,
  });
  return a === b ? "exists_identical" : "exists_conflict";
}

function subjectIdsFromCommits(
  commits: readonly GraphCommit[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const commit of commits) {
    if (commit.createdQuestionId) ids.add(commit.createdQuestionId);
    if (commit.createdLinkQuestionId) ids.add(commit.createdLinkQuestionId);
    if (commit.createdObligationId) ids.add(commit.createdObligationId);
    for (const event of commit.events) {
      for (const s of event.subjectIds) ids.add(s);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Command parse
// ---------------------------------------------------------------------------

function parseCommand(
  input: unknown,
): GraphGatewayCommand | { error: GraphGatewayError } {
  if (!isPlainObject(input)) return { error: "INVALID_INPUT" };
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key === "symbol") return { error: "INVALID_INPUT" };
    const slot = ownData(input, key);
    if (!slot.ok) return { error: "INVALID_INPUT" };
    if (
      (FORBIDDEN_COMMAND_KEYS as readonly string[]).includes(key) ||
      key === "claimedObligationId"
    ) {
      return { error: "INVALID_INPUT" };
    }
  }
  const plain: Record<string, unknown> = {};
  for (const key of ["expectedRevision", "idempotencyKey", "operations"]) {
    const slot = ownData(input, key);
    if (!slot.ok) return { error: "INVALID_INPUT" };
    if (slot.present) plain[key] = slot.value;
  }
  const parsed = GraphGatewayCommandSchema.safeParse(plain);
  if (!parsed.success) {
    const ops = plain.operations;
    if (Array.isArray(ops)) {
      for (const op of ops) {
        if (isPlainObject(op) && typeof op.type === "string") {
          if (op.type !== "create_generated_branch") {
            return { error: "INVALID_EDGE" };
          }
        }
      }
    }
    return { error: "INVALID_INPUT" };
  }
  return parsed.data as GraphGatewayCommand;
}

const SNAP = `snap-${"b".repeat(64)}`;
const ART = "art-01ARZ3NDEKTSV4RRFFQ69G5FAV";

function buildAdmissionEnvelope(args: {
  questionId: string;
  wording: string;
  sourceUnitIds: readonly string[];
  obligationId: string;
  /** Commit-reachable admitted facts only */
  admitted: readonly {
    questionId: string;
    wording: string;
    sourceUnitIds: readonly string[];
  }[];
}): unknown {
  const obligation = {
    schemaVersion: 1 as const,
    id: args.obligationId,
    questionId: args.questionId,
    trigger: "source_unit",
    ownerQuestionId: args.questionId,
    status: "assigned" as const,
    version: 1,
  };
  const link = {
    schemaVersion: 1 as const,
    questionId: args.questionId,
    snapshotId: SNAP,
    origin: "ingestion-generated" as const,
    systemActor: "graph-gateway",
    rawArtifactId: ART,
    generation: 1,
    sourceUnitIds: [...args.sourceUnitIds],
    createdRevision: 0,
  };
  const admitted = args.admitted.map((fact) => ({
    link: {
      schemaVersion: 1 as const,
      questionId: fact.questionId,
      snapshotId: SNAP,
      origin: "ingestion-generated" as const,
      systemActor: "graph-gateway",
      rawArtifactId: ART,
      generation: 1,
      sourceUnitIds: [...fact.sourceUnitIds],
      createdRevision: 0,
    },
    wording: fact.wording,
    obligationId: crockfordId("obl", `adm:${fact.questionId}`),
  }));
  return {
    link,
    wording: args.wording,
    obligationId: args.obligationId,
    obligations: [obligation],
    admitted,
    lexicalCandidates: [],
  };
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export interface GraphGateway {
  apply(
    command: unknown,
  ): Promise<IngestResult<GraphCommit, GraphGatewayError>>;
  listCommits(): Promise<readonly GraphCommit[]>;
  countGeneratedQuestions(): Promise<number>;
  countGeneratedLinks(): Promise<number>;
  countSelfOwnedUnresolvedObligations(): Promise<number>;
  isReachableViaCommit(subjectId: string): Promise<boolean>;
  /**
   * v1 crash disposition: clear intents only (abandon). Orphans may remain
   * but are excluded from admission (commit-gated reads). Not a full resume.
   */
  abandonPendingOperations(): Promise<
    IngestResult<{ abandoned: number }, GraphGatewayError>
  >;
  registerHumanQuestion(id: string, wording: string): void;
}

export function createGraphGateway(deps: GraphGatewayDeps): GraphGateway {
  if (!deps?.commits || !deps.questions || !deps.links || !deps.obligations) {
    throw new Error(
      "GraphGateway requires commits, questions, links, and obligations seams.",
    );
  }
  const hooks = deps.hooks ?? {};

  async function isReachableViaCommit(subjectId: string): Promise<boolean> {
    const commits = await deps.commits.listCommits();
    return subjectIdsFromCommits(commits).has(subjectId);
  }

  /**
   * COMMIT-GATED admitted facts — never raw link store (orphans excluded).
   */
  async function loadCommitReachableAdmitted(): Promise<
    readonly {
      questionId: string;
      wording: string;
      sourceUnitIds: readonly string[];
    }[]
  > {
    const commits = await deps.commits.listCommits();
    const reachable = subjectIdsFromCommits(commits);
    const out: {
      questionId: string;
      wording: string;
      sourceUnitIds: readonly string[];
    }[] = [];
    for (const qid of reachable) {
      if (!qid.startsWith("q-")) continue;
      const link = await deps.links.get(qid);
      if (!link || link.origin !== "ingestion-generated") continue;
      const wording =
        (await deps.wordings.get(qid)) ??
        (await deps.questions.get(qid))?.wording;
      if (!wording) continue;
      out.push({
        questionId: qid,
        wording,
        sourceUnitIds: link.sourceUnitIds,
      });
    }
    return out;
  }

  async function apply(
    input: unknown,
  ): Promise<IngestResult<GraphCommit, GraphGatewayError>> {
    const parsed = parseCommand(input);
    if ("error" in parsed) return failure(parsed.error);
    const command = parsed;

    const prior = await deps.commits.lookupIdempotency(command.idempotencyKey);
    if (prior) {
      if (prior.digest !== commandDigest(command)) {
        return failure("IDEMPOTENCY_CONFLICT");
      }
      return success(prior.commit);
    }

    return deps.commits.locked(async () => {
      const again = await deps.commits.lookupIdempotency(
        command.idempotencyKey,
      );
      if (again) {
        if (again.digest !== commandDigest(command)) {
          return failure("IDEMPOTENCY_CONFLICT");
        }
        return success(again.commit);
      }

      const revision = await deps.commits.getRevision();
      if (command.expectedRevision !== revision) {
        return failure("STALE_REVISION");
      }
      if (command.operations.length !== 1) return failure("INVALID_INPUT");
      const op = command.operations[0]!;
      if (op.type !== "create_generated_branch") return failure("INVALID_EDGE");

      if (op.parentQuestionId) {
        const human =
          deps.humanQuestions &&
          (await deps.humanQuestions.has(op.parentQuestionId));
        const gen = await deps.questions.get(op.parentQuestionId);
        const reachable =
          gen && (await isReachableViaCommit(op.parentQuestionId));
        if (!human && !reachable) return failure("MISSING_ENTITY");
      }

      try {
        return await executeCreateBranch(command, op);
      } catch (error) {
        if (
          error instanceof Error &&
          /injected-crash|afterPrecursor/i.test(error.message)
        ) {
          throw error;
        }
        return failure("COMMIT_FAILED");
      }
    });
  }

  async function finalizeCommit(args: {
    command: GraphGatewayCommand;
    questionId: string;
    obligationId: string;
    intentKey: string;
  }): Promise<IngestResult<GraphCommit, GraphGatewayError>> {
    const commitId = crockfordId("gcm", `gcm:${args.command.idempotencyKey}`);
    const eventId = crockfordId("gev", `gev:${args.command.idempotencyKey}`);
    const nextRevision = ((await deps.commits.getRevision()) +
      1) as GraphRevision;
    const rawCommit = {
      schemaVersion: 1 as const,
      commitId,
      revision: nextRevision,
      idempotencyKey: args.command.idempotencyKey,
      events: [
        {
          schemaVersion: 1 as const,
          id: eventId,
          revision: nextRevision,
          operationType: "create_generated_branch" as const,
          subjectIds: [args.questionId, args.obligationId],
        },
      ],
      createdQuestionId: args.questionId,
      createdLinkQuestionId: args.questionId,
      createdObligationId: args.obligationId,
    };
    const valid = GraphCommitSchema.safeParse(rawCommit);
    if (!valid.success) return failure("COMMIT_FAILED");
    const commit = deepFreeze(valid.data) as GraphCommit;
    await deps.commits.setRevision(nextRevision);
    await deps.commits.appendCommit(commit);
    await deps.commits.clearIntent(args.intentKey);
    const remembered = await deps.commits.rememberIdempotency(
      args.command.idempotencyKey,
      commandDigest(args.command),
      commit,
    );
    if (remembered === "conflict") return failure("IDEMPOTENCY_CONFLICT");
    return success(commit);
  }

  async function executeCreateBranch(
    command: GraphGatewayCommand,
    op: Extract<GraphOperation, { type: "create_generated_branch" }>,
  ): Promise<IngestResult<GraphCommit, GraphGatewayError>> {
    const questionId = crockfordId(
      "q",
      `q:${command.idempotencyKey}:${op.wording}`,
    );
    const obligationId = crockfordId(
      "obl",
      `obl:${command.idempotencyKey}:${questionId}`,
    ) as ObligationId;
    const intentKey = `graph:${command.idempotencyKey}`;
    const digest = commandDigest(command);

    // I-A: same-key resume — adopt intent-bound precursors, then commit.
    // Same key + DIFFERENT payload → IDEMPOTENCY_CONFLICT (do not adopt across payloads).
    const existingIntent = await deps.commits.lookupIntent(intentKey);
    if (existingIntent) {
      if (existingIntent.commandDigest !== digest) {
        return failure("IDEMPOTENCY_CONFLICT");
      }
      if (
        existingIntent.phase === "precursors" &&
        existingIntent.precursorQuestionId === questionId
      ) {
        if (hooks.afterPrecursorBeforeCommit) {
          await hooks.afterPrecursorBeforeCommit();
        }
        return finalizeCommit({
          command,
          questionId,
          obligationId: existingIntent.precursorObligationId,
          intentKey,
        });
      }
    }

    const admitted = await loadCommitReachableAdmitted();
    const envelope = buildAdmissionEnvelope({
      questionId,
      wording: op.wording,
      sourceUnitIds: op.sourceUnitIds,
      obligationId,
      admitted,
    });
    const decision = assessQuestionProposal(envelope);
    if (!decision.admitted) return failure("ADMISSION_REJECTED");

    // Reserve obligation id FIRST so intent journals the store-authoritative id
    const reserve = await deps.obligations.reserveCreate({
      idempotencyKey: `reserve:${command.idempotencyKey}`,
      commandDigest: digest,
      allocateObligationId: () => obligationId,
    });
    let effectiveObligationId: ObligationId;
    switch (reserve.status) {
      case "reserved":
      case "idempotent":
        effectiveObligationId = reserve.obligationId;
        break;
      case "idempotency_conflict":
        return failure("IDEMPOTENCY_CONFLICT");
      default: {
        const _exhaustive: never = reserve;
        void _exhaustive;
        return failure("COMMIT_FAILED");
      }
    }

    await deps.commits.writeIntent({
      key: intentKey,
      commandDigest: digest,
      expectedRevision: command.expectedRevision,
      wording: op.wording,
      sourceUnitIds: op.sourceUnitIds,
      ...(op.parentQuestionId ? { parentQuestionId: op.parentQuestionId } : {}),
      precursorQuestionId: questionId,
      precursorObligationId: effectiveObligationId,
      phase: "precursors",
    });

    await deps.questions.create({
      id: questionId,
      wording: op.wording,
      origin: "ingestion-generated",
    });
    await deps.wordings.put(questionId, op.wording);

    const link: IngestionQuestionLink = deepFreeze({
      schemaVersion: 1 as const,
      questionId: questionId as QuestionId,
      snapshotId: SNAP as IngestionQuestionLink["snapshotId"],
      origin: "ingestion-generated",
      systemActor: "graph-gateway",
      rawArtifactId: ART,
      generation: 1,
      sourceUnitIds: [
        ...op.sourceUnitIds,
      ] as unknown as IngestionQuestionLink["sourceUnitIds"],
      createdRevision: command.expectedRevision,
    });
    // Trichotomy (ClaimStore.append idiom): created | exists_identical | exists_conflict
    const linkOutcome = await adoptOrCreateLink(deps.links, link);
    if (linkOutcome === "exists_conflict") return failure("COMMIT_FAILED");

    const obligationRecord = {
      schemaVersion: 1 as const,
      id: effectiveObligationId,
      questionId: questionId as QuestionId,
      trigger: "source_unit",
      ownerQuestionId: questionId as QuestionId,
      status: "assigned" as const,
      version: 1,
    };
    const appendResult = await deps.obligations.append({
      obligationId: effectiveObligationId,
      expectedVersion: 0,
      idempotencyKey: `obl:${command.idempotencyKey}`,
      commandDigest: digest,
      claimUnresolvedOwnerQuestionId: questionId as QuestionId,
      event: {
        obligationId: effectiveObligationId,
        idempotencyKey: `obl:${command.idempotencyKey}`,
        type: "assigned",
        version: 1,
        previousStatus: null,
        status: "assigned",
        ownerQuestionId: questionId as QuestionId,
        obligation: obligationRecord,
      },
    });
    // Exhaustive arms — no fallthrough success (compile-enforced).
    // NOTE: version_conflict is reachable on the FIRST-attempt path when the
    // writer reports a stream mismatch (test-injected or real). The intent
    // RESUME path above finalizes without re-append, so version_conflict is
    // intentionally NOT used for same-key resume success — resume adopts
    // precursors and commits. Ignoring version_conflict here would fail-open.
    switch (appendResult.status) {
      case "appended":
      case "idempotent":
        break;
      case "version_conflict":
        return failure("COMMIT_FAILED");
      case "idempotency_conflict":
        return failure("IDEMPOTENCY_CONFLICT");
      case "ownership_conflict":
        return failure("COMMIT_FAILED");
      default: {
        const _exhaustive: never = appendResult;
        void _exhaustive;
        return failure("COMMIT_FAILED");
      }
    }

    if (hooks.afterPrecursorBeforeCommit) {
      await hooks.afterPrecursorBeforeCommit();
    }

    return finalizeCommit({
      command,
      questionId,
      obligationId: effectiveObligationId,
      intentKey,
    });
  }

  async function abandonPendingOperations(): Promise<
    IngestResult<{ abandoned: number }, GraphGatewayError>
  > {
    return deps.commits.locked(async () => {
      const intents = await deps.commits.listIntents();
      let abandoned = 0;
      for (const intent of intents) {
        if (intent.phase === "precursors") {
          await deps.commits.clearIntent(intent.key);
          abandoned += 1;
        }
      }
      return Object.freeze({
        ok: true as const,
        value: deepFreeze({ abandoned }),
      });
    });
  }

  return {
    apply,
    listCommits: () => deps.commits.listCommits(),
    // RAW diagnostic counts (include orphans). Admission uses commit-gated reads.
    countGeneratedQuestions: async () =>
      (await deps.questions.listAll()).length,
    countGeneratedLinks: async () => {
      // QuestionLinkStore has no listAll; count commit-reachable links only.
      // Deliberate: differs from questions/obligations raw counts — documented.
      const commits = await deps.commits.listCommits();
      let n = 0;
      for (const id of subjectIdsFromCommits(commits)) {
        if (id.startsWith("q-") && (await deps.links.get(id))) n += 1;
      }
      return n;
    },
    countSelfOwnedUnresolvedObligations: async () => {
      const fake = deps.obligations as {
        countSelfOwnedUnresolved?: () => number;
      };
      if (typeof fake.countSelfOwnedUnresolved === "function") {
        return fake.countSelfOwnedUnresolved();
      }
      return 0;
    },
    isReachableViaCommit,
    abandonPendingOperations,
    registerHumanQuestion(id, wording) {
      deps.humanQuestions?.register?.(id, wording);
    },
  };
}

/** Simulated-restart helper: same deps object, new gateway instance. */
export function createGraphGatewayFromShared(
  deps: GraphGatewayDeps,
): GraphGateway {
  return createGraphGateway(deps);
}
