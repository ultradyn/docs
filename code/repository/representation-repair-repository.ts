import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readlink,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { ULID_PATTERN } from "../domain/ingest/id-schemas.js";
import { withRepositoryLock } from "./knowledge-repository.js";

type HookName =
  | "afterLockAcquired"
  | "beforeJournalWrite"
  | "afterJournalWrite"
  | "beforeRecordWrite"
  | "afterRecordWrite"
  | "beforeRevisionBump"
  | "afterApprovalEntryBeforeOutbox"
  /** Test-only: fires after root path is resolved, before the root descriptor open. */
  | "beforeRootDescriptorOpen";

type Hooks = Partial<Record<HookName, () => void | Promise<void>>>;

interface JournalEntry {
  readonly revision: number;
  readonly repairId: string;
  readonly idempotencyKey?: string;
  readonly payloadDigest: string;
  readonly path: string;
  readonly record: Record<string, unknown>;
}

interface OutboxEntry {
  readonly request: Record<string, unknown>;
  readonly acknowledged: boolean;
}

interface Journal {
  readonly revision: number;
  readonly entries: readonly JournalEntry[];
  readonly outbox: Readonly<Record<string, OutboxEntry>>;
}

const EMPTY: Journal = { revision: 1, entries: [], outbox: {} };

const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const REPAIR_COMPONENTS = [".ultradyn", "repair"] as const;
const RECORDS_COMPONENT = "records";

/**
 * Test-only custody knobs. Not part of the production public contract; do not
 * import from production barrels for product code.
 */
export interface RepresentationRepairRepositoryTestingOptions {
  /**
   * Force the descriptor-binding capability path. `unavailable` must fail
   * closed (no pathname TOCTOU fallback).
   */
  readonly descriptorBinding?: "required" | "unavailable";
}

export interface RepresentationRepairRepositoryOptions {
  readonly root: string;
  readonly hooks?: Hooks;
  readonly testing?: RepresentationRepairRepositoryTestingOptions;
}

interface BoundDirectory {
  readonly at: (name: string) => string;
  readonly close: () => Promise<void>;
}

function descriptorBindingAvailable(): boolean {
  return process.platform === "linux" && existsSync("/proc/self/fd");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function contained(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return (
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !resolve(candidate).startsWith(`${sep}${sep}`)
  );
}

/** `prefix` is the bare brand (e.g. `rpr`, `inv`), not including the hyphen. */
function validIdentity(value: unknown, prefix: string): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^${prefix}-${ULID_PATTERN}$`).test(value)
  );
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Open a directory by binding the caller root descriptor first
 * (O_DIRECTORY|O_NOFOLLOW — never realpath-then-pathname-open), verifying
 * identity from the held fd, then walking each component via /proc/self/fd.
 */
async function openComponentDirectory(
  root: string,
  components: readonly string[],
  hooks: Hooks | undefined,
  testing: RepresentationRepairRepositoryTestingOptions | undefined,
): Promise<BoundDirectory> {
  const binding =
    testing?.descriptorBinding ??
    (descriptorBindingAvailable() ? "required" : "unavailable");
  if (binding === "unavailable" || !descriptorBindingAvailable()) {
    throw new Error(
      "Descriptor-bound custody is unavailable; refusing pathname fallback.",
    );
  }

  const handles = new Set<FileHandle>();
  // Resolve only for verification after open — never open(realpath(...)).
  const callerRoot = resolve(root);
  await hooks?.beforeRootDescriptorOpen?.();
  let handle: FileHandle;
  try {
    handle = await open(callerRoot, DIRECTORY_FLAGS);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw new Error(
        `Refusing symbolic-link or non-directory repository root at ${callerRoot}.`,
        { cause: error },
      );
    }
    throw error;
  }
  handles.add(handle);
  try {
    // Identity from the held descriptor (proc fd), not a prior realpath string.
    const fdIdentity = await readlink(`/proc/self/fd/${handle.fd}`);
    const rootStat = await handle.stat();
    if (!rootStat.isDirectory()) {
      throw new Error(`Expected directory at repository root ${callerRoot}.`);
    }
    // Soft check: if the path still exists and is not the same inode, we still
    // trust the held fd only (path may have been swapped after open).
    void fdIdentity;

    for (const component of components) {
      const componentPath = `/proc/self/fd/${handle.fd}/${component}`;
      try {
        await mkdir(componentPath, { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      let child: FileHandle;
      try {
        child = await open(componentPath, DIRECTORY_FLAGS);
      } catch (error) {
        const code = errorCode(error);
        if (code === "ELOOP" || code === "ENOTDIR") {
          throw new Error(
            `Refusing symbolic-link path component ${component} under ${root}.`,
            { cause: error },
          );
        }
        throw error;
      }
      handles.add(child);
      const parent = handle;
      handle = child;
      await parent.close();
      handles.delete(parent);
    }
  } catch (error) {
    for (const openHandle of handles) {
      try {
        await openHandle.close();
      } catch {
        // Best-effort cleanup must not mask the primary traversal failure.
      }
    }
    throw error;
  }
  const bound = handle;
  return {
    at: (name) => `/proc/self/fd/${bound.fd}/${name}`,
    close: () => bound.close(),
  };
}

async function readNoFollowText(path: string): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ELOOP") {
      throw new Error(`Refusing symbolic link at ${path}.`, { cause: error });
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`Expected regular file at ${path}.`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function writeExclusive(path: string, bytes: string): Promise<void> {
  try {
    const file = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o444,
    );
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    const code = errorCode(error);
    if (code === "ELOOP") {
      throw new Error(`Refusing symbolic link at ${path}.`, { cause: error });
    }
    if (code !== "EEXIST") throw error;
    if ((await readNoFollowText(path)) !== bytes) {
      throw new Error(
        "Immutable repair record conflicts with existing bytes.",
        {
          cause: error,
        },
      );
    }
  }
}

async function writeAtomicNoFollow(path: string, bytes: string): Promise<void> {
  const temporary = `${path}.${process.pid}-${Date.now()}.tmp`;
  // Temp must not follow a pre-planted symlink either.
  try {
    await lstat(temporary);
    // Existing path: refuse if symlink, otherwise remove only the leaf name.
    const meta = await lstat(temporary);
    if (meta.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link at ${temporary}.`);
    }
    await rm(temporary, { force: true });
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
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
  // rename of temp onto destination: reject if destination is a symlink leaf
  // by trying O_NOFOLLOW open first when it exists.
  try {
    await lstat(path);
    const existing = await lstat(path);
    if (existing.isSymbolicLink()) {
      await rm(temporary, { force: true });
      throw new Error(`Refusing symbolic link at ${path}.`);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  await rename(temporary, path);
}

export function createRepresentationRepairRepository(
  options: RepresentationRepairRepositoryOptions,
) {
  async function withRepairDir<T>(
    operation: (repair: BoundDirectory) => Promise<T>,
  ): Promise<T> {
    const repair = await openComponentDirectory(
      options.root,
      REPAIR_COMPONENTS,
      options.hooks,
      options.testing,
    );
    try {
      return await operation(repair);
    } finally {
      await repair.close();
    }
  }

  async function withRecordsDir<T>(
    operation: (records: BoundDirectory) => Promise<T>,
  ): Promise<T> {
    const records = await openComponentDirectory(
      options.root,
      [...REPAIR_COMPONENTS, RECORDS_COMPONENT],
      options.hooks,
      options.testing,
    );
    try {
      return await operation(records);
    } finally {
      await records.close();
    }
  }

  async function load(): Promise<Journal> {
    return withRepairDir(async (repair) => {
      const journalPath = repair.at("journal.json");
      try {
        const parsed = JSON.parse(
          await readNoFollowText(journalPath),
        ) as Journal;
        if (
          !Number.isInteger(parsed.revision) ||
          parsed.revision < 1 ||
          !Array.isArray(parsed.entries) ||
          parsed.outbox === null ||
          typeof parsed.outbox !== "object"
        ) {
          throw new Error("Invalid repair journal.");
        }
        return parsed;
      } catch (error) {
        if (errorCode(error) === "ENOENT") return EMPTY;
        throw error;
      }
    });
  }

  async function commit(next: Journal): Promise<void> {
    await withRepairDir(async (repair) => {
      const journalPath = repair.at("journal.json");
      await writeAtomicNoFollow(
        journalPath,
        `${JSON.stringify(next, null, 2)}\n`,
      );
    });
  }

  async function locked<T>(operation: () => Promise<T>): Promise<T> {
    return withRepositoryLock(options.root, async () => {
      await options.hooks?.afterLockAcquired?.();
      return operation();
    });
  }

  async function appendRecordInJournal(
    journal: Journal,
    record: Record<string, unknown>,
    outboxUpdate?: Readonly<Record<string, OutboxEntry>>,
  ): Promise<
    | { ok: true; value: JournalEntry & { replayed: boolean } }
    | {
        ok: false;
        code:
          | "INVALID_RECORD"
          | "IDEMPOTENCY_CONFLICT"
          | "REVISION_CONFLICT"
          | "COMMIT_FAILED";
      }
  > {
    const repairId = record.repairId;
    const idempotencyKey = record.idempotencyKey;
    const payloadDigest = record.payloadDigest ?? digest(record);
    if (
      !validIdentity(repairId, "rpr") ||
      (idempotencyKey !== undefined &&
        (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "")) ||
      typeof payloadDigest !== "string"
    ) {
      return { ok: false as const, code: "INVALID_RECORD" as const };
    }
    const replay = journal.entries.find(
      (entry) =>
        entry.idempotencyKey === idempotencyKey && idempotencyKey !== undefined,
    );
    if (replay) {
      return replay.payloadDigest === payloadDigest
        ? { ok: true as const, value: { ...replay, replayed: true } }
        : { ok: false as const, code: "IDEMPOTENCY_CONFLICT" as const };
    }
    if (record.expectedRevision !== journal.revision) {
      return { ok: false as const, code: "REVISION_CONFLICT" as const };
    }
    const nextRevision = journal.revision + 1;
    const relativePath = `.ultradyn/repair/records/${String(nextRevision).padStart(8, "0")}-${repairId}.json`;
    const absolutePath = join(options.root, relativePath);
    if (!contained(options.root, absolutePath)) {
      return { ok: false as const, code: "INVALID_RECORD" as const };
    }
    const entry: JournalEntry = {
      revision: nextRevision,
      repairId,
      ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
      payloadDigest,
      path: relativePath,
      record: structuredClone(record),
    };
    const bytes = `${JSON.stringify(entry, null, 2)}\n`;
    const recordName = `${String(nextRevision).padStart(8, "0")}-${repairId}.json`;
    const pendingName = `.pending-${nextRevision}-${repairId}.json`;
    try {
      await options.hooks?.beforeJournalWrite?.();
      await options.hooks?.afterJournalWrite?.();
      await options.hooks?.beforeRecordWrite?.();
      await withRepairDir(async (repair) => {
        await writeExclusive(repair.at(pendingName), bytes);
      });
      await options.hooks?.afterRecordWrite?.();
      // Historical fault point: under the single-transaction path this fires
      // before the journal publish that carries entry and optional outbox.
      await options.hooks?.afterApprovalEntryBeforeOutbox?.();
      await options.hooks?.beforeRevisionBump?.();
      await withRecordsDir(async (records) => {
        await writeExclusive(records.at(recordName), bytes);
      });
      await commit({
        revision: nextRevision,
        entries: [...journal.entries, entry],
        outbox: outboxUpdate ?? journal.outbox,
      });
      await withRepairDir(async (repair) => {
        await rm(repair.at(pendingName), { force: true });
      });
      return { ok: true as const, value: { ...entry, replayed: false } };
    } catch {
      try {
        await withRepairDir(async (repair) => {
          await rm(repair.at(pendingName), { force: true });
        });
      } catch {
        // cleanup best-effort
      }
      return { ok: false as const, code: "COMMIT_FAILED" as const };
    }
  }

  async function append(record: Record<string, unknown>) {
    return locked(async () => {
      try {
        const journal = await load();
        return appendRecordInJournal(journal, record);
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.startsWith("Refusing symbolic") ||
            error.message.startsWith("Expected regular file") ||
            error.message.startsWith("Expected directory") ||
            error.message.startsWith("Descriptor-bound custody is unavailable"))
        ) {
          return { ok: false as const, code: "COMMIT_FAILED" as const };
        }
        throw error;
      }
    });
  }

  async function mutateOutbox(
    operation: (journal: Journal) => Journal | undefined,
  ): Promise<void> {
    await locked(async () => {
      const journal = await load();
      const next = operation(journal);
      if (!next) return;
      await options.hooks?.beforeRevisionBump?.();
      await commit(next);
    });
  }

  return {
    lockIdentity: async () => join(options.root, ".git"),
    append,
    list: async () =>
      (await load()).entries.map((entry) => structuredClone(entry.record)),
    currentRevision: async () => (await load()).revision,
    enqueueInvalidation: async (request: Record<string, unknown>) => {
      if (!validIdentity(request.id, "inv"))
        throw new Error("Invalid invalidation identity.");
      await mutateOutbox((journal) => {
        const existing = journal.outbox[request.id as string];
        if (existing) {
          if (digest(existing.request) !== digest(request))
            throw new Error("Invalidation conflict.");
          return undefined;
        }
        return {
          ...journal,
          outbox: {
            ...journal.outbox,
            [request.id as string]: {
              request: structuredClone(request),
              acknowledged: false,
            },
          },
        };
      });
    },
    pendingInvalidations: async () =>
      Object.entries((await load()).outbox)
        .filter(([, entry]) => !entry.acknowledged)
        .map(([id]) => id)
        .sort(),
    acknowledgeInvalidation: async (id: string) =>
      mutateOutbox((journal) => {
        const current = journal.outbox[id];
        if (!current || current.acknowledged) return undefined;
        return {
          ...journal,
          outbox: {
            ...journal.outbox,
            [id]: { ...current, acknowledged: true },
          },
        };
      }),
    appendLedgerRecord: async (record: Record<string, unknown>) => {
      const nested =
        record.kind === "proposal" &&
        record.proposal &&
        typeof record.proposal === "object"
          ? (record.proposal as Record<string, unknown>)
          : undefined;
      const repairId =
        nested?.id ??
        (record.approval as Record<string, unknown> | undefined)?.repairId ??
        (record.rejection as Record<string, unknown> | undefined)?.repairId;
      if (!validIdentity(repairId, "rpr"))
        throw new Error("Invalid ledger repair identity.");

      const invalidation = record.invalidation;
      let outboxRequest: Record<string, unknown> | undefined;
      if (invalidation && typeof invalidation === "object") {
        const request = invalidation as Record<string, unknown>;
        if (!validIdentity(request.id, "inv"))
          throw new Error("Invalid invalidation identity.");
        outboxRequest = structuredClone(request);
      }

      const result = await locked(async () => {
        const journal = await load();
        const nextOutbox =
          outboxRequest === undefined
            ? undefined
            : {
                ...journal.outbox,
                [outboxRequest.id as string]: {
                  request: outboxRequest,
                  acknowledged: false,
                },
              };
        // Idempotent outbox: identical request is allowed; conflicting is not.
        if (
          outboxRequest !== undefined &&
          journal.outbox[outboxRequest.id as string] !== undefined
        ) {
          const existing = journal.outbox[outboxRequest.id as string]!;
          if (digest(existing.request) !== digest(outboxRequest)) {
            throw new Error("Invalidation conflict.");
          }
        }
        return appendRecordInJournal(
          journal,
          {
            ...record,
            repairId,
            expectedRevision: journal.revision,
            ...(nested
              ? {
                  idempotencyKey: nested.idempotencyKey,
                  payloadDigest: digest(record),
                }
              : {}),
          },
          nextOutbox,
        );
      });
      if (!result.ok) throw new Error(result.code);
    },
    readPendingInvalidations: async () =>
      Object.entries((await load()).outbox)
        .filter(([, entry]) => !entry.acknowledged)
        .map(([, entry]) => structuredClone(entry.request)),
  };
}

export type RepresentationRepairRepository = ReturnType<
  typeof createRepresentationRepairRepository
>;
