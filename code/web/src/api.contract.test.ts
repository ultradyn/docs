// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer, createDemoServices } from "../../server/index.js";
import { ApiClient } from "./api.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("live HTTP contract adapter", () => {
  it("uses the web UI origin by default and preserves explicit overrides", () => {
    vi.stubGlobal("window", {
      location: { origin: "http://xsm:5885" },
    });

    expect(new ApiClient().url("/api/settings")).toBe(
      "http://xsm:5885/api/settings",
    );
    expect(
      new ApiClient({ baseUrl: "http://127.0.0.1:49321" }).url("/api/settings"),
    ).toBe("http://127.0.0.1:49321/api/settings");
  });

  it("preserves environment, desktop, and non-browser API defaults", () => {
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {},
      location: { origin: "http://xsm:5885" },
    });
    vi.stubEnv("VITE_ULTRADYN_API_BASE", "http://dev-server.test:7443/");
    expect(new ApiClient().url("/api/settings")).toBe(
      "http://dev-server.test:7443/api/settings",
    );

    vi.unstubAllEnvs();
    expect(new ApiClient().url("/api/settings")).toBe(
      "http://127.0.0.1:49321/api/settings",
    );

    vi.stubGlobal("window", undefined);
    expect(new ApiClient().url("/api/settings")).toBe("/api/settings");
  });

  it("bootstraps a same-origin browser session before loading runtime state", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const browserSetTimeout = globalThis.setTimeout.bind(globalThis);
    const browserClearTimeout = globalThis.clearTimeout.bind(globalThis);
    vi.stubGlobal("window", {
      location: { origin: "http://xsm:5885" },
      setTimeout: browserSetTimeout,
      clearTimeout: browserClearTimeout,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), ...(init ? { init } : {}) });
        const pathname = new URL(String(input)).pathname;
        if (pathname === "/api/browser-session") return json({ status: "ok" });
        if (pathname === "/api/runtime")
          return json({
            maintenanceEnabled: false,
            demoMode: false,
            repoRoot: "/srv/docs",
            version: "contract-test",
          });
        throw new Error(`Unexpected route ${pathname}`);
      }),
    );

    const { runtime } = await ApiClient.connect();

    expect(runtime.version).toBe("contract-test");
    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/browser-session",
      "/api/runtime",
    ]);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(
      new Headers(calls[0]?.init?.headers).get("x-ultradyn-browser-session"),
    ).toBe("1");
  });

  it("does not bootstrap a cross-origin development override", async () => {
    const calls: string[] = [];
    const browserSetTimeout = globalThis.setTimeout.bind(globalThis);
    const browserClearTimeout = globalThis.clearTimeout.bind(globalThis);
    vi.stubGlobal("window", {
      location: { origin: "http://xsm:5885" },
      setTimeout: browserSetTimeout,
      clearTimeout: browserClearTimeout,
    });
    vi.stubEnv("VITE_ULTRADYN_API_BASE", "http://dev-server.test:7443");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        calls.push(String(input));
        return json({
          maintenanceEnabled: false,
          demoMode: false,
          repoRoot: "/srv/docs",
          version: "dev-contract-test",
        });
      }),
    );

    const { runtime } = await ApiClient.connect();

    expect(runtime.version).toBe("dev-contract-test");
    expect(calls).toEqual(["http://dev-server.test:7443/api/runtime"]);
  });

  it("does not bootstrap the deterministic client-demo connection", async () => {
    const fetch = vi.fn();
    vi.stubEnv("VITE_ULTRADYN_DEMO", "true");
    vi.stubGlobal("fetch", fetch);

    const { api, runtime } = await ApiClient.connect();

    expect(api.clientDemo).toBe(true);
    expect(runtime.demoMode).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reauthenticates one stale session before replaying concurrent settings reads", async () => {
    const calls: string[] = [];
    let authenticated = false;
    const browserSetTimeout = globalThis.setTimeout.bind(globalThis);
    const browserClearTimeout = globalThis.clearTimeout.bind(globalThis);
    vi.stubGlobal("window", {
      location: { origin: "http://xsm:5885" },
      setTimeout: browserSetTimeout,
      clearTimeout: browserClearTimeout,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const pathname = new URL(String(input)).pathname;
        calls.push(pathname);
        if (pathname === "/api/browser-session") {
          authenticated = true;
          return json({ status: "ok" });
        }
        if (!authenticated)
          return json(
            {
              error: {
                code: "session_required",
                message:
                  "Open the server URL directly to establish a local browser session.",
              },
            },
            401,
          );
        if (pathname === "/api/settings") return json({ items: [] });
        if (pathname === "/api/settings/schema") return json({ items: [] });
        if (pathname === "/api/providers") return json({ items: [] });
        throw new Error(`Unexpected route ${pathname}`);
      }),
    );
    const api = new ApiClient({ baseUrl: "http://xsm:5885" });

    const [settings, schema, providers] = await Promise.all([
      api.settings(),
      api.settingSchema(),
      api.providers(),
    ]);

    expect(settings).toEqual({ values: {} });
    expect(schema).toEqual([]);
    expect(providers).toEqual([]);
    expect(calls.filter((path) => path === "/api/browser-session")).toHaveLength(
      1,
    );
    expect(calls.filter((path) => path === "/api/settings")).toHaveLength(2);
    expect(calls.filter((path) => path === "/api/settings/schema")).toHaveLength(
      2,
    );
    expect(calls.filter((path) => path === "/api/providers")).toHaveLength(2);
  });

  it("reauthenticates before safely replaying a settings write rejected by the auth hook", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    let authenticated = false;
    const browserSetTimeout = globalThis.setTimeout.bind(globalThis);
    const browserClearTimeout = globalThis.clearTimeout.bind(globalThis);
    vi.stubGlobal("window", {
      location: { origin: "http://xsm:5885" },
      setTimeout: browserSetTimeout,
      clearTimeout: browserClearTimeout,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = init?.method ?? "GET";
        calls.push({ method, path });
        if (path === "/api/browser-session") {
          authenticated = true;
          return json({ status: "ok" });
        }
        if (!authenticated)
          return json(
            {
              error: {
                code: "session_required",
                message:
                  "Open the server URL directly to establish a local browser session.",
              },
            },
            401,
          );
        if (method === "PUT") return json({ status: "ok" });
        return json({ items: [{ key: "server.maintenance", value: false }] });
      }),
    );
    const api = new ApiClient({ baseUrl: "http://xsm:5885" });

    await expect(
      api.settingsSave(
        { "server.maintenance": false },
        { "server.maintenance": "repo" },
      ),
    ).resolves.toEqual({ values: { "server.maintenance": false } });
    expect(calls).toEqual([
      { method: "PUT", path: "/api/settings" },
      { method: "POST", path: "/api/browser-session" },
      { method: "PUT", path: "/api/settings" },
      { method: "GET", path: "/api/settings" },
    ]);
  });

  it("does not replay a settings write after an ambiguous transport failure", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("connection dropped"));
    vi.stubGlobal("fetch", fetch);
    const api = new ApiClient({ baseUrl: "http://server.test" });

    await expect(
      api.settingsSave(
        { "server.maintenance": false },
        { "server.maintenance": "repo" },
      ),
    ).rejects.toThrow("connection dropped");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("restores the browser session and event stream after the server drops", async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      readonly close = vi.fn();
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;

      constructor(readonly url: string) {
        FakeEventSource.instances.push(this);
      }

      addEventListener() {}
    }
    const browserSetTimeout = globalThis.setTimeout.bind(globalThis);
    const browserClearTimeout = globalThis.clearTimeout.bind(globalThis);
    vi.stubGlobal("window", {
      location: { origin: "http://xsm:5885" },
      setTimeout: browserSetTimeout,
      clearTimeout: browserClearTimeout,
    });
    const fetch = vi.fn().mockResolvedValue(json({ status: "ok" }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("EventSource", FakeEventSource);
    const api = new ApiClient({ baseUrl: "http://xsm:5885" });
    const onConnection = vi.fn();

    const unsubscribe = api.subscribe(vi.fn(), onConnection);
    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.instances[0]?.onerror?.(new Event("error"));

    await vi.waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(2);
    });
    expect(FakeEventSource.instances[0]?.close).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "http://xsm:5885/api/browser-session",
    );
    expect(FakeEventSource.instances[1]?.url).toBe(
      "http://xsm:5885/api/events",
    );
    expect(onConnection).toHaveBeenCalledWith(false);

    unsubscribe();
    expect(FakeEventSource.instances[1]?.close).toHaveBeenCalledOnce();
  });

  it("interoperates with the real Fastify public seam", async () => {
    const server = buildServer({
      services: createDemoServices(),
      runtime: {
        maintenanceEnabled: true,
        demoMode: true,
        repoRoot: "/tmp/network-docs",
        version: "contract-test",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const response = await server.inject({
          method: (init?.method ?? "GET") as "GET" | "POST" | "PUT",
          url: `${url.pathname}${url.search}`,
          ...(typeof init?.body === "string" ? { payload: init.body } : {}),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        });
        return new Response(response.body, {
          status: response.statusCode,
          headers: {
            "content-type":
              response.headers["content-type"] ?? "application/json",
          },
        });
      }),
    );
    const api = new ApiClient({ baseUrl: "http://server.test" });

    try {
      expect((await api.goals()).length).toBeGreaterThan(3);
      expect(await api.settingSchema()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "server.pollIntervalMinutes",
            restartRequired: true,
          }),
        ]),
      );
      expect(await api.providers()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "codex", consent: "required" }),
        ]),
      );
      const logged = await api.ask({
        question: "How does the unknown bridge recover?",
        goals: ["implementation"],
        asker: "max",
      });
      expect(logged.kind).toBe("logged");
      expect(await api.questions({ bucket: "active" })).toEqual([
        expect.objectContaining({ tier: "P3" }),
      ]);
      await api.settingsSave(
        { "server.maintenance": false },
        { "server.maintenance": "repo" },
      );
      expect((await api.runtime()).maintenanceEnabled).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("adapts the server's item envelopes and shared record fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === "/api/goals")
          return json({
            items: [
              {
                id: "documentation",
                label: "Documentation",
                description: "Clear and cited",
                criteria: "Citations",
              },
            ],
          });
        if (pathname === "/api/settings/schema")
          return json({
            items: [
              {
                key: "server.maintenance",
                category: "Server",
                label: "Maintenance mode",
                description: "Show maintenance",
                type: "boolean",
                scope: "repo",
                default: false,
                restartRequired: true,
              },
            ],
          });
        if (pathname === "/api/settings")
          return json({
            items: [
              {
                key: "server.maintenance",
                value: true,
                scope: "repo",
                source: "repo",
              },
            ],
          });
        if (pathname === "/api/providers")
          return json({
            items: [
              {
                id: "codex",
                name: "Codex CLI",
                kind: "llm",
                state: "consent_required",
                detail: "Delegate to Codex",
                fakeAvailable: true,
                oauth: true,
                capabilities: ["model"],
                consentScopes: [
                  {
                    scope: "model",
                    consent: "required",
                    availability: "unknown",
                  },
                ],
              },
            ],
          });
        if (pathname === "/api/maintenance")
          return json({
            enabled: true,
            items: [
              {
                id: "review-1",
                kind: "review",
                title: "Review a diff",
                detail: "Run locally",
                status: "open",
                updated: "2026-07-16T00:00:00.000Z",
              },
            ],
          });
        if (pathname === "/api/questions/q-LIVE")
          return json({
            id: "q-LIVE",
            title: "Live contract",
            state: "in-answer",
            bucket: "active",
            tier: "P2",
            goals: ["documentation"],
            tags: ["raw"],
            askers: ["max"],
            created: "2026-07-16T00:00:00.000Z",
            updated: "2026-07-16T01:00:00.000Z",
            rationale: "Active goal gap",
            rawQuestion: "What is the contract?",
            chat: "Need it now",
            provenance: [],
            transcripts: [
              {
                id: "tx-1",
                text: "Verbatim segment",
                source: "typed",
                created: "2026-07-16T00:30:00.000Z",
              },
            ],
            structuredAnswer: "Structured",
            evaluation: {
              done: true,
              goalResults: [
                {
                  goal: "documentation",
                  status: "satisfied",
                  rationale: "Directly answered",
                },
              ],
              contradictions: [],
              deferredChildren: [],
            },
          });
        throw new Error(`Unexpected route ${pathname}`);
      }),
    );
    const api = new ApiClient({ baseUrl: "http://server.test" });

    expect(await api.goals()).toEqual([
      expect.objectContaining({ id: "documentation" }),
    ]);
    expect(await api.settingSchema()).toEqual([
      expect.objectContaining({
        key: "server.maintenance",
        defaultValue: false,
        restartRequired: true,
      }),
    ]);
    expect(await api.settings()).toEqual({
      values: { "server.maintenance": true },
    });
    expect(await api.providers()).toEqual([
      expect.objectContaining({
        id: "codex",
        label: "Codex CLI",
        kind: "model",
        consent: "required",
        fake: true,
        oauth: true,
        consentScopes: [
          {
            scope: "model",
            consent: "required",
            availability: "unknown",
          },
        ],
      }),
    ]);
    expect(await api.maintenance()).toEqual(
      expect.objectContaining({
        tasks: [expect.objectContaining({ id: "review-1", status: "ready" })],
      }),
    );
    expect(await api.question("q-LIVE")).toEqual(
      expect.objectContaining({
        question: "What is the contract?",
        transcript: "Verbatim segment",
        askers: [{ name: "max" }],
        findings: [
          expect.objectContaining({
            goal: "documentation",
            status: "satisfied",
          }),
        ],
      }),
    );
  });

  it("writes the server's one-setting PUT shape and uses binary audio content type", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), ...(init ? { init } : {}) });
        const pathname = new URL(String(input)).pathname;
        if (pathname === "/api/settings" && init?.method === "PUT")
          return json({
            key: "server.maintenance",
            value: true,
            scope: "repo",
            source: "repo",
          });
        if (pathname === "/api/settings")
          return json({
            items: [
              {
                key: "server.maintenance",
                value: true,
                scope: "repo",
                source: "repo",
              },
            ],
          });
        if (pathname.includes("/chunks/"))
          return json({ sequence: 0, durableBytes: 3 }, 202);
        throw new Error(`Unexpected route ${pathname}`);
      }),
    );
    const api = new ApiClient({ baseUrl: "http://server.test" });

    await api.settingsSave(
      { "server.maintenance": true },
      { "server.maintenance": "repo" },
    );
    await api.uploadAudioChunk(
      "aud-1",
      0,
      new Blob(["abc"], { type: "audio/webm;codecs=opus" }),
    );

    const settingCall = calls.find(
      (call) =>
        call.init?.method === "PUT" && call.url.endsWith("/api/settings"),
    );
    expect(JSON.parse(String(settingCall?.init?.body))).toEqual({
      key: "server.maintenance",
      value: true,
      scope: "repo",
    });
    const audioCall = calls.find((call) => call.url.includes("/chunks/0"));
    expect(new Headers(audioCall?.init?.headers).get("content-type")).toBe(
      "application/octet-stream",
    );
  });

  it("calls provider OAuth start/status/cancel endpoints", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? "GET" });
        if (url.endsWith("/oauth/start"))
          return json({ authorizeUrl: "#/settings", state: "s1" });
        if (url.endsWith("/oauth/status"))
          return json({ state: "pending", authorizeUrl: "#/settings" });
        if (url.endsWith("/oauth/cancel")) return json({ ok: true });
        throw new Error(`Unexpected route ${url}`);
      }),
    );
    const api = new ApiClient({ baseUrl: "http://server.test" });

    await expect(api.providerOauthStart("xai-oauth")).resolves.toEqual({
      authorizeUrl: "#/settings",
      state: "s1",
    });
    await expect(api.providerOauthStatus("xai-oauth")).resolves.toEqual({
      state: "pending",
      authorizeUrl: "#/settings",
    });
    await expect(api.providerOauthCancel("xai-oauth")).resolves.toEqual({
      ok: true,
    });

    expect(calls).toEqual([
      {
        url: "http://server.test/api/providers/xai-oauth/oauth/start",
        method: "POST",
      },
      {
        url: "http://server.test/api/providers/xai-oauth/oauth/status",
        method: "GET",
      },
      {
        url: "http://server.test/api/providers/xai-oauth/oauth/cancel",
        method: "POST",
      },
    ]);
  });
});
