import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";

import type {
  ChangeRequestDraft,
  CodecProvider,
  CodecRequest,
  CodecResult,
  GitHostPollRequest,
  GitHostPollResult,
  GitHostProvider,
  LlmEvent,
  LlmProvider,
  LlmRequest,
  ProviderStatus,
  PublishedChangeRequest,
  SttEvent,
  SttProvider,
  SttRequest,
} from "./contracts.js";

export class FakeLlmProvider implements LlmProvider {
  readonly id = "fake-llm";
  readonly requests: LlmRequest[] = [];
  readonly #outputs: unknown[];
  readonly #resolve:
    | ((request: LlmRequest, call: number) => unknown | Promise<unknown>)
    | undefined;

  constructor(
    options: {
      outputs?: unknown[];
      resolve?: (
        request: LlmRequest,
        call: number,
      ) => unknown | Promise<unknown>;
    } = {},
  ) {
    this.#outputs = [...(options.outputs ?? [])];
    this.#resolve = options.resolve;
  }

  async status(): Promise<ProviderStatus> {
    return {
      id: this.id,
      kind: "llm",
      label: "Deterministic fake model",
      availability: "available",
      consent: "not-applicable",
      streaming: "native",
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    const call = this.requests.length;
    const snapshot: LlmRequest = { ...request };
    delete snapshot.signal;
    this.requests.push(structuredClone(snapshot) as LlmRequest);
    yield {
      type: "started",
      providerId: this.id,
      invocationId: request.invocationId,
    };
    const output = this.#resolve
      ? await this.#resolve(request, call)
      : (this.#outputs.shift() ?? { ok: true });
    const text = typeof output === "string" ? output : JSON.stringify(output);
    yield { type: "text-delta", delta: text };
    yield { type: "completed", output, text };
  }
}

export class FakeSttProvider implements SttProvider {
  readonly id = "fake-stt";
  constructor(
    readonly fixture: { transcript?: string; confidence?: number } = {},
  ) {}

  async status(): Promise<ProviderStatus> {
    return {
      id: this.id,
      kind: "stt",
      label: "Deterministic fake transcription",
      availability: "available",
      consent: "not-applicable",
      streaming: "native",
    };
  }

  async *transcribe(request: SttRequest): AsyncIterable<SttEvent> {
    yield {
      type: "started",
      providerId: this.id,
      sessionId: request.sessionId,
    };
    for await (const chunk of request.chunks) {
      yield {
        type: "chunk-accepted",
        sequence: chunk.sequence,
        bytes: chunk.bytes.byteLength,
      };
    }
    const transcript =
      this.fixture.transcript ?? "Deterministic fake transcript.";
    yield { type: "transcript-delta", text: transcript, stable: true };
    yield {
      type: "completed",
      transcript,
      ...(this.fixture.confidence === undefined
        ? {}
        : { confidence: this.fixture.confidence }),
    };
  }
}

export class FakeCodecProvider implements CodecProvider {
  readonly id = "fake-codec";

  async status(): Promise<ProviderStatus> {
    return {
      id: this.id,
      kind: "codec",
      label: "Deterministic fake codec",
      availability: "available",
      consent: "not-applicable",
      streaming: "none",
    };
  }

  async transcode(request: CodecRequest): Promise<CodecResult> {
    const bytes = await readFile(request.inputPath);
    await writeFile(request.outputPath, bytes, { flag: "wx" });
    const size = (await stat(request.outputPath)).size;
    return {
      outputPath: request.outputPath,
      mimeType: request.format === "ogg" ? "audio/ogg" : "audio/mpeg",
      bytes: size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
}

export class FakeGitHostProvider implements GitHostProvider {
  readonly id = "fake-git-host";
  readonly published: PublishedChangeRequest[] = [];
  readonly tasks: GitHostPollResult["tasks"] = [];
  #polls = 0;

  async status(): Promise<ProviderStatus> {
    return {
      id: this.id,
      kind: "git-host",
      label: "Deterministic fake Git host",
      availability: "available",
      consent: "not-applicable",
      streaming: "none",
    };
  }

  async publish(request: ChangeRequestDraft): Promise<PublishedChangeRequest> {
    const result: PublishedChangeRequest = {
      id: `fake-cr-${String(this.published.length + 1).padStart(4, "0")}`,
      repository: request.repository,
      branch: request.branch,
      state: "open",
    };
    this.published.push(result);
    return result;
  }

  async poll(request: GitHostPollRequest): Promise<GitHostPollResult> {
    void request;
    this.#polls += 1;
    const tasks = this.tasks.splice(0);
    return {
      cursor: `fake-cursor-${String(this.#polls).padStart(4, "0")}`,
      tasks,
    };
  }
}
