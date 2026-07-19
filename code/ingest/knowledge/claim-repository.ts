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
  ClaimSchema,
  ClaimStateSchema,
  ClaimTypeSchema,
  type Claim,
  type ClaimState,
} from "../../domain/ingest/claim.js";
import type {
  ClaimId,
  IngestResult,
  Sha256,
} from "../../domain/ingest/index.js";
import { ClaimIdSchema } from "../../domain/ingest/claim.js";

export type ClaimServiceError =
  | "INVALID_INPUT"
  | "CLAIM_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "OVERWRITE_DENIED"
  | "REVIEW_REQUIRED"
  | "EVIDENCE_UNVERIFIED"
  | "ACCEPTANCE_FORBIDDEN"
  | "ILLEGAL_TRANSITION"
  | "CYCLE_DETECTED"
  | "COMMIT_FAILED"
  | "STREAM_CORRUPT";

export interface EvidenceVerificationReader {
  isVerified(ref: {
    readonly snapshotId: string;
    readonly fileId: string;
    readonly unitId: string;
    readonly fileSha256: string;
    readonly unitSha256: string;
  }): Promise<boolean>;
}

/** T-22-03 seam: grants structural acceptance authority (not crypto). */
export interface ClaimAcceptanceAuthority {
  authorizeAcceptance(input: {
    readonly claimId: string;
    readonly reviewerRunId?: string;
  }): Promise<
    | {
        readonly ok: true;
        readonly value: { readonly reviewApplicationRef: string };
      }
    | {
        readonly ok: false;
        readonly code: "ACCEPTANCE_FORBIDDEN" | string;
        readonly message: string;
      }
  >;
}

export interface ClaimStore {
  /** With version: exact; without: latest (undefined if missing). */
  get(claimId: string, version?: number): Promise<Claim | undefined>;
  latest(claimId: string): Promise<Claim | undefined>;
  append(
    claim: Claim,
  ): Promise<"created" | "exists_identical" | "exists_conflict">;
  locked<T>(operation: () => Promise<T>): Promise<T>;
  listClaimIds?(): Promise<readonly string[]>;
  rememberIdempotency?(
    key: string,
    digest: string,
    claim: Claim,
  ): Promise<"stored" | "conflict" | "replay">;
  lookupIdempotency?(
    key: string,
  ): Promise<{ digest: string; claim: Claim } | undefined>;
  writeOperationIntent?(intent: {
    readonly key: string;
    readonly commandDigest: string;
    readonly recordId: string;
    readonly version: number;
    readonly payloadDigest: string;
  }): Promise<void>;
  lookupOperationIntent?(key: string): Promise<
    | {
        readonly key: string;
        readonly commandDigest: string;
        readonly recordId: string;
        readonly version: number;
        readonly payloadDigest: string;
      }
    | undefined
  >;
  clearOperationIntent?(key: string): Promise<void>;
}

export interface ClaimRepository {
  create(input: unknown): Promise<IngestResult<Claim, ClaimServiceError>>;
  transition(input: unknown): Promise<IngestResult<Claim, ClaimServiceError>>;
  get(claimId: string): Promise<IngestResult<Claim, ClaimServiceError>>;
  getVersion(
    claimId: string,
    version: number,
  ): Promise<IngestResult<Claim, ClaimServiceError>>;
  list(): Promise<IngestResult<readonly Claim[], ClaimServiceError>>;
  markStaleFromSourceChange(
    input: unknown,
  ): Promise<IngestResult<readonly Claim[], ClaimServiceError>>;
}

function failure(
  code: ClaimServiceError,
  message: string,
): IngestResult<never, ClaimServiceError> {
  return Object.freeze({ ok: false as const, code, message });
}

function success<T>(value: T): IngestResult<T, ClaimServiceError> {
  return Object.freeze({ ok: true as const, value: deepFreeze(value) });
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

export function deriveClaimId(
  questionId: string,
  packetId: string,
  statement: string,
): ClaimId {
  const hex = createHash("sha256")
    .update(`claim:${questionId}:${packetId}:${statement}`)
    .digest("hex")
    .toUpperCase();
  const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let body = "";
  for (let index = 0; index < 26; index += 1) {
    const nibble = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    body += crockford[nibble % 32]!;
  }
  return `clm-${body}` as ClaimId;
}

function commandDigestOf(input: {
  statement: string;
  claimType: string;
  scope: unknown;
  authority: string;
  lifecycle: string;
  evidenceRefs: unknown;
  relationships: unknown;
  createdFrom: unknown;
}): Sha256 {
  return sha256Hex(
    JSON.stringify([
      input.statement,
      input.claimType,
      input.scope,
      input.authority,
      input.lifecycle,
      input.evidenceRefs,
      input.relationships,
      input.createdFrom,
    ]),
  );
}

function payloadDigestOf(claim: Claim): Sha256 {
  return sha256Hex(JSON.stringify(claim));
}

const LEGAL: ReadonlyMap<ClaimState, ReadonlySet<ClaimState>> = new Map([
  ["proposed", new Set(["accepted", "disputed"])],
  ["accepted", new Set(["stale", "superseded", "disputed"])],
  ["disputed", new Set(["disputed", "accepted", "stale", "superseded"])],
  ["stale", new Set(["stale", "superseded", "disputed"])],
  ["superseded", new Set(["superseded"])],
]);

export function createInMemoryClaimStore(): ClaimStore {
  const claims = new Map<string, Claim>();
  const idem = new Map<string, { digest: string; claim: Claim }>();
  const intents = new Map<
    string,
    {
      key: string;
      commandDigest: string;
      recordId: string;
      version: number;
      payloadDigest: string;
    }
  >();
  const holder = new AsyncLocalStorage<true>();
  let queue: Promise<unknown> = Promise.resolve();

  function key(id: string, version: number): string {
    return `${id}@${version}`;
  }

  return {
    async get(claimId, version) {
      if (version === undefined) {
        return this.latest(claimId);
      }
      const claim = claims.get(key(claimId, version));
      return claim ? deepFreeze(structuredClone(claim)) : undefined;
    },
    async latest(claimId) {
      let best: Claim | undefined;
      for (const claim of claims.values()) {
        if (claim.id !== claimId) continue;
        if (!best || claim.version > best.version) best = claim;
      }
      return best ? deepFreeze(structuredClone(best)) : undefined;
    },
    async append(claim) {
      const k = key(claim.id, claim.version);
      const existing = claims.get(k);
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(claim)) {
          return "exists_identical";
        }
        return "exists_conflict";
      }
      claims.set(k, deepFreeze(structuredClone(claim)));
      return "created";
    },
    async listClaimIds() {
      const ids = new Set<string>();
      for (const claim of claims.values()) ids.add(claim.id);
      return [...ids];
    },
    async rememberIdempotency(idKey, digest, claim) {
      const prior = idem.get(idKey);
      if (prior) {
        if (prior.digest !== digest) return "conflict";
        return "replay";
      }
      idem.set(idKey, { digest, claim: deepFreeze(structuredClone(claim)) });
      return "stored";
    },
    async lookupIdempotency(idKey) {
      const prior = idem.get(idKey);
      return prior
        ? {
            digest: prior.digest,
            claim: deepFreeze(structuredClone(prior.claim)),
          }
        : undefined;
    },
    async writeOperationIntent(intent) {
      intents.set(intent.key, { ...intent });
    },
    async lookupOperationIntent(idKey) {
      const intent = intents.get(idKey);
      return intent ? { ...intent } : undefined;
    },
    async clearOperationIntent(idKey) {
      intents.delete(idKey);
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
const CLAIM_COMPONENTS = [".ultradyn", "claims"] as const;
const JOURNAL_COMPONENTS = [".ultradyn", "claims-journal"] as const;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

interface FileClaimStoreHooks {
  afterTempWriteBeforePublish?: () => void | Promise<void>;
  afterImmutablePublishBeforeOpCommit?: () => void | Promise<void>;
  betweenBindAndLeafOpen?: () => void | Promise<void>;
}

export function createFileClaimStore(
  root: string,
  hooks: FileClaimStoreHooks = {},
): ClaimStore {
  if (!FD_BOUND) {
    const unavailable = () => {
      throw new Error(
        "Descriptor binding unavailable: file claim store fail-closed.",
      );
    };
    return {
      get: unavailable as ClaimStore["get"],
      latest: unavailable as ClaimStore["latest"],
      append: unavailable as ClaimStore["append"],
      locked: (operation) => operation(),
      listClaimIds: unavailable as NonNullable<ClaimStore["listClaimIds"]>,
      rememberIdempotency: unavailable as NonNullable<
        ClaimStore["rememberIdempotency"]
      >,
      lookupIdempotency: unavailable as NonNullable<
        ClaimStore["lookupIdempotency"]
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
        throw new Error("Refusing symbolic-link or non-directory claim root.", {
          cause: error,
        });
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

  function streamComponents(claimId: string): readonly string[] {
    return [...CLAIM_COMPONENTS, claimId];
  }

  function claimFileName(version: number): string {
    return `v${String(version).padStart(8, "0")}.json`;
  }

  const VERSION_NAME = /^v(\d{8})\.json$/u;

  async function listClaimStream(
    bound: { at: (name: string) => string; list: () => Promise<string[]> },
    claimId: string,
  ): Promise<Claim[]> {
    if (hooks.betweenBindAndLeafOpen) {
      await hooks.betweenBindAndLeafOpen();
    }
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
    const out: Claim[] = [];
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
        const st = await handle.stat();
        if (!st.isFile()) {
          throw new Error(`STREAM_CORRUPT: non-regular ${name}`);
        }
        const bytes = await handle.readFile("utf8");
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(bytes);
        } catch {
          throw new Error(`STREAM_CORRUPT: malformed JSON ${name}`);
        }
        const parsed = ClaimSchema.safeParse(parsedJson);
        if (!parsed.success) {
          throw new Error(`STREAM_CORRUPT: malformed claim ${name}`);
        }
        if (parsed.data.id !== claimId || parsed.data.version !== version) {
          throw new Error(
            `STREAM_CORRUPT: cross-stream or id/version mismatch ${name}`,
          );
        }
        out.push(deepFreeze(parsed.data as Claim));
      } finally {
        await handle.close();
      }
    }
    return out;
  }

  return {
    async get(claimId, version) {
      if (version === undefined) {
        return this.latest(claimId);
      }
      const bound = await openBoundPath(streamComponents(claimId));
      try {
        if (hooks.betweenBindAndLeafOpen) {
          await hooks.betweenBindAndLeafOpen();
        }
        const path = bound.at(claimFileName(version));
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
          const st = await handle.stat();
          if (!st.isFile()) {
            throw new Error("STREAM_CORRUPT: non-regular claim leaf");
          }
          const bytes = await handle.readFile("utf8");
          const parsed = ClaimSchema.safeParse(JSON.parse(bytes));
          if (!parsed.success) {
            throw new Error("STREAM_CORRUPT: malformed claim bytes");
          }
          return deepFreeze(parsed.data as Claim);
        } finally {
          await handle.close();
        }
      } finally {
        await bound.close();
      }
    },
    async latest(claimId) {
      const bound = await openBoundPath(streamComponents(claimId));
      try {
        const stream = await listClaimStream(bound, claimId);
        return stream.at(-1);
      } finally {
        await bound.close();
      }
    },
    async append(claim) {
      const bound = await openBoundPath(streamComponents(claim.id));
      const leaf = claimFileName(claim.version);
      const path = bound.at(leaf);
      const bytes = `${JSON.stringify(claim)}\n`;
      const temporary = bound.at(`.${leaf}.${process.pid}-${Date.now()}.tmp`);
      try {
        const stream = await listClaimStream(bound, claim.id);
        const expectedNext = stream.length + 1;
        if (claim.version !== expectedNext) {
          if (!(
            stream.length > 0 && claim.version === stream.at(-1)!.version
          )) {
            throw new Error(
              `STREAM_CORRUPT: append version ${claim.version} != next ${expectedNext}`,
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
        // Immutable publish (rename). Op/idempotency commit is the next service step.
        await rename(temporary, path);
        if (hooks.afterImmutablePublishBeforeOpCommit) {
          await hooks.afterImmutablePublishBeforeOpCommit();
        }
        return "created";
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        await bound.close();
      }
    },
    async listClaimIds() {
      const bound = await openBoundPath(CLAIM_COMPONENTS);
      try {
        const names = await bound.list();
        return names.filter(
          (name) =>
            name !== "." &&
            name !== ".." &&
            ClaimIdSchema.safeParse(name).success,
        );
      } finally {
        await bound.close();
      }
    },
    async rememberIdempotency(idKey, digest, claim) {
      const journal = await openBoundPath(JOURNAL_COMPONENTS);
      try {
        const safeKey = sha256Hex(idKey);
        const path = journal.at(`idem-${safeKey}.json`);
        const record = JSON.stringify({ key: idKey, digest, claim });
        try {
          const existing = await readFile(path, "utf8");
          const parsed = JSON.parse(existing) as {
            digest: string;
            claim: Claim;
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
            claim: Claim;
          };
          return {
            digest: parsed.digest,
            claim: deepFreeze(parsed.claim),
          };
        } catch (error) {
          if (errorCode(error) === "ENOENT") return undefined;
          throw error;
        }
      } finally {
        await journal.close();
      }
    },
    async writeOperationIntent(intent) {
      const journal = await openBoundPath(JOURNAL_COMPONENTS);
      try {
        const path = journal.at(`op-intent-${sha256Hex(intent.key)}.json`);
        const bytes = JSON.stringify(intent);
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
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        await rm(path, { force: true }).catch(() => undefined);
        await rename(temporary, path);
      } finally {
        await journal.close();
      }
    },
    async lookupOperationIntent(idKey) {
      const journal = await openBoundPath(JOURNAL_COMPONENTS);
      try {
        const path = journal.at(`op-intent-${sha256Hex(idKey)}.json`);
        try {
          const existing = await readFile(path, "utf8");
          return deepFreeze(JSON.parse(existing));
        } catch (error) {
          if (errorCode(error) === "ENOENT") return undefined;
          return undefined;
        }
      } finally {
        await journal.close();
      }
    },
    async clearOperationIntent(idKey) {
      const journal = await openBoundPath(JOURNAL_COMPONENTS);
      try {
        await rm(journal.at(`op-intent-${sha256Hex(idKey)}.json`), {
          force: true,
        });
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

export function createClaimRepository(options: {
  readonly store: ClaimStore;
  readonly evidence: EvidenceVerificationReader;
  readonly acceptance: ClaimAcceptanceAuthority;
}): ClaimRepository {
  const { store, evidence, acceptance } = options;
  if (!evidence || typeof evidence.isVerified !== "function") {
    throw new Error("EvidenceVerificationReader (evidence) is required.");
  }
  if (!acceptance || typeof acceptance.authorizeAcceptance !== "function") {
    throw new Error("ClaimAcceptanceAuthority (acceptance) is required.");
  }

  async function readLatest(
    claimId: string,
  ): Promise<IngestResult<Claim, ClaimServiceError>> {
    try {
      const claim = await store.latest(claimId);
      if (!claim) {
        return failure("CLAIM_NOT_FOUND", `No claim stream for ${claimId}.`);
      }
      return success(claim);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("STREAM_CORRUPT")
      ) {
        return failure("STREAM_CORRUPT", error.message);
      }
      if (
        error instanceof Error &&
        (error.message.includes("injected-crash") ||
          /afterTempWrite|afterImmutablePublish/i.test(error.message))
      ) {
        throw error;
      }
      return failure(
        "COMMIT_FAILED",
        error instanceof Error ? error.message : "read failed",
      );
    }
  }

  return {
    async create(input) {
      if (!isPlainObject(input)) {
        return failure("INVALID_INPUT", "Create input must be a plain object.");
      }
      const allowed = new Set([
        "statement",
        "claimType",
        "scope",
        "authority",
        "lifecycle",
        "evidenceRefs",
        "relationships",
        "createdFrom",
        "idempotencyKey",
        "state",
      ]);
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key === "symbol" || !allowed.has(key)) {
          return failure("INVALID_INPUT", "Unknown or hostile create fields.");
        }
        if (!ownData(input, key).ok) {
          return failure("INVALID_INPUT", "Hostile accessors are rejected.");
        }
      }
      const forcedState = ownData(input, "state");
      if (forcedState.ok && forcedState.present) {
        return failure("INVALID_INPUT", "Cannot force state on create.");
      }

      const statementProp = ownData(input, "statement");
      if (
        !statementProp.ok ||
        !statementProp.present ||
        typeof statementProp.value !== "string" ||
        statementProp.value.length === 0
      ) {
        return failure("INVALID_INPUT", "statement is required.");
      }
      const statement = statementProp.value;

      const typeProp = ownData(input, "claimType");
      if (!typeProp.ok || !typeProp.present) {
        return failure("INVALID_INPUT", "claimType is required.");
      }
      const typeParsed = ClaimTypeSchema.safeParse(typeProp.value);
      if (!typeParsed.success) {
        return failure("INVALID_INPUT", "claimType is invalid.");
      }

      const scopeProp = ownData(input, "scope");
      if (
        !scopeProp.ok ||
        !scopeProp.present ||
        !isPlainObject(scopeProp.value)
      ) {
        return failure("INVALID_INPUT", "scope is required.");
      }

      const authorityProp = ownData(input, "authority");
      if (
        !authorityProp.ok ||
        !authorityProp.present ||
        typeof authorityProp.value !== "string" ||
        authorityProp.value.length === 0
      ) {
        return failure("INVALID_INPUT", "authority is required.");
      }

      const lifecycleProp = ownData(input, "lifecycle");
      if (
        !lifecycleProp.ok ||
        !lifecycleProp.present ||
        typeof lifecycleProp.value !== "string" ||
        lifecycleProp.value.length === 0
      ) {
        return failure("INVALID_INPUT", "lifecycle is required.");
      }

      const evidenceProp = ownData(input, "evidenceRefs");
      if (
        !evidenceProp.ok ||
        !evidenceProp.present ||
        !Array.isArray(evidenceProp.value) ||
        evidenceProp.value.length === 0
      ) {
        return failure("INVALID_INPUT", "evidenceRefs must be non-empty.");
      }

      const relProp = ownData(input, "relationships");
      if (!relProp.ok || !relProp.present || !isPlainObject(relProp.value)) {
        return failure("INVALID_INPUT", "relationships is required.");
      }

      const fromProp = ownData(input, "createdFrom");
      if (!fromProp.ok || !fromProp.present || !isPlainObject(fromProp.value)) {
        return failure("INVALID_INPUT", "createdFrom is required.");
      }
      const qProp = ownData(fromProp.value, "questionId");
      const pProp = ownData(fromProp.value, "packetId");
      if (
        !qProp.ok ||
        !qProp.present ||
        typeof qProp.value !== "string" ||
        !pProp.ok ||
        !pProp.present ||
        typeof pProp.value !== "string"
      ) {
        return failure("INVALID_INPUT", "createdFrom is malformed.");
      }

      let idempotencyKey: string | undefined;
      const idemProp = ownData(input, "idempotencyKey");
      if (idemProp.ok && idemProp.present) {
        if (typeof idemProp.value !== "string" || idemProp.value.length === 0) {
          return failure("INVALID_INPUT", "idempotencyKey invalid.");
        }
        idempotencyKey = idemProp.value;
      }

      const claimId = deriveClaimId(qProp.value, pProp.value, statement);
      const commandDigest = commandDigestOf({
        statement,
        claimType: typeParsed.data,
        scope: scopeProp.value,
        authority: authorityProp.value,
        lifecycle: lifecycleProp.value,
        evidenceRefs: evidenceProp.value,
        relationships: relProp.value,
        createdFrom: fromProp.value,
      });

      const record: Claim = deepFreeze({
        schemaVersion: 1 as const,
        id: claimId,
        version: 1,
        statement,
        claimType: typeParsed.data,
        scope: deepFreeze({ ...scopeProp.value }),
        authority: authorityProp.value,
        lifecycle: lifecycleProp.value,
        state: "proposed" as const,
        evidenceRefs: deepFreeze(
          structuredClone(evidenceProp.value) as Claim["evidenceRefs"],
        ),
        relationships: deepFreeze(
          structuredClone(relProp.value) as Claim["relationships"],
        ),
        createdFrom: deepFreeze({
          questionId: qProp.value,
          packetId: pProp.value,
        }),
      });

      if (!ClaimSchema.safeParse(record).success) {
        return failure("INVALID_INPUT", "Derived claim failed schema.");
      }

      try {
        return await store.locked(async () => {
          // Key by question + user key only — statement is part of commandDigest.
          const idKey =
            idempotencyKey !== undefined
              ? `create:${qProp.value}:${idempotencyKey}`
              : undefined;
          if (idKey && store.lookupIdempotency) {
            const prior = await store.lookupIdempotency(idKey);
            if (prior) {
              if (prior.digest !== commandDigest) {
                return failure(
                  "IDEMPOTENCY_CONFLICT",
                  "Idempotency key reused with a different payload.",
                );
              }
              return success(structuredClone(prior.claim));
            }
          }
          if (idKey && store.lookupOperationIntent) {
            const intent = await store.lookupOperationIntent(idKey);
            if (intent && intent.commandDigest === commandDigest) {
              const existing = await store.get(intent.recordId, intent.version);
              if (
                existing &&
                payloadDigestOf(existing) === intent.payloadDigest
              ) {
                if (store.rememberIdempotency) {
                  await store.rememberIdempotency(
                    idKey,
                    commandDigest,
                    existing,
                  );
                }
                if (store.clearOperationIntent) {
                  await store.clearOperationIntent(idKey);
                }
                return success(structuredClone(existing));
              }
              if (store.clearOperationIntent) {
                await store.clearOperationIntent(idKey);
              }
            }
          }

          if (idKey && store.writeOperationIntent) {
            await store.writeOperationIntent({
              key: idKey,
              commandDigest,
              recordId: record.id,
              version: 1,
              payloadDigest: payloadDigestOf(record),
            });
          }

          const appendResult = await store.append(record);
          if (appendResult === "exists_conflict") {
            return failure(
              "OVERWRITE_DENIED",
              "Append-only store refused overwrite.",
            );
          }
          if (idKey && store.rememberIdempotency) {
            const remembered = await store.rememberIdempotency(
              idKey,
              commandDigest,
              record,
            );
            if (remembered === "conflict") {
              return failure(
                "IDEMPOTENCY_CONFLICT",
                "Idempotency key reused with a different payload.",
              );
            }
          }
          if (idKey && store.clearOperationIntent) {
            await store.clearOperationIntent(idKey);
          }
          return success(record);
        });
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes("injected-crash") ||
            /afterTempWrite|afterImmutablePublish/i.test(error.message))
        ) {
          throw error;
        }
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

    async transition(input) {
      if (!isPlainObject(input)) {
        return failure("INVALID_INPUT", "Transition input must be plain.");
      }
      const allowed = new Set([
        "claimId",
        "expectedVersion",
        "to",
        "reviewerRunId",
        "reason",
        "supersederId",
        "idempotencyKey",
      ]);
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key === "symbol" || !allowed.has(key)) {
          return failure("INVALID_INPUT", "Unknown transition fields.");
        }
        if (!ownData(input, key).ok) {
          return failure("INVALID_INPUT", "Hostile accessors.");
        }
      }

      const idProp = ownData(input, "claimId");
      if (!idProp.ok || !idProp.present || typeof idProp.value !== "string") {
        return failure("INVALID_INPUT", "claimId required.");
      }
      const claimId = idProp.value;

      const verProp = ownData(input, "expectedVersion");
      if (
        !verProp.ok ||
        !verProp.present ||
        typeof verProp.value !== "number" ||
        !Number.isInteger(verProp.value) ||
        verProp.value < 1
      ) {
        return failure("VERSION_CONFLICT", "expectedVersion invalid.");
      }
      const expectedVersion = verProp.value;

      const toProp = ownData(input, "to");
      if (!toProp.ok || !toProp.present) {
        return failure("INVALID_INPUT", "to required.");
      }
      const toParsed = ClaimStateSchema.safeParse(toProp.value);
      if (!toParsed.success) {
        return failure("INVALID_INPUT", "to is not a ClaimState.");
      }
      const to = toParsed.data;

      let reviewerRunId: string | undefined;
      const runProp = ownData(input, "reviewerRunId");
      if (runProp.ok && runProp.present) {
        if (typeof runProp.value !== "string" || runProp.value.length === 0) {
          return failure("INVALID_INPUT", "reviewerRunId invalid.");
        }
        reviewerRunId = runProp.value;
      }

      let reason: string | undefined;
      const reasonProp = ownData(input, "reason");
      if (reasonProp.ok && reasonProp.present) {
        if (typeof reasonProp.value !== "string") {
          return failure("INVALID_INPUT", "reason invalid.");
        }
        reason = reasonProp.value;
      }

      let supersederId: string | undefined;
      const superProp = ownData(input, "supersederId");
      if (superProp.ok && superProp.present) {
        if (typeof superProp.value !== "string") {
          return failure("INVALID_INPUT", "supersederId invalid.");
        }
        supersederId = superProp.value;
      }

      let idempotencyKey: string | undefined;
      const idemProp = ownData(input, "idempotencyKey");
      if (idemProp.ok && idemProp.present) {
        if (typeof idemProp.value !== "string" || idemProp.value.length === 0) {
          return failure("INVALID_INPUT", "idempotencyKey invalid.");
        }
        idempotencyKey = idemProp.value;
      }

      const transitionDigest = sha256Hex(
        JSON.stringify([
          claimId,
          expectedVersion,
          to,
          reviewerRunId ?? null,
          reason ?? null,
          supersederId ?? null,
        ]),
      );
      const idKey =
        idempotencyKey !== undefined
          ? `transition:${claimId}:${idempotencyKey}`
          : undefined;

      try {
        return await store.locked(async () => {
          if (idKey && store.lookupIdempotency) {
            const prior = await store.lookupIdempotency(idKey);
            if (prior) {
              if (prior.digest !== transitionDigest) {
                return failure(
                  "IDEMPOTENCY_CONFLICT",
                  "Idempotency key reused with a different payload.",
                );
              }
              return success(structuredClone(prior.claim));
            }
          }

          const current = await store.latest(claimId);
          if (!current) {
            return failure("CLAIM_NOT_FOUND", "Claim not found.");
          }
          if (current.version !== expectedVersion) {
            return failure(
              "VERSION_CONFLICT",
              `expectedVersion ${expectedVersion} does not match ${current.version}.`,
            );
          }

          const allowedNext = LEGAL.get(current.state);
          if (!allowedNext || !allowedNext.has(to)) {
            return failure(
              "ILLEGAL_TRANSITION",
              `${current.state} → ${to} is illegal.`,
            );
          }

          if (to === "accepted") {
            if (!reviewerRunId) {
              return failure(
                "REVIEW_REQUIRED",
                "reviewerRunId provenance required for accept.",
              );
            }
            const grant = await acceptance.authorizeAcceptance({
              claimId,
              reviewerRunId,
            });
            if (!grant.ok) {
              return failure(
                "ACCEPTANCE_FORBIDDEN",
                grant.message || "Acceptance authority denied.",
              );
            }
            for (const ref of current.evidenceRefs) {
              const ok = await evidence.isVerified({
                snapshotId: ref.snapshotId,
                fileId: ref.fileId,
                unitId: ref.unitId,
                fileSha256: ref.fileSha256,
                unitSha256: ref.unitSha256,
              });
              if (!ok) {
                return failure(
                  "EVIDENCE_UNVERIFIED",
                  "Evidence ref not verified.",
                );
              }
            }
            if (
              !current.authority ||
              !current.lifecycle ||
              !current.scope ||
              current.evidenceRefs.length === 0
            ) {
              return failure(
                "INVALID_INPUT",
                "scope/authority/lifecycle/evidence required.",
              );
            }
          }

          if (to === "superseded") {
            if (!supersederId) {
              return failure("INVALID_INPUT", "supersederId required.");
            }
            // Acyclic: walk superseder chain; reject if claimId appears.
            let cursor: string | undefined = supersederId;
            const seen = new Set<string>([claimId]);
            while (cursor) {
              if (seen.has(cursor)) {
                return failure("CYCLE_DETECTED", "Supersession cycle.");
              }
              seen.add(cursor);
              const next = await store.latest(cursor);
              cursor = next?.supersederId;
            }
          }

          const next: Claim = deepFreeze({
            ...structuredClone(current),
            version: current.version + 1,
            state: to,
            ...(reviewerRunId !== undefined ? { reviewerRunId } : {}),
            ...(reason !== undefined ? { reason } : {}),
            ...(supersederId !== undefined
              ? { supersederId: supersederId as ClaimId }
              : {}),
            ...(to === "accepted"
              ? {
                  evidenceRefs: current.evidenceRefs.map((ref) =>
                    deepFreeze({ ...ref, verified: true }),
                  ),
                }
              : {}),
          });

          if (!ClaimSchema.safeParse(next).success) {
            return failure("INVALID_INPUT", "Transition claim failed schema.");
          }

          const appendResult = await store.append(next);
          if (appendResult === "exists_conflict") {
            return failure("OVERWRITE_DENIED", "Version overwrite denied.");
          }
          if (idKey && store.rememberIdempotency) {
            const remembered = await store.rememberIdempotency(
              idKey,
              transitionDigest,
              next,
            );
            if (remembered === "conflict") {
              return failure(
                "IDEMPOTENCY_CONFLICT",
                "Idempotency key reused with a different payload.",
              );
            }
          }
          return success(next);
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("injected-crash")
        ) {
          throw error;
        }
        return failure(
          "COMMIT_FAILED",
          error instanceof Error ? error.message : "transition failed",
        );
      }
    },

    async get(claimId) {
      return readLatest(claimId);
    },

    async getVersion(claimId, version) {
      try {
        const claim = await store.get(claimId, version);
        if (!claim) {
          return failure("CLAIM_NOT_FOUND", `No claim ${claimId}@${version}.`);
        }
        return success(claim);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("STREAM_CORRUPT")
        ) {
          return failure("STREAM_CORRUPT", error.message);
        }
        return failure(
          "COMMIT_FAILED",
          error instanceof Error ? error.message : "read failed",
        );
      }
    },

    async list() {
      try {
        const ids = store.listClaimIds ? await store.listClaimIds() : [];
        const out: Claim[] = [];
        for (const id of ids) {
          const latest = await store.latest(id);
          if (latest) out.push(latest);
        }
        return success(Object.freeze(out));
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("STREAM_CORRUPT")
        ) {
          return failure("STREAM_CORRUPT", error.message);
        }
        return failure(
          "COMMIT_FAILED",
          error instanceof Error ? error.message : "list failed",
        );
      }
    },

    async markStaleFromSourceChange(input) {
      if (!isPlainObject(input)) {
        return failure("INVALID_INPUT", "markStale input must be plain.");
      }
      const snapProp = ownData(input, "snapshotId");
      const unitsProp = ownData(input, "unitIds");
      const reasonProp = ownData(input, "reason");
      if (
        !snapProp.ok ||
        !snapProp.present ||
        typeof snapProp.value !== "string"
      ) {
        return failure("INVALID_INPUT", "snapshotId required.");
      }
      if (
        !unitsProp.ok ||
        !unitsProp.present ||
        !Array.isArray(unitsProp.value)
      ) {
        return failure("INVALID_INPUT", "unitIds required.");
      }
      const unitSet = new Set(
        unitsProp.value.filter((u): u is string => typeof u === "string"),
      );
      const reason =
        reasonProp.ok &&
        reasonProp.present &&
        typeof reasonProp.value === "string"
          ? reasonProp.value
          : "source changed";

      try {
        return await store.locked(async () => {
          const ids = store.listClaimIds ? await store.listClaimIds() : [];
          const updated: Claim[] = [];
          for (const id of ids) {
            const latest = await store.latest(id);
            if (!latest || latest.state !== "accepted") continue;
            const hit = latest.evidenceRefs.some(
              (ref) =>
                ref.snapshotId === snapProp.value && unitSet.has(ref.unitId),
            );
            if (!hit) continue;
            const next: Claim = deepFreeze({
              ...structuredClone(latest),
              version: latest.version + 1,
              state: "stale" as const,
              reason,
            });
            // B001: honour the append verdict. Discarding it reported claims as
            // staled whose write never landed — fail-open on an INVALIDATION
            // path, which silently keeps superseded evidence trusted.
            const outcome = await store.append(next);
            switch (outcome) {
              case "created":
              case "exists_identical":
                // The stale record is durable; safe to report it.
                updated.push(next);
                break;
              case "exists_conflict":
                // A different record already occupies this version. The stale
                // write did NOT land, so fail closed rather than claim it did.
                //
                // HONEST RESIDUAL: this aborts mid-loop, so stale records
                // appended for EARLIER claims in this call remain durable while
                // the call reports failure. The operation is NOT atomic across
                // claims. That is safe to retry rather than merely tolerable:
                // re-running re-derives identical stale records, which the store
                // reports as exists_identical, so a retry converges instead of
                // duplicating. Callers MUST retry; treating the failure as
                // "nothing happened" would be wrong.
                return failure(
                  "COMMIT_FAILED",
                  "stale write conflicted with an existing claim version",
                );
              default: {
                const _exhaustive: never = outcome;
                void _exhaustive;
                return failure(
                  "COMMIT_FAILED",
                  "unknown claim store append outcome",
                );
              }
            }
          }
          return success(Object.freeze(updated));
        });
      } catch (error) {
        return failure(
          "COMMIT_FAILED",
          error instanceof Error ? error.message : "markStale failed",
        );
      }
    },
  };
}
