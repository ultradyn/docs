import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import {
  FileOAuthTokenStore,
  getValidToken,
  OAuthTokenStoreCorruptError,
  OAuthTokenUnavailableError,
  tokenStoreFileMode,
} from "./token-store.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "oauth-tokens-"));
}

function testConfig(tokenEndpoint: string): OAuthFlowConfig {
  return {
    id: "xai-oauth",
    providerId: "xai",
    label: "xAI OAuth",
    issuer: "https://auth.x.ai",
    authorizeEndpoint: "https://auth.x.ai/oauth2/authorize",
    tokenEndpoint,
    clientId: "client",
    scopes: ["openid"],
    redirectPath: "/callback",
    consentScopes: ["model", "transcription"],
  };
}

interface FakeTokenServer {
  hits: number;
  bodies: URLSearchParams[];
  endpoint: string;
  setResponse(body: unknown, status?: number): void;
  close(): Promise<void>;
}

async function startTokenServer(
  handler?: (body: URLSearchParams) => { status: number; body: unknown },
): Promise<FakeTokenServer> {
  let response = {
    status: 200,
    body: {
      access_token: "new-access",
      expires_in: 3600,
      token_type: "Bearer",
    } as unknown,
  };
  const bodies: URLSearchParams[] = [];
  let hits = 0;

  const server: Server = createServer(
    (request: IncomingMessage, responseWriter: ServerResponse) => {
      if (request.method !== "POST") {
        responseWriter.writeHead(404);
        responseWriter.end();
        return;
      }
      hits += 1;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = new URLSearchParams(
          Buffer.concat(chunks).toString("utf8"),
        );
        bodies.push(body);
        const next = handler?.(body) ?? response;
        responseWriter.writeHead(next.status, {
          "content-type": "application/json",
        });
        responseWriter.end(JSON.stringify(next.body));
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
  if (!address || typeof address === "string") {
    throw new Error("token server failed to bind");
  }

  return {
    get hits() {
      return hits;
    },
    get bodies() {
      return bodies;
    },
    endpoint: `http://127.0.0.1:${address.port}/token`,
    setResponse(body: unknown, status = 200) {
      response = { status, body };
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const servers: FakeTokenServer[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close().catch(() => undefined);
  }
});

describe("FileOAuthTokenStore", () => {
  it("round-trips set/get/clear/list", async () => {
    const root = await tempRoot();
    const store = new FileOAuthTokenStore(root);
    expect(await store.get("xai-oauth")).toBeUndefined();
    expect(await store.list()).toEqual([]);

    await store.set("xai-oauth", {
      accessToken: "a1",
      refreshToken: "r1",
      expiresAt: 1_700_000_000_000,
    });
    await store.set("openai-oauth", { accessToken: "a2" });

    expect(await store.get("xai-oauth")).toEqual({
      accessToken: "a1",
      refreshToken: "r1",
      expiresAt: 1_700_000_000_000,
    });
    expect(await store.list()).toEqual(["openai-oauth", "xai-oauth"]);

    await store.clear("xai-oauth");
    expect(await store.get("xai-oauth")).toBeUndefined();
    expect(await store.list()).toEqual(["openai-oauth"]);
  });

  it("writes the token file with mode 0600", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot();
    const store = new FileOAuthTokenStore(root);
    await store.set("xai-oauth", { accessToken: "a" });
    expect(await tokenStoreFileMode(store)).toBe(0o600);
  });

  it("treats a missing file as empty", async () => {
    const store = new FileOAuthTokenStore(await tempRoot());
    expect(await store.get("anything")).toBeUndefined();
  });

  it("throws OAuthTokenStoreCorruptError and preserves the file", async () => {
    const root = await tempRoot();
    const path = join(root, "oauth-tokens.json");
    await writeFile(path, "{not-json", "utf8");
    const store = new FileOAuthTokenStore(root);
    await expect(store.get("x")).rejects.toBeInstanceOf(
      OAuthTokenStoreCorruptError,
    );
    expect(await readFile(path, "utf8")).toBe("{not-json");
  });
});

describe("getValidToken", () => {
  it("returns a still-valid token without calling fetch", async () => {
    const store = new FileOAuthTokenStore(await tempRoot());
    await store.set("xai-oauth", {
      accessToken: "live",
      refreshToken: "r",
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    let fetchCalls = 0;
    const tokens = await getValidToken({
      store,
      flowId: "xai-oauth",
      config: testConfig("http://127.0.0.1:9/token"),
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("should not fetch");
      },
      now: () => Date.now(),
    });
    expect(tokens.accessToken).toBe("live");
    expect(fetchCalls).toBe(0);
  });

  it("refreshes when inside the buffer, persists rotation, and keeps old refresh when omitted", async () => {
    const server = await startTokenServer();
    servers.push(server);
    server.setResponse({
      access_token: "rotated-access",
      expires_in: 3600,
      token_type: "Bearer",
      // deliberately omit refresh_token
    });

    const store = new FileOAuthTokenStore(await tempRoot());
    const now = 1_000_000;
    await store.set("xai-oauth", {
      accessToken: "old-access",
      refreshToken: "keep-me",
      expiresAt: now + 60_000, // within default 5 min buffer
    });

    const tokens = await getValidToken({
      store,
      flowId: "xai-oauth",
      config: testConfig(server.endpoint),
      now: () => now,
    });

    expect(tokens.accessToken).toBe("rotated-access");
    expect(tokens.refreshToken).toBe("keep-me");
    expect(await store.get("xai-oauth")).toMatchObject({
      accessToken: "rotated-access",
      refreshToken: "keep-me",
    });
    expect(server.hits).toBe(1);
  });

  it("clears the store and throws OAuthTokenUnavailableError on terminal invalid_grant", async () => {
    const server = await startTokenServer();
    servers.push(server);
    server.setResponse(
      { error: "invalid_grant", error_description: "revoked" },
      400,
    );

    const store = new FileOAuthTokenStore(await tempRoot());
    await store.set("xai-oauth", {
      accessToken: "old",
      refreshToken: "dead",
      expiresAt: Date.now() - 1_000,
    });

    await expect(
      getValidToken({
        store,
        flowId: "xai-oauth",
        config: testConfig(server.endpoint),
      }),
    ).rejects.toBeInstanceOf(OAuthTokenUnavailableError);
    expect(await store.get("xai-oauth")).toBeUndefined();
  });

  it("single-flights concurrent refreshes for the same flowId", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hits = 0;

    const server = await startTokenServer(() => {
      hits += 1;
      // Block first request until both callers are in-flight; but our handler
      // is sync-return. Use a delayed JSON response via a custom server instead.
      return {
        status: 200,
        body: {
          access_token: `access-${hits}`,
          expires_in: 3600,
          token_type: "Bearer",
        },
      };
    });
    // Replace with a slower custom server for true concurrency.
    await server.close();
    servers.pop();

    const bodies: URLSearchParams[] = [];
    let resolveFirstBody!: () => void;
    const firstBodySeen = new Promise<void>((resolve) => {
      resolveFirstBody = resolve;
    });
    let hitCount = 0;
    const slow: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        hitCount += 1;
        bodies.push(
          new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
        );
        if (hitCount === 1) resolveFirstBody();
        void gate.then(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: "shared-access",
              expires_in: 3600,
              token_type: "Bearer",
            }),
          );
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      slow.once("error", reject);
      slow.listen(0, "127.0.0.1", () => {
        slow.off("error", reject);
        resolve();
      });
    });
    const address = slow.address();
    if (!address || typeof address === "string") throw new Error("bind failed");
    const endpoint = `http://127.0.0.1:${address.port}/token`;
    servers.push({
      hits: 0,
      bodies,
      endpoint,
      setResponse() {},
      close: () =>
        new Promise((resolve, reject) => {
          slow.close((error) => (error ? reject(error) : resolve()));
        }),
    });

    const store = new FileOAuthTokenStore(await tempRoot());
    await store.set("xai-oauth", {
      accessToken: "old",
      refreshToken: "r",
      expiresAt: Date.now() - 1,
    });
    const config = testConfig(endpoint);

    const p1 = getValidToken({ store, flowId: "xai-oauth", config });
    const p2 = getValidToken({ store, flowId: "xai-oauth", config });
    await firstBodySeen;
    // Second caller should join the in-flight promise without a second hit.
    await new Promise((r) => setTimeout(r, 50));
    expect(hitCount).toBe(1);
    release();
    const [a, b] = await Promise.all([p1, p2]);
    expect(a.accessToken).toBe("shared-access");
    expect(b.accessToken).toBe("shared-access");
    expect(hitCount).toBe(1);
  });
});
