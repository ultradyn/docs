import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer, createDemoServices } from "./index.js";

describe("HTTP API", () => {
  const servers: Array<ReturnType<typeof buildServer>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  function server(options: { maintenanceEnabled?: boolean } = {}) {
    const app = buildServer({
      services: createDemoServices(),
      runtime: {
        maintenanceEnabled: options.maintenanceEnabled ?? false,
        demoMode: true,
        repoRoot: "/tmp/network-docs",
        version: "0.1.0-test",
      },
    });
    servers.push(app);
    return app;
  }

  it("reports a ready runtime without leaking secrets", async () => {
    const app = server();

    const health = await app.inject({ method: "GET", url: "/api/health" });
    const runtime = await app.inject({ method: "GET", url: "/api/runtime" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok", version: "0.1.0-test" });
    expect(runtime.json()).toEqual({
      maintenanceEnabled: false,
      demoMode: true,
      repoRoot: "/tmp/network-docs",
      version: "0.1.0-test",
    });
    expect(runtime.body).not.toContain("token");
  });

  it("answers a documented question with citations", async () => {
    const app = server();

    const response = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "What is already documented?",
        goals: ["documentation"],
        asker: "max",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      kind: "answer",
      citations: [{ path: "docs/overview.md" }],
      goalResults: [{ goal: "documentation", status: "satisfied" }],
    });
  });

  it("refuses to invent attribution for an ask with no asker", async () => {
    const response = await server().inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "Who asked this?",
        goals: ["documentation"],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it("logs an unsatisfied question and exposes it through the queue", async () => {
    const app = server();

    const logged = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "How does the undocumented bridge recover?",
        goals: ["implementation", "security-review"],
        asker: "max",
        chat: "We need this to implement the node.",
      },
    });
    const body = logged.json();
    const queue = await app.inject({
      method: "GET",
      url: "/api/questions?bucket=active",
    });

    expect(body.kind).toBe("logged");
    expect(body.question.id).toMatch(/^q-/);
    expect(body.question.tier).toBe("P3");
    expect(queue.json().items).toEqual([
      expect.objectContaining({
        id: body.question.id,
        goals: ["implementation", "security-review"],
      }),
    ]);
  });

  it("uses documentation when the asker supplies no goal", async () => {
    const app = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "An unknown goal-free question",
        goals: [],
        asker: "max",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().question.goals).toEqual(["documentation"]);
  });

  it("evaluates the documentation goal for an inline answer when goals are empty", async () => {
    const app = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "What is already documented?",
        goals: [],
        asker: "max",
      },
    });

    expect(response.json().goalResults).toEqual([
      expect.objectContaining({ goal: "documentation", status: "satisfied" }),
    ]);
  });

  it("supports the answer loop through public question actions", async () => {
    const app = server();
    const logged = await app.inject({
      method: "POST",
      url: "/api/ask",
      payload: {
        question: "Unknown implementation detail",
        goals: ["implementation"],
        asker: "max",
      },
    });
    const id = logged.json().question.id as string;

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/questions/${id}/claim`,
          payload: { answerer: "max" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/questions/${id}/transcripts`,
          payload: {
            text: "The bridge replays the journal from its last checkpoint.",
            source: "typed",
          },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/questions/${id}/structure`,
        })
      ).json(),
    ).toMatchObject({
      structuredAnswer:
        "The bridge replays the journal from its last checkpoint.",
    });
    expect(
      (
        await app.inject({ method: "POST", url: `/api/questions/${id}/critic` })
      ).json(),
    ).toMatchObject({
      evaluation: {
        done: true,
        goalResults: [{ goal: "implementation", status: "satisfied" }],
      },
    });
  });

  it("keeps personal and repository settings visibly scoped", async () => {
    const app = server();

    const update = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { key: "server.maintenance", value: true, scope: "repo" },
    });
    const values = await app.inject({ method: "GET", url: "/api/settings" });
    const runtime = await app.inject({ method: "GET", url: "/api/runtime" });

    expect(update.statusCode).toBe(200);
    expect(values.json().items).toContainEqual({
      key: "server.maintenance",
      value: true,
      scope: "repo",
      source: "repo",
    });
    expect(runtime.json().maintenanceEnabled).toBe(true);
  });

  it("passes exactly one validated provider scope to the consent service", async () => {
    const services = createDemoServices();
    const consent = vi.spyOn(services.providers, "consent");
    const app = buildServer({
      services,
      runtime: {
        maintenanceEnabled: false,
        demoMode: true,
        repoRoot: "/tmp/network-docs",
        version: "0.1.0-test",
      },
    });
    servers.push(app);

    const granted = await app.inject({
      method: "POST",
      url: "/api/providers/codex/consent",
      payload: { scope: "model", granted: true },
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/api/providers/codex/consent",
      payload: { scope: "filesystem", granted: true },
    });

    expect(granted.statusCode).toBe(200);
    expect(consent).toHaveBeenCalledOnce();
    expect(consent).toHaveBeenCalledWith("codex", "model", true);
    expect(invalid.statusCode).toBe(400);
  });

  it("exposes OAuth start/status/cancel routes with the fixed contract", async () => {
    const app = server();

    const idle = await app.inject({
      method: "GET",
      url: "/api/providers/xai-oauth/oauth/status",
    });
    expect(idle.statusCode).toBe(200);
    expect(idle.json()).toEqual({ state: "idle" });

    const started = await app.inject({
      method: "POST",
      url: "/api/providers/xai-oauth/oauth/start",
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toEqual({
      authorizeUrl: "#/settings",
      state: "demo",
    });

    const pending = await app.inject({
      method: "GET",
      url: "/api/providers/xai-oauth/oauth/status",
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({
      state: "pending",
      authorizeUrl: "#/settings",
    });

    const cancelled = await app.inject({
      method: "POST",
      url: "/api/providers/xai-oauth/oauth/cancel",
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toEqual({ ok: true });

    const afterCancel = await app.inject({
      method: "GET",
      url: "/api/providers/xai-oauth/oauth/status",
    });
    expect(afterCancel.json()).toEqual({ state: "idle" });

    const unknown = await app.inject({
      method: "POST",
      url: "/api/providers/missing-oauth/oauth/start",
    });
    expect(unknown.statusCode).toBe(404);

    const nonOauth = await app.inject({
      method: "POST",
      url: "/api/providers/codex/oauth/start",
    });
    expect(nonOauth.statusCode).toBe(400);
    expect(nonOauth.json()).toMatchObject({
      error: { code: "oauth_not_supported" },
    });
  });

  it("makes maintenance routes conditional", async () => {
    const off = server();
    const on = server({ maintenanceEnabled: true });

    expect(
      (await off.inject({ method: "GET", url: "/api/maintenance" })).statusCode,
    ).toBe(404);
    expect(
      (await on.inject({ method: "POST", url: "/api/maintenance/run" }))
        .statusCode,
    ).toBe(202);
    expect(
      (await on.inject({ method: "GET", url: "/api/maintenance" })).json(),
    ).toMatchObject({ enabled: true });
  });

  it("acknowledges ordered audio chunks and makes finalization retry-safe", async () => {
    const app = server();
    const created = await app.inject({
      method: "POST",
      url: "/api/audio/sessions",
      payload: {
        questionId: "q-01J00000000000000000000000",
        mimeType: "audio/webm",
      },
    });
    const id = created.json().id as string;

    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/audio/sessions/${id}/chunks/0`,
          headers: { "content-type": "application/octet-stream" },
          payload: Buffer.from("chunk-zero"),
        })
      ).statusCode,
    ).toBe(202);
    const finalized = await app.inject({
      method: "POST",
      url: `/api/audio/sessions/${id}/finalize`,
    });
    const repeated = await app.inject({
      method: "POST",
      url: `/api/audio/sessions/${id}/finalize`,
    });

    expect(finalized.json()).toMatchObject({ state: "ready", chunks: 1 });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual(finalized.json());
  });

  it("rejects decoded traversal identifiers before calling a service", async () => {
    const services = createDemoServices();
    const getQuestion = vi.spyOn(services.questions, "get");
    const appendAudio = vi.spyOn(services.audio, "append");
    const getChangeRequest = vi.spyOn(services.changeRequests, "get");
    const connectProvider = vi.spyOn(services.providers, "connect");
    const validateAgent = vi.spyOn(services.agents, "validate");
    const app = buildServer({
      services,
      runtime: {
        maintenanceEnabled: false,
        demoMode: true,
        repoRoot: "/tmp/network-docs",
        version: "0.1.0-test",
      },
    });
    servers.push(app);
    const traversal = "%2E%2E%2Fprivate";

    const responses = await Promise.all([
      app.inject({ method: "GET", url: `/api/questions/${traversal}` }),
      app.inject({
        method: "PUT",
        url: `/api/audio/sessions/${traversal}/chunks/0`,
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from("audio"),
      }),
      app.inject({
        method: "GET",
        url: `/api/change-requests/${traversal}`,
      }),
      app.inject({
        method: "POST",
        url: `/api/providers/${traversal}/connect`,
      }),
      app.inject({
        method: "POST",
        url: `/api/agents/${traversal}/fixtures`,
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([
      400, 400, 400, 400, 400,
    ]);
    expect(getQuestion).not.toHaveBeenCalled();
    expect(appendAudio).not.toHaveBeenCalled();
    expect(getChangeRequest).not.toHaveBeenCalled();
    expect(connectProvider).not.toHaveBeenCalled();
    expect(validateAgent).not.toHaveBeenCalled();
  });

  it("allows only the two packaged Tauri origins when desktop CORS is enabled", async () => {
    const app = buildServer({
      services: createDemoServices(),
      runtime: {
        maintenanceEnabled: false,
        demoMode: false,
        repoRoot: "/tmp/network-docs",
        version: "0.1.0-test",
      },
      allowOrigin: ["tauri://localhost", "http://tauri.localhost"],
    });
    servers.push(app);

    const macLinux = await app.inject({
      method: "GET",
      url: "/api/runtime",
      headers: { origin: "tauri://localhost" },
    });
    const windows = await app.inject({
      method: "GET",
      url: "/api/runtime",
      headers: { origin: "http://tauri.localhost" },
    });
    const arbitrary = await app.inject({
      method: "GET",
      url: "/api/runtime",
      headers: { origin: "https://attacker.invalid" },
    });

    expect(macLinux.headers["access-control-allow-origin"]).toBe(
      "tauri://localhost",
    );
    expect(windows.headers["access-control-allow-origin"]).toBe(
      "http://tauri.localhost",
    );
    expect(arbitrary.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
