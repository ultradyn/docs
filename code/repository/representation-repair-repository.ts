import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import writeFileAtomic from "write-file-atomic";

import { withRepositoryLock } from "./knowledge-repository.js";

type HookName =
  | "afterLockAcquired"
  | "beforeJournalWrite"
  | "afterJournalWrite"
  | "beforeRecordWrite"
  | "afterRecordWrite"
  | "beforeRevisionBump";

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

export interface RepresentationRepairRepositoryOptions {
  readonly root: string;
  readonly hooks?: Hooks;
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

function validIdentity(value: unknown, prefix: string): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(prefix) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value !== "." &&
    value !== ".."
  );
}

async function writeExclusive(path: string, bytes: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const file = await open(path, "wx", 0o444);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(path, "utf8")) !== bytes) {
      throw new Error(
        "Immutable repair record conflicts with existing bytes.",
        {
          cause: error,
        },
      );
    }
  }
}

export function createRepresentationRepairRepository(
  options: RepresentationRepairRepositoryOptions,
) {
  const directory = join(options.root, ".ultradyn", "repair");
  const journalPath = join(directory, "journal.json");

  async function load(): Promise<Journal> {
    try {
      const parsed = JSON.parse(await readFile(journalPath, "utf8")) as Journal;
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
      throw error;
    }
  }

  async function commit(next: Journal): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFileAtomic(journalPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async function locked<T>(operation: () => Promise<T>): Promise<T> {
    return withRepositoryLock(options.root, async () => {
      await options.hooks?.afterLockAcquired?.();
      return operation();
    });
  }

  async function append(record: Record<string, unknown>) {
    return locked(async () => {
      const journal = await load();
      const repairId = record.repairId;
      const idempotencyKey = record.idempotencyKey;
      const payloadDigest = record.payloadDigest ?? digest(record);
      if (
        !validIdentity(repairId, "rpr-") ||
        (idempotencyKey !== undefined &&
          (typeof idempotencyKey !== "string" ||
            idempotencyKey.trim() === "")) ||
        typeof payloadDigest !== "string"
      ) {
        return { ok: false as const, code: "INVALID_RECORD" as const };
      }
      const replay = journal.entries.find(
        (entry) =>
          entry.idempotencyKey === idempotencyKey &&
          idempotencyKey !== undefined,
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
      try {
        await options.hooks?.beforeJournalWrite?.();
        await options.hooks?.afterJournalWrite?.();
        await options.hooks?.beforeRecordWrite?.();
        const pending = join(
          directory,
          `.pending-${nextRevision}-${repairId}.json`,
        );
        await writeExclusive(pending, bytes);
        await options.hooks?.afterRecordWrite?.();
        await options.hooks?.beforeRevisionBump?.();
        await writeExclusive(absolutePath, bytes);
        await commit({
          revision: nextRevision,
          entries: [...journal.entries, entry],
          outbox: journal.outbox,
        });
        await rm(pending, { force: true });
        return { ok: true as const, value: { ...entry, replayed: false } };
      } catch {
        await rm(join(directory, `.pending-${nextRevision}-${repairId}.json`), {
          force: true,
        });
        return { ok: false as const, code: "COMMIT_FAILED" as const };
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
      if (!validIdentity(request.id, "inv-"))
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
      if (!validIdentity(repairId, "rpr-"))
        throw new Error("Invalid ledger repair identity.");
      const journal = await load();
      const result = await append({
        ...record,
        repairId,
        expectedRevision: journal.revision,
        ...(nested
          ? {
              idempotencyKey: nested.idempotencyKey,
              payloadDigest: digest(record),
            }
          : {}),
      });
      if (!result.ok) throw new Error(result.code);
      const invalidation = record.invalidation;
      if (invalidation && typeof invalidation === "object") {
        await (async () => {
          const request = invalidation as Record<string, unknown>;
          if (!validIdentity(request.id, "inv-"))
            throw new Error("Invalid invalidation identity.");
          await mutateOutbox((state) => ({
            ...state,
            outbox: {
              ...state.outbox,
              [request.id as string]: {
                request: structuredClone(request),
                acknowledged: false,
              },
            },
          }));
        })();
      }
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
