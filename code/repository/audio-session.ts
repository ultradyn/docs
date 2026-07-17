import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

import { IdSchemas } from "../domain/index.js";
import type { AudioTargetFormat, CodecProvider } from "../providers/index.js";

const chunkSchema = z.object({
  sequence: z.number().int().nonnegative(),
  path: z.string().min(1),
  mimeType: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  acknowledgedAt: z.string().datetime({ offset: true }),
});

const audioSessionSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchemas.audioSession,
  questionId: IdSchemas.question,
  state: z.enum(["recording", "finalizing", "complete", "failed"]),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  nextSequence: z.number().int().nonnegative(),
  chunks: z.array(chunkSchema),
  rawRetained: z.boolean(),
  output: z
    .object({
      path: z.string().min(1),
      format: z.enum(["ogg", "mp3"]),
      mimeType: z.enum(["audio/ogg", "audio/mpeg"]),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .optional(),
  failure: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      at: z.string().datetime({ offset: true }),
    })
    .optional(),
});

export type AudioSessionRecord = z.infer<typeof audioSessionSchema>;
export type AudioChunkAcknowledgement = Pick<
  z.infer<typeof chunkSchema>,
  "sequence" | "bytes" | "sha256"
> & { durable: true };

export type AudioSessionMetadataWriter = (
  path: string,
  contents: string,
) => Promise<void>;

export const DEFAULT_MAX_AUDIO_SESSION_BYTES = 128 * 1024 * 1024;
export const DEFAULT_MAX_AUDIO_SESSION_CHUNKS = 10_000;

export class AudioChunkOrderError extends Error {
  constructor(expected: number, received: number) {
    super(
      `Audio chunks must be appended in order: expected ${expected}, received ${received}.`,
    );
    this.name = "AudioChunkOrderError";
  }
}

export class AudioSessionStateError extends Error {
  constructor(state: string, operation: string) {
    super(`Cannot ${operation} an audio session in ${state} state.`);
    this.name = "AudioSessionStateError";
  }
}

export class AudioSessionByteLimitError extends Error {
  readonly limit: number;
  readonly attempted: number;

  constructor(limit: number, attempted: number) {
    super(
      `Audio session byte limit exceeded: limit ${limit}, attempted ${attempted}.`,
    );
    this.name = "AudioSessionByteLimitError";
    this.limit = limit;
    this.attempted = attempted;
  }
}

export class AudioSessionChunkLimitError extends Error {
  readonly limit: number;
  readonly attempted: number;

  constructor(limit: number, attempted: number) {
    super(
      `Audio session chunk limit exceeded: limit ${limit}, attempted ${attempted}.`,
    );
    this.name = "AudioSessionChunkLimitError";
    this.limit = limit;
    this.attempted = attempted;
  }
}

function positiveSafeInteger(value: number, option: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${option} must be a positive safe integer.`);
  }
  return value;
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function durableExclusiveWrite(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function readDescriptorBytes(
  file: FileHandle,
  expectedSize: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(expectedSize);
  let offset = 0;
  while (offset < expectedSize) {
    const result = await file.read(
      bytes,
      offset,
      expectedSize - offset,
      offset,
    );
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  const afterRead = await file.stat();
  if (offset !== expectedSize || afterRead.size !== expectedSize) {
    throw new Error(
      "Existing audio chunk changed while recovery was reading it.",
    );
  }
  return bytes;
}

async function openStableRegularFileNoFollow(
  path: string,
  onOpened?: (path: string) => void | Promise<void>,
): Promise<{
  bytes: Buffer;
  verifyPathAndBytes: () => Promise<void>;
  close: () => Promise<void>;
}> {
  let file;
  try {
    file = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Existing audio chunk recovery refuses symbolic links.", {
        cause: error,
      });
    }
    throw error;
  }
  try {
    const opened = await file.stat();
    if (!opened.isFile()) {
      throw new Error("Existing audio chunk recovery requires a regular file.");
    }
    await onOpened?.(path);
    const beforeRead = await lstat(path);
    if (
      !beforeRead.isFile() ||
      beforeRead.dev !== opened.dev ||
      beforeRead.ino !== opened.ino
    ) {
      throw new Error(
        "Existing audio chunk changed while recovery was opening it.",
      );
    }
    const bytes = await readDescriptorBytes(file, opened.size);
    const afterRead = await lstat(path);
    if (
      !afterRead.isFile() ||
      afterRead.dev !== opened.dev ||
      afterRead.ino !== opened.ino
    ) {
      throw new Error(
        "Existing audio chunk changed while recovery was reading it.",
      );
    }
    return {
      bytes,
      async verifyPathAndBytes() {
        const [visible, descriptor] = await Promise.all([
          lstat(path),
          file.stat(),
        ]);
        if (
          !visible.isFile() ||
          visible.dev !== opened.dev ||
          visible.ino !== opened.ino ||
          visible.size !== bytes.byteLength ||
          descriptor.dev !== opened.dev ||
          descriptor.ino !== opened.ino ||
          descriptor.size !== bytes.byteLength
        ) {
          throw new Error(
            "Existing audio chunk pathname was replaced during metadata publication.",
          );
        }
        const finalBytes = await readDescriptorBytes(file, bytes.byteLength);
        if (!finalBytes.equals(bytes)) {
          throw new Error(
            "Existing audio chunk bytes changed during metadata publication.",
          );
        }
        const [finalVisible, finalDescriptor] = await Promise.all([
          lstat(path),
          file.stat(),
        ]);
        if (
          !finalVisible.isFile() ||
          finalVisible.dev !== opened.dev ||
          finalVisible.ino !== opened.ino ||
          finalVisible.size !== bytes.byteLength ||
          !finalDescriptor.isFile() ||
          finalDescriptor.dev !== opened.dev ||
          finalDescriptor.ino !== opened.ino ||
          finalDescriptor.size !== bytes.byteLength
        ) {
          throw new Error(
            "Existing audio chunk pathname was replaced during the final recovery read.",
          );
        }
      },
      async close() {
        await file.close();
      },
    };
  } catch (error) {
    await file.close();
    throw error;
  }
}

const defaultMetadataWriter: AudioSessionMetadataWriter = async (
  path,
  contents,
) => {
  await writeFileAtomic(path, contents, {
    encoding: "utf8",
    mode: 0o600,
  });
};

export class FileAudioSessionStore {
  readonly root: string;
  readonly #now: () => string;
  readonly #maxSessionBytes: number;
  readonly #maxChunksPerSession: number;
  readonly #metadataWriter: AudioSessionMetadataWriter;
  readonly #onExistingChunkOpened:
    ((path: string) => void | Promise<void>) | undefined;

  constructor(
    root: string,
    options: {
      maxChunksPerSession?: number;
      maxSessionBytes?: number;
      metadataWriter?: AudioSessionMetadataWriter;
      onExistingChunkOpened?: (path: string) => void | Promise<void>;
      now?: () => string;
    } = {},
  ) {
    this.root = resolve(root);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#maxSessionBytes = positiveSafeInteger(
      options.maxSessionBytes ?? DEFAULT_MAX_AUDIO_SESSION_BYTES,
      "maxSessionBytes",
    );
    this.#maxChunksPerSession = positiveSafeInteger(
      options.maxChunksPerSession ?? DEFAULT_MAX_AUDIO_SESSION_CHUNKS,
      "maxChunksPerSession",
    );
    this.#metadataWriter = options.metadataWriter ?? defaultMetadataWriter;
    this.#onExistingChunkOpened = options.onExistingChunkOpened;
  }

  async start(input: {
    sessionId: string;
    questionId: string;
  }): Promise<AudioSessionRecord> {
    const id = IdSchemas.audioSession.parse(input.sessionId);
    const questionId = IdSchemas.question.parse(input.questionId);
    const directory = this.#directory(questionId, id);
    await mkdir(directory, { recursive: true });
    const at = this.#now();
    const record = audioSessionSchema.parse({
      schemaVersion: 1,
      id,
      questionId,
      state: "recording",
      createdAt: at,
      updatedAt: at,
      nextSequence: 0,
      chunks: [],
      rawRetained: true,
    });
    try {
      await durableExclusiveWrite(
        join(directory, "session.json"),
        new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const existing = await this.get(id);
        if (existing.questionId !== questionId) {
          throw new Error(
            `Audio session ${id} already belongs to ${existing.questionId}.`,
            { cause: error },
          );
        }
        return existing;
      }
      throw error;
    }
    return record;
  }

  async get(sessionId: string): Promise<AudioSessionRecord> {
    const id = IdSchemas.audioSession.parse(sessionId);
    const directory = await this.#findDirectory(id);
    return this.#read(directory, id);
  }

  async appendChunk(
    sessionId: string,
    input: { sequence: number; bytes: Uint8Array; mimeType: string },
  ): Promise<AudioChunkAcknowledgement> {
    const id = IdSchemas.audioSession.parse(sessionId);
    const directory = await this.#findDirectory(id);
    return this.#locked(directory, async () => {
      const record = await this.#read(directory, id);
      if (record.state !== "recording")
        throw new AudioSessionStateError(record.state, "append to");
      const digest = checksum(input.bytes);
      if (input.sequence < record.nextSequence) {
        const prior = record.chunks.find(
          (chunk) => chunk.sequence === input.sequence,
        );
        if (
          prior &&
          prior.sha256 === digest &&
          prior.bytes === input.bytes.byteLength
        ) {
          return {
            sequence: prior.sequence,
            bytes: prior.bytes,
            sha256: prior.sha256,
            durable: true,
          };
        }
        throw new RawAudioChunkConflictError(input.sequence);
      }
      if (input.sequence !== record.nextSequence) {
        throw new AudioChunkOrderError(record.nextSequence, input.sequence);
      }
      if (record.chunks.length >= this.#maxChunksPerSession) {
        throw new AudioSessionChunkLimitError(
          this.#maxChunksPerSession,
          record.chunks.length + 1,
        );
      }
      const sessionBytes = record.chunks.reduce(
        (total, chunk) => total + chunk.bytes,
        0,
      );
      const attemptedBytes = sessionBytes + input.bytes.byteLength;
      if (attemptedBytes > this.#maxSessionBytes) {
        throw new AudioSessionByteLimitError(
          this.#maxSessionBytes,
          attemptedBytes,
        );
      }
      const relativePath = `chunks/${String(input.sequence).padStart(6, "0")}.part`;
      const chunkPath = join(directory, relativePath);
      let recoveredExisting = false;
      try {
        await durableExclusiveWrite(chunkPath, input.bytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        recoveredExisting = true;
      }
      const opened = await openStableRegularFileNoFollow(
        chunkPath,
        recoveredExisting ? this.#onExistingChunkOpened : undefined,
      );
      try {
        if (!opened.bytes.equals(Buffer.from(input.bytes))) {
          throw new RawAudioChunkConflictError(input.sequence);
        }
        const at = this.#now();
        const chunk = {
          sequence: input.sequence,
          path: relativePath,
          mimeType: input.mimeType,
          bytes: input.bytes.byteLength,
          sha256: digest,
          acknowledgedAt: at,
        };
        await this.#write(directory, {
          ...record,
          updatedAt: at,
          nextSequence: record.nextSequence + 1,
          chunks: [...record.chunks, chunk],
        });
        try {
          await opened.verifyPathAndBytes();
        } catch (error) {
          try {
            await this.#write(directory, record);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "Audio chunk metadata publication raced with pathname replacement and acknowledgement rollback also failed.",
              { cause: rollbackError },
            );
          }
          throw error;
        }
        return {
          sequence: chunk.sequence,
          bytes: chunk.bytes,
          sha256: chunk.sha256,
          durable: true,
        };
      } finally {
        await opened.close();
      }
    });
  }

  async finalize(
    sessionId: string,
    input: { codec: CodecProvider; targetFormat: AudioTargetFormat },
  ): Promise<AudioSessionRecord> {
    const id = IdSchemas.audioSession.parse(sessionId);
    const directory = await this.#findDirectory(id);
    return this.#locked(directory, async () => {
      let record = await this.#read(directory, id);
      if (record.state === "complete") return record;
      if (
        record.state !== "recording" &&
        record.state !== "failed" &&
        record.state !== "finalizing"
      ) {
        throw new AudioSessionStateError(record.state, "finalize");
      }
      if (record.chunks.length === 0 && !record.output)
        throw new Error("Cannot finalize an audio session with no chunks.");

      if (record.state !== "finalizing") {
        await this.#verifyChunks(directory, record);
        record = await this.#write(directory, {
          ...record,
          state: "finalizing",
          updatedAt: this.#now(),
          output: undefined,
          failure: undefined,
        });
      }

      const capturePath = join(directory, "capture.raw");
      const outputPath = join(directory, `audio.${input.targetFormat}`);

      if (!record.output) {
        await rm(capturePath, { force: true });
        await rm(outputPath, { force: true });
        try {
          await this.#verifyChunks(directory, record);
          const capture = await open(capturePath, "wx", 0o600);
          try {
            for (const chunk of record.chunks) {
              await capture.writeFile(
                await readFile(join(directory, chunk.path)),
              );
            }
            await capture.sync();
          } finally {
            await capture.close();
          }
          const result = await input.codec.transcode({
            inputPath: capturePath,
            outputPath,
            format: input.targetFormat,
          });
          const outputBytes = await readFile(outputPath);
          const outputStat = await stat(outputPath);
          if (
            outputStat.size !== result.bytes ||
            checksum(outputBytes) !== result.sha256 ||
            resolve(result.outputPath) !== resolve(outputPath)
          ) {
            throw new Error(
              "Codec output failed post-transcode integrity verification.",
            );
          }
          record = await this.#write(directory, {
            ...record,
            state: "finalizing",
            updatedAt: this.#now(),
            rawRetained: true,
            output: {
              path: outputPath,
              format: input.targetFormat,
              mimeType: result.mimeType,
              bytes: result.bytes,
              sha256: result.sha256,
            },
            failure: undefined,
          });
        } catch (error) {
          await rm(capturePath, { force: true });
          await this.#write(directory, {
            ...record,
            state: "failed",
            updatedAt: this.#now(),
            rawRetained: true,
            output: undefined,
            failure: {
              code: "transcode_failed",
              message: error instanceof Error ? error.message : String(error),
              at: this.#now(),
            },
          });
          throw error;
        }
      } else {
        await this.#verifyOutput(record);
      }

      if (record.rawRetained) {
        record = await this.#write(directory, {
          ...record,
          state: "finalizing",
          updatedAt: this.#now(),
          rawRetained: false,
          failure: undefined,
        });
      }

      for (const chunk of record.chunks)
        await rm(join(directory, chunk.path), { force: true });
      await rm(join(directory, "chunks"), { recursive: true, force: true });
      await rm(capturePath, { force: true });
      return this.#write(directory, {
        ...record,
        state: "complete",
        updatedAt: this.#now(),
        rawRetained: false,
        failure: undefined,
      });
    });
  }

  async #verifyOutput(record: AudioSessionRecord): Promise<void> {
    if (!record.output) {
      throw new Error("Finalizing audio session has no verified output.");
    }
    const bytes = await readFile(record.output.path);
    const outputStat = await stat(record.output.path);
    if (
      outputStat.size !== record.output.bytes ||
      checksum(bytes) !== record.output.sha256
    ) {
      throw new Error(
        "Persisted codec output failed finalization integrity verification.",
      );
    }
  }

  async #verifyChunks(
    directory: string,
    record: AudioSessionRecord,
  ): Promise<void> {
    for (const chunk of record.chunks) {
      const bytes = await readFile(join(directory, chunk.path));
      if (
        bytes.byteLength !== chunk.bytes ||
        checksum(bytes) !== chunk.sha256
      ) {
        throw new Error(
          `Audio chunk ${chunk.sequence} failed integrity verification.`,
        );
      }
    }
  }

  async #read(
    directory: string,
    expectedId?: string,
  ): Promise<AudioSessionRecord> {
    const record = audioSessionSchema.parse(
      JSON.parse(await readFile(join(directory, "session.json"), "utf8")),
    );
    if (expectedId && record.id !== expectedId) {
      throw new Error(
        `Audio session record ${record.id} does not match requested ID ${expectedId}.`,
      );
    }
    return record;
  }

  async #write(directory: string, value: unknown): Promise<AudioSessionRecord> {
    const record = audioSessionSchema.parse(value);
    await this.#metadataWriter(
      join(directory, "session.json"),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    return record;
  }

  #directory(questionId: string, sessionId: string): string {
    return join(this.root, questionId, sessionId);
  }

  async #findDirectory(sessionId: string): Promise<string> {
    const id = IdSchemas.audioSession.parse(sessionId);
    const { readdir } = await import("node:fs/promises");
    let questions: string[];
    try {
      questions = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Unknown audio session ${id}.`, {
          cause: error,
        });
      }
      throw error;
    }
    for (const questionId of questions.sort()) {
      const directory = join(this.root, questionId, id);
      try {
        await stat(join(directory, "session.json"));
        return directory;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new Error(`Unknown audio session ${id}.`);
  }

  async #locked<T>(directory: string, operation: () => Promise<T>): Promise<T> {
    const release = await lockfile.lock(directory, {
      realpath: false,
      lockfilePath: join(directory, ".session.lock"),
      stale: 30_000,
      retries: { retries: 20, factor: 1.2, minTimeout: 10, maxTimeout: 200 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}

export class RawAudioChunkConflictError extends Error {
  constructor(sequence: number) {
    super(
      `Audio chunk ${sequence} was already acknowledged with different bytes.`,
    );
    this.name = "RawAudioChunkConflictError";
  }
}
