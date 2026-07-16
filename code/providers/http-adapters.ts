import type {
  AudioChunk,
  LlmEvent,
  LlmProvider,
  LlmRequest,
  ProviderStatus,
  SttEvent,
  SttProvider,
  SttRequest,
} from "./contracts.js";
import type { CredentialCapability } from "./credentials.js";

type Fetch = typeof globalThis.fetch;

function bearer(
  capability: CredentialCapability,
): Extract<CredentialCapability, { kind: "http-bearer" }> {
  if (capability.kind !== "http-bearer") {
    throw new Error(
      `HTTP provider requires an http-bearer capability, not ${capability.kind}.`,
    );
  }
  return capability;
}

async function* responseLines(response: Response): AsyncIterable<string> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) yield line;
    if (done) break;
  }
  if (buffer) yield buffer;
}

export class OpenAiResponsesLlmProvider implements LlmProvider {
  readonly id: string;
  readonly #fetch: Fetch;
  readonly #credential: Extract<CredentialCapability, { kind: "http-bearer" }>;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #label: string;

  constructor(options: {
    credential: CredentialCapability;
    model?: string;
    fetch?: Fetch;
    baseUrl?: string;
    id?: string;
    label?: string;
  }) {
    this.id = options.id ?? "openai-api";
    this.#credential = bearer(options.credential);
    this.#model = options.model ?? "gpt-5.2";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.#label = options.label ?? "OpenAI Responses API";
  }

  async status(): Promise<ProviderStatus> {
    return {
      id: this.id,
      kind: "llm",
      label: this.#label,
      availability: "available",
      consent: "granted",
      streaming: "native",
    };
  }

  async listModels(): Promise<string[]> {
    const headers = new Headers();
    await this.#credential.authorize(headers);
    const response = await this.#fetch(`${this.#baseUrl}/models`, { headers });
    if (!response.ok) {
      throw new Error(
        `${this.id} model discovery failed with HTTP ${response.status}.`,
      );
    }
    const payload = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };
    return (payload.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    yield {
      type: "started",
      providerId: this.id,
      invocationId: request.invocationId,
    };
    const headers = new Headers({ "content-type": "application/json" });
    await this.#credential.authorize(headers);
    const response = await this.#fetch(`${this.#baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: request.model ?? this.#model,
        instructions: request.agent.prompt,
        input: request.messages,
        store: false,
        stream: true,
        ...(request.responseSchema
          ? {
              text: {
                format: {
                  type: "json_schema",
                  name: `${request.agent.name.replace(/[^a-z0-9_-]/giu, "_")}_output`,
                  strict: true,
                  schema: request.responseSchema,
                },
              },
            }
          : {}),
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!response.ok) {
      yield {
        type: "failed",
        code: `openai_http_${response.status}`,
        message: (await response.text()).slice(0, 1000) || response.statusText,
        retryable: response.status === 429 || response.status >= 500,
      };
      return;
    }
    let text = "";
    for await (const line of responseLines(response)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data) as { type?: string; delta?: string };
      if (event.type === "response.output_text.delta" && event.delta) {
        text += event.delta;
        yield { type: "text-delta", delta: event.delta };
      }
    }
    let output: unknown = text;
    if (request.responseSchema) {
      try {
        output = JSON.parse(text);
      } catch {
        yield {
          type: "failed",
          code: "invalid_structured_output",
          message: "OpenAI returned non-JSON output for a structured request.",
          retryable: true,
        };
        return;
      }
    }
    yield { type: "completed", output, text };
  }
}

export class XaiResponsesLlmProvider extends OpenAiResponsesLlmProvider {
  constructor(options: {
    credential: CredentialCapability;
    model?: string;
    fetch?: Fetch;
    baseUrl?: string;
  }) {
    super({
      ...options,
      id: "xai-responses",
      label: "xAI Responses API",
      model: options.model ?? "grok-4.5",
      baseUrl: options.baseUrl ?? "https://api.x.ai/v1",
    });
  }
}

async function collectChunks(
  request: SttRequest,
  onChunk: (chunk: AudioChunk) => void,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const chunks: Uint8Array[] = [];
  let mimeType = "audio/webm";
  let length = 0;
  for await (const chunk of request.chunks) {
    onChunk(chunk);
    chunks.push(chunk.bytes);
    length += chunk.bytes.byteLength;
    mimeType = chunk.mimeType;
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: joined, mimeType };
}

abstract class MultipartSttProvider implements SttProvider {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly endpoint: string;
  abstract readonly defaultModel: string;
  readonly #fetch: Fetch;
  readonly #credential: Extract<CredentialCapability, { kind: "http-bearer" }>;
  readonly #model: string | undefined;

  constructor(options: {
    credential: CredentialCapability;
    model?: string;
    fetch?: Fetch;
  }) {
    this.#credential = bearer(options.credential);
    this.#model = options.model;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async status(): Promise<ProviderStatus> {
    return {
      id: this.id,
      kind: "stt",
      label: this.label,
      availability: "available",
      consent: "granted",
      streaming: "buffered",
    };
  }

  protected appendParameters(form: FormData, request: SttRequest): void {
    form.append("model", this.#model ?? this.defaultModel);
    if (request.language) form.append("language", request.language);
    if (request.prompt) form.append("prompt", request.prompt);
  }

  async *transcribe(request: SttRequest): AsyncIterable<SttEvent> {
    yield {
      type: "started",
      providerId: this.id,
      sessionId: request.sessionId,
    };
    const accepted: SttEvent[] = [];
    const audio = await collectChunks(request, (chunk) => {
      accepted.push({
        type: "chunk-accepted",
        sequence: chunk.sequence,
        bytes: chunk.bytes.byteLength,
      });
    });
    for (const event of accepted) yield event;
    const form = new FormData();
    this.appendParameters(form, request);
    // xAI requires the file field after all other multipart parameters; this ordering is safe for both APIs.
    const blobBytes = audio.bytes.buffer.slice(
      audio.bytes.byteOffset,
      audio.bytes.byteOffset + audio.bytes.byteLength,
    ) as ArrayBuffer;
    form.append(
      "file",
      new Blob([blobBytes], { type: audio.mimeType }),
      `audio-${request.sessionId}.webm`,
    );
    const headers = new Headers();
    await this.#credential.authorize(headers);
    const response = await this.#fetch(this.endpoint, {
      method: "POST",
      headers,
      body: form,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!response.ok) {
      yield {
        type: "failed",
        code: `${this.id}_http_${response.status}`,
        message: (await response.text()).slice(0, 1000) || response.statusText,
        retryable: response.status === 429 || response.status >= 500,
      };
      return;
    }
    const result = (await response.json()) as {
      text?: string;
      transcript?: string;
      confidence?: number;
    };
    const transcript = result.text ?? result.transcript;
    if (!transcript) {
      yield {
        type: "failed",
        code: "missing_transcript",
        message: `${this.label} returned no transcript text.`,
        retryable: false,
      };
      return;
    }
    yield { type: "transcript-delta", text: transcript, stable: true };
    yield {
      type: "completed",
      transcript,
      ...(result.confidence === undefined
        ? {}
        : { confidence: result.confidence }),
    };
  }
}

export class OpenAiApiSttProvider extends MultipartSttProvider {
  readonly id = "openai-stt";
  readonly label = "OpenAI transcription API";
  readonly endpoint = "https://api.openai.com/v1/audio/transcriptions";
  readonly defaultModel = "gpt-4o-transcribe";
}

export class XaiRestSttProvider extends MultipartSttProvider {
  readonly id = "xai-stt";
  readonly label = "xAI speech-to-text API";
  readonly endpoint = "https://api.x.ai/v1/stt";
  readonly defaultModel = "grok-2-audio";
}
