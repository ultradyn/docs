import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { GitHostProvider, GitHostReviewTask } from "../providers/index.js";
import type { MaintenanceTask } from "../shared/index.js";

interface StoredTask extends MaintenanceTask {
  repository: string;
  changeRequestId: string;
  revision: string;
  providerEventId: string;
}

interface MaintenanceState {
  version: 1;
  providerId: string;
  repository: string;
  cursor: string | null;
  tasks: StoredTask[];
}

export interface MaintenanceCoordinatorOptions {
  dataRoot: string;
  provider: GitHostProvider;
  now?: () => Date;
}

export class MaintenanceCoordinator {
  readonly #dataRoot: string;
  readonly #provider: GitHostProvider;
  readonly #now: () => Date;
  readonly #operations = new Map<string, Promise<void>>();

  constructor(options: MaintenanceCoordinatorOptions) {
    this.#dataRoot = options.dataRoot;
    this.#provider = options.provider;
    this.#now = options.now ?? (() => new Date());
  }

  async list(repository: string): Promise<MaintenanceTask[]> {
    await this.#operations.get(repository);
    const state = await this.#read(repository);
    return state.tasks.map(toPublicTask);
  }

  async setStatus(
    repository: string,
    id: string,
    status: MaintenanceTask["status"],
  ): Promise<MaintenanceTask> {
    return this.#enqueue(repository, async () => {
      const state = await this.#read(repository);
      const task = state.tasks.find((candidate) => candidate.id === id);
      if (!task) throw new Error(`Unknown maintenance task: ${id}`);
      task.status = status;
      task.updated = this.#now().toISOString();
      await this.#write(repository, state);
      return toPublicTask(task);
    });
  }

  async run(repository: string): Promise<MaintenanceTask[]> {
    return this.#enqueue(repository, () => this.#poll(repository));
  }

  async #poll(repository: string): Promise<MaintenanceTask[]> {
    const state = await this.#read(repository);
    const result = await this.#provider.poll({
      repository,
      cursor: state.cursor,
    });

    for (const event of result.tasks) {
      const id = taskId(this.#provider.id, repository, event.changeRequestId);
      const existing = state.tasks.find((task) => task.id === id);
      if (existing?.revision === event.revision) continue;
      if (existing) {
        const previousRevision = existing.revision;
        existing.kind = "rereview";
        existing.title = `Re-review change request #${event.changeRequestId}`;
        existing.detail = `Head revision changed from ${previousRevision} to ${event.revision}; the prior review is no longer current.`;
        existing.status = "open";
        existing.updated = this.#now().toISOString();
        existing.revision = event.revision;
        existing.providerEventId = event.id;
        continue;
      }
      state.tasks.push(
        createStoredTask({
          id,
          repository,
          providerId: this.#provider.id,
          event,
          updated: this.#now().toISOString(),
        }),
      );
    }
    state.cursor = result.cursor;
    await this.#write(repository, state);
    return state.tasks.map(toPublicTask);
  }

  async #enqueue<T>(
    repository: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#operations.get(repository) ?? Promise.resolve();
    const execution = previous.catch(() => undefined).then(operation);
    const tail = execution.then(
      () => undefined,
      () => undefined,
    );
    this.#operations.set(repository, tail);
    try {
      return await execution;
    } finally {
      if (this.#operations.get(repository) === tail) {
        this.#operations.delete(repository);
      }
    }
  }

  async #read(repository: string): Promise<MaintenanceState> {
    try {
      return JSON.parse(
        await readFile(this.#path(repository), "utf8"),
      ) as MaintenanceState;
    } catch (error) {
      if (isMissingFile(error)) {
        return {
          version: 1,
          providerId: this.#provider.id,
          repository,
          cursor: null,
          tasks: [],
        };
      }
      throw error;
    }
  }

  async #write(repository: string, state: MaintenanceState): Promise<void> {
    const path = this.#path(repository);
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  #path(repository: string): string {
    const key = createHash("sha256")
      .update(`${this.#provider.id}\0${repository}`)
      .digest("hex")
      .slice(0, 24);
    return join(this.#dataRoot, "maintenance", `${key}.json`);
  }
}

function createStoredTask(input: {
  id: string;
  repository: string;
  providerId: string;
  event: GitHostReviewTask;
  updated: string;
}): StoredTask {
  const kind = input.event.reason === "updated" ? "rereview" : "review";
  return {
    id: input.id,
    kind,
    title: `${kind === "rereview" ? "Re-review" : "Review"} change request #${input.event.changeRequestId}`,
    detail: `${input.providerId} reported ${input.event.reason} at revision ${input.event.revision}.`,
    status: "open",
    updated: input.updated,
    repository: input.repository,
    changeRequestId: input.event.changeRequestId,
    revision: input.event.revision,
    providerEventId: input.event.id,
  };
}

function taskId(
  providerId: string,
  repository: string,
  changeRequestId: string,
): string {
  return `${providerId}:${repository}#${changeRequestId}`;
}

function toPublicTask(task: StoredTask): MaintenanceTask {
  const {
    repository,
    changeRequestId,
    revision,
    providerEventId,
    ...publicTask
  } = task;
  void repository;
  void changeRequestId;
  void revision;
  void providerEventId;
  return publicTask;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
