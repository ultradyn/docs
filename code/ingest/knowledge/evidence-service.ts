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
import { join } from "node:path";

import {
  DEFAULT_EVIDENCE_PACKET_LIMITS,
  EvidencePacketLimitsSchema,
  EvidencePacketSchema,
  EvidenceReferenceSchema,
  canonicalPacketPayloadDigest,
  type EvidencePacket,
  type EvidencePacketLimits,
  type EvidenceReference,
} from "../../domain/ingest/evidence-packet.js";
import type {
  EvidencePacketId,
  IngestResult,
  Sha256,
  SnapshotId,
  SourceFileId,
  SourceUnitId,
} from "../../domain/ingest/index.js";
import {
  QuestionIdSchema,
  SearchReceiptSchema,
} from "../../domain/ingest/index.js";

export type EvidenceServiceError =
  | "INVALID_INPUT"
  | "HASH_MISMATCH"
  | "UNRESOLVED_REFERENCE"
  | "RECEIPT_REQUIRED"
  | "RECEIPT_INVALID"
  | "VERSION_CONFLICT"
  | "PACKET_NOT_FOUND"
  | "OVERWRITE_DENIED"
  | "LIMIT_EXCEEDED"
  | "IDEMPOTENCY_CONFLICT"
  | "LINK_REQUIRED"
  | "QUESTION_NOT_FOUND"
  | "COMMIT_FAILED"
  | "STREAM_CORRUPT";

export interface SourceHashContext {
  fileSha256(snapshotId: SnapshotId, fileId: SourceFileId): Sha256 | undefined;
  unitBinding(
    snapshotId: SnapshotId,
    unitId: SourceUnitId,
  ):
    | { readonly textSha256: Sha256; readonly sourceFileId: SourceFileId }
    | undefined;
}

export interface QuestionLinkReader {
  get(questionId: string): Promise<
    | {
        readonly questionId: string;
        readonly snapshotId: SnapshotId | string;
        readonly sourceUnitIds?: readonly string[];
      }
    | undefined
  >;
}

/** Canonical stored receipt reader for verifyReferences rehash. */
export interface ReceiptReader {
  get(receiptId: string): Promise<
    | {
        readonly id: string;
        readonly snapshotId: string;
        readonly indexVersion: string;
        readonly indexedRepresentationsSha256: string;
        readonly query: string;
        readonly filters: unknown;
        readonly candidateIds: readonly string[];
        readonly selectedIds: readonly string[];
        readonly failures: readonly string[];
      }
    | undefined
  >;
}

export interface EvidencePacketStore {
  get(
    packetId: EvidencePacketId,
    version: number,
  ): Promise<EvidencePacket | undefined>;
  latest(packetId: EvidencePacketId): Promise<EvidencePacket | undefined>;
  append(
    packet: EvidencePacket,
  ): Promise<"created" | "exists_identical" | "exists_conflict">;
  locked<T>(operation: () => Promise<T>): Promise<T>;
  /** Durable ops journal for idempotency across process restarts. */
  rememberIdempotency?(
    key: string,
    digest: string,
    packet: EvidencePacket,
  ): Promise<"stored" | "conflict" | "replay">;
  lookupIdempotency?(
    key: string,
  ): Promise<{ digest: string; packet: EvidencePacket } | undefined>;
}

export interface EvidenceService {
  appendPacket(
    input: unknown,
  ): Promise<IngestResult<EvidencePacket, EvidenceServiceError>>;
  verifyReferences(
    packetId: EvidencePacketId | string,
    version: number,
    context: SourceHashContext,
  ): Promise<IngestResult<true, EvidenceServiceError>>;
  getPacket(
    packetId: EvidencePacketId | string,
    version: number,
  ): Promise<IngestResult<EvidencePacket, EvidenceServiceError>>;
}

function failure(
  code: EvidenceServiceError,
  message: string,
): IngestResult<never, EvidenceServiceError> {
  return { ok: false, code, message };
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

export function deriveEvidencePacketId(questionId: string): EvidencePacketId {
  const hex = createHash("sha256")
    .update(`evidence-packet:${questionId}`)
    .digest("hex")
    .toUpperCase();
  const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let body = "";
  for (let index = 0; index < 26; index += 1) {
    const nibble = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    body += crockford[nibble % 32]!;
  }
  return `pkt-${body}` as EvidencePacketId;
}

export function receiptDigestOf(receipt: {
  readonly id: string;
  readonly snapshotId: string;
  readonly indexVersion: string;
  readonly indexedRepresentationsSha256: string;
  readonly query: string;
  readonly filters: unknown;
  readonly candidateIds: readonly string[];
  readonly selectedIds: readonly string[];
  readonly failures: readonly string[];
}): Sha256 {
  // Fixed field order for digest stability.
  const material = [
    ["id", receipt.id],
    ["snapshotId", receipt.snapshotId],
    ["indexVersion", receipt.indexVersion],
    ["indexedRepresentationsSha256", receipt.indexedRepresentationsSha256],
    ["query", receipt.query],
    ["filters", receipt.filters],
    ["candidateIds", [...receipt.candidateIds]],
    ["selectedIds", [...receipt.selectedIds]],
    ["failures", [...receipt.failures]],
  ] as const;
  return sha256Hex(JSON.stringify(material));
}

function canonicalizeReferences(
  references: readonly EvidenceReference[],
): EvidenceReference[] {
  return references.map((reference) =>
    deepFreeze({
      snapshotId: reference.snapshotId,
      fileId: reference.fileId,
      unitId: reference.unitId,
      fileSha256: reference.fileSha256,
      unitSha256: reference.unitSha256,
      role: reference.role,
      facetIds: Object.freeze(
        [...new Set(reference.facetIds)].sort((a, b) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      ),
    }),
  );
}

function verifyReferenceAgainstContext(
  reference: EvidenceReference,
  context: SourceHashContext,
): IngestResult<true, EvidenceServiceError> {
  const fileHash = context.fileSha256(reference.snapshotId, reference.fileId);
  if (fileHash === undefined) {
    return failure(
      "UNRESOLVED_REFERENCE",
      `Unknown file ${reference.fileId} in snapshot ${reference.snapshotId}.`,
    );
  }
  if (fileHash !== reference.fileSha256) {
    return failure(
      "HASH_MISMATCH",
      `File hash mismatch for ${reference.fileId}.`,
    );
  }
  const unit = context.unitBinding(reference.snapshotId, reference.unitId);
  if (unit === undefined) {
    return failure(
      "UNRESOLVED_REFERENCE",
      `Unknown unit ${reference.unitId} in snapshot ${reference.snapshotId}.`,
    );
  }
  if (unit.sourceFileId !== reference.fileId) {
    return failure(
      "UNRESOLVED_REFERENCE",
      `Unit ${reference.unitId} is not bound to file ${reference.fileId}.`,
    );
  }
  if (unit.textSha256 !== reference.unitSha256) {
    return failure(
      "HASH_MISMATCH",
      `Unit hash mismatch for ${reference.unitId}.`,
    );
  }
  return { ok: true, value: true };
}

export function createInMemoryEvidencePacketStore(): EvidencePacketStore {
  const packets = new Map<string, EvidencePacket>();
  const idem = new Map<string, { digest: string; packet: EvidencePacket }>();
  const holder = new AsyncLocalStorage<true>();
  let queue: Promise<unknown> = Promise.resolve();

  function key(id: string, version: number): string {
    return `${id}@${version}`;
  }

  return {
    async get(packetId, version) {
      const packet = packets.get(key(packetId, version));
      return packet ? deepFreeze(structuredClone(packet)) : undefined;
    },
    async latest(packetId) {
      let best: EvidencePacket | undefined;
      for (const packet of packets.values()) {
        if (packet.id !== packetId) continue;
        if (!best || packet.version > best.version) best = packet;
      }
      return best ? deepFreeze(structuredClone(best)) : undefined;
    },
    async append(packet) {
      const k = key(packet.id, packet.version);
      const existing = packets.get(k);
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(packet)) {
          return "exists_identical";
        }
        return "exists_conflict";
      }
      packets.set(k, deepFreeze(structuredClone(packet)));
      return "created";
    },
    async rememberIdempotency(idKey, digest, packet) {
      const prior = idem.get(idKey);
      if (prior) {
        if (prior.digest !== digest) return "conflict";
        return "replay";
      }
      idem.set(idKey, {
        digest,
        packet: deepFreeze(structuredClone(packet)),
      });
      return "stored";
    },
    async lookupIdempotency(idKey) {
      const prior = idem.get(idKey);
      return prior
        ? {
            digest: prior.digest,
            packet: deepFreeze(structuredClone(prior.packet)),
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
const EVIDENCE_COMPONENTS = [".ultradyn", "evidence", "packets"] as const;
const JOURNAL_COMPONENTS = [".ultradyn", "evidence", "journal"] as const;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export interface FileEvidencePacketStoreHooks {
  /** Test-only fault seam: after temp write, before publish rename. */
  afterTempWriteBeforePublish?: () => void | Promise<void>;
}

/**
 * Descriptor-bound durable evidence store.
 * Fails closed when Linux /proc fd binding is unavailable.
 */
export function createFileEvidencePacketStore(
  root: string,
  hooks: FileEvidencePacketStoreHooks = {},
): EvidencePacketStore {
  if (!FD_BOUND) {
    const unavailable = () => {
      throw new Error(
        "Descriptor binding unavailable: file evidence store fail-closed.",
      );
    };
    return {
      get: unavailable as EvidencePacketStore["get"],
      latest: unavailable as EvidencePacketStore["latest"],
      append: unavailable as EvidencePacketStore["append"],
      locked: (operation) => operation(),
      rememberIdempotency: unavailable as NonNullable<
        EvidencePacketStore["rememberIdempotency"]
      >,
      lookupIdempotency: unavailable as NonNullable<
        EvidencePacketStore["lookupIdempotency"]
      >,
    };
  }

  const holder = new AsyncLocalStorage<true>();
  let queue: Promise<unknown> = Promise.resolve();

  async function openBoundPath(
    components: readonly string[],
  ): Promise<{ dir: string; close: () => Promise<void> }> {
    let handle = await open(root, DIRECTORY_FLAGS).catch((error: unknown) => {
      const code = errorCode(error);
      if (code === "ELOOP" || code === "ENOTDIR") {
        throw new Error(
          "Refusing symbolic-link or non-directory evidence root.",
          {
            cause: error,
          },
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
      const dir = join(root, ...components);
      return {
        dir,
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

  function packetFileName(id: string, version: number): string {
    return `${id}-v${String(version).padStart(8, "0")}.json`;
  }

  const PACKET_NAME = /^(pkt-[0-9A-HJKMNP-TV-Z]{26})-v(\d{8})\.json$/u;

  async function listPacketStream(
    dir: string,
    packetId: string,
  ): Promise<EvidencePacket[]> {
    const names = await readdir(dir);
    const versions = new Map<number, string>();
    for (const name of names) {
      if (name.endsWith(".tmp")) continue;
      const match = PACKET_NAME.exec(name);
      if (!match) {
        // Unknown files in stream dir are attack/corrupt.
        throw new Error(`STREAM_CORRUPT: unexpected file ${name}`);
      }
      const id = match[1]!;
      const version = Number(match[2]);
      if (id !== packetId) continue;
      if (versions.has(version)) {
        throw new Error(`STREAM_CORRUPT: duplicate version ${version}`);
      }
      versions.set(version, name);
    }
    if (versions.size === 0) return [];
    const sorted = [...versions.keys()].sort((a, b) => a - b);
    // Contiguous from 1..N
    for (let index = 0; index < sorted.length; index += 1) {
      if (sorted[index] !== index + 1) {
        throw new Error(
          `STREAM_CORRUPT: version gap or non-start at ${sorted.join(",")}`,
        );
      }
    }
    const packets: EvidencePacket[] = [];
    for (const version of sorted) {
      const name = versions.get(version)!;
      // Leaf no-follow read
      let handle;
      try {
        handle = await open(
          join(dir, name),
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
        const parsed = EvidencePacketSchema.safeParse(JSON.parse(bytes));
        if (!parsed.success) {
          throw new Error(`STREAM_CORRUPT: malformed packet ${name}`);
        }
        if (parsed.data.id !== packetId || parsed.data.version !== version) {
          throw new Error(
            `STREAM_CORRUPT: cross-stream or rename attack ${name}`,
          );
        }
        packets.push(deepFreeze(parsed.data as EvidencePacket));
      } finally {
        await handle.close();
      }
    }
    return packets;
  }

  return {
    async get(packetId, version) {
      // Never fall back to process memory — durable only.
      const bound = await openBoundPath(EVIDENCE_COMPONENTS);
      try {
        const path = join(bound.dir, packetFileName(packetId, version));
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
          const parsed = EvidencePacketSchema.safeParse(JSON.parse(bytes));
          if (!parsed.success) {
            throw new Error("STREAM_CORRUPT: malformed packet bytes");
          }
          return deepFreeze(parsed.data as EvidencePacket);
        } finally {
          await handle.close();
        }
      } finally {
        await bound.close();
      }
    },
    async latest(packetId) {
      const bound = await openBoundPath(EVIDENCE_COMPONENTS);
      try {
        const stream = await listPacketStream(bound.dir, packetId);
        return stream.at(-1);
      } finally {
        await bound.close();
      }
    },
    async append(packet) {
      const bound = await openBoundPath(EVIDENCE_COMPONENTS);
      const path = join(bound.dir, packetFileName(packet.id, packet.version));
      const bytes = `${JSON.stringify(packet)}\n`;
      const temporary = `${path}.${process.pid}-${Date.now()}.tmp`;
      try {
        // Validate stream before append (contiguous)
        const stream = await listPacketStream(bound.dir, packet.id);
        const expectedNext = stream.length + 1;
        if (packet.version !== expectedNext) {
          // Allow exact replay of last version only via exists_* paths below
          if (!(
            stream.length > 0 && packet.version === stream.at(-1)!.version
          )) {
            throw new Error(
              `STREAM_CORRUPT: append version ${packet.version} != next ${expectedNext}`,
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
        // Journal intent then publish (single-commit: journal first)
        const journal = await openBoundPath(JOURNAL_COMPONENTS);
        try {
          const intentPath = join(
            journal.dir,
            `intent-${packet.id}-v${packet.version}.json`,
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
                packetId: packet.id,
                version: packet.version,
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
    async rememberIdempotency(idKey, digest, packet) {
      const journal = await openBoundPath(JOURNAL_COMPONENTS);
      try {
        const safeKey = sha256Hex(idKey);
        const path = join(journal.dir, `idem-${safeKey}.json`);
        const record = JSON.stringify({
          key: idKey,
          digest,
          packet,
        });
        try {
          const existing = await readFile(path, "utf8");
          const parsed = JSON.parse(existing) as {
            digest: string;
            packet: EvidencePacket;
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
        const path = join(journal.dir, `idem-${safeKey}.json`);
        try {
          const existing = await readFile(path, "utf8");
          const parsed = JSON.parse(existing) as {
            digest: string;
            packet: EvidencePacket;
          };
          return {
            digest: parsed.digest,
            packet: deepFreeze(parsed.packet),
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

export function createEvidenceService(options: {
  readonly store: EvidencePacketStore;
  /** Mandatory authoritative question-link reader. */
  readonly links: QuestionLinkReader;
  /** Optional receipt store for verifyReferences rehash. */
  readonly receipts?: ReceiptReader;
}): EvidenceService {
  const { store, links, receipts } = options;
  if (!links || typeof links.get !== "function") {
    throw new Error("QuestionLinkReader is required.");
  }

  return {
    async appendPacket(input) {
      if (!isPlainObject(input)) {
        return failure("INVALID_INPUT", "Append input must be a plain object.");
      }
      const allowed = new Set([
        "questionId",
        "references",
        "receipt",
        "receiptDigest",
        "expectedVersion",
        "idempotencyKey",
        "limits",
        "context",
      ]);
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key === "symbol" || !allowed.has(key)) {
          return failure("INVALID_INPUT", "Unknown or hostile append fields.");
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
      const questionId = questionParsed.data;

      const link = await links.get(questionId);
      if (!link) {
        return failure(
          "LINK_REQUIRED",
          `No authoritative question link for ${questionId}.`,
        );
      }

      const receiptProp = ownData(input, "receipt");
      if (!receiptProp.ok || !receiptProp.present) {
        return failure("RECEIPT_REQUIRED", "A SearchReceipt is required.");
      }
      const receiptParsed = SearchReceiptSchema.safeParse(receiptProp.value);
      if (!receiptParsed.success) {
        return failure(
          "RECEIPT_INVALID",
          "SearchReceipt failed schema validation.",
        );
      }
      const receipt = receiptParsed.data;

      if (receipt.failures.includes("INDEX_UNAVAILABLE")) {
        return failure(
          "RECEIPT_INVALID",
          "INDEX_UNAVAILABLE receipt cannot authorize an evidence packet.",
        );
      }
      if (
        typeof receipt.indexedRepresentationsSha256 !== "string" ||
        receipt.indexedRepresentationsSha256.length !== 64 ||
        !receipt.indexVersion
      ) {
        return failure(
          "RECEIPT_INVALID",
          "SearchReceipt is not corpus-bound / healthy.",
        );
      }

      if (link.snapshotId !== receipt.snapshotId) {
        return failure(
          "HASH_MISMATCH",
          "Question link snapshotId must match receipt.snapshotId.",
        );
      }

      const digestActual = receiptDigestOf(receipt);
      const digestProp = ownData(input, "receiptDigest");
      if (!digestProp.ok || !digestProp.present) {
        return failure("INVALID_INPUT", "receiptDigest is required on append.");
      }
      if (
        typeof digestProp.value !== "string" ||
        digestProp.value !== digestActual
      ) {
        return failure(
          "HASH_MISMATCH",
          "receiptDigest does not match the provided receipt.",
        );
      }

      const referencesProp = ownData(input, "references");
      if (!referencesProp.ok || !referencesProp.present) {
        return failure("INVALID_INPUT", "references array is required.");
      }
      if (
        !Array.isArray(referencesProp.value) ||
        Object.getPrototypeOf(referencesProp.value) !== Array.prototype
      ) {
        return failure("INVALID_INPUT", "references must be a plain array.");
      }

      let limits: EvidencePacketLimits = DEFAULT_EVIDENCE_PACKET_LIMITS;
      const limitsProp = ownData(input, "limits");
      if (limitsProp.ok && limitsProp.present) {
        const ok = EvidencePacketLimitsSchema.safeParse(limitsProp.value);
        if (!ok.success) {
          return failure("INVALID_INPUT", "limits are invalid.");
        }
        limits = ok.data;
      }

      if (referencesProp.value.length > limits.maxReferences) {
        return failure("LIMIT_EXCEEDED", "Too many references.");
      }

      const references: EvidenceReference[] = [];
      for (let index = 0; index < referencesProp.value.length; index += 1) {
        const itemProp = ownData(referencesProp.value as object, String(index));
        if (!itemProp.ok || !itemProp.present) {
          return failure("INVALID_INPUT", "Hostile reference entry.");
        }
        const parsed = EvidenceReferenceSchema.safeParse(itemProp.value);
        if (!parsed.success) {
          return failure("INVALID_INPUT", `Reference ${index} is invalid.`);
        }
        if (parsed.data.facetIds.length > limits.maxFacetsPerReference) {
          return failure("LIMIT_EXCEEDED", "Too many facets on a reference.");
        }
        references.push(parsed.data);
      }

      const selected = new Set(receipt.selectedIds);
      for (const reference of references) {
        if (!selected.has(reference.unitId)) {
          return failure(
            "UNRESOLVED_REFERENCE",
            `Unit ${reference.unitId} is not in receipt.selectedIds.`,
          );
        }
        if (reference.snapshotId !== receipt.snapshotId) {
          return failure(
            "HASH_MISMATCH",
            "Reference snapshotId must match receipt.snapshotId.",
          );
        }
      }

      const contextProp = ownData(input, "context");
      if (!contextProp.ok || !contextProp.present) {
        return failure("INVALID_INPUT", "Source hash context is required.");
      }
      const context = contextProp.value as SourceHashContext;
      if (
        typeof context !== "object" ||
        context === null ||
        typeof context.fileSha256 !== "function" ||
        typeof context.unitBinding !== "function"
      ) {
        return failure("INVALID_INPUT", "Source hash context is incomplete.");
      }

      for (const reference of references) {
        const verified = verifyReferenceAgainstContext(reference, context);
        if (!verified.ok) return verified;
      }

      let idempotencyKey: string | undefined;
      const idemProp = ownData(input, "idempotencyKey");
      if (idemProp.ok && idemProp.present) {
        if (typeof idemProp.value !== "string" || idemProp.value.length === 0) {
          return failure("INVALID_INPUT", "idempotencyKey must be a string.");
        }
        idempotencyKey = idemProp.value;
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

      const canonRefs = canonicalizeReferences(references);
      const digest = canonicalPacketPayloadDigest({
        questionId,
        receiptId: receipt.id,
        receiptDigest: digestActual,
        references: canonRefs,
      });

      try {
        return await store.locked(async () => {
          if (idempotencyKey !== undefined) {
            const idKey = `${questionId}:${idempotencyKey}`;
            if (store.lookupIdempotency) {
              const prior = await store.lookupIdempotency(idKey);
              if (prior) {
                if (prior.digest !== digest) {
                  return failure(
                    "IDEMPOTENCY_CONFLICT",
                    "Idempotency key reused with a different payload.",
                  );
                }
                return {
                  ok: true,
                  value: deepFreeze(structuredClone(prior.packet)),
                };
              }
            }
          }

          const packetId = deriveEvidencePacketId(questionId);
          const latest = await store.latest(packetId);
          const nextVersion = latest ? latest.version + 1 : 1;

          if (expectedVersion !== undefined) {
            const base = latest?.version ?? 0;
            if (expectedVersion !== base) {
              return failure(
                "VERSION_CONFLICT",
                `expectedVersion ${expectedVersion} does not match current ${base}.`,
              );
            }
          }

          const packet: EvidencePacket = deepFreeze({
            schemaVersion: 1 as const,
            id: packetId,
            questionId,
            version: nextVersion,
            references: canonRefs,
            receiptId: receipt.id,
            receiptDigest: digestActual,
            limits: deepFreeze({ ...limits }),
          });

          if (!EvidencePacketSchema.safeParse(packet).success) {
            return failure("INVALID_INPUT", "Derived packet failed schema.");
          }

          const result = await store.append(packet);
          if (result === "exists_conflict") {
            return failure(
              "OVERWRITE_DENIED",
              "Append-only store refused to overwrite packet version.",
            );
          }
          if (idempotencyKey !== undefined && store.rememberIdempotency) {
            const remembered = await store.rememberIdempotency(
              `${questionId}:${idempotencyKey}`,
              digest,
              packet,
            );
            if (remembered === "conflict") {
              return failure(
                "IDEMPOTENCY_CONFLICT",
                "Idempotency key reused with a different payload.",
              );
            }
          }
          return { ok: true, value: packet };
        });
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.startsWith("Refusing") ||
            error.message.startsWith("STREAM_CORRUPT") ||
            error.message.includes("fail-closed") ||
            error.message.includes("Descriptor binding"))
        ) {
          return failure(
            error.message.startsWith("STREAM_CORRUPT")
              ? "STREAM_CORRUPT"
              : "COMMIT_FAILED",
            error.message,
          );
        }
        return failure(
          "COMMIT_FAILED",
          error instanceof Error ? error.message : "commit failed",
        );
      }
    },

    async verifyReferences(packetId, version, context) {
      if (typeof packetId !== "string" || !packetId.startsWith("pkt-")) {
        return failure("INVALID_INPUT", "packetId is malformed.");
      }
      if (!Number.isInteger(version) || version < 1) {
        return failure("INVALID_INPUT", "version is invalid.");
      }
      const packet = await store.get(packetId as EvidencePacketId, version);
      if (!packet) {
        return failure(
          "PACKET_NOT_FOUND",
          `Unknown packet ${packetId}@${version}.`,
        );
      }
      if (receipts) {
        const stored = await receipts.get(packet.receiptId);
        if (!stored) {
          return failure(
            "RECEIPT_INVALID",
            "Canonical receipt missing for packet.",
          );
        }
        const rehash = receiptDigestOf(stored);
        if (rehash !== packet.receiptDigest) {
          return failure(
            "HASH_MISMATCH",
            "Stored receipt does not match packet.receiptDigest.",
          );
        }
      }
      for (const reference of packet.references) {
        const verified = verifyReferenceAgainstContext(reference, context);
        if (!verified.ok) return verified;
      }
      return { ok: true, value: true };
    },

    async getPacket(packetId, version) {
      if (typeof packetId !== "string" || !packetId.startsWith("pkt-")) {
        return failure("INVALID_INPUT", "packetId is malformed.");
      }
      try {
        const packet = await store.get(packetId as EvidencePacketId, version);
        if (!packet) {
          return failure(
            "PACKET_NOT_FOUND",
            `Unknown packet ${packetId}@${version}.`,
          );
        }
        return { ok: true, value: packet };
      } catch (error) {
        return failure(
          "COMMIT_FAILED",
          error instanceof Error ? error.message : "get failed",
        );
      }
    },
  };
}
