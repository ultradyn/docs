import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CodexCliLlmProvider,
  ConsentRequiredError,
  CredentialSourceRegistry,
  EnvironmentBearerCredentialSource,
  FakeCodecProvider,
  FakeGitHostProvider,
  FakeLlmProvider,
  FakeSttProvider,
  InMemoryConsentStore,
  GhCliGitHostProvider,
  GrokAuthFileCredentialSource,
  XaiRestSttProvider,
  XaiResponsesLlmProvider,
  type ProcessRunner,
} from "./index.js";

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("provider public seam", () => {
  it("does not inspect a credential source until the person grants scoped consent", async () => {
    const reads: string[] = [];
    const registry = new CredentialSourceRegistry(new InMemoryConsentStore());
    registry.register(
      new EnvironmentBearerCredentialSource({
        id: "openai-env",
        label: "OpenAI environment variable",
        providerId: "openai",
        variable: "OPENAI_API_KEY",
        readEnvironment: (name) => {
          reads.push(name);
          return "secret-value";
        },
      }),
    );

    expect((await registry.status("openai-env", "model")).consent).toBe(
      "required",
    );
    expect(reads).toEqual([]);
    await expect(
      registry.resolve("openai-env", "model"),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(reads).toEqual([]);

    await registry.setConsent(
      "openai-env",
      "model",
      "granted",
      "2026-07-16T00:00:00.000Z",
    );
    const capability = await registry.resolve("openai-env", "model");
    const headers = new Headers();
    if (capability.kind !== "http-bearer") throw new Error("wrong capability");
    await capability.authorize(headers);

    expect(headers.get("authorization")).toBe("Bearer secret-value");
    expect(reads).toEqual(["OPENAI_API_KEY", "OPENAI_API_KEY"]);
  });

  it("streams deterministic fake LLM and STT events through production-shaped contracts", async () => {
    const llm = new FakeLlmProvider({
      outputs: [{ answer: "Use the committed projection." }],
    });
    const llmEvents = await collect(
      llm.stream({
        invocationId: "inv-1",
        agent: { name: "librarian", prompt: "Answer with citations." },
        messages: [{ role: "user", content: "How?" }],
      }),
    );
    expect(llmEvents.map((event) => event.type)).toEqual([
      "started",
      "text-delta",
      "completed",
    ]);
    expect(llmEvents.at(-1)).toMatchObject({
      type: "completed",
      output: { answer: "Use the committed projection." },
    });

    const stt = new FakeSttProvider({
      transcript: "immutable raw words",
      confidence: 0.98,
    });
    const chunks = (async function* () {
      yield {
        sequence: 0,
        bytes: new Uint8Array([1, 2]),
        mimeType: "audio/webm",
      };
      yield { sequence: 1, bytes: new Uint8Array([3]), mimeType: "audio/webm" };
    })();
    const sttEvents = await collect(
      stt.transcribe({ sessionId: "aud-test", chunks }),
    );
    expect(
      sttEvents.filter((event) => event.type === "chunk-accepted"),
    ).toHaveLength(2);
    expect(sttEvents.at(-1)).toEqual({
      type: "completed",
      transcript: "immutable raw words",
      confidence: 0.98,
    });
  });

  it("delegates safely to codex exec without reading or naming its credential cache", async () => {
    const calls: Array<{ command: string; args: string[]; input?: string }> =
      [];
    const runner: ProcessRunner = {
      async run(command, args, options) {
        calls.push({
          command,
          args: [...args],
          ...(options.input === undefined ? {} : { input: options.input }),
        });
        return {
          exitCode: 0,
          stderr: "",
          stdout:
            '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true}"}}\n',
        };
      },
    };
    const provider = new CodexCliLlmProvider({ runner, cwd: "/tmp/safe-repo" });
    const events = await collect(
      provider.stream({
        invocationId: "inv-codex",
        agent: { name: "critic", prompt: "Evaluate." },
        messages: [{ role: "user", content: "draft" }],
        responseSchema: {
          type: "object",
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
      }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      output: { ok: true },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("codex");
    expect(calls[0]?.args).toContain("--sandbox");
    expect(calls[0]?.args).toContain("read-only");
    expect(calls[0]?.args.join(" ")).not.toMatch(
      /auth\.json|dangerously|bypass/i,
    );
    expect(calls[0]?.input).toContain("critic");
  });

  it("provides deterministic codec and Git-host fakes for complete offline workflows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ultradyn-provider-"));
    const input = join(directory, "capture.raw");
    const output = join(directory, "capture.ogg");
    await writeFile(input, new Uint8Array([9, 8, 7]));
    const codec = new FakeCodecProvider();
    const result = await codec.transcode({
      inputPath: input,
      outputPath: output,
      format: "ogg",
    });
    expect(result.bytes).toBe(3);
    expect([...new Uint8Array(await readFile(output))]).toEqual([9, 8, 7]);

    const gitHost = new FakeGitHostProvider();
    const change = await gitHost.publish({
      repository: "ultradyn/docs",
      branch: "ultradyn/q-test",
      title: "Document indexes",
      body: "Adds index documentation.",
    });
    expect(change).toMatchObject({ id: "fake-cr-0001", state: "open" });
    expect(
      await gitHost.poll({ repository: "ultradyn/docs", cursor: null }),
    ).toMatchObject({
      cursor: "fake-cursor-0001",
      tasks: [],
    });
  });

  it("uploads xAI REST transcription parameters before the audio file", async () => {
    const observed: string[] = [];
    const provider = new XaiRestSttProvider({
      credential: {
        kind: "http-bearer",
        sourceId: "xai-test",
        providerId: "xai",
        authorize: async (headers) =>
          headers.set("authorization", "Bearer test"),
      },
      fetch: async (url, init) => {
        expect(url).toBe("https://api.x.ai/v1/stt");
        const form = init?.body;
        if (!(form instanceof FormData))
          throw new Error("Expected multipart form data.");
        observed.push(...[...form.keys()]);
        return new Response(JSON.stringify({ text: "xAI transcript" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const events = await collect(
      provider.transcribe({
        sessionId: "aud-test",
        language: "en",
        chunks: (async function* () {
          yield {
            sequence: 0,
            bytes: new Uint8Array([1]),
            mimeType: "audio/webm",
          };
        })(),
      }),
    );
    expect(observed).toEqual(["model", "language", "file"]);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      transcript: "xAI transcript",
    });
  });

  it("reads a Grok OIDC auth file only after consent and rejects expired tokens without disclosure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ultradyn-grok-auth-"));
    const path = join(directory, "auth.json");
    await writeFile(
      path,
      JSON.stringify({
        "https://auth.x.ai::user": {
          key: "private-oidc-token",
          auth_mode: "oidc",
          principal_type: "User",
          expires_at: "2026-07-16T01:00:00.000000000Z",
          refresh_token: "",
        },
      }),
    );
    const registry = new CredentialSourceRegistry(new InMemoryConsentStore());
    registry.register(
      new GrokAuthFileCredentialSource({
        path,
        now: () => new Date("2026-07-16T00:00:00.000Z"),
      }),
    );

    expect(
      (await registry.status("grok-auth-file", "model")).availability,
    ).toBe("unknown");
    await registry.setConsent(
      "grok-auth-file",
      "model",
      "granted",
      "2026-07-16T00:00:00.000Z",
    );
    const capability = await registry.resolve("grok-auth-file", "model");
    if (capability.kind !== "http-bearer") throw new Error("wrong capability");
    const headers = new Headers();
    await capability.authorize(headers);
    expect(headers.get("authorization")).toBe("Bearer private-oidc-token");

    const expired = new GrokAuthFileCredentialSource({
      path,
      now: () => new Date("2026-07-16T02:00:00.000Z"),
    });
    const status = await expired.inspect();
    expect(status).toMatchObject({ available: false });
    expect(status.reason).toMatch(/expired.*sign in/i);
    expect(status.reason).not.toContain("private-oidc-token");
  });

  it("streams xAI Responses output and discovers the models available to the bearer", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const provider = new XaiResponsesLlmProvider({
      credential: {
        kind: "http-bearer",
        sourceId: "xai-test",
        providerId: "xai",
        authorize: async (headers) =>
          headers.set("authorization", "Bearer test"),
      },
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          ...(typeof init?.body === "string"
            ? { body: JSON.parse(init.body) }
            : {}),
        });
        if (String(url).endsWith("/models")) {
          return new Response(
            JSON.stringify({ data: [{ id: "grok-4.5" }, { id: "grok-fast" }] }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        const stream = [
          'data: {"type":"response.output_text.delta","delta":"{\\"ok\\":"}',
          'data: {"type":"response.output_text.delta","delta":"true}"}',
          "data: [DONE]",
          "",
        ].join("\n");
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    expect(await provider.listModels()).toEqual(["grok-4.5", "grok-fast"]);
    const events = await collect(
      provider.stream({
        invocationId: "inv-grok",
        agent: { name: "critic", prompt: "Evaluate decisively." },
        messages: [{ role: "user", content: "Check the answer." }],
        responseSchema: {
          type: "object",
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
      }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      output: { ok: true },
    });
    expect(requests[1]).toMatchObject({
      url: "https://api.x.ai/v1/responses",
      body: {
        model: "grok-4.5",
        store: false,
        stream: true,
      },
    });
  });

  it("maps GitHub head changes to idempotent local rereview tasks through gh delegation", async () => {
    const outputs = [
      'HTTP/2 200\netag: "one"\n\n[{"number":7,"head":{"sha":"abc"},"requested_reviewers":[]}]',
      'HTTP/2 200\netag: "two"\n\n[{"number":7,"head":{"sha":"def"},"requested_reviewers":[]}]',
    ];
    const calls: string[][] = [];
    const runner: ProcessRunner = {
      async run(command, args) {
        expect(command).toBe("gh");
        calls.push([...args]);
        return { exitCode: 0, stderr: "", stdout: outputs.shift() ?? "" };
      },
    };
    const github = new GhCliGitHostProvider({ runner });
    const first = await github.poll({
      repository: "ultradyn/docs",
      cursor: null,
    });
    const second = await github.poll({
      repository: "ultradyn/docs",
      cursor: first.cursor,
    });
    expect(first.tasks[0]).toMatchObject({
      changeRequestId: "7",
      revision: "abc",
      reason: "opened",
    });
    expect(second.tasks[0]).toMatchObject({
      changeRequestId: "7",
      revision: "def",
      reason: "updated",
    });
    expect(calls[1]).toContain('If-None-Match: "one"');
  });
});
