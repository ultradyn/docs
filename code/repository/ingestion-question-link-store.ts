import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import lockfile from "proper-lockfile";

import {
  IngestionQuestionLinkSchema,
  type IngestionQuestionLink,
  type QuestionLinkStore,
} from "../domain/ingest/question-link.js";
import { resolveContainedPathNoSymlinks } from "../shared/safe-path.js";

class FileQuestionLinkStore implements QuestionLinkStore {
  constructor(private readonly root: string) {}

  async get(questionId: string): Promise<IngestionQuestionLink | undefined> {
    const path = await this.#path(questionId);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
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
    const path = await this.#path(link.questionId);
    await mkdir(dirname(path), { recursive: true });
    return this.#locked(async () => {
      if (await this.#exists(path)) return false;

      const temporaryPath = await this.#temporaryPath(link.questionId);
      await rm(temporaryPath, { force: true });
      let handle: FileHandle;
      try {
        handle = await open(temporaryPath, "wx", 0o444);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }

      try {
        await handle.writeFile(`${JSON.stringify(link, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(temporaryPath, 0o444);
      await rename(temporaryPath, path);
      return true;
    });
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

  async #exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  #path(questionId: string): Promise<string> {
    return resolveContainedPathNoSymlinks(
      this.root,
      join(
        this.root,
        "ingest",
        "question-links",
        `${encodeURIComponent(questionId)}.json`,
      ),
    );
  }

  #temporaryPath(questionId: string): Promise<string> {
    return resolveContainedPathNoSymlinks(
      this.root,
      join(
        this.root,
        "ingest",
        "question-links",
        `.${encodeURIComponent(questionId)}.json.tmp`,
      ),
    );
  }
}

export function createFileQuestionLinkStore(root: string): QuestionLinkStore {
  return new FileQuestionLinkStore(root);
}
