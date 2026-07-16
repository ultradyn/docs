import { z } from "zod";

export const ProviderKindSchema = z.enum(["llm", "stt", "codec", "git-host"]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ProviderStatusSchema = z.object({
  id: z.string().min(1),
  kind: ProviderKindSchema,
  label: z.string().min(1),
  availability: z.enum(["available", "unavailable", "activation-required"]),
  consent: z.enum([
    "not-applicable",
    "required",
    "granted",
    "denied",
    "revoked",
  ]),
  reason: z.string().min(1).optional(),
  streaming: z.enum(["native", "buffered", "none"]).default("none"),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export type JsonSchema = Record<string, unknown>;

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  invocationId: string;
  agent: { name: string; prompt: string };
  messages: LlmMessage[];
  responseSchema?: JsonSchema;
  model?: string;
  signal?: AbortSignal;
}

export type LlmEvent =
  | { type: "started"; providerId: string; invocationId: string }
  | { type: "text-delta"; delta: string }
  | { type: "completed"; output: unknown; text: string }
  | { type: "failed"; code: string; message: string; retryable: boolean };

export interface LlmProvider {
  readonly id: string;
  status(): Promise<ProviderStatus>;
  stream(request: LlmRequest): AsyncIterable<LlmEvent>;
}

export interface AudioChunk {
  sequence: number;
  bytes: Uint8Array;
  mimeType: string;
}

export interface SttRequest {
  sessionId: string;
  chunks: AsyncIterable<AudioChunk>;
  language?: string;
  prompt?: string;
  signal?: AbortSignal;
}

export type SttEvent =
  | { type: "started"; providerId: string; sessionId: string }
  | { type: "chunk-accepted"; sequence: number; bytes: number }
  | { type: "transcript-delta"; text: string; stable: boolean }
  | { type: "completed"; transcript: string; confidence?: number }
  | { type: "failed"; code: string; message: string; retryable: boolean };

export interface SttProvider {
  readonly id: string;
  status(): Promise<ProviderStatus>;
  transcribe(request: SttRequest): AsyncIterable<SttEvent>;
}

export type AudioTargetFormat = "ogg" | "mp3";

export interface CodecRequest {
  inputPath: string;
  outputPath: string;
  format: AudioTargetFormat;
  signal?: AbortSignal;
}

export interface CodecResult {
  outputPath: string;
  mimeType: "audio/ogg" | "audio/mpeg";
  bytes: number;
  sha256: string;
}

export interface CodecProvider {
  readonly id: string;
  status(): Promise<ProviderStatus>;
  transcode(request: CodecRequest): Promise<CodecResult>;
}

export interface ChangeRequestDraft {
  repository: string;
  branch: string;
  title: string;
  body: string;
  base?: string;
}

export interface PublishedChangeRequest {
  id: string;
  url?: string;
  repository: string;
  branch: string;
  state: "open" | "merged" | "closed";
}

export interface GitHostPollRequest {
  repository: string;
  cursor: string | null;
}

export interface GitHostReviewTask {
  id: string;
  changeRequestId: string;
  revision: string;
  reason: "opened" | "updated" | "review-requested";
}

export interface GitHostPollResult {
  cursor: string;
  tasks: GitHostReviewTask[];
}

export interface GitHostProvider {
  readonly id: string;
  status(): Promise<ProviderStatus>;
  publish(request: ChangeRequestDraft): Promise<PublishedChangeRequest>;
  poll(request: GitHostPollRequest): Promise<GitHostPollResult>;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options: { cwd?: string; input?: string; signal?: AbortSignal },
  ): Promise<ProcessResult>;
}
