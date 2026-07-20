import type {
  CredentialCapability,
  CredentialSource,
  CredentialSourceDescription,
} from "../credentials.js";

import type { OAuthFlowConfig } from "./flows.js";
import {
  FileOAuthTokenStore,
  getValidToken,
  OAuthTokenUnavailableError,
} from "./token-store.js";

export interface OAuthTokenCredentialSourceOptions {
  store: FileOAuthTokenStore;
  config: OAuthFlowConfig;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/**
 * CredentialSource backed by a machine-local OAuth token store.
 * `inspect` is side-effect free (no refresh); `resolve` may refresh.
 */
export class OAuthTokenCredentialSource implements CredentialSource {
  readonly #store: FileOAuthTokenStore;
  readonly #config: OAuthFlowConfig;
  readonly #fetch?: typeof globalThis.fetch;
  readonly #now?: () => number;

  constructor(options: OAuthTokenCredentialSourceOptions) {
    this.#store = options.store;
    this.#config = options.config;
    if (options.fetch !== undefined) this.#fetch = options.fetch;
    if (options.now !== undefined) this.#now = options.now;
  }

  describe(): CredentialSourceDescription {
    return {
      id: this.#config.id,
      label: this.#config.label,
      providerId: this.#config.providerId,
      kind: "http-bearer",
      scopes: [...this.#config.consentScopes],
    };
  }

  async inspect(): Promise<{ available: boolean; reason?: string }> {
    const tokens = await this.#store.get(this.#config.id);
    if (!tokens) {
      return {
        available: false,
        reason: "No OAuth token is stored; complete the sign-in flow.",
      };
    }

    const now = this.#now?.() ?? Date.now();
    if (
      tokens.expiresAt !== undefined &&
      tokens.expiresAt <= now &&
      tokens.refreshToken
    ) {
      return {
        available: true,
        reason: "Access token is expired; a refresh will run on resolve.",
      };
    }
    if (tokens.expiresAt !== undefined && tokens.expiresAt <= now) {
      return {
        available: false,
        reason: "Access token is expired and no refresh token is stored.",
      };
    }
    return { available: true };
  }

  async resolve(): Promise<CredentialCapability> {
    return {
      kind: "http-bearer",
      sourceId: this.#config.id,
      providerId: this.#config.providerId,
      authorize: async (headers) => {
        try {
          const tokens = await getValidToken({
            store: this.#store,
            flowId: this.#config.id,
            config: this.#config,
            ...(this.#fetch !== undefined ? { fetch: this.#fetch } : {}),
            ...(this.#now !== undefined ? { now: this.#now } : {}),
          });
          headers.set("authorization", `Bearer ${tokens.accessToken}`);
        } catch (error) {
          if (error instanceof OAuthTokenUnavailableError) throw error;
          throw new OAuthTokenUnavailableError(
            this.#config.id,
            error instanceof Error ? error.message : "token resolution failed",
          );
        }
      },
    };
  }
}
