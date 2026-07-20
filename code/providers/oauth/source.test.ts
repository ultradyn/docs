import { mkdtemp } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { OAuthFlowConfig } from "./flows.js";
import { OAuthTokenCredentialSource } from "./source.js";
import { FileOAuthTokenStore } from "./token-store.js";

function config(tokenEndpoint: string): OAuthFlowConfig {
  return {
    id: "xai-oauth",
    providerId: "xai",
    label: "xAI OAuth",
    issuer: "https://auth.x.ai",
    authorizeEndpoint: "https://auth.x.ai/oauth2/authorize",
    tokenEndpoint,
    clientId: "client",
    scopes: ["openid", "profile", "email", "offline_access", "api:access"],
    redirectPath: "/callback",
  };
}

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close().catch(() => undefined);
  }
});

async function startRefreshServer(accessToken: string): Promise<string> {
  const server: Server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on("data", (c: Buffer) => chunks.push(c));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: accessToken,
            expires_in: 3600,
            token_type: "Bearer",
          }),
        );
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bind failed");
  servers.push({
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });
  return `http://127.0.0.1:${address.port}/token`;
}

describe("OAuthTokenCredentialSource", () => {
  it("describes the flow as an http-bearer credential source", async () => {
    const store = new FileOAuthTokenStore(await mkdtemp(join(tmpdir(), "oauth-src-")));
    const source = new OAuthTokenCredentialSource({
      store,
      config: config("http://127.0.0.1:9/token"),
    });
    expect(source.describe()).toEqual({
      id: "xai-oauth",
      label: "xAI OAuth",
      providerId: "xai",
      kind: "http-bearer",
      scopes: ["model", "transcription"],
    });
  });

  it("inspects availability without side effects (no fetch)", async () => {
    const store = new FileOAuthTokenStore(await mkdtemp(join(tmpdir(), "oauth-src-")));
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
      throw new Error("inspect must not fetch");
    };
    const source = new OAuthTokenCredentialSource({
      store,
      config: config("http://127.0.0.1:9/token"),
      fetch: fetchImpl,
      now: () => 1_000_000,
    });

    expect(await source.inspect()).toEqual({
      available: false,
      reason: "No OAuth token is stored; complete the sign-in flow.",
    });

    await store.set("xai-oauth", {
      accessToken: "live",
      refreshToken: "r",
      expiresAt: 1_000_000 + 60_000,
    });
    expect(await source.inspect()).toEqual({ available: true });

    await store.set("xai-oauth", {
      accessToken: "expired",
      refreshToken: "r",
      expiresAt: 1_000_000 - 1,
    });
    expect(await source.inspect()).toEqual({
      available: true,
      reason: "Access token is expired; a refresh will run on resolve.",
    });

    await store.set("xai-oauth", {
      accessToken: "expired",
      expiresAt: 1_000_000 - 1,
    });
    expect(await source.inspect()).toEqual({
      available: false,
      reason: "Access token is expired and no refresh token is stored.",
    });

    expect(fetchCalls).toBe(0);
  });

  it("resolve sets a Bearer header from a valid stored token", async () => {
    const store = new FileOAuthTokenStore(await mkdtemp(join(tmpdir(), "oauth-src-")));
    await store.set("xai-oauth", {
      accessToken: "tok-live",
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    const source = new OAuthTokenCredentialSource({
      store,
      config: config("http://127.0.0.1:9/token"),
    });
    const capability = await source.resolve();
    expect(capability.kind).toBe("http-bearer");
    if (capability.kind !== "http-bearer") throw new Error("wrong kind");
    const headers = new Headers();
    await capability.authorize(headers);
    expect(headers.get("authorization")).toBe("Bearer tok-live");
  });

  it("resolve refreshes an expired token", async () => {
    const endpoint = await startRefreshServer("tok-refreshed");
    const store = new FileOAuthTokenStore(await mkdtemp(join(tmpdir(), "oauth-src-")));
    await store.set("xai-oauth", {
      accessToken: "old",
      refreshToken: "r",
      expiresAt: Date.now() - 1_000,
    });
    const source = new OAuthTokenCredentialSource({
      store,
      config: config(endpoint),
    });
    const capability = await source.resolve();
    if (capability.kind !== "http-bearer") throw new Error("wrong kind");
    const headers = new Headers();
    await capability.authorize(headers);
    expect(headers.get("authorization")).toBe("Bearer tok-refreshed");
    expect(await store.get("xai-oauth")).toMatchObject({
      accessToken: "tok-refreshed",
      refreshToken: "r",
    });
  });
});
