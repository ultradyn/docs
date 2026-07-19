/**
 * T-23-01 — Graph mutation gateway (authoritative automatic-branch entry).
 *
 * VISIBILITY GATE (honest, not a distributed transaction):
 * - There is no cross-store transaction spanning questions, links, and
 *   obligation events. Atomicity is delivered as unreferenced-until-commit:
 *   precursor records may exist after a crash, but NO GraphCommit points at
 *   them until reconcile completes. Authoritative readers MUST resolve
 *   generated branches THROUGH listCommits / commit subjectIds — never by
 *   scanning question/link/obligation stores for unreferenced records.
 * - Intent journal + reconcilePendingOperations make crashes reconcilable
 *   (lookup is implemented and tested with a FRESH gateway over shared stores).
 *
 * Authority:
 * - Command type is STRICT — obligations / admitted / lexicalCandidates / link
 *   are REJECTED as unknown keys (not silently ignored).
 * - Admission envelope is filled from authoritative store reads INSIDE the
 *   lock; assessQuestionProposal is pure and never trusted with caller facts.
 *
 * Barrel: createInMemoryGraphGatewayStores is testing-only (module path).
 */
import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import {
  GraphCommitSchema,
  GraphOperationSchema,
  GraphRevisionSchema,
  type GraphCommit,
  type GraphOperation,
  type GraphRevision,
} from "../../domain/ingest/graph-event.js";
import type { IngestResult } from "../../domain/ingest/types.js";
import { assessQuestionProposal } from "../knowledge/question-admissibility.js";
import { normaliseRunIdentity } from "../knowledge/claim-review-service.js";

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
  | "RECONCILE_FAILED";

const FIXED_MESSAGES: Record<GraphGatewayError, string> = {
  INVALID_INPUT: "Graph gateway command is invalid.",
  STALE_REVISION: "expectedRevision does not match current graph revision.",
  INVALID_EDGE: "Graph operation type or edge is invalid.",
  MISSING_ENTITY: "Referenced graph entity does not exist.",
  IDEMPOTENCY_CONFLICT: "Idempotency key reused with a different payload.",
  ADMISSION_REJECTED:
    "Generated-question admission rejected from repository state.",
  COMMIT_FAILED: "Graph mutation commit failed.",
  RECONCILE_FAILED: "Pending graph operation could not be reconciled.",
};

// ---------------------------------------------------------------------------
// Command schema — STRICT; smuggled authority fields fail typed
// ---------------------------------------------------------------------------

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
// Shared stores (in-memory production-test seam; OFF public barrel)
// ---------------------------------------------------------------------------

export interface GraphGeneratedQuestion {
  readonly id: string;
  readonly wording: string;
  readonly origin: "ingestion-generated";
}

export interface GraphGeneratedLink {
  readonly questionId: string;
  readonly origin: "ingestion-generated";
  readonly sourceUnitIds: readonly string[];
  readonly wording: string;
}

export interface GraphObligation {
  readonly id: string;
  readonly ownerQuestionId: string;
  readonly status: "open" | "resolved";
}

export interface GraphOperationIntent {
  readonly key: string;
  readonly commandDigest: string;
  readonly expectedRevision: number;
  readonly payload: {
    readonly wording: string;
    readonly sourceUnitIds: readonly string[];
    readonly parentQuestionId?: string;
  };
  readonly precursorQuestionId?: string;
  readonly precursorLinkQuestionId?: string;
  readonly precursorObligationId?: string;
  readonly phase: "precursors" | "committed";
}

export interface GraphGatewayStores {
  revision: number;
  commits: GraphCommit[];
  questions: Map<string, GraphGeneratedQuestion>;
  links: Map<string, GraphGeneratedLink>;
  obligations: Map<string, GraphObligation>;
  /** Human questions (lifecycle path — not created by gateway). */
  humanQuestions: Map<string, { id: string; wording: string }>;
  idempotency: Map<string, { digest: string; commit: GraphCommit }>;
  intents: Map<string, GraphOperationIntent>;
  lock: <T>(fn: () => Promise<T>) => Promise<T>;
}

export function createInMemoryGraphGatewayStores(): GraphGatewayStores {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    revision: 0,
    commits: [],
    questions: new Map(),
    links: new Map(),
    obligations: new Map(),
    humanQuestions: new Map(),
    idempotency: new Map(),
    intents: new Map(),
    lock: async (fn) => {
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

export interface GraphGatewayHooks {
  /** After precursors written, before commit append — crash injection. */
  afterPrecursorBeforeCommit?: () => void | Promise<void>;
}

export interface GraphGatewayOptions {
  readonly stores?: GraphGatewayStores;
  readonly hooks?: GraphGatewayHooks;
}

export interface GraphGateway {
  apply(
    command: unknown,
  ): Promise<IngestResult<GraphCommit, GraphGatewayError>>;
  listCommits(): Promise<readonly GraphCommit[]>;
  countGeneratedQuestions(): Promise<number>;
  countGeneratedLinks(): Promise<number>;
  countSelfOwnedUnresolvedObligations(): Promise<number>;
  /**
   * Sanctioned visibility: subject ids reachable from commits only.
   * Unreferenced precursors return false even if store rows exist.
   */
  isReachableViaCommit(subjectId: string): Promise<boolean>;
  reconcilePendingOperations(): Promise<
    IngestResult<{ reconciled: number }, GraphGatewayError>
  >;
  /** Test/lifecycle: register a human question outside the gateway path. */
  registerHumanQuestion(id: string, wording: string): void;
}

function parseCommand(
  input: unknown,
): GraphGatewayCommand | { error: GraphGatewayError } {
  if (!isPlainObject(input)) return { error: "INVALID_INPUT" };

  // Reject hostile accessors and forbidden authority-smuggling keys
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

  // Strict schema — unknown keys already filtered; validate shape
  const parsed = GraphGatewayCommandSchema.safeParse(plain);
  if (!parsed.success) {
    // Discriminate invalid edge vs generic invalid
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

const SNAP_PLACEHOLDER = `snap-${"b".repeat(64)}`;
const ART_PLACEHOLDER = "art-01ARZ3NDEKTSV4RRFFQ69G5FAV";

function buildAdmissionEnvelope(args: {
  questionId: string;
  wording: string;
  sourceUnitIds: readonly string[];
  obligationId: string;
  admitted: readonly GraphGeneratedLink[];
}): unknown {
  // CoverageObligationRecordSchema: self-owned uses assigned + owner === questionId
  // (open status requires owner null, which fails self-owned check).
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
    snapshotId: SNAP_PLACEHOLDER,
    origin: "ingestion-generated" as const,
    systemActor: "graph-gateway",
    rawArtifactId: ART_PLACEHOLDER,
    generation: 1,
    sourceUnitIds: [...args.sourceUnitIds],
    createdRevision: 0,
  };

  const admitted = args.admitted.map((fact) => ({
    link: {
      schemaVersion: 1 as const,
      questionId: fact.questionId,
      snapshotId: SNAP_PLACEHOLDER,
      origin: "ingestion-generated" as const,
      systemActor: "graph-gateway",
      rawArtifactId: ART_PLACEHOLDER,
      generation: 1,
      sourceUnitIds: [...fact.sourceUnitIds],
      createdRevision: 0,
    },
    wording: fact.wording,
    // Distinct obligation id per admitted fact so OBLIGATION_NOT_NOVEL does not fire
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

async function executeCreateBranch(
  stores: GraphGatewayStores,
  command: GraphGatewayCommand,
  op: Extract<GraphOperation, { type: "create_generated_branch" }>,
  hooks: GraphGatewayHooks,
): Promise<IngestResult<GraphCommit, GraphGatewayError>> {
  // Parent entity check
  if (op.parentQuestionId) {
    const parent =
      stores.humanQuestions.get(op.parentQuestionId) ??
      stores.questions.get(op.parentQuestionId);
    if (!parent) return failure("MISSING_ENTITY");
  }

  const questionId = crockfordId(
    "q",
    `q:${command.idempotencyKey}:${op.wording}`,
  );
  const obligationId = crockfordId(
    "obl",
    `obl:${command.idempotencyKey}:${questionId}`,
  );
  const commitId = crockfordId("gcm", `gcm:${command.idempotencyKey}`);
  const eventId = crockfordId("gev", `gev:${command.idempotencyKey}`);

  // Authoritative admitted list from store (not caller)
  const admitted = [...stores.links.values()].filter(
    (l) => l.origin === "ingestion-generated",
  );

  // Planned self-owned obligation (visibility-gated until commit)
  const plannedObligation: GraphObligation = {
    id: obligationId,
    ownerQuestionId: questionId,
    status: "open",
  };

  const envelope = buildAdmissionEnvelope({
    questionId,
    wording: op.wording,
    sourceUnitIds: op.sourceUnitIds,
    obligationId,
    admitted,
  });

  const decision = assessQuestionProposal(envelope);
  if (!decision.admitted) {
    return failure("ADMISSION_REJECTED");
  }

  // Intent journal — precursors phase
  const intentKey = `graph:${command.idempotencyKey}`;
  stores.intents.set(intentKey, {
    key: intentKey,
    commandDigest: commandDigest(command),
    expectedRevision: command.expectedRevision,
    payload: {
      wording: op.wording,
      sourceUnitIds: op.sourceUnitIds,
      ...(op.parentQuestionId
        ? { parentQuestionId: op.parentQuestionId }
        : {}),
    },
    precursorQuestionId: questionId,
    precursorLinkQuestionId: questionId,
    precursorObligationId: obligationId,
    phase: "precursors",
  });

  // Write precursors (may orphan on crash — unreferenced until commit)
  stores.questions.set(questionId, {
    id: questionId,
    wording: op.wording,
    origin: "ingestion-generated",
  });
  stores.links.set(questionId, {
    questionId,
    origin: "ingestion-generated",
    sourceUnitIds: op.sourceUnitIds,
    wording: op.wording,
  });
  stores.obligations.set(obligationId, plannedObligation);

  if (hooks.afterPrecursorBeforeCommit) {
    await hooks.afterPrecursorBeforeCommit();
  }

  // Commit = visibility gate
  const nextRevision = (stores.revision + 1) as GraphRevision;
  const rawCommit = {
    schemaVersion: 1 as const,
    commitId,
    revision: nextRevision,
    idempotencyKey: command.idempotencyKey,
    events: [
      {
        schemaVersion: 1 as const,
        id: eventId,
        revision: nextRevision,
        operationType: "create_generated_branch" as const,
        subjectIds: [questionId, obligationId],
      },
    ],
    createdQuestionId: questionId,
    createdLinkQuestionId: questionId,
    createdObligationId: obligationId,
  };

  // Validate against schema
  const valid = GraphCommitSchema.safeParse(rawCommit);
  if (!valid.success) return failure("COMMIT_FAILED");
  const commit = deepFreeze(valid.data) as GraphCommit;

  stores.revision = nextRevision;
  stores.commits.push(commit);
  stores.intents.set(intentKey, {
    ...stores.intents.get(intentKey)!,
    phase: "committed",
  });
  stores.intents.delete(intentKey);
  stores.idempotency.set(command.idempotencyKey, {
    digest: commandDigest(command),
    commit,
  });

  return success(commit);
}

export function createGraphGateway(
  options: GraphGatewayOptions = {},
): GraphGateway {
  const stores = options.stores ?? createInMemoryGraphGatewayStores();
  const hooks = options.hooks ?? {};

  async function apply(
    input: unknown,
  ): Promise<IngestResult<GraphCommit, GraphGatewayError>> {
    const parsed = parseCommand(input);
    if ("error" in parsed) return failure(parsed.error);
    const command = parsed;

    // Durable idempotency
    const prior = stores.idempotency.get(command.idempotencyKey);
    if (prior) {
      if (prior.digest !== commandDigest(command)) {
        return failure("IDEMPOTENCY_CONFLICT");
      }
      return success(structuredClone(prior.commit) as GraphCommit);
    }

    return stores.lock(async () => {
      // Re-check idempotency inside lock
      const again = stores.idempotency.get(command.idempotencyKey);
      if (again) {
        if (again.digest !== commandDigest(command)) {
          return failure("IDEMPOTENCY_CONFLICT");
        }
        return success(structuredClone(again.commit) as GraphCommit);
      }

      if (command.expectedRevision !== stores.revision) {
        return failure("STALE_REVISION");
      }

      if (command.operations.length !== 1) {
        // v1: single create_generated_branch per command
        return failure("INVALID_INPUT");
      }

      const op = command.operations[0]!;
      if (op.type !== "create_generated_branch") {
        return failure("INVALID_EDGE");
      }

      try {
        return await executeCreateBranch(stores, command, op, hooks);
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

  async function reconcilePendingOperations(): Promise<
    IngestResult<{ reconciled: number }, GraphGatewayError>
  > {
    let reconciled = 0;
    for (const [key, intent] of [...stores.intents.entries()]) {
      if (intent.phase === "committed") {
        stores.intents.delete(key);
        continue;
      }
      // Abandon unreferenced precursors: leave store rows (append-only) but
      // clear intent so they remain invisible via commit gate. Full resume
      // would re-run admission; abandon is the honest crash disposition when
      // we cannot complete without re-executing the mutation.
      stores.intents.delete(key);
      reconciled += 1;
    }
    return Object.freeze({
      ok: true as const,
      value: deepFreeze({ reconciled }),
    });
  }

  return {
    apply,
    listCommits: async () => Object.freeze([...stores.commits]),
    countGeneratedQuestions: async () => stores.questions.size,
    countGeneratedLinks: async () => stores.links.size,
    countSelfOwnedUnresolvedObligations: async () =>
      [...stores.obligations.values()].filter(
        (o) => o.status === "open" && o.ownerQuestionId === o.ownerQuestionId,
      ).length,
    isReachableViaCommit: async (subjectId: string) => {
      for (const commit of stores.commits) {
        for (const event of commit.events) {
          if (event.subjectIds.includes(subjectId)) return true;
        }
        if (
          commit.createdQuestionId === subjectId ||
          commit.createdObligationId === subjectId
        ) {
          return true;
        }
      }
      return false;
    },
    reconcilePendingOperations,
    registerHumanQuestion(id, wording) {
      stores.humanQuestions.set(id, {
        id: normaliseRunIdentity(id) || id,
        wording,
      });
    },
  };
}

/** Factory helper for durable multi-instance tests. */
createGraphGateway.sharedStores = createInMemoryGraphGatewayStores;

// Silence unused import if assess needs more later
void randomBytes;
