import { z } from "zod";

import type { OAuthFlowConfig } from "./flows.js";
import {
  startLoopbackListener,
  type LoopbackListener,
} from "./loopback.js";
import { createOAuthState, createPkcePair } from "./pkce.js";

export type OAuthTokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  idToken?: string;
};

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
  id_token: z.string().min(1).optional(),
  token_type: z.string().optional(),
});

export class OAuthError extends Error {
  readonly status?: number;
  readonly errorCode?: string;
  readonly errorDescription?: string;

  constructor(
    message: string,
    options: {
      status?: number;
      errorCode?: string;
      errorDescription?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = "OAuthError";
    if (options.status !== undefined) this.status = options.status;
    if (options.errorCode !== undefined) this.errorCode = options.errorCode;
    if (options.errorDescription !== undefined) {
      this.errorDescription = options.errorDescription;
    }
  }
}

export class OAuthStateMismatchError extends OAuthError {
  constructor() {
    super("OAuth state parameter did not match the expected value.");
    this.name = "OAuthStateMismatchError";
  }
}

export class OAuthRefreshFailedError extends OAuthError {
  readonly terminal: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      errorCode?: string;
      errorDescription?: string;
      terminal?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, options);
    this.name = "OAuthRefreshFailedError";
    this.terminal = options.terminal ?? false;
  }
}

export interface RunOAuthFlowOptions {
  config: OAuthFlowConfig;
  fetch?: typeof globalThis.fetch;
  presentUrl?: (url: string) => void | Promise<void>;
  listener?: LoopbackListener;
  timeoutMs?: number;
}

export async function runOAuthFlow(
  options: RunOAuthFlowOptions,
): Promise<OAuthTokenSet> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const { config } = options;
  const pkce = createPkcePair();
  const state = createOAuthState();

  const ownedListener =
    options.listener === undefined
      ? await startLoopbackListener({
          path: config.redirectPath,
          ...(config.fixedPort !== undefined
            ? { port: config.fixedPort }
            : {}),
          ...(options.timeoutMs !== undefined
            ? { timeoutMs: options.timeoutMs }
            : {}),
        })
      : undefined;
  const listener = options.listener ?? ownedListener;
  if (!listener) {
    throw new OAuthError("OAuth loopback listener could not be started.");
  }

  try {
    const redirectUri = `http://127.0.0.1:${listener.port}${config.redirectPath}`;
    const authorizeUrl = new URL(config.authorizeEndpoint);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", config.clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", config.scopes.join(" "));
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    if (config.extraAuthorizeParams) {
      for (const [key, value] of Object.entries(config.extraAuthorizeParams)) {
        authorizeUrl.searchParams.set(key, value);
      }
    }

    if (options.presentUrl) {
      await options.presentUrl(authorizeUrl.toString());
    }

    const callback = await listener.waitForCallback();
    if (callback.state !== state) {
      throw new OAuthStateMismatchError();
    }

    return await exchangeToken({
      config,
      fetchImpl,
      body: {
        grant_type: "authorization_code",
        client_id: config.clientId,
        code: callback.code,
        redirect_uri: redirectUri,
        code_verifier: pkce.verifier,
      },
    });
  } finally {
    if (ownedListener) {
      await ownedListener.close().catch(() => undefined);
    }
  }
}

export interface RefreshOAuthTokenOptions {
  config: OAuthFlowConfig;
  refreshToken: string;
  fetch?: typeof globalThis.fetch;
}

export async function refreshOAuthToken(
  options: RefreshOAuthTokenOptions,
): Promise<OAuthTokenSet> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    return await exchangeToken({
      config: options.config,
      fetchImpl,
      body: {
        grant_type: "refresh_token",
        client_id: options.config.clientId,
        refresh_token: options.refreshToken,
      },
    });
  } catch (error) {
    if (
      error instanceof OAuthError &&
      (error.errorCode === "invalid_grant" ||
        error.status === 400 ||
        error.status === 401)
    ) {
      throw new OAuthRefreshFailedError(
        error.errorDescription
          ? `OAuth refresh failed: ${error.errorDescription}`
          : error.message,
        {
          ...(error.status !== undefined ? { status: error.status } : {}),
          ...(error.errorCode !== undefined
            ? { errorCode: error.errorCode }
            : {}),
          ...(error.errorDescription !== undefined
            ? { errorDescription: error.errorDescription }
            : {}),
          terminal: error.errorCode === "invalid_grant",
          cause: error,
        },
      );
    }
    throw error;
  }
}

async function exchangeToken(options: {
  config: OAuthFlowConfig;
  fetchImpl: typeof globalThis.fetch;
  body: Record<string, string>;
}): Promise<OAuthTokenSet> {
  const form = new URLSearchParams(options.body);
  let response: Response;
  try {
    response = await options.fetchImpl(options.config.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
    });
  } catch (error) {
    throw new OAuthError("OAuth token request failed to complete.", {
      cause: error,
    });
  }

  const rawText = await response.text();
  let parsedJson: unknown;
  try {
    parsedJson = rawText.length === 0 ? {} : JSON.parse(rawText);
  } catch (error) {
    throw new OAuthError(
      `OAuth token endpoint returned non-JSON (HTTP ${response.status}).`,
      { status: response.status, cause: error },
    );
  }

  if (!response.ok) {
    const body =
      parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)
        ? (parsedJson as Record<string, unknown>)
        : {};
    const errorCode =
      typeof body.error === "string" ? body.error : undefined;
    const errorDescription =
      typeof body.error_description === "string"
        ? body.error_description
        : undefined;
    throw new OAuthError(
      errorDescription
        ? `OAuth token endpoint error: ${errorDescription}`
        : errorCode
          ? `OAuth token endpoint error: ${errorCode}`
          : `OAuth token endpoint returned HTTP ${response.status}.`,
      {
        status: response.status,
        ...(errorCode !== undefined ? { errorCode } : {}),
        ...(errorDescription !== undefined ? { errorDescription } : {}),
      },
    );
  }

  let tokenBody: z.infer<typeof tokenResponseSchema>;
  try {
    tokenBody = tokenResponseSchema.parse(parsedJson);
  } catch (error) {
    throw new OAuthError("OAuth token response failed schema validation.", {
      status: response.status,
      cause: error,
    });
  }

  const tokens: OAuthTokenSet = {
    accessToken: tokenBody.access_token,
  };
  if (tokenBody.refresh_token !== undefined) {
    tokens.refreshToken = tokenBody.refresh_token;
  }
  if (tokenBody.id_token !== undefined) {
    tokens.idToken = tokenBody.id_token;
  }
  if (tokenBody.expires_in !== undefined) {
    tokens.expiresAt = Date.now() + tokenBody.expires_in * 1000;
  }
  return tokens;
}
