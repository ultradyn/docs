import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

import type { OAuthFlowConfig } from "./flows.js";
import {
  OAuthRefreshFailedError,
  refreshOAuthToken,
  type OAuthTokenSet,
} from "./flow.js";

const tokenSetSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().finite().optional(),
  idToken: z.string().min(1).optional(),
});

const storeFileSchema = z.object({
  schemaVersion: z.literal(1),
  tokens: z.record(z.string(), tokenSetSchema),
});

type StoreFile = z.infer<typeof storeFileSchema>;

export class OAuthTokenStoreCorruptError extends Error {
  constructor(path: string, cause?: unknown) {
    super(`OAuth token store at ${path} is corrupt or invalid.`, {
      cause,
    });
    this.name = "OAuthTokenStoreCorruptError";
  }
}

export class OAuthTokenUnavailableError extends Error {
  constructor(flowId: string, reason: string) {
    super(`OAuth token for ${flowId} is unavailable: ${reason}`);
    this.name = "OAuthTokenUnavailableError";
  }
}

export class FileOAuthTokenStore {
  readonly #rootDir: string;
  readonly #path: string;

  constructor(rootDir: string) {
    this.#rootDir = rootDir;
    this.#path = join(rootDir, "oauth-tokens.json");
  }

  get path(): string {
    return this.#path;
  }

  async get(flowId: string): Promise<OAuthTokenSet | undefined> {
    const stored = (await this.#read()).tokens[flowId];
    return stored === undefined ? undefined : toTokenSet(stored);
  }

  async set(flowId: string, tokens: OAuthTokenSet): Promise<void> {
    const current = await this.#read();
    current.tokens[flowId] = toStoredToken(tokens);
    await this.#write(current);
  }

  async clear(flowId: string): Promise<void> {
    const current = await this.#read();
    if (!(flowId in current.tokens)) return;
    delete current.tokens[flowId];
    await this.#write(current);
  }

  async list(): Promise<string[]> {
    return Object.keys((await this.#read()).tokens).sort();
  }

  async #read(): Promise<StoreFile> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, tokens: {} };
      }
      throw error;
    }

    try {
      return storeFileSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new OAuthTokenStoreCorruptError(this.#path, error);
    }
  }

  async #write(data: StoreFile): Promise<void> {
    await mkdir(this.#rootDir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(
      this.#path,
      `${JSON.stringify(data, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
  }
}

const inflightRefreshes = new Map<string, Promise<OAuthTokenSet>>();

export interface GetValidTokenOptions {
  store: FileOAuthTokenStore;
  flowId: string;
  config: OAuthFlowConfig;
  fetch?: typeof globalThis.fetch;
  refreshBufferMs?: number;
  now?: () => number;
}

/**
 * Return a still-valid token, refreshing once (single-flight per flowId) when
 * the stored token is inside the refresh buffer or already expired.
 */
export async function getValidToken(
  options: GetValidTokenOptions,
): Promise<OAuthTokenSet> {
  const now = options.now ?? (() => Date.now());
  const bufferMs = options.refreshBufferMs ?? 5 * 60 * 1000;
  const stored = await options.store.get(options.flowId);
  if (!stored) {
    throw new OAuthTokenUnavailableError(
      options.flowId,
      "no token is stored",
    );
  }

  const expiresAt = stored.expiresAt;
  const stillValid =
    expiresAt === undefined || expiresAt - bufferMs > now();
  if (stillValid) {
    return stored;
  }

  if (!stored.refreshToken) {
    await options.store.clear(options.flowId);
    throw new OAuthTokenUnavailableError(
      options.flowId,
      "access token expired and no refresh token is available",
    );
  }

  const existing = inflightRefreshes.get(options.flowId);
  if (existing) {
    return existing;
  }

  const refreshPromise = (async (): Promise<OAuthTokenSet> => {
    try {
      const refreshed = await refreshOAuthToken({
        config: options.config,
        refreshToken: stored.refreshToken!,
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      });
      const next: OAuthTokenSet = { accessToken: refreshed.accessToken };
      const refreshToken = refreshed.refreshToken ?? stored.refreshToken;
      if (refreshToken !== undefined) next.refreshToken = refreshToken;
      if (refreshed.expiresAt !== undefined) {
        next.expiresAt = refreshed.expiresAt;
      }
      if (refreshed.idToken !== undefined) {
        next.idToken = refreshed.idToken;
      } else if (stored.idToken !== undefined) {
        next.idToken = stored.idToken;
      }
      await options.store.set(options.flowId, next);
      return next;
    } catch (error) {
      if (error instanceof OAuthRefreshFailedError && error.terminal) {
        await options.store.clear(options.flowId);
        throw new OAuthTokenUnavailableError(
          options.flowId,
          error.errorDescription ?? error.message,
        );
      }
      throw error;
    } finally {
      inflightRefreshes.delete(options.flowId);
    }
  })();

  inflightRefreshes.set(options.flowId, refreshPromise);
  return refreshPromise;
}

type StoredToken = z.infer<typeof tokenSetSchema>;

function toTokenSet(stored: StoredToken): OAuthTokenSet {
  const tokens: OAuthTokenSet = { accessToken: stored.accessToken };
  if (stored.refreshToken !== undefined) tokens.refreshToken = stored.refreshToken;
  if (stored.expiresAt !== undefined) tokens.expiresAt = stored.expiresAt;
  if (stored.idToken !== undefined) tokens.idToken = stored.idToken;
  return tokens;
}

function toStoredToken(tokens: OAuthTokenSet): StoredToken {
  const stored: StoredToken = { accessToken: tokens.accessToken };
  if (tokens.refreshToken !== undefined) stored.refreshToken = tokens.refreshToken;
  if (tokens.expiresAt !== undefined) stored.expiresAt = tokens.expiresAt;
  if (tokens.idToken !== undefined) stored.idToken = tokens.idToken;
  return stored;
}

/** Test helper: inspect file mode of the token store path when it exists. */
export async function tokenStoreFileMode(
  store: FileOAuthTokenStore,
): Promise<number | undefined> {
  try {
    const info = await stat(store.path);
    return info.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
