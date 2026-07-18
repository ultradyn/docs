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

import lockfile from "proper-lockfile";

import {
  IngestionQuestionLinkSchema,
  type IngestionQuestionLink,
  type QuestionLinkStore,
} from "../domain/ingest/question-link.js";
import { resolveContainedPathNoSymlinks } from "../shared/safe-path.js";

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

class FileQuestionLinkStore implements QuestionLinkStore {
  constructor(private readonly root: string) {}

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
    return this.#locked(async () => {
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

  async #locked<T>(operation: () => Promise<T>): Promise<T> {
    const lockRoot = await resolveContainedPathNoSymlinks(
      this.root,
      join(this.root, ".ultradyn", "locks"),
    );
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const lockfilePath = await resolveContainedPathNoSymlinks(
      this.root,
      join(lockRoot, "ingest-question-links.lock"),
    );
    const release = await lockfile.lock(this.root, {
      realpath: false,
      lockfilePath,
      stale: 30_000,
      retries: { retries: 4, factor: 1.25, minTimeout: 10, maxTimeout: 250 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}

function fileName(questionId: string): string {
  return `${encodeURIComponent(questionId)}.json`;
}

function temporaryName(questionId: string): string {
  return `.${encodeURIComponent(questionId)}.json.tmp`;
}

export function createFileQuestionLinkStore(root: string): QuestionLinkStore {
  return new FileQuestionLinkStore(root);
}
