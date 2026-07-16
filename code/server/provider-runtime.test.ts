import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CredentialSourceRegistry,
  EnvironmentBearerCredentialSource,
  FileConsentStore,
  InMemoryConsentStore,
  createInstalledClientCredentialSources,
  type CredentialSource,
  type ProcessRunner,
} from "../providers/index.js";
import {
  ProviderRuntimeFactory,
  createDefaultProviderRuntimeFactory,
} from "./index.js";

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function environmentSource(
  id: "openai-env" | "xai-env",
  providerId: "openai" | "xai",
  reads: string[],
): CredentialSource {
  return new EnvironmentBearerCredentialSource({
    id,
    label: id,
    providerId,
    variable: id === "openai-env" ? "OPENAI_API_KEY" : "XAI_API_KEY",
    scopes: ["model", "transcription"],
    readEnvironment: (name) => {
      reads.push(name);
      return "test-only-token";
    },
  });
}

describe("provider runtime public seam", () => {
  it("resolves all deterministic selections without inspecting credential sources", async () => {
    const reads: string[] = [];
    const credentials = new CredentialSourceRegistry(
      new InMemoryConsentStore(),
    );
    credentials.register(environmentSource("openai-env", "openai", reads));
    const runtime = new ProviderRuntimeFactory({
      credentials,
      cwd: "/tmp/ultradyn-docs-test",
    });

    const selection = await runtime.resolve({
      llm: "fake-llm",
      stt: "fake-stt",
      codec: "fake-codec",
    });

    expect(selection.ready).toBe(true);
    expect(selection.llm).toMatchObject({
      state: "ready",
      selected: "fake-llm",
      provider: { id: "fake-llm" },
    });
    expect(selection.stt).toMatchObject({
      state: "ready",
      selected: "fake-stt",
      provider: { id: "fake-stt" },
    });
    expect(selection.codec).toMatchObject({
      state: "ready",
      selected: "fake-codec",
      provider: { id: "fake-codec" },
    });
    expect(reads).toEqual([]);
  });

  it("blocks an external selection without inspecting it before scoped consent", async () => {
    const reads: string[] = [];
    const credentials = new CredentialSourceRegistry(
      new InMemoryConsentStore(),
    );
    credentials.register(environmentSource("openai-env", "openai", reads));
    const runtime = new ProviderRuntimeFactory({
      credentials,
      cwd: "/tmp/ultradyn-docs-test",
    });

    const selection = await runtime.resolveLlm("openai-env");

    expect(selection).toEqual({
      state: "blocked",
      selected: "openai-env",
      sourceId: "openai-env",
      scope: "model",
      reason: "consent-required",
      message:
        "Explicit model consent is required before inspecting openai-env.",
      activationChecklist: [
        "Grant model consent for openai-env in personal settings.",
        "Run the provider capability test.",
      ],
    });
    expect(reads).toEqual([]);
  });

  it("resolves OpenAI only after granted consent survives a runtime restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ultradyn-runtime-"));
    const consentPath = join(directory, "consent.json");
    const firstRegistry = new CredentialSourceRegistry(
      new FileConsentStore(consentPath),
    );
    firstRegistry.register(environmentSource("openai-env", "openai", []));
    await firstRegistry.setConsent(
      "openai-env",
      "model",
      "granted",
      "2026-07-16T00:00:00.000Z",
    );

    const reads: string[] = [];
    const restartedRegistry = new CredentialSourceRegistry(
      new FileConsentStore(consentPath),
    );
    restartedRegistry.register(
      environmentSource("openai-env", "openai", reads),
    );
    const restartedRuntime = new ProviderRuntimeFactory({
      credentials: restartedRegistry,
      cwd: directory,
    });

    const selection = await restartedRuntime.resolveLlm("openai-env");

    expect(selection).toMatchObject({
      state: "ready",
      selected: "openai-env",
      provider: { id: "openai-api" },
    });
    expect(reads).toEqual(["OPENAI_API_KEY", "OPENAI_API_KEY"]);
  });

  it("maps separately consented xAI model and transcription scopes to their adapters", async () => {
    const credentials = new CredentialSourceRegistry(
      new InMemoryConsentStore(),
    );
    credentials.register(environmentSource("xai-env", "xai", []));
    await credentials.setConsent(
      "xai-env",
      "model",
      "granted",
      "2026-07-16T00:00:00.000Z",
    );
    await credentials.setConsent(
      "xai-env",
      "transcription",
      "granted",
      "2026-07-16T00:00:00.000Z",
    );
    const runtime = new ProviderRuntimeFactory({
      credentials,
      cwd: "/tmp/ultradyn-docs-test",
    });

    const selection = await runtime.resolve({
      llm: "xai-env",
      stt: "xai-env",
      codec: "fake-codec",
    });

    expect(selection.ready).toBe(true);
    expect(selection.llm).toMatchObject({
      state: "ready",
      provider: { id: "xai-responses" },
    });
    expect(selection.stt).toMatchObject({
      state: "ready",
      provider: { id: "xai-stt" },
    });
  });

  it("does not resolve transcription from model-only consent", async () => {
    const credentials = new CredentialSourceRegistry(
      new InMemoryConsentStore(),
    );
    credentials.register(environmentSource("xai-env", "xai", []));
    await credentials.setConsent(
      "xai-env",
      "model",
      "granted",
      "2026-07-16T00:00:00.000Z",
    );
    const runtime = new ProviderRuntimeFactory({
      credentials,
      cwd: "/tmp/ultradyn-docs-test",
    });

    expect(await runtime.resolveLlm("xai-env")).toMatchObject({
      state: "ready",
    });
    expect(await runtime.resolveStt("xai-env")).toMatchObject({
      state: "blocked",
      sourceId: "xai-env",
      scope: "transcription",
      reason: "consent-required",
    });
  });

  it("maps the consented Grok auth-file source to xAI model and transcription adapters", async () => {
    const credentials = new CredentialSourceRegistry(
      new InMemoryConsentStore(),
    );
    credentials.register(
      new EnvironmentBearerCredentialSource({
        id: "grok-auth-file",
        label: "Grok client OIDC sign-in",
        providerId: "xai",
        variable: "GROK_TEST_TOKEN",
        scopes: ["model", "transcription"],
        readEnvironment: () => "test-only-token",
      }),
    );
    await credentials.setConsent(
      "grok-auth-file",
      "model",
      "granted",
      "2026-07-16T00:00:00.000Z",
    );
    await credentials.setConsent(
      "grok-auth-file",
      "transcription",
      "granted",
      "2026-07-16T00:00:00.000Z",
    );
    const runtime = new ProviderRuntimeFactory({
      credentials,
      cwd: "/tmp/ultradyn-docs-test",
    });

    const selection = await runtime.resolve({
      llm: "grok-auth-file",
      stt: "grok-auth-file",
      codec: "fake-codec",
    });

    expect(selection).toMatchObject({
      ready: true,
      llm: { state: "ready", provider: { id: "xai-responses" } },
      stt: { state: "ready", provider: { id: "xai-stt" } },
    });
  });

  it("resolves the Codex CLI only through its consented delegated source", async () => {
    const calls: string[] = [];
    const runner: ProcessRunner = {
      async run(command, args) {
        calls.push([command, ...args].join(" "));
        return { exitCode: 0, stdout: "codex-cli 1.0", stderr: "" };
      },
    };
    const credentials = new CredentialSourceRegistry(
      new InMemoryConsentStore(),
    );
    const codexSource = createInstalledClientCredentialSources(runner).find(
      (source) => source.describe().id === "codex-cli",
    );
    if (!codexSource) throw new Error("Codex source fixture is missing.");
    credentials.register(codexSource);
    await credentials.setConsent(
      "codex-cli",
      "model",
      "granted",
      "2026-07-16T00:00:00.000Z",
    );
    const runtime = new ProviderRuntimeFactory({
      credentials,
      cwd: "/tmp/ultradyn-docs-test",
      processRunner: runner,
    });

    const selection = await runtime.resolveLlm("codex-cli");

    expect(selection).toMatchObject({
      state: "ready",
      selected: "codex-cli",
      provider: { id: "codex-cli" },
    });
    expect(calls).toEqual(["codex --version", "codex --version"]);
  });

  it.each(["denied", "revoked"] as const)(
    "reports %s consent without inspecting the selected credential source",
    async (decision) => {
      const reads: string[] = [];
      const credentials = new CredentialSourceRegistry(
        new InMemoryConsentStore(),
      );
      credentials.register(environmentSource("openai-env", "openai", reads));
      await credentials.setConsent(
        "openai-env",
        "model",
        decision,
        "2026-07-16T00:00:00.000Z",
      );
      const runtime = new ProviderRuntimeFactory({
        credentials,
        cwd: "/tmp/ultradyn-docs-test",
      });

      const selection = await runtime.resolveLlm("openai-env");

      expect(selection).toMatchObject({
        state: "blocked",
        sourceId: "openai-env",
        scope: "model",
        reason: `consent-${decision}`,
      });
      expect(reads).toEqual([]);
    },
  );

  it("reports activation required when a consented credential source is unavailable", async () => {
    const reads: string[] = [];
    const credentials = new CredentialSourceRegistry(
      new InMemoryConsentStore(),
    );
    credentials.register(
      new EnvironmentBearerCredentialSource({
        id: "openai-env",
        label: "OPENAI_API_KEY",
        providerId: "openai",
        variable: "OPENAI_API_KEY",
        scopes: ["model", "transcription"],
        readEnvironment: (name) => {
          reads.push(name);
          return undefined;
        },
      }),
    );
    await credentials.setConsent(
      "openai-env",
      "model",
      "granted",
      "2026-07-16T00:00:00.000Z",
    );
    const runtime = new ProviderRuntimeFactory({
      credentials,
      cwd: "/tmp/ultradyn-docs-test",
    });

    const selection = await runtime.resolveLlm("openai-env");

    expect(selection).toEqual({
      state: "blocked",
      selected: "openai-env",
      sourceId: "openai-env",
      scope: "model",
      reason: "activation-required",
      message: "OPENAI_API_KEY is not set.",
      activationChecklist: [
        "Configure or sign in to OPENAI_API_KEY outside the repository.",
        "Run the provider capability test.",
      ],
    });
    expect(reads).toEqual(["OPENAI_API_KEY"]);
  });

  it.each([
    { exitCode: 0, state: "ready", reason: undefined },
    { exitCode: 1, state: "blocked", reason: "activation-required" },
  ] as const)(
    "reports FFmpeg as $state when its capability probe exits $exitCode",
    async ({ exitCode, state, reason }) => {
      const calls: string[] = [];
      const runner: ProcessRunner = {
        async run(command, args) {
          calls.push([command, ...args].join(" "));
          return { exitCode, stdout: "", stderr: "" };
        },
      };
      const runtime = new ProviderRuntimeFactory({
        credentials: new CredentialSourceRegistry(new InMemoryConsentStore()),
        cwd: "/tmp/ultradyn-docs-test",
        processRunner: runner,
      });

      const selection = await runtime.resolveCodec("ffmpeg");

      expect(selection).toMatchObject({
        state,
        selected: "ffmpeg",
        ...(reason ? { reason } : { provider: { id: "ffmpeg" } }),
      });
      expect(calls).toEqual(["ffmpeg -version"]);
    },
  );

  it("uses gpt-5.6 for OpenAI Responses while leaving provider secrets delegated", async () => {
    const credentials = new CredentialSourceRegistry(
      new InMemoryConsentStore(),
    );
    credentials.register(environmentSource("openai-env", "openai", []));
    await credentials.setConsent(
      "openai-env",
      "model",
      "granted",
      "2026-07-16T00:00:00.000Z",
    );
    let requestBody: unknown;
    const runtime = new ProviderRuntimeFactory({
      credentials,
      cwd: "/tmp/ultradyn-docs-test",
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const selection = await runtime.resolveLlm("openai-env");
    if (selection.state !== "ready") throw new Error(selection.message);

    await collect(
      selection.provider.stream({
        invocationId: "runtime-openai-default",
        agent: { name: "librarian", prompt: "Answer from documentation." },
        messages: [{ role: "user", content: "How is the index rebuilt?" }],
      }),
    );

    expect(requestBody).toMatchObject({ model: "gpt-5.6", store: false });
    expect(JSON.stringify(requestBody)).not.toContain("test-only-token");
  });

  it("builds a production runtime with a durable consent store without probing sources", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "ultradyn-default-runtime-"),
    );
    const reads: string[] = [];
    const runtime = createDefaultProviderRuntimeFactory({
      repoRoot: directory,
      dataRoot: join(directory, ".machine"),
      credentialSources: [environmentSource("openai-env", "openai", reads)],
    });

    expect(runtime.credentials.descriptions()).toEqual([
      expect.objectContaining({ id: "openai-env", providerId: "openai" }),
    ]);
    expect(reads).toEqual([]);

    await runtime.credentials.setConsent(
      "openai-env",
      "transcription",
      "granted",
      "2026-07-16T00:00:00.000Z",
    );
    const restarted = createDefaultProviderRuntimeFactory({
      repoRoot: directory,
      dataRoot: join(directory, ".machine"),
      credentialSources: [environmentSource("openai-env", "openai", reads)],
    });
    expect(await restarted.resolveStt("openai-env")).toMatchObject({
      state: "ready",
      provider: { id: "openai-stt" },
    });
  });

  it("distinguishes a missing source from a source that lacks the selected scope", async () => {
    const missingRuntime = new ProviderRuntimeFactory({
      credentials: new CredentialSourceRegistry(new InMemoryConsentStore()),
      cwd: "/tmp/ultradyn-docs-test",
    });
    expect(await missingRuntime.resolveLlm("openai-env")).toMatchObject({
      state: "blocked",
      reason: "source-not-registered",
      sourceId: "openai-env",
      scope: "model",
    });

    let inspections = 0;
    const credentials = new CredentialSourceRegistry(
      new InMemoryConsentStore(),
    );
    credentials.register({
      describe: () => ({
        id: "openai-env",
        providerId: "openai",
        label: "Model-only OpenAI source",
        kind: "http-bearer",
        scopes: ["model"],
      }),
      inspect: async () => {
        inspections += 1;
        return { available: true };
      },
      resolve: async () => ({
        kind: "http-bearer",
        sourceId: "openai-env",
        providerId: "openai",
        authorize: async () => undefined,
      }),
    });
    const incompatibleRuntime = new ProviderRuntimeFactory({
      credentials,
      cwd: "/tmp/ultradyn-docs-test",
    });

    expect(await incompatibleRuntime.resolveStt("openai-env")).toMatchObject({
      state: "blocked",
      reason: "incompatible-source",
      sourceId: "openai-env",
      scope: "transcription",
    });
    expect(inspections).toBe(0);
  });

  it("blocks a registered source whose resolved provider does not match its selection", async () => {
    const credentials = new CredentialSourceRegistry(
      new InMemoryConsentStore(),
    );
    credentials.register(
      new EnvironmentBearerCredentialSource({
        id: "xai-env",
        label: "Mismatched test source",
        providerId: "openai",
        variable: "TEST_API_KEY",
        scopes: ["model", "transcription"],
        readEnvironment: () => "test-only-token",
      }),
    );
    await credentials.setConsent(
      "xai-env",
      "model",
      "granted",
      "2026-07-16T00:00:00.000Z",
    );
    const runtime = new ProviderRuntimeFactory({
      credentials,
      cwd: "/tmp/ultradyn-docs-test",
    });

    expect(await runtime.resolveLlm("xai-env")).toMatchObject({
      state: "blocked",
      selected: "xai-env",
      sourceId: "xai-env",
      scope: "model",
      reason: "incompatible-source",
    });
  });

  it("returns a blocked outcome when a credential disappears during resolution", async () => {
    let inspections = 0;
    const credentials = new CredentialSourceRegistry(
      new InMemoryConsentStore(),
    );
    credentials.register({
      describe: () => ({
        id: "openai-env",
        providerId: "openai",
        label: "Ephemeral OpenAI source",
        kind: "http-bearer",
        scopes: ["model"],
      }),
      inspect: async () => {
        inspections += 1;
        return inspections === 1
          ? { available: true }
          : { available: false, reason: "The token was removed." };
      },
      resolve: async () => ({
        kind: "http-bearer",
        sourceId: "openai-env",
        providerId: "openai",
        authorize: async () => undefined,
      }),
    });
    await credentials.setConsent(
      "openai-env",
      "model",
      "granted",
      "2026-07-16T00:00:00.000Z",
    );
    const runtime = new ProviderRuntimeFactory({
      credentials,
      cwd: "/tmp/ultradyn-docs-test",
    });

    expect(await runtime.resolveLlm("openai-env")).toMatchObject({
      state: "blocked",
      reason: "activation-required",
      sourceId: "openai-env",
      scope: "model",
    });
    expect(inspections).toBe(2);
  });

  it("registers the supported production credential sources without probing them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ultradyn-sources-"));
    const processCalls: string[] = [];
    const runtime = createDefaultProviderRuntimeFactory({
      repoRoot: directory,
      dataRoot: join(directory, ".machine"),
      processRunner: {
        async run(command, args) {
          processCalls.push([command, ...args].join(" "));
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    });

    expect(
      runtime.credentials.descriptions().map((description) => description.id),
    ).toEqual(
      expect.arrayContaining([
        "codex-cli",
        "grok-auth-file",
        "openai-env",
        "xai-env",
      ]),
    );
    expect(processCalls).toEqual([]);
  });
});
