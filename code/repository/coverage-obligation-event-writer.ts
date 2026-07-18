import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  link as hardlink,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import {
  CoverageObligationEventSchema,
  ObligationIdSchema,
  isTerminalObligationStatus,
  type AppendCoverageObligationEventCommand,
  type AppendCoverageObligationEventResult,
  type CoverageObligationEvent,
  type CoverageObligationEventWriter,
  type ObligationId,
  type QuestionId,
  type ReserveCoverageObligationCreateCommand,
  type ReserveCoverageObligationCreateResult,
} from "../domain/ingest/index.js";
import {
  withRepositoryLock,
  type RepositoryLockOptions,
} from "./knowledge-repository.js";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

const OperationRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    idempotencyKey: z.string().trim().min(1),
    commandDigest: z.string().min(1),
    obligationId: ObligationIdSchema.nullable(),
    state: z.enum(["claimed", "reserved", "committed"]),
    eventDigest: z.string().regex(DIGEST_PATTERN).nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if ((record.state === "committed") !== (record.eventDigest !== null)) {
      context.addIssue({
        code: "custom",
        path: ["eventDigest"],
        message: "Committed operation state requires an event digest.",
      });
    }
    if ((record.state === "claimed") !== (record.obligationId === null)) {
      context.addIssue({
        code: "custom",
        path: ["obligationId"],
        message: "Only a claimed operation may omit its obligation ID.",
      });
    }
  });
type OperationRecord = z.infer<typeof OperationRecordSchema>;
type AllocatedOperationRecord = OperationRecord & {
  obligationId: ObligationId;
};

function allocatedOperation(record: OperationRecord): AllocatedOperationRecord {
  if (record.obligationId === null) {
    throw new Error("Coverage-obligation operation is still being claimed.");
  }
  return record as AllocatedOperationRecord;
}

export interface CoverageObligationEventWriterHooks {
  /** Deterministic crash seam after immutable event publication, before intent commit. */
  afterEventPublished?: () => void | Promise<void>;
}

export interface FileCoverageObligationEventWriterOptions extends RepositoryLockOptions {
  hooks?: CoverageObligationEventWriterHooks;
}

interface DirectoryReference {
  at(name: string): string;
  list(): Promise<string[]>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const EVENT_FILE = /^\d{8}\.json$/u;
let temporaryAttempt = 0;

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function eventBytes(event: CoverageObligationEvent): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event, null, 2)}\n`);
}

function eventDigest(event: CoverageObligationEvent): string {
  return digest(eventBytes(event));
}

function operationFileName(idempotencyKey: string): string {
  return `${digest(idempotencyKey)}.json`;
}

function eventFileName(version: number): string {
  return `${String(version).padStart(8, "0")}.json`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && digest(left) === digest(right);
}

function validateAppendCommand(
  command: AppendCoverageObligationEventCommand,
): CoverageObligationEvent {
  const event = CoverageObligationEventSchema.parse(command.event);
  if (
    command.obligationId !== event.obligationId ||
    command.obligationId !== event.obligation.id ||
    command.idempotencyKey !== event.idempotencyKey ||
    event.version !== command.expectedVersion + 1 ||
    event.obligation.version !== event.version ||
    event.obligation.status !== event.status ||
    event.obligation.ownerQuestionId !== event.ownerQuestionId
  ) {
    throw new Error("Coverage-obligation append command and event disagree.");
  }
  return event;
}

async function readNoFollow(path: string): Promise<Uint8Array | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`Refusing symbolic link at ${path}.`, { cause: error });
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new Error(`Expected regular file at ${path}.`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function publishNoReplace(
  directory: DirectoryReference,
  name: string,
  bytes: Uint8Array,
): Promise<boolean> {
  const temporaryName = `.${name}.${process.pid}-${(temporaryAttempt += 1)}.tmp`;
  const temporary = directory.at(temporaryName);
  const destination = directory.at(name);
  let handle: FileHandle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o444,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await hardlink(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readNoFollow(destination);
      if (!existing || !sameBytes(existing, bytes)) {
        throw new Error(`Portable record collision at ${destination}.`, {
          cause: error,
        });
      }
      return false;
    }
    await directory.sync();
    return true;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function replaceAtomic(
  directory: DirectoryReference,
  name: string,
  bytes: Uint8Array,
  expectedBytes?: Uint8Array,
): Promise<void> {
  const temporaryName = `.${name}.${process.pid}-${(temporaryAttempt += 1)}.tmp`;
  const temporary = directory.at(temporaryName);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o444,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (expectedBytes) {
      const existing = await readNoFollow(directory.at(name));
      if (!existing || !sameBytes(existing, expectedBytes)) {
        throw new Error(
          `Portable record changed before atomic replacement at ${directory.at(name)}.`,
        );
      }
    }
    await rename(temporary, directory.at(name));
    await directory.sync();
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readOperation(
  directory: DirectoryReference,
  idempotencyKey: string,
): Promise<OperationRecord | undefined> {
  const bytes = await readNoFollow(
    directory.at(operationFileName(idempotencyKey)),
  );
  if (!bytes) return undefined;
  const record = OperationRecordSchema.parse(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
  if (record.idempotencyKey !== idempotencyKey) {
    throw new Error(
      "Hashed operation filename does not match its idempotency key.",
    );
  }
  return record;
}

function encodeOperation(record: OperationRecord): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(OperationRecordSchema.parse(record), null, 2)}\n`,
  );
}

async function latestByObligation(
  root: DirectoryReference,
): Promise<Map<string, CoverageObligationEvent>> {
  const latest = new Map<string, CoverageObligationEvent>();
  for (const obligationId of (await root.list()).sort()) {
    let parsedId: ObligationId;
    try {
      parsedId = ObligationIdSchema.parse(obligationId);
    } catch (error) {
      throw new Error(
        `Unexpected coverage-obligation stream ${obligationId}.`,
        {
          cause: error,
        },
      );
    }
    const stream = await openChildDirectory(root, parsedId, false);
    try {
      const history = await readStream(stream, parsedId);
      const event = history.at(-1);
      if (event) latest.set(obligationId, event);
    } finally {
      await stream.close();
    }
  }
  return latest;
}

async function readStream(
  directory: DirectoryReference,
  obligationId: ObligationId,
): Promise<CoverageObligationEvent[]> {
  const events: CoverageObligationEvent[] = [];
  for (const name of (await directory.list()).sort()) {
    if (name.startsWith(".") && name.endsWith(".tmp")) continue;
    if (!EVENT_FILE.test(name)) {
      throw new Error(`Unexpected coverage-obligation event file ${name}.`);
    }
    const bytes = await readNoFollow(directory.at(name));
    if (!bytes) throw new Error(`Coverage-obligation event ${name} vanished.`);
    const event = CoverageObligationEventSchema.parse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    if (
      event.obligationId !== obligationId ||
      event.obligation.id !== obligationId
    ) {
      events.push(event);
      continue;
    }
    if (name !== eventFileName(event.version)) {
      throw new Error("Coverage-obligation event filename/version mismatch.");
    }
    events.push(event);
  }
  return events;
}

async function openChildDirectory(
  parent: DirectoryReference,
  component: string,
  create: boolean,
): Promise<DirectoryReference> {
  const path = parent.at(component);
  if (create) {
    try {
      await mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  let handle: FileHandle;
  try {
    handle = await open(path, DIRECTORY_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw new Error(`Refusing symbolic-link directory ${path}.`, {
        cause: error,
      });
    }
    throw error;
  }
  const prefix =
    process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : path;
  return {
    at: (name) => `${prefix}/${name}`,
    list: () => readdir(prefix),
    sync: () => handle.sync(),
    close: () => handle.close(),
  };
}

async function openPortableDirectories(root: string): Promise<{
  operations: DirectoryReference;
  obligations: DirectoryReference;
  close(): Promise<void>;
}> {
  const canonicalRoot = await realpath(resolve(root));
  const repository = await open(canonicalRoot, DIRECTORY_FLAGS);
  const repositoryPrefix =
    process.platform === "linux"
      ? `/proc/self/fd/${repository.fd}`
      : canonicalRoot;
  const repositoryDirectory: DirectoryReference = {
    at: (name) => `${repositoryPrefix}/${name}`,
    list: () => readdir(repositoryPrefix),
    sync: () => repository.sync(),
    close: () => repository.close(),
  };
  const ingest = await openChildDirectory(repositoryDirectory, "ingest", true);
  const obligations = await openChildDirectory(
    ingest,
    "coverage-obligations",
    true,
  );
  const operations = await openChildDirectory(
    ingest,
    "coverage-obligation-operations",
    true,
  );
  return {
    operations,
    obligations,
    close: async () => {
      await operations.close();
      await obligations.close();
      await ingest.close();
      await repositoryDirectory.close();
    },
  };
}

class FileCoverageObligationEventWriter implements CoverageObligationEventWriter {
  readonly #root: string;
  readonly #options: FileCoverageObligationEventWriterOptions;

  constructor(root: string, options: FileCoverageObligationEventWriterOptions) {
    this.#root = resolve(root);
    this.#options = options;
  }

  reserveCreate(
    command: ReserveCoverageObligationCreateCommand,
  ): Promise<ReserveCoverageObligationCreateResult> {
    return this.#locked(async (directories) => {
      const prior = await readOperation(
        directories.operations,
        command.idempotencyKey,
      );
      if (prior) {
        if (prior.commandDigest !== command.commandDigest) {
          return { status: "idempotency_conflict" };
        }
        const allocated = allocatedOperation(prior);
        if (allocated.state === "reserved") {
          const stream = await openChildDirectory(
            directories.obligations,
            allocated.obligationId,
            true,
          );
          try {
            const event = (await readStream(stream, allocated.obligationId)).at(
              -1,
            );
            if (event) {
              if (
                event.type !== "created" ||
                event.idempotencyKey !== command.idempotencyKey
              ) {
                throw new Error(
                  "Reserved create operation points to conflicting history.",
                );
              }
              await this.#commitOperation(
                directories.operations,
                allocated,
                eventDigest(event),
              );
            }
          } finally {
            await stream.close();
          }
        } else {
          await this.#verifyCommittedOperation(directories, allocated);
        }
        return {
          status: "idempotent",
          obligationId: allocated.obligationId,
        };
      }

      // Publish an ID-less claim first. OS no-replace, rather than advisory
      // lock liveness, selects the sole process allowed to invoke the ID
      // generator. The claim is immediately completed under the same lock.
      const claim: OperationRecord = {
        schemaVersion: 1,
        idempotencyKey: command.idempotencyKey,
        commandDigest: command.commandDigest,
        obligationId: null,
        state: "claimed",
        eventDigest: null,
      };
      const published = await publishNoReplace(
        directories.operations,
        operationFileName(command.idempotencyKey),
        encodeOperation(claim),
      );
      if (!published) {
        const winner = await readOperation(
          directories.operations,
          command.idempotencyKey,
        );
        if (!winner || winner.commandDigest !== command.commandDigest) {
          return { status: "idempotency_conflict" };
        }
        const allocated = allocatedOperation(winner);
        return {
          status: "idempotent",
          obligationId: allocated.obligationId,
        };
      }
      const obligationId = ObligationIdSchema.parse(
        command.allocateObligationId(),
      );
      const reservation: AllocatedOperationRecord = {
        ...claim,
        obligationId,
        state: "reserved",
      };
      await replaceAtomic(
        directories.operations,
        operationFileName(command.idempotencyKey),
        encodeOperation(reservation),
        encodeOperation(claim),
      );
      return { status: "reserved", obligationId };
    });
  }

  append(
    command: AppendCoverageObligationEventCommand,
  ): Promise<AppendCoverageObligationEventResult> {
    const event = validateAppendCommand(command);
    return this.#locked(async (directories) => {
      const rawOperation = await readOperation(
        directories.operations,
        command.idempotencyKey,
      );
      const digestOfEvent = eventDigest(event);
      let operation = rawOperation
        ? allocatedOperation(rawOperation)
        : undefined;
      if (operation) {
        if (operation.obligationId !== command.obligationId) {
          return { status: "idempotency_conflict" };
        }
        if (operation.state === "committed") {
          await this.#verifyCommittedOperation(directories, operation);
          return operation.eventDigest === digestOfEvent
            ? { status: "idempotent", event }
            : { status: "idempotency_conflict" };
        }
        if (
          event.type !== "created" &&
          operation.commandDigest !== command.commandDigest
        ) {
          return { status: "idempotency_conflict" };
        }
      } else {
        operation = {
          schemaVersion: 1,
          idempotencyKey: command.idempotencyKey,
          commandDigest: command.commandDigest,
          obligationId: command.obligationId,
          state: "reserved",
          eventDigest: null,
        };
        await publishNoReplace(
          directories.operations,
          operationFileName(command.idempotencyKey),
          encodeOperation(operation),
        );
      }

      const stream = await openChildDirectory(
        directories.obligations,
        command.obligationId,
        true,
      );
      try {
        const history = await readStream(stream, command.obligationId);
        const currentVersion = history.at(-1)?.version ?? 0;
        const existing = history.find(
          (candidate) => candidate.idempotencyKey === command.idempotencyKey,
        );
        if (existing) {
          if (eventDigest(existing) !== digestOfEvent) {
            return { status: "idempotency_conflict" };
          }
          await this.#commitOperation(
            directories.operations,
            operation,
            digestOfEvent,
          );
          return { status: "idempotent", event: existing };
        }
        if (currentVersion !== command.expectedVersion) {
          return { status: "version_conflict", currentVersion };
        }
        if (command.claimUnresolvedOwnerQuestionId) {
          const latest = await latestByObligation(directories.obligations);
          if (
            [...latest.values()].some(
              (candidate) =>
                candidate.obligationId !== command.obligationId &&
                candidate.ownerQuestionId ===
                  command.claimUnresolvedOwnerQuestionId &&
                !isTerminalObligationStatus(candidate.status),
            )
          ) {
            return {
              status: "ownership_conflict",
              ownerQuestionId:
                command.claimUnresolvedOwnerQuestionId as QuestionId,
            };
          }
        }
        await publishNoReplace(
          stream,
          eventFileName(event.version),
          eventBytes(event),
        );
        await this.#options.hooks?.afterEventPublished?.();
        await this.#commitOperation(
          directories.operations,
          operation,
          digestOfEvent,
        );
        return { status: "appended", event };
      } finally {
        await stream.close();
      }
    });
  }

  async read(obligationId: ObligationId): Promise<readonly unknown[]> {
    ObligationIdSchema.parse(obligationId);
    const directories = await openPortableDirectories(this.#root);
    try {
      let stream: DirectoryReference;
      try {
        stream = await openChildDirectory(
          directories.obligations,
          obligationId,
          false,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      try {
        return await readStream(stream, obligationId);
      } finally {
        await stream.close();
      }
    } finally {
      await directories.close();
    }
  }

  async readAll(): Promise<readonly unknown[]> {
    const directories = await openPortableDirectories(this.#root);
    try {
      const all: CoverageObligationEvent[] = [];
      for (const obligationId of (
        await directories.obligations.list()
      ).sort()) {
        const parsedId = ObligationIdSchema.parse(obligationId);
        const stream = await openChildDirectory(
          directories.obligations,
          obligationId,
          false,
        );
        try {
          all.push(...(await readStream(stream, parsedId)));
        } finally {
          await stream.close();
        }
      }
      return all;
    } finally {
      await directories.close();
    }
  }

  async #commitOperation(
    operations: DirectoryReference,
    record: OperationRecord,
    committedEventDigest: string,
  ): Promise<void> {
    await replaceAtomic(
      operations,
      operationFileName(record.idempotencyKey),
      encodeOperation({
        ...record,
        state: "committed",
        eventDigest: committedEventDigest,
      }),
      encodeOperation(record),
    );
  }

  async #verifyCommittedOperation(
    directories: Awaited<ReturnType<typeof openPortableDirectories>>,
    operation: AllocatedOperationRecord,
  ): Promise<void> {
    if (!operation.eventDigest) {
      throw new Error("Committed operation has no event digest.");
    }
    const stream = await openChildDirectory(
      directories.obligations,
      operation.obligationId,
      false,
    );
    try {
      const matching = (
        await readStream(stream, operation.obligationId)
      ).filter((event) => event.idempotencyKey === operation.idempotencyKey);
      if (
        matching.length !== 1 ||
        eventDigest(matching[0]!) !== operation.eventDigest
      ) {
        throw new Error(
          "Committed operation does not match portable event history.",
        );
      }
    } finally {
      await stream.close();
    }
  }

  async #locked<T>(
    operation: (
      directories: Awaited<ReturnType<typeof openPortableDirectories>>,
    ) => Promise<T>,
  ): Promise<T> {
    return withRepositoryLock(
      this.#root,
      async () => {
        const directories = await openPortableDirectories(this.#root);
        try {
          return await operation(directories);
        } finally {
          await directories.close();
        }
      },
      this.#options,
    );
  }
}

export function createFileCoverageObligationEventWriter(
  root: string,
  options: FileCoverageObligationEventWriterOptions = {},
): CoverageObligationEventWriter {
  return new FileCoverageObligationEventWriter(root, options);
}
