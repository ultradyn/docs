import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";

import {
  BoundedFollowUpSchema,
  EvidenceVerdictSchema,
  FacetStateRecordSchema,
  ReferenceReviewSchema,
  TerminalVerdictSchema,
  canonicalVerdictPayloadDigest,
  type BoundedFollowUp,
  type EvidenceVerdict,
  type FacetStateRecord,
  type ReferenceReview,
  type TerminalVerdict,
} from "../../domain/ingest/evidence-verdict.js";
import type { EvidencePacket } from "../../domain/ingest/evidence-packet.js";
import { canonicalPacketPayloadDigest } from "../../domain/ingest/evidence-packet.js";
import type {
  EvidencePacketId,
  EvidenceVerdictId,
  IngestResult,
  QuestionId,
  Sha256,
} from "../../domain/ingest/index.js";
import {
  EvidencePacketIdSchema,
  QuestionIdSchema,
} from "../../domain/ingest/index.js";

export type EvidenceVerdictServiceError =
  | "INVALID_INPUT"
  | "PACKET_NOT_FOUND"
  | "PACKET_MISMATCH"
  | "PACKET_UNVERIFIED"
  | "FACET_UNSATISFIED"
  | "FACET_REQUIRED_NA"
  | "REFERENCE_UNCLASSIFIED"
  | "REFERENCE_INVALID"
  | "EMPTY_PACKET"
  | "FOLLOW_UP_REQUIRED"
  | "OUTAGE_NOT_GAP"
  | "RECEIPT_INVALID"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "OVERWRITE_DENIED"
  | "COMMIT_FAILED"
  | "STREAM_CORRUPT"
  | "VERDICT_NOT_FOUND";

export type EvidenceVerdictTransition = {
  readonly done: boolean;
  readonly activateP1: boolean;
  readonly kind:
    | "accepted"
    | "refine"
    | "no_supported_answer"
    | "search_incomplete"
    | "contradiction"
    | "blocked";
};

export type EvidenceVerdictApplyResult =
  | {
      readonly ok: true;
      readonly value: EvidenceVerdict;
      readonly transition: EvidenceVerdictTransition;
    }
  | {
      readonly ok: false;
      readonly code: EvidenceVerdictServiceError;
      readonly message: string;
    };

export interface EvidencePacketReader {
  get(packetId: string, version: number): Promise<EvidencePacket | undefined>;
}

export interface ReceiptFailureReader {
  get(receiptId: string): Promise<
    | {
        readonly id: string;
        readonly failures: readonly string[];
        readonly selectedIds: readonly string[];
        readonly snapshotId?: string;
        readonly query?: string;
        readonly filters?: unknown;
        readonly candidateIds?: readonly string[];
        readonly indexVersion?: string;
        readonly indexedRepresentationsSha256?: string;
      }
    | undefined
  >;
}

export interface PacketVerifier {
  verifyReferences(
    packetId: string,
    version: number,
  ): Promise<IngestResult<true, string>>;
}

export interface EvidenceVerdictStore {
  get(
    verdictId: EvidenceVerdictId,
    version: number,
  ): Promise<EvidenceVerdict | undefined>;
  latest(verdictId: EvidenceVerdictId): Promise<EvidenceVerdict | undefined>;
  append(
    verdict: EvidenceVerdict,
  ): Promise<"created" | "exists_identical" | "exists_conflict">;
  locked<T>(operation: () => Promise<T>): Promise<T>;
  rememberIdempotency?(
    key: string,
    digest: string,
    verdict: EvidenceVerdict,
  ): Promise<"stored" | "conflict" | "replay">;
  lookupIdempotency?(
    key: string,
  ): Promise<{ digest: string; verdict: EvidenceVerdict } | undefined>;
}

export interface EvidenceVerdictService {
  apply(input: unknown): Promise<EvidenceVerdictApplyResult>;
  getVerdict(
    verdictId: EvidenceVerdictId | string,
    version: number,
  ): Promise<IngestResult<EvidenceVerdict, EvidenceVerdictServiceError>>;
  latest(
    verdictId: EvidenceVerdictId | string,
  ): Promise<IngestResult<EvidenceVerdict, EvidenceVerdictServiceError>>;
}

const OUTAGE_CODES = new Set([
  "INDEX_UNAVAILABLE",
  "SEARCH_UNAVAILABLE",
  "PROVIDER_OUTAGE",
  "RETRIEVAL_UNAVAILABLE",
]);

function failure(
  code: EvidenceVerdictServiceError,
  message: string,
): EvidenceVerdictApplyResult {
  return Object.freeze({ ok: false as const, code, message });
}

function success(
  value: EvidenceVerdict,
  transition: EvidenceVerdictTransition,
): EvidenceVerdictApplyResult {
  return Object.freeze({
    ok: true as const,
    value: deepFreeze(value),
    transition: Object.freeze({ ...transition }),
  });
}

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

/**
 * Map custody/I/O errors to typed failures without leaking paths, fds, or bytes.
 * Returns null when the error should rethrow (deterministic crash hooks).
 */
function mapCustodyError(
  error: unknown,
): EvidenceVerdictApplyResult | "rethrow" | null {
  if (!(error instanceof Error)) {
    return failure("COMMIT_FAILED", "Durable verdict store commit failed.");
  }
  if (
    error.message.includes("injected-crash") ||
    /afterTempWrite/i.test(error.message)
  ) {
    return "rethrow";
  }
  if (error.message.startsWith("STREAM_CORRUPT")) {
    return failure("STREAM_CORRUPT", "Verdict stream is corrupt.");
  }
  if (
    error.message.startsWith("Refusing") ||
    error.message.includes("fail-closed") ||
    error.message.includes("Descriptor binding") ||
    error.message.includes("symbolic")
  ) {
    return failure(
      "COMMIT_FAILED",
      "Durable verdict store refused the operation.",
    );
  }
  return null;
}

function mapReadError(
  error: unknown,
): IngestResult<never, EvidenceVerdictServiceError> {
  if (error instanceof Error && error.message.startsWith("STREAM_CORRUPT")) {
    return {
      ok: false,
      code: "STREAM_CORRUPT",
      message: "Verdict stream is corrupt.",
    };
  }
  return {
    ok: false,
    code: "COMMIT_FAILED",
    message: "Durable verdict store read failed.",
  };
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

export function deriveEvidenceVerdictId(
  questionId: string,
  packetId: string,
): EvidenceVerdictId {
  const hex = createHash("sha256")
    .update(`evidence-verdict:${questionId}:${packetId}`)
    .digest("hex")
    .toUpperCase();
  const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let body = "";
  for (let index = 0; index < 26; index += 1) {
    const nibble = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    body += crockford[nibble % 32]!;
  }
  return `evv-${body}` as EvidenceVerdictId;
}

function computeTransition(
  verdict: TerminalVerdict,
  facetStates: readonly FacetStateRecord[],
): EvidenceVerdictTransition {
  const hasConflictingFacet = facetStates.some(
    (facet) => facet.state === "conflicting",
  );
  if (verdict === "conflicting_or_deprecated" || hasConflictingFacet) {
    return { done: false, activateP1: true, kind: "contradiction" };
  }
  switch (verdict) {
    case "accepted":
      return { done: true, activateP1: false, kind: "accepted" };
    case "needs_more_evidence":
      return { done: false, activateP1: false, kind: "refine" };
    case "no_supported_answer":
      return { done: true, activateP1: false, kind: "no_supported_answer" };
    case "search_incomplete":
      return { done: true, activateP1: false, kind: "search_incomplete" };
    case "human_authority_required":
    case "source_processing_blocked":
    case "ambiguous_scope":
      return { done: false, activateP1: false, kind: "blocked" };
    default:
      return { done: false, activateP1: false, kind: "blocked" };
  }
}

export function createInMemoryEvidenceVerdictStore(): EvidenceVerdictStore {
  const verdicts = new Map<string, EvidenceVerdict>();
  const idem = new Map<string, { digest: string; verdict: EvidenceVerdict }>();
  const holder = new AsyncLocalStorage<true>();
  let queue: Promise<unknown> = Promise.resolve();

  function key(id: string, version: number): string {
    return `${id}@${version}`;
  }

  return {
    async get(verdictId, version) {
      const verdict = verdicts.get(key(verdictId, version));
      return verdict ? deepFreeze(structuredClone(verdict)) : undefined;
    },
    async latest(verdictId) {
      let best: EvidenceVerdict | undefined;
      for (const verdict of verdicts.values()) {
        if (verdict.id !== verdictId) continue;
        if (!best || verdict.version > best.version) best = verdict;
      }
      return best ? deepFreeze(structuredClone(best)) : undefined;
    },
    async append(verdict) {
      const k = key(verdict.id, verdict.version);
      const existing = verdicts.get(k);
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(verdict)) {
          return "exists_identical";
        }
        return "exists_conflict";
      }
      verdicts.set(k, deepFreeze(structuredClone(verdict)));
      return "created";
    },
    async rememberIdempotency(idKey, digest, verdict) {
      const prior = idem.get(idKey);
      if (prior) {
        if (prior.digest !== digest) return "conflict";
        return "replay";
      }
      idem.set(idKey, {
        digest,
        verdict: deepFreeze(structuredClone(verdict)),
      });
      return "stored";
    },
    async lookupIdempotency(idKey) {
      const prior = idem.get(idKey);
      return prior
        ? {
            digest: prior.digest,
            verdict: deepFreeze(structuredClone(prior.verdict)),
          }
        : undefined;
    },
    locked(operation) {
      if (holder.getStore()) return operation();
      const run = () => holder.run(true, operation);
      const result = queue.then(run, run);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FD_BOUND = process.platform === "linux";
const VERDICT_COMPONENTS = [".ultradyn", "evidence-verdicts"] as const;
const JOURNAL_COMPONENTS = [".ultradyn", "evidence-verdicts-journal"] as const;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Test-only fault seam — not part of the public knowledge barrel contract. */
interface FileEvidenceVerdictStoreHooks {
  afterTempWriteBeforePublish?: () => void | Promise<void>;
}

/**
 * Descriptor-bound durable verdict store.
 * Fails closed when Linux /proc fd binding is unavailable.
 */
export function createFileEvidenceVerdictStore(
  root: string,
  hooks: FileEvidenceVerdictStoreHooks = {},
): EvidenceVerdictStore {
  if (!FD_BOUND) {
    const unavailable = () => {
      throw new Error(
        "Descriptor binding unavailable: file verdict store fail-closed.",
      );
    };
    return {
      get: unavailable as EvidenceVerdictStore["get"],
      latest: unavailable as EvidenceVerdictStore["latest"],
      append: unavailable as EvidenceVerdictStore["append"],
      locked: (operation) => operation(),
      rememberIdempotency: unavailable as NonNullable<
        EvidenceVerdictStore["rememberIdempotency"]
      >,
      lookupIdempotency: unavailable as NonNullable<
        EvidenceVerdictStore["lookupIdempotency"]
      >,
    };
  }

  const holder = new AsyncLocalStorage<true>();
  let queue: Promise<unknown> = Promise.resolve();

  async function openBoundPath(components: readonly string[]): Promise<{
    at: (name: string) => string;
    list: () => Promise<string[]>;
    close: () => Promise<void>;
  }> {
    let handle = await open(root, DIRECTORY_FLAGS).catch((error: unknown) => {
      const code = errorCode(error);
      if (code === "ELOOP" || code === "ENOTDIR") {
        throw new Error(
          "Refusing symbolic-link or non-directory evidence root.",
          { cause: error },
        );
      }
      throw error;
    });
    const handles = [handle];
    try {
      for (const component of components) {
        const viaFd = `/proc/self/fd/${handle.fd}/${component}`;
        try {
          await mkdir(viaFd, { mode: 0o700 });
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
        }
        let child;
        try {
          child = await open(viaFd, DIRECTORY_FLAGS);
        } catch (error) {
          const code = errorCode(error);
          if (code === "ELOOP" || code === "ENOTDIR") {
            throw new Error(
              `Refusing symbolic-link path component ${component}.`,
              { cause: error },
            );
          }
          throw error;
        }
        handles.push(child);
        await handle.close();
        handles.shift();
        handle = child;
      }
      const bound = handle;
      return {
        at: (name: string) => `/proc/self/fd/${bound.fd}/${name}`,
        list: async () => readdir(`/proc/self/fd/${bound.fd}`),
        close: async () => {
          await bound.close();
        },
      };
    } catch (error) {
      for (const openHandle of handles) {
        await openHandle.close().catch(() => undefined);
      }
      throw error;
    }
  }

  function streamComponents(verdictId: string): readonly string[] {
    return [...VERDICT_COMPONENTS, verdictId];
  }

  function verdictFileName(version: number): string {
    return `v${String(version).padStart(8, "0")}.json`;
  }

  const VERSION_NAME = /^v(\d{8})\.json$/u;

  async function listVerdictStream(
    bound: { at: (name: string) => string; list: () => Promise<string[]> },
    verdictId: string,
  ): Promise<EvidenceVerdict[]> {
    const names = await bound.list();
    const versions = new Map<number, string>();
    for (const name of names) {
      if (name === "." || name === ".." || name.endsWith(".tmp")) continue;
      if (name.startsWith("intent-") || name.startsWith("idem-")) continue;
      const match = VERSION_NAME.exec(name);
      if (!match) {
        throw new Error(`STREAM_CORRUPT: unexpected file ${name}`);
      }
      const version = Number(match[1]);
      if (versions.has(version)) {
        throw new Error(`STREAM_CORRUPT: duplicate version ${version}`);
      }
      versions.set(version, name);
    }
    if (versions.size === 0) return [];
    const sorted = [...versions.keys()].sort((a, b) => a - b);
    for (let index = 0; index < sorted.length; index += 1) {
      if (sorted[index] !== index + 1) {
        throw new Error(
          `STREAM_CORRUPT: version gap or non-start at ${sorted.join(",")}`,
        );
      }
    }
    const out: EvidenceVerdict[] = [];
    for (const version of sorted) {
      const name = versions.get(version)!;
      let handle;
      try {
        handle = await open(
          bound.at(name),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (errorCode(error) === "ELOOP") {
          throw new Error(`Refusing symbolic link at ${name}.`, {
            cause: error,
          });
        }
        throw error;
      }
      try {
        const bytes = await handle.readFile("utf8");
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(bytes);
        } catch {
          throw new Error(`STREAM_CORRUPT: malformed JSON ${name}`);
        }
        const parsed = EvidenceVerdictSchema.safeParse(parsedJson);
        if (!parsed.success) {
          throw new Error(`STREAM_CORRUPT: malformed verdict ${name}`);
        }
        if (parsed.data.id !== verdictId || parsed.data.version !== version) {
          throw new Error(
            `STREAM_CORRUPT: cross-stream or rename attack ${name}`,
          );
        }
        out.push(deepFreeze(parsed.data as EvidenceVerdict));
      } finally {
        await handle.close();
      }
    }
    return out;
  }

  return {
    async get(verdictId, version) {
      const bound = await openBoundPath(streamComponents(verdictId));
      try {
        const path = bound.at(verdictFileName(version));
        let handle;
        try {
          handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (error) {
          if (errorCode(error) === "ENOENT") return undefined;
          if (errorCode(error) === "ELOOP") {
            throw new Error(`Refusing symbolic link at ${path}.`, {
              cause: error,
            });
          }
          throw error;
        }
        try {
          const bytes = await handle.readFile("utf8");
          const parsed = EvidenceVerdictSchema.safeParse(JSON.parse(bytes));
          if (!parsed.success) {
            throw new Error("STREAM_CORRUPT: malformed verdict bytes");
          }
          return deepFreeze(parsed.data as EvidenceVerdict);
        } finally {
          await handle.close();
        }
      } finally {
        await bound.close();
      }
    },
    async latest(verdictId) {
      const bound = await openBoundPath(streamComponents(verdictId));
      try {
        const stream = await listVerdictStream(bound, verdictId);
        return stream.at(-1);
      } finally {
        await bound.close();
      }
    },
    async append(verdict) {
      const bound = await openBoundPath(streamComponents(verdict.id));
      const leaf = verdictFileName(verdict.version);
      const path = bound.at(leaf);
      const bytes = `${JSON.stringify(verdict)}\n`;
      const temporary = bound.at(`.${leaf}.${process.pid}-${Date.now()}.tmp`);
      try {
        const stream = await listVerdictStream(bound, verdict.id);
        const expectedNext = stream.length + 1;
        if (verdict.version !== expectedNext) {
          if (!(
            stream.length > 0 && verdict.version === stream.at(-1)!.version
          )) {
            throw new Error(
              `STREAM_CORRUPT: append version ${verdict.version} != next ${expectedNext}`,
            );
          }
        }
        const file = await open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        if (hooks.afterTempWriteBeforePublish) {
          await hooks.afterTempWriteBeforePublish();
        }
        try {
          const existing = await lstat(path);
          if (existing.isSymbolicLink()) {
            await rm(temporary, { force: true });
            throw new Error(`Refusing symbolic link at ${path}.`);
          }
          const prior = await readFile(path, "utf8");
          await rm(temporary, { force: true });
          if (prior === bytes) return "exists_identical";
          return "exists_conflict";
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
        const journal = await openBoundPath(JOURNAL_COMPONENTS);
        try {
          const intentPath = journal.at(
            `intent-${verdict.id}-v${verdict.version}.json`,
          );
          const intent = await open(
            intentPath,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          try {
            await intent.writeFile(
              JSON.stringify({
                verdictId: verdict.id,
                version: verdict.version,
                digest: sha256Hex(bytes),
              }),
            );
            await intent.sync();
          } finally {
            await intent.close();
          }
          await rename(temporary, path);
          await rm(intentPath, { force: true });
        } finally {
          await journal.close();
        }
        return "created";
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        await bound.close();
      }
    },
    async rememberIdempotency(idKey, digest, verdict) {
      const journal = await openBoundPath(JOURNAL_COMPONENTS);
      try {
        const safeKey = sha256Hex(idKey);
        const path = journal.at(`idem-${safeKey}.json`);
        const record = JSON.stringify({
          key: idKey,
          digest,
          verdict,
        });
        try {
          const existing = await readFile(path, "utf8");
          const parsed = JSON.parse(existing) as {
            digest: string;
            verdict: EvidenceVerdict;
          };
          if (parsed.digest !== digest) return "conflict";
          return "replay";
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
        const temporary = `${path}.${process.pid}.tmp`;
        const file = await open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(record);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
        return "stored";
      } finally {
        await journal.close();
      }
    },
    async lookupIdempotency(idKey) {
      const journal = await openBoundPath(JOURNAL_COMPONENTS);
      try {
        const safeKey = sha256Hex(idKey);
        const path = journal.at(`idem-${safeKey}.json`);
        try {
          const existing = await readFile(path, "utf8");
          const parsed = JSON.parse(existing) as {
            digest: string;
            verdict: EvidenceVerdict;
          };
          return {
            digest: parsed.digest,
            verdict: deepFreeze(parsed.verdict),
          };
        } catch (error) {
          if (errorCode(error) === "ENOENT") return undefined;
          throw error;
        }
      } finally {
        await journal.close();
      }
    },
    locked(operation) {
      if (holder.getStore()) return operation();
      const run = () => holder.run(true, operation);
      const result = queue.then(run, run);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

export function createEvidenceVerdictService(options: {
  readonly store: EvidenceVerdictStore;
  readonly packets: EvidencePacketReader;
  readonly receipts: ReceiptFailureReader;
  readonly verifier: PacketVerifier;
}): EvidenceVerdictService {
  const { store, packets, receipts, verifier } = options;
  if (!packets || typeof packets.get !== "function") {
    throw new Error("EvidencePacketReader (packets) is required.");
  }
  if (!receipts || typeof receipts.get !== "function") {
    throw new Error("ReceiptFailureReader (receipts) is required.");
  }
  if (!verifier || typeof verifier.verifyReferences !== "function") {
    throw new Error("PacketVerifier (verifier) is required.");
  }

  return {
    async apply(input) {
      if (!isPlainObject(input)) {
        return failure("INVALID_INPUT", "Apply input must be a plain object.");
      }
      const allowed = new Set([
        "questionId",
        "packetId",
        "packetVersion",
        "requiredFacetIds",
        "referenceReviews",
        "facetStates",
        "verdict",
        "criticisms",
        "followUpRequest",
        "expectedVersion",
        "idempotencyKey",
      ]);
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key === "symbol" || !allowed.has(key)) {
          return failure("INVALID_INPUT", "Unknown or hostile apply fields.");
        }
        if (!ownData(input, key).ok) {
          return failure("INVALID_INPUT", "Hostile accessors are rejected.");
        }
      }

      const questionProp = ownData(input, "questionId");
      if (!questionProp.ok || !questionProp.present) {
        return failure("INVALID_INPUT", "questionId is required.");
      }
      const questionParsed = QuestionIdSchema.safeParse(questionProp.value);
      if (!questionParsed.success) {
        return failure("INVALID_INPUT", "questionId is malformed.");
      }
      const questionId = questionParsed.data as QuestionId;

      const packetIdProp = ownData(input, "packetId");
      if (!packetIdProp.ok || !packetIdProp.present) {
        return failure("INVALID_INPUT", "packetId is required.");
      }
      const packetIdParsed = EvidencePacketIdSchema.safeParse(
        packetIdProp.value,
      );
      if (!packetIdParsed.success) {
        return failure("INVALID_INPUT", "packetId is malformed.");
      }
      const packetId = packetIdParsed.data as EvidencePacketId;

      const packetVersionProp = ownData(input, "packetVersion");
      if (!packetVersionProp.ok || !packetVersionProp.present) {
        return failure("INVALID_INPUT", "packetVersion is required.");
      }
      if (
        typeof packetVersionProp.value !== "number" ||
        !Number.isInteger(packetVersionProp.value) ||
        packetVersionProp.value < 1
      ) {
        return failure("INVALID_INPUT", "packetVersion is invalid.");
      }
      const packetVersion = packetVersionProp.value;

      const requiredProp = ownData(input, "requiredFacetIds");
      if (!requiredProp.ok || !requiredProp.present) {
        return failure("INVALID_INPUT", "requiredFacetIds is required.");
      }
      if (
        !Array.isArray(requiredProp.value) ||
        Object.getPrototypeOf(requiredProp.value) !== Array.prototype
      ) {
        return failure(
          "INVALID_INPUT",
          "requiredFacetIds must be a plain array.",
        );
      }
      if (requiredProp.value.length === 0) {
        return failure("INVALID_INPUT", "requiredFacetIds must be non-empty.");
      }
      const requiredFacetIds: string[] = [];
      for (let index = 0; index < requiredProp.value.length; index += 1) {
        const item = ownData(requiredProp.value as object, String(index));
        if (!item.ok || !item.present || typeof item.value !== "string") {
          return failure("INVALID_INPUT", "Hostile requiredFacetIds entry.");
        }
        if (item.value.length === 0 || item.value.length > 128) {
          return failure("INVALID_INPUT", "requiredFacetId is invalid.");
        }
        requiredFacetIds.push(item.value);
      }
      const requiredSet = new Set(requiredFacetIds);
      if (requiredSet.size !== requiredFacetIds.length) {
        return failure("INVALID_INPUT", "requiredFacetIds must be unique.");
      }

      const verdictProp = ownData(input, "verdict");
      if (!verdictProp.ok || !verdictProp.present) {
        return failure("INVALID_INPUT", "verdict is required.");
      }
      const verdictParsed = TerminalVerdictSchema.safeParse(verdictProp.value);
      if (!verdictParsed.success) {
        return failure("INVALID_INPUT", "verdict is not a closed terminal.");
      }
      const terminal = verdictParsed.data;

      const reviewsProp = ownData(input, "referenceReviews");
      if (!reviewsProp.ok || !reviewsProp.present) {
        return failure("INVALID_INPUT", "referenceReviews is required.");
      }
      if (
        !Array.isArray(reviewsProp.value) ||
        Object.getPrototypeOf(reviewsProp.value) !== Array.prototype
      ) {
        return failure(
          "INVALID_INPUT",
          "referenceReviews must be a plain array.",
        );
      }
      const reviews: ReferenceReview[] = [];
      const reviewedUnits = new Set<string>();
      for (let index = 0; index < reviewsProp.value.length; index += 1) {
        const item = ownData(reviewsProp.value as object, String(index));
        if (!item.ok || !item.present) {
          return failure("INVALID_INPUT", "Hostile referenceReviews entry.");
        }
        const parsed = ReferenceReviewSchema.safeParse(item.value);
        if (!parsed.success) {
          return failure(
            "INVALID_INPUT",
            `referenceReviews[${index}] invalid.`,
          );
        }
        if (reviewedUnits.has(parsed.data.unitId)) {
          return failure("INVALID_INPUT", "Duplicate reference review unitId.");
        }
        reviewedUnits.add(parsed.data.unitId);
        reviews.push(parsed.data);
      }

      const facetsProp = ownData(input, "facetStates");
      if (!facetsProp.ok || !facetsProp.present) {
        return failure("INVALID_INPUT", "facetStates is required.");
      }
      if (
        !Array.isArray(facetsProp.value) ||
        Object.getPrototypeOf(facetsProp.value) !== Array.prototype
      ) {
        return failure("INVALID_INPUT", "facetStates must be a plain array.");
      }
      const facetStates: FacetStateRecord[] = [];
      const facetIds = new Set<string>();
      for (let index = 0; index < facetsProp.value.length; index += 1) {
        const item = ownData(facetsProp.value as object, String(index));
        if (!item.ok || !item.present) {
          return failure("INVALID_INPUT", "Hostile facetStates entry.");
        }
        const parsed = FacetStateRecordSchema.safeParse(item.value);
        if (!parsed.success) {
          return failure("INVALID_INPUT", `facetStates[${index}] invalid.`);
        }
        if (facetIds.has(parsed.data.facetId)) {
          return failure("INVALID_INPUT", "Duplicate facetId.");
        }
        facetIds.add(parsed.data.facetId);
        const facet: FacetStateRecord = {
          facetId: parsed.data.facetId,
          state: parsed.data.state,
          reason: parsed.data.reason,
          ...(parsed.data.sourceUnitIds !== undefined
            ? { sourceUnitIds: parsed.data.sourceUnitIds }
            : {}),
        };
        facetStates.push(facet);
      }

      const criticismsProp = ownData(input, "criticisms");
      if (!criticismsProp.ok || !criticismsProp.present) {
        return failure("INVALID_INPUT", "criticisms is required.");
      }
      if (
        !Array.isArray(criticismsProp.value) ||
        Object.getPrototypeOf(criticismsProp.value) !== Array.prototype
      ) {
        return failure("INVALID_INPUT", "criticisms must be a plain array.");
      }
      const criticisms: string[] = [];
      for (let index = 0; index < criticismsProp.value.length; index += 1) {
        const item = ownData(criticismsProp.value as object, String(index));
        if (!item.ok || !item.present || typeof item.value !== "string") {
          return failure("INVALID_INPUT", "Hostile criticisms entry.");
        }
        if (item.value.length === 0 || item.value.length > 2_000) {
          return failure("INVALID_INPUT", "criticism string invalid.");
        }
        criticisms.push(item.value);
      }

      let followUpRequest: BoundedFollowUp | null = null;
      const followProp = ownData(input, "followUpRequest");
      if (!followProp.ok) {
        return failure("INVALID_INPUT", "Hostile followUpRequest.");
      }
      if (followProp.present) {
        if (followProp.value === null) {
          followUpRequest = null;
        } else {
          const parsed = BoundedFollowUpSchema.safeParse(followProp.value);
          if (!parsed.success) {
            return failure("INVALID_INPUT", "followUpRequest is invalid.");
          }
          const data = parsed.data;
          followUpRequest = {
            missingFacetIds: data.missingFacetIds,
            whyCurrentPacketFails: data.whyCurrentPacketFails,
            ...(data.requiredSearch !== undefined
              ? {
                  requiredSearch: {
                    subject: data.requiredSearch.subject,
                    ...(data.requiredSearch.scope !== undefined
                      ? { scope: data.requiredSearch.scope }
                      : {}),
                    ...(data.requiredSearch.exclusions !== undefined
                      ? { exclusions: data.requiredSearch.exclusions }
                      : {}),
                  },
                }
              : {}),
          };
        }
      }

      let expectedVersion: number | undefined;
      const expectedProp = ownData(input, "expectedVersion");
      if (expectedProp.ok && expectedProp.present) {
        if (
          typeof expectedProp.value !== "number" ||
          !Number.isInteger(expectedProp.value) ||
          expectedProp.value < 0
        ) {
          return failure("INVALID_INPUT", "expectedVersion is invalid.");
        }
        expectedVersion = expectedProp.value;
      }

      let idempotencyKey: string | undefined;
      const idemProp = ownData(input, "idempotencyKey");
      if (idemProp.ok && idemProp.present) {
        if (typeof idemProp.value !== "string" || idemProp.value.length === 0) {
          return failure("INVALID_INPUT", "idempotencyKey must be a string.");
        }
        idempotencyKey = idemProp.value;
      }

      // Authoritative packet
      let packet: EvidencePacket | undefined;
      try {
        packet = await packets.get(packetId, packetVersion);
      } catch {
        return failure("COMMIT_FAILED", "Packet reader failed.");
      }
      if (!packet) {
        return failure(
          "PACKET_NOT_FOUND",
          `Unknown packet ${packetId}@${packetVersion}.`,
        );
      }
      if (packet.questionId !== questionId) {
        return failure(
          "PACKET_MISMATCH",
          "questionId does not match stored packet.",
        );
      }
      if (packet.id !== packetId || packet.version !== packetVersion) {
        return failure(
          "PACKET_MISMATCH",
          "packet identity mismatch with store.",
        );
      }

      const verified = await verifier.verifyReferences(packetId, packetVersion);
      if (!verified.ok) {
        return failure(
          "PACKET_UNVERIFIED",
          verified.message ?? "Packet verifyReferences failed.",
        );
      }

      // Receipt re-read for outage defense-in-depth
      const receipt = await receipts.get(packet.receiptId);
      if (!receipt) {
        return failure(
          "RECEIPT_INVALID",
          "Canonical receipt missing for packet.",
        );
      }
      if (!Array.isArray(receipt.failures)) {
        return failure("RECEIPT_INVALID", "Receipt failures missing.");
      }
      const hasOutage = receipt.failures.some((code) => OUTAGE_CODES.has(code));

      const packetUnitIds = new Set(
        packet.references.map((reference) => reference.unitId),
      );
      for (const review of reviews) {
        if (!packetUnitIds.has(review.unitId)) {
          return failure(
            "INVALID_INPUT",
            `Review unit ${review.unitId} is not on the packet.`,
          );
        }
      }
      for (const facet of facetStates) {
        if (facet.sourceUnitIds) {
          for (const unitId of facet.sourceUnitIds) {
            if (!packetUnitIds.has(unitId)) {
              return failure(
                "INVALID_INPUT",
                `Facet source unit ${unitId} is not on the packet.`,
              );
            }
          }
        }
      }

      // Material = primary
      const materialUnitIds = packet.references
        .filter((reference) => reference.role === "primary")
        .map((reference) => reference.unitId);

      // Terminal-specific gates
      if (terminal === "accepted") {
        if (packet.references.length === 0) {
          return failure("EMPTY_PACKET", "Empty packet cannot be accepted.");
        }
        if (hasOutage) {
          return failure(
            "OUTAGE_NOT_GAP",
            "Outage receipt cannot authorize accepted.",
          );
        }
        if (followUpRequest !== null) {
          return failure(
            "INVALID_INPUT",
            "accepted must not carry followUpRequest.",
          );
        }
        for (const required of requiredFacetIds) {
          if (!facetIds.has(required)) {
            return failure(
              "FACET_UNSATISFIED",
              `Required facet ${required} missing from facetStates.`,
            );
          }
        }
        for (const facet of facetStates) {
          if (!requiredSet.has(facet.facetId)) continue;
          if (facet.state === "not_applicable") {
            return failure(
              "FACET_REQUIRED_NA",
              `Required facet ${facet.facetId} cannot be not_applicable.`,
            );
          }
          if (facet.state !== "satisfied") {
            return failure(
              "FACET_UNSATISFIED",
              `Required facet ${facet.facetId} is ${facet.state}, not satisfied.`,
            );
          }
        }
        for (const unitId of materialUnitIds) {
          if (!reviewedUnits.has(unitId)) {
            return failure(
              "REFERENCE_UNCLASSIFIED",
              `Material (primary) unit ${unitId} lacks a classification.`,
            );
          }
        }
        for (const review of reviews) {
          if (!materialUnitIds.includes(review.unitId)) continue;
          if (
            review.classification === "conflicting" ||
            review.classification === "unverifiable"
          ) {
            return failure(
              "REFERENCE_INVALID",
              `Material review ${review.unitId} is ${review.classification}.`,
            );
          }
        }
      } else if (terminal === "no_supported_answer") {
        if (hasOutage) {
          return failure(
            "OUTAGE_NOT_GAP",
            "Retrieval outage cannot become no_supported_answer.",
          );
        }
        if (followUpRequest !== null) {
          return failure(
            "INVALID_INPUT",
            "no_supported_answer must not carry followUpRequest.",
          );
        }
        // All material must still be classified when present
        for (const unitId of materialUnitIds) {
          if (!reviewedUnits.has(unitId)) {
            return failure(
              "REFERENCE_UNCLASSIFIED",
              `Material unit ${unitId} lacks a classification.`,
            );
          }
        }
      } else if (terminal === "needs_more_evidence") {
        if (followUpRequest === null) {
          return failure(
            "FOLLOW_UP_REQUIRED",
            "needs_more_evidence requires BoundedFollowUp.",
          );
        }
        const hasMissing =
          followUpRequest.missingFacetIds.length > 0 ||
          (followUpRequest.requiredSearch !== undefined &&
            followUpRequest.requiredSearch.subject.length > 0);
        if (!hasMissing) {
          return failure(
            "FOLLOW_UP_REQUIRED",
            "BoundedFollowUp must name missing facets or a search subject.",
          );
        }
        for (const unitId of materialUnitIds) {
          if (!reviewedUnits.has(unitId)) {
            return failure(
              "REFERENCE_UNCLASSIFIED",
              `Material unit ${unitId} lacks a classification.`,
            );
          }
        }
      } else {
        // Other terminals: follow-up must be null; material classified when present
        if (followUpRequest !== null) {
          return failure(
            "INVALID_INPUT",
            `${terminal} must not carry followUpRequest.`,
          );
        }
        for (const unitId of materialUnitIds) {
          if (!reviewedUnits.has(unitId)) {
            return failure(
              "REFERENCE_UNCLASSIFIED",
              `Material unit ${unitId} lacks a classification.`,
            );
          }
        }
        // search_incomplete allowed under outage; other terminals: outage only blocks no_supported_answer
      }

      // Required facet coverage for non-accepted (set equality of required present)
      for (const required of requiredFacetIds) {
        if (!facetIds.has(required)) {
          // For non-accepted, still require states for required facets
          if (terminal === "accepted") {
            // already handled
          } else {
            return failure(
              "FACET_UNSATISFIED",
              `Required facet ${required} missing from facetStates.`,
            );
          }
        }
      }

      const packetDigest = canonicalPacketPayloadDigest({
        questionId: packet.questionId,
        receiptId: packet.receiptId,
        receiptDigest: packet.receiptDigest,
        references: packet.references,
      });

      const frozenReviews = Object.freeze(
        reviews.map((review) =>
          deepFreeze({
            unitId: review.unitId,
            classification: review.classification,
            reason: review.reason,
          }),
        ),
      );
      const frozenFacets = Object.freeze(
        facetStates.map((facet) =>
          deepFreeze({
            facetId: facet.facetId,
            state: facet.state,
            ...(facet.sourceUnitIds
              ? {
                  sourceUnitIds: Object.freeze([...facet.sourceUnitIds]),
                }
              : {}),
            reason: facet.reason,
          }),
        ),
      );
      const frozenCriticisms = Object.freeze([...criticisms]);
      const frozenFollowUp: BoundedFollowUp | null =
        followUpRequest === null
          ? null
          : deepFreeze({
              missingFacetIds: Object.freeze([
                ...followUpRequest.missingFacetIds,
              ]) as readonly string[],
              ...(followUpRequest.requiredSearch
                ? {
                    requiredSearch: deepFreeze({
                      subject: followUpRequest.requiredSearch.subject,
                      ...(followUpRequest.requiredSearch.scope !== undefined
                        ? { scope: followUpRequest.requiredSearch.scope }
                        : {}),
                      ...(followUpRequest.requiredSearch.exclusions
                        ? {
                            exclusions: Object.freeze([
                              ...followUpRequest.requiredSearch.exclusions,
                            ]) as readonly string[],
                          }
                        : {}),
                    }),
                  }
                : {}),
              whyCurrentPacketFails: followUpRequest.whyCurrentPacketFails,
            } satisfies BoundedFollowUp);

      const digest = canonicalVerdictPayloadDigest({
        questionId,
        packetId,
        packetVersion,
        packetDigest,
        referenceReviews: frozenReviews,
        facetStates: frozenFacets,
        verdict: terminal,
        criticisms: frozenCriticisms,
        followUpRequest,
      });

      const verdictId = deriveEvidenceVerdictId(questionId, packetId);
      const transition = computeTransition(terminal, frozenFacets);

      try {
        return await store.locked(async () => {
          if (idempotencyKey !== undefined) {
            const idKey = `${verdictId}:${idempotencyKey}`;
            if (store.lookupIdempotency) {
              const prior = await store.lookupIdempotency(idKey);
              if (prior) {
                if (prior.digest !== digest) {
                  return failure(
                    "IDEMPOTENCY_CONFLICT",
                    "Idempotency key reused with a different payload.",
                  );
                }
                return success(
                  deepFreeze(structuredClone(prior.verdict)),
                  computeTransition(
                    prior.verdict.verdict,
                    prior.verdict.facetStates,
                  ),
                );
              }
            }
          }

          const latest = await store.latest(verdictId);
          const nextVersion = latest ? latest.version + 1 : 1;

          if (expectedVersion !== undefined) {
            const base = latest?.version ?? 0;
            if (expectedVersion !== base) {
              return failure(
                "VERSION_CONFLICT",
                `expectedVersion ${expectedVersion} does not match current ${base}.`,
              );
            }
          } else if (latest) {
            // Second different apply without expectedVersion bump → conflict
            // (identical payload with idempotency already handled above)
            return failure(
              "VERSION_CONFLICT",
              "A verdict already exists for this packet; provide expectedVersion to append.",
            );
          }

          const record: EvidenceVerdict = deepFreeze({
            schemaVersion: 1 as const,
            id: verdictId,
            questionId,
            packetId,
            packetVersion,
            version: nextVersion,
            referenceReviews: frozenReviews,
            facetStates: frozenFacets,
            verdict: terminal,
            criticisms: frozenCriticisms,
            followUpRequest: frozenFollowUp,
            packetDigest,
          });

          if (!EvidenceVerdictSchema.safeParse(record).success) {
            return failure("INVALID_INPUT", "Derived verdict failed schema.");
          }

          const appendResult = await store.append(record);
          if (appendResult === "exists_conflict") {
            return failure(
              "OVERWRITE_DENIED",
              "Append-only store refused to overwrite verdict version.",
            );
          }
          if (idempotencyKey !== undefined && store.rememberIdempotency) {
            const remembered = await store.rememberIdempotency(
              `${verdictId}:${idempotencyKey}`,
              digest,
              record,
            );
            if (remembered === "conflict") {
              return failure(
                "IDEMPOTENCY_CONFLICT",
                "Idempotency key reused with a different payload.",
              );
            }
          }
          return success(record, transition);
        });
      } catch (error) {
        const mapped = mapCustodyError(error);
        if (mapped === "rethrow") throw error;
        if (mapped) return mapped;
        return failure("COMMIT_FAILED", "Durable verdict store commit failed.");
      }
    },

    async getVerdict(verdictId, version) {
      if (typeof verdictId !== "string" || !verdictId.startsWith("evv-")) {
        return {
          ok: false,
          code: "INVALID_INPUT",
          message: "verdictId is malformed.",
        };
      }
      if (!Number.isInteger(version) || version < 1) {
        return {
          ok: false,
          code: "INVALID_INPUT",
          message: "version is invalid.",
        };
      }
      try {
        const verdict = await store.get(
          verdictId as EvidenceVerdictId,
          version,
        );
        if (!verdict) {
          return {
            ok: false,
            code: "VERDICT_NOT_FOUND",
            message: `Unknown verdict ${verdictId}@${version}.`,
          };
        }
        return { ok: true, value: deepFreeze(verdict) };
      } catch (error) {
        return mapReadError(error);
      }
    },

    async latest(verdictId) {
      if (typeof verdictId !== "string" || !verdictId.startsWith("evv-")) {
        return {
          ok: false,
          code: "INVALID_INPUT",
          message: "verdictId is malformed.",
        };
      }
      try {
        const verdict = await store.latest(verdictId as EvidenceVerdictId);
        if (!verdict) {
          return {
            ok: false,
            code: "VERDICT_NOT_FOUND",
            message: `No verdict stream for ${verdictId}.`,
          };
        }
        return { ok: true, value: deepFreeze(verdict) };
      } catch (error) {
        return mapReadError(error);
      }
    },
  };
}
