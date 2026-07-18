import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import {
  link as hardlink,
  lstat,
  mkdir,
  open,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import {
  IngestionQuestionLinkSchema,
  type IngestionQuestionLink,
  type QuestionLinkStore,
} from "../domain/ingest/question-link.js";
import { resolveContainedPathNoSymlinks } from "../shared/safe-path.js";
import {
  withRepositoryLock,
  type RepositoryLockOptions,
} from "./knowledge-repository.js";

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

class FileQuestionLinkStore implements QuestionLinkStore {
  readonly #holder = new AsyncLocalStorage<true>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly lockOptions: RepositoryLockOptions = {},
  ) {}

  // The canonical machine-local repository lock (same lockfile as
  // KnowledgeRepository for this root), so link publication and question
  // lifecycle mutations share one mutual-exclusion domain. Reentrant within
  // the holding async context; serialized in-process via a queue.
  locked<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#holder.getStore()) return operation();
    const run = () =>
      withRepositoryLock(
        this.root,
        () => this.#holder.run(true, operation),
        this.lockOptions,
      );
    const result = this.#queue.then(run, run);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async get(questionId: string): Promise<IngestionQuestionLink | undefined> {
    const path = join(await this.#directory(), fileName(questionId));
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return undefined;
      if (code === "ELOOP") {
        throw new Error(`Refusing to read symbolic link at ${path}.`);
      }
      throw error;
    }
    let bytes: Buffer;
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const parsed = IngestionQuestionLinkSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    );
    if (parsed.questionId !== questionId) {
      throw new Error(
        `Stored link questionId ${parsed.questionId} does not match requested ${questionId}.`,
      );
    }
    return parsed;
  }

  async create(input: IngestionQuestionLink): Promise<boolean> {
    const link = IngestionQuestionLinkSchema.parse(input);
    const directory = await this.#directory();
    const destination = join(directory, fileName(link.questionId));
    const temporary = join(directory, temporaryName(link.questionId));
    return this.locked(async () => {
      // rm targets the temp name itself (never its referent), clearing stale
      // partial writes and squatted symlinks alike; O_EXCL then guarantees a
      // fresh regular file even if the name reappears in between.
      await rm(temporary, { force: true });
      let handle: FileHandle;
      try {
        handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o444,
        );
      } catch (error) {
        if (errorCode(error) === "EEXIST") return false;
        throw error;
      }
      try {
        await handle.writeFile(`${JSON.stringify(link, null, 2)}\n`);
        await handle.chmod(0o444);
        await handle.sync();
      } finally {
        await handle.close();
      }

      // link(2) never follows or replaces an existing destination entry, so
      // publication is exclusive at the OS level even without the advisory
      // lock; EEXIST distinguishes an already-published link from sabotage.
      try {
        await hardlink(temporary, destination);
      } catch (error) {
        await rm(temporary, { force: true });
        if (errorCode(error) === "EEXIST") {
          const existing = await lstat(destination);
          if (existing.isSymbolicLink()) {
            throw new Error(
              `Refusing to publish over symbolic link at ${destination}.`,
            );
          }
          return false;
        }
        throw error;
      }
      await rm(temporary, { force: true });
      await this.#syncDirectory(directory);
      return true;
    });
  }

  async #directory(): Promise<string> {
    const directory = join(this.root, "ingest", "question-links");
    await mkdir(directory, { recursive: true });
    return resolveContainedPathNoSymlinks(this.root, directory);
  }

  async #syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

}

function fileName(questionId: string): string {
  return `${encodeURIComponent(questionId)}.json`;
}

function temporaryName(questionId: string): string {
  return `.${encodeURIComponent(questionId)}.json.tmp`;
}

export function createFileQuestionLinkStore(
  root: string,
  lockOptions: RepositoryLockOptions = {},
): QuestionLinkStore {
  return new FileQuestionLinkStore(root, lockOptions);
}
