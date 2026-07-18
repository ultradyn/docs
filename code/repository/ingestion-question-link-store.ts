import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import {
  link as hardlink,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import {
  IngestionQuestionLinkSchema,
  type IngestionQuestionLink,
  type QuestionLinkStore,
} from "../domain/ingest/index.js";
import { resolveContainedPathNoSymlinks } from "../shared/safe-path.js";
import {
  withRepositoryLock,
  type RepositoryLockOptions,
} from "./knowledge-repository.js";

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

export interface QuestionLinkStoreHooks {
  /** Test seam: runs after the links directory is resolved/opened and before
   * any read or publication syscall against it. */
  afterDirectoryResolved?: () => Promise<void> | void;
  /** Test seam: runs after the destination directory has been fsynced. */
  onDirectorySynced?: () => void;
}

export interface FileQuestionLinkStoreOptions extends RepositoryLockOptions {
  hooks?: QuestionLinkStoreHooks;
}

/**
 * A links directory whose identity stays bound for the lifetime of the
 * reference: on Linux every child pathname routes through /proc/self/fd of a
 * directory handle opened with O_DIRECTORY|O_NOFOLLOW per component, so
 * swapping an ancestor to a symlink after the descent cannot redirect any
 * later syscall. Platforms without /proc fall back to pathname resolution
 * with symlink-component rejection; the ancestor-swap window between
 * resolution and use is a documented residual risk there.
 */
interface DirectoryReference {
  at(name: string): string;
  list(): Promise<string[]>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const LINKS_COMPONENTS = ["ingest", "question-links"] as const;
const FD_BOUND = process.platform === "linux";

let temporaryAttempt = 0;

class FileQuestionLinkStore implements QuestionLinkStore {
  readonly #holder = new AsyncLocalStorage<true>();
  #queue: Promise<unknown> = Promise.resolve();
  readonly #hooks: QuestionLinkStoreHooks;
  #canonicalRoot: Promise<string> | undefined;

  constructor(
    private readonly root: string,
    private readonly options: FileQuestionLinkStoreOptions = {},
  ) {
    this.#hooks = options.hooks ?? {};
  }

  // The canonical machine-local repository lock (same lockfile as
  // KnowledgeRepository for this root), so link publication and question
  // lifecycle mutations share one mutual-exclusion domain. Reentrant within
  // the holding async context; serialized in-process via a queue.
  locked<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#holder.getStore()) return operation();
    const run = async () =>
      withRepositoryLock(
        await this.#getCanonicalRoot(),
        () => this.#holder.run(true, operation),
        this.options,
      );
    const result = this.#queue.then(run, run);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async get(questionId: string): Promise<IngestionQuestionLink | undefined> {
    const directory = await this.#openLinksDirectory();
    let operationFailed = false;
    try {
      await this.#hooks.afterDirectoryResolved?.();
      const path = directory.at(fileName(questionId));
      let handle: FileHandle;
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT") return undefined;
        if (code === "ELOOP") {
          throw new Error(`Refusing to read symbolic link at ${path}.`, {
            cause: error,
          });
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
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      await this.#closeDirectoryReference(directory, operationFailed);
    }
  }

  async create(input: IngestionQuestionLink): Promise<boolean> {
    const link = IngestionQuestionLinkSchema.parse(input);
    return this.locked(async () => {
      const directory = await this.#openLinksDirectory();
      let operationFailed = false;
      try {
        await this.#hooks.afterDirectoryResolved?.();
        const encoded = encodeURIComponent(link.questionId);
        const destination = directory.at(`${encoded}.json`);

        // Sweep crash leftovers for this ID. rm targets each temp name itself
        // (never its referent), so squatted symlinks are cleared, not
        // followed. Live writers are unaffected: temp names are unique per
        // attempt and the sweep precedes this attempt's O_EXCL create.
        for (const entry of await directory.list()) {
          if (entry.startsWith(`.${encoded}.json.`) && entry.endsWith(".tmp")) {
            await rm(directory.at(entry), { force: true });
          }
        }

        const temporary = directory.at(
          `.${encoded}.json.${process.pid}-${(temporaryAttempt += 1)}.tmp`,
        );
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
          const code = errorCode(error);
          if (code === "EEXIST") {
            const existing = await lstat(destination);
            if (existing.isSymbolicLink()) {
              throw new Error(
                `Refusing to publish over symbolic link at ${destination}.`,
                { cause: error },
              );
            }
            return false;
          }
          if (code === "ENOENT") {
            // A competing writer's sweep unlinked this attempt's temp file.
            // The record itself is safe (nothing was published); report the
            // race as a duplicate if the rival already landed.
            if (await this.#exists(destination)) return false;
          }
          throw error;
        }
        await rm(temporary, { force: true });
        await directory.sync();
        this.#hooks.onDirectorySynced?.();
        return true;
      } catch (error) {
        operationFailed = true;
        throw error;
      } finally {
        await this.#closeDirectoryReference(directory, operationFailed);
      }
    });
  }

  async #closeDirectoryReference(
    directory: DirectoryReference,
    preservePrimaryError: boolean,
  ): Promise<void> {
    try {
      await directory.close();
    } catch (error) {
      if (!preservePrimaryError) throw error;
    }
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
  }

  async #openLinksDirectory(): Promise<DirectoryReference> {
    if (!FD_BOUND) return this.#openLinksDirectoryByPath();

    const handles = new Set<FileHandle>();
    let handle = await open(await this.#getCanonicalRoot(), DIRECTORY_FLAGS);
    handles.add(handle);
    try {
      for (const component of LINKS_COMPONENTS) {
        const componentPath = `/proc/self/fd/${handle.fd}/${component}`;
        try {
          await mkdir(componentPath);
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
              `Refusing symbolic-link path component ${component} under ${this.root}.`,
              { cause: error },
            );
          }
          throw error;
        }
        handles.add(child);
        const parent = handle;
        handle = child;
        await this.#closeDirectoryHandle(parent);
        handles.delete(parent);
      }
    } catch (error) {
      await this.#closeDirectoryHandles(handles);
      throw error;
    }
    const bound = handle;
    return {
      at: (name) => `/proc/self/fd/${bound.fd}/${name}`,
      list: () => readdir(`/proc/self/fd/${bound.fd}`),
      sync: () => bound.sync(),
      close: () => bound.close(),
    };
  }

  async #getCanonicalRoot(): Promise<string> {
    if (!this.#canonicalRoot) {
      const pending = realpath(this.root);
      this.#canonicalRoot = pending;
      try {
        await pending;
      } catch (error) {
        this.#clearRejectedCanonicalRoot(pending);
        throw error;
      }
    }
    return await this.#canonicalRoot;
  }

  #clearRejectedCanonicalRoot(pending: Promise<string>): void {
    if (this.#canonicalRoot === pending) this.#canonicalRoot = undefined;
  }

  async #closeDirectoryHandle(handle: FileHandle): Promise<void> {
    await handle.close();
  }

  async #closeDirectoryHandles(handles: Set<FileHandle>): Promise<void> {
    for (const handle of handles) {
      try {
        await this.#closeDirectoryHandle(handle);
      } catch {
        try {
          await handle.close();
        } catch {
          // Best-effort cleanup must not mask the primary traversal failure.
        }
      }
    }
  }

  async #openLinksDirectoryByPath(): Promise<DirectoryReference> {
    const canonicalRoot = await this.#getCanonicalRoot();
    const directory = join(canonicalRoot, ...LINKS_COMPONENTS);
    await mkdir(directory, { recursive: true });
    const resolved = await resolveContainedPathNoSymlinks(
      canonicalRoot,
      directory,
    );
    return {
      at: (name) => join(resolved, name),
      list: () => readdir(resolved),
      sync: async () => {
        const handle = await open(resolved, constants.O_RDONLY);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
      close: async () => {},
    };
  }
}

function fileName(questionId: string): string {
  return `${encodeURIComponent(questionId)}.json`;
}

export function createFileQuestionLinkStore(
  root: string,
  options: FileQuestionLinkStoreOptions = {},
): QuestionLinkStore {
  return new FileQuestionLinkStore(root, options);
}
