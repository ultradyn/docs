import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FakeCodecProvider, type CodecProvider } from "../providers/index.js";
import {
  AudioChunkOrderError,
  AudioSessionByteLimitError,
  AudioSessionChunkLimitError,
  FileAudioSessionStore,
} from "./index.js";

const sessionId = "aud-01J00000000000000000000000";
const questionId = "q-01J00000000000000000000000";

describe("audio session public seam", () => {
  it("refuses a chunk that would exceed the session byte limit before writing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-audio-"));
    const store = new FileAudioSessionStore(root, {
      maxSessionBytes: 3,
      now: () => "2026-07-16T00:00:00.000Z",
    });
    await store.start({ sessionId, questionId });
    await store.appendChunk(sessionId, {
      sequence: 0,
      bytes: new Uint8Array([1, 2]),
      mimeType: "audio/webm",
    });

    await expect(
      store.appendChunk(sessionId, {
        sequence: 1,
        bytes: new Uint8Array([3, 4]),
        mimeType: "audio/webm",
      }),
    ).rejects.toBeInstanceOf(AudioSessionByteLimitError);
    await expect(
      access(join(root, questionId, sessionId, "chunks", "000001.part")),
    ).rejects.toThrow();
    expect(await store.get(sessionId)).toMatchObject({
      nextSequence: 1,
      chunks: [{ sequence: 0, bytes: 2 }],
    });
  });

  it("refuses a chunk that would exceed the session chunk limit before writing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-audio-"));
    const store = new FileAudioSessionStore(root, {
      maxChunksPerSession: 1,
      now: () => "2026-07-16T00:00:00.000Z",
    });
    await store.start({ sessionId, questionId });
    await store.appendChunk(sessionId, {
      sequence: 0,
      bytes: new Uint8Array([1]),
      mimeType: "audio/webm",
    });

    await expect(
      store.appendChunk(sessionId, {
        sequence: 1,
        bytes: new Uint8Array([2]),
        mimeType: "audio/webm",
      }),
    ).rejects.toBeInstanceOf(AudioSessionChunkLimitError);
    await expect(
      access(join(root, questionId, sessionId, "chunks", "000001.part")),
    ).rejects.toThrow();
    expect((await store.get(sessionId)).nextSequence).toBe(1);
  });

  it("durably acknowledges ordered chunks and treats byte-identical retries as idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-audio-"));
    const store = new FileAudioSessionStore(root, {
      now: () => "2026-07-16T00:00:00.000Z",
    });
    await store.start({ sessionId, questionId });
    await expect(
      store.appendChunk(`${sessionId}/../${sessionId}`, {
        sequence: 0,
        bytes: new Uint8Array([9]),
        mimeType: "audio/webm",
      }),
    ).rejects.toThrow();
    const first = await store.appendChunk(sessionId, {
      sequence: 0,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/webm",
    });
    const retried = await store.appendChunk(sessionId, {
      sequence: 0,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/webm",
    });

    expect(first).toMatchObject({ sequence: 0, bytes: 3, durable: true });
    expect(retried).toEqual(first);
    const restarted = await store.start({ sessionId, questionId });
    expect(restarted.nextSequence).toBe(1);
    expect(restarted.chunks).toHaveLength(1);
    await expect(
      store.appendChunk(sessionId, {
        sequence: 2,
        bytes: new Uint8Array([9]),
        mimeType: "audio/webm",
      }),
    ).rejects.toBeInstanceOf(AudioChunkOrderError);
    expect((await store.get(sessionId)).nextSequence).toBe(1);
  });

  it("verifies conversion before deleting raw chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-audio-"));
    const store = new FileAudioSessionStore(root, {
      now: () => "2026-07-16T00:00:00.000Z",
    });
    await store.start({ sessionId, questionId });
    await store.appendChunk(sessionId, {
      sequence: 0,
      bytes: new Uint8Array([1, 2]),
      mimeType: "audio/webm",
    });
    await store.appendChunk(sessionId, {
      sequence: 1,
      bytes: new Uint8Array([3, 4]),
      mimeType: "audio/webm",
    });

    const complete = await store.finalize(sessionId, {
      codec: new FakeCodecProvider(),
      targetFormat: "ogg",
    });
    expect(complete.state).toBe("complete");
    expect(complete.output).toMatchObject({ bytes: 4, mimeType: "audio/ogg" });
    expect(complete.rawRetained).toBe(false);
    await expect(
      access(join(root, questionId, sessionId, "chunks", "000000.part")),
    ).rejects.toThrow();
    await expect(
      access(complete.output?.path ?? "missing"),
    ).resolves.toBeUndefined();
  });

  it("recovers cleanup from persisted finalizing metadata after the completion write fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-audio-"));
    let failCompleteWrite = true;
    const store = new FileAudioSessionStore(root, {
      metadataWriter: async (path, contents) => {
        const snapshot = JSON.parse(contents) as {
          state: string;
        };
        if (snapshot.state === "complete" && failCompleteWrite) {
          failCompleteWrite = false;
          throw new Error("simulated completion metadata failure");
        }
        await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
      },
      now: () => "2026-07-16T00:00:00.000Z",
    });
    await store.start({ sessionId, questionId });
    await store.appendChunk(sessionId, {
      sequence: 0,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/webm",
    });
    let transcodes = 0;
    const fake = new FakeCodecProvider();
    const codec: CodecProvider = {
      id: fake.id,
      status: () => fake.status(),
      transcode: async (input) => {
        transcodes += 1;
        return fake.transcode(input);
      },
    };

    await expect(
      store.finalize(sessionId, { codec, targetFormat: "ogg" }),
    ).rejects.toThrow(/simulated completion metadata failure/i);
    expect(await store.get(sessionId)).toMatchObject({
      state: "finalizing",
      rawRetained: false,
      output: { format: "ogg", bytes: 3 },
    });
    await expect(
      access(join(root, questionId, sessionId, "chunks", "000000.part")),
    ).rejects.toThrow();

    const recovered = await store.finalize(sessionId, {
      codec,
      targetFormat: "ogg",
    });
    expect(recovered).toMatchObject({ state: "complete", rawRetained: false });
    expect(transcodes).toBe(1);
  });

  it("retains raw bytes when the cleanup-intent metadata write fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-audio-"));
    let failCleanupIntentWrite = true;
    const store = new FileAudioSessionStore(root, {
      metadataWriter: async (path, contents) => {
        const snapshot = JSON.parse(contents) as {
          output?: unknown;
          rawRetained: boolean;
          state: string;
        };
        if (
          snapshot.state === "finalizing" &&
          snapshot.output &&
          !snapshot.rawRetained &&
          failCleanupIntentWrite
        ) {
          failCleanupIntentWrite = false;
          throw new Error("simulated cleanup-intent metadata failure");
        }
        await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
      },
      now: () => "2026-07-16T00:00:00.000Z",
    });
    await store.start({ sessionId, questionId });
    await store.appendChunk(sessionId, {
      sequence: 0,
      bytes: new Uint8Array([7, 8]),
      mimeType: "audio/webm",
    });
    let transcodes = 0;
    const fake = new FakeCodecProvider();
    const codec: CodecProvider = {
      id: fake.id,
      status: () => fake.status(),
      transcode: async (input) => {
        transcodes += 1;
        return fake.transcode(input);
      },
    };

    await expect(
      store.finalize(sessionId, { codec, targetFormat: "ogg" }),
    ).rejects.toThrow(/simulated cleanup-intent metadata failure/i);
    expect(await store.get(sessionId)).toMatchObject({
      state: "finalizing",
      rawRetained: true,
      output: { format: "ogg", bytes: 2 },
    });
    await expect(
      access(join(root, questionId, sessionId, "chunks", "000000.part")),
    ).resolves.toBeUndefined();

    const recovered = await store.finalize(sessionId, {
      codec,
      targetFormat: "ogg",
    });
    expect(recovered).toMatchObject({ state: "complete", rawRetained: false });
    expect(transcodes).toBe(1);
  });

  it("retains raw chunks and exposes a failed state when conversion fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-audio-"));
    const store = new FileAudioSessionStore(root, {
      now: () => "2026-07-16T00:00:00.000Z",
    });
    await store.start({ sessionId, questionId });
    await store.appendChunk(sessionId, {
      sequence: 0,
      bytes: new Uint8Array([5]),
      mimeType: "audio/webm",
    });
    const failing: CodecProvider = {
      id: "failing-codec",
      status: async () => ({
        id: "failing-codec",
        kind: "codec",
        label: "Failing codec",
        availability: "available",
        consent: "not-applicable",
        streaming: "none",
      }),
      transcode: async () => {
        throw new Error("codec exploded");
      },
    };

    await expect(
      store.finalize(sessionId, { codec: failing, targetFormat: "ogg" }),
    ).rejects.toThrow(/codec exploded/i);
    const failed = await store.get(sessionId);
    expect(failed).toMatchObject({ state: "failed", rawRetained: true });
    await expect(
      access(join(root, questionId, sessionId, "chunks", "000000.part")),
    ).resolves.toBeUndefined();
  });
});
