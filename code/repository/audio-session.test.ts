import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { FakeCodecProvider, type CodecProvider } from "../providers/index.js";
import {
  AudioChunkOrderError,
  AudioSessionByteLimitError,
  AudioSessionChunkLimitError,
  FileAudioSessionStore,
  RawAudioChunkConflictError,
} from "./index.js";

const sessionId = "aud-01J00000000000000000000000";
const questionId = "q-01J00000000000000000000000";
const execFile = promisify(execFileCallback);

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

  it("migrates a schema-v1 active session only after validating its raw chunk", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-audio-v1-active-"));
    const directory = join(root, questionId, sessionId);
    const chunkPath = join(directory, "chunks", "000000.part");
    const bytes = Buffer.from([1, 2, 3]);
    await mkdir(join(directory, "chunks"), { recursive: true });
    await writeFile(chunkPath, bytes);
    const legacy = {
      schemaVersion: 1,
      id: sessionId,
      questionId,
      state: "recording",
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      nextSequence: 1,
      chunks: [
        {
          sequence: 0,
          path: "chunks/000000.part",
          mimeType: "audio/webm",
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          acknowledgedAt: "2026-07-16T00:00:00.000Z",
        },
      ],
      rawRetained: true,
    };
    await writeFile(
      join(directory, "session.json"),
      `${JSON.stringify(legacy, null, 2)}\n`,
    );

    const migrated = await new FileAudioSessionStore(root).get(sessionId);

    expect(migrated).toMatchObject({
      schemaVersion: 2,
      state: "recording",
      nextSequence: 1,
      chunks: [
        {
          sequence: 0,
          fileIdentity: {
            device: expect.any(Number),
            inode: expect.any(Number),
          },
        },
      ],
    });
    await expect(
      readFile(join(directory, "session.json"), "utf8"),
    ).resolves.toContain('"schemaVersion": 2');
  });

  it("migrates pre-cycle finalized and cleaned session records", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-audio-v1-history-"));
    const finalizedId = "aud-01J00000000000000000000001";
    const cleanedId = "aud-01J00000000000000000000002";
    const bytes = Buffer.from([4, 5, 6]);
    const chunk = {
      sequence: 0,
      path: "chunks/000000.part",
      mimeType: "audio/webm",
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      acknowledgedAt: "2026-07-16T00:00:00.000Z",
    };
    const base = {
      schemaVersion: 1,
      questionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:01:00.000Z",
      nextSequence: 1,
      chunks: [chunk],
    };
    const finalizedDirectory = join(root, questionId, finalizedId);
    await mkdir(join(finalizedDirectory, "chunks"), { recursive: true });
    await writeFile(join(finalizedDirectory, chunk.path), bytes);
    await writeFile(
      join(finalizedDirectory, "session.json"),
      `${JSON.stringify(
        {
          ...base,
          id: finalizedId,
          state: "finalizing",
          rawRetained: true,
          output: {
            path: join(finalizedDirectory, "audio.ogg"),
            format: "ogg",
            mimeType: "audio/ogg",
            bytes: 3,
            sha256: "0".repeat(64),
          },
        },
        null,
        2,
      )}\n`,
    );
    const cleanedDirectory = join(root, questionId, cleanedId);
    await mkdir(cleanedDirectory, { recursive: true });
    await writeFile(
      join(cleanedDirectory, "session.json"),
      `${JSON.stringify(
        {
          ...base,
          id: cleanedId,
          state: "complete",
          rawRetained: false,
          output: {
            path: join(cleanedDirectory, "audio.ogg"),
            format: "ogg",
            mimeType: "audio/ogg",
            bytes: 3,
            sha256: "0".repeat(64),
          },
        },
        null,
        2,
      )}\n`,
    );
    const store = new FileAudioSessionStore(root);

    await expect(store.get(finalizedId)).resolves.toMatchObject({
      schemaVersion: 2,
      state: "finalizing",
      rawRetained: true,
      chunks: [{ fileIdentity: expect.any(Object) }],
    });
    const cleaned = await store.get(cleanedId);
    expect(cleaned).toMatchObject({
      schemaVersion: 2,
      state: "complete",
      rawRetained: false,
      chunks: [{ sequence: 0 }],
    });
    expect(cleaned.chunks[0]).not.toHaveProperty("fileIdentity");
  });

  it.each(["tampered", "symlink"] as const)(
    "refuses schema-v1 raw migration through a %s chunk",
    async (adversary) => {
      const root = await mkdtemp(
        join(tmpdir(), `ultradyn-audio-v1-${adversary}-`),
      );
      const externalRoot = await mkdtemp(
        join(tmpdir(), `ultradyn-audio-v1-${adversary}-external-`),
      );
      const directory = join(root, questionId, sessionId);
      const chunkPath = join(directory, "chunks", "000000.part");
      const expectedBytes = Buffer.from([1, 2, 3]);
      await mkdir(join(directory, "chunks"), { recursive: true });
      if (adversary === "tampered") {
        await writeFile(chunkPath, new Uint8Array([9, 9, 9]));
      } else {
        const externalChunk = join(externalRoot, "owner.part");
        await writeFile(externalChunk, expectedBytes);
        await symlink(externalChunk, chunkPath);
      }
      await writeFile(
        join(directory, "session.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            id: sessionId,
            questionId,
            state: "recording",
            createdAt: "2026-07-16T00:00:00.000Z",
            updatedAt: "2026-07-16T00:00:00.000Z",
            nextSequence: 1,
            chunks: [
              {
                sequence: 0,
                path: "chunks/000000.part",
                mimeType: "audio/webm",
                bytes: expectedBytes.byteLength,
                sha256: createHash("sha256")
                  .update(expectedBytes)
                  .digest("hex"),
                acknowledgedAt: "2026-07-16T00:00:00.000Z",
              },
            ],
            rawRetained: true,
          },
          null,
          2,
        )}\n`,
      );

      await expect(
        new FileAudioSessionStore(root).get(sessionId),
      ).rejects.toThrow(/legacy audio chunk|digest|symbolic link|migration/i);
      await expect(
        readFile(join(directory, "session.json"), "utf8"),
      ).resolves.toContain('"schemaVersion": 1');
    },
  );

  it("adopts a byte-identical unmanifested chunk after metadata failure and rejects conflicting retry bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-audio-append-retry-"));
    let failChunkMetadata = true;
    const failing = new FileAudioSessionStore(root, {
      metadataWriter: async (path, contents) => {
        const snapshot = JSON.parse(contents) as { chunks: unknown[] };
        if (snapshot.chunks.length === 1 && failChunkMetadata) {
          failChunkMetadata = false;
          throw new Error("simulated chunk metadata failure");
        }
        await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
      },
      now: () => "2026-07-16T00:00:00.000Z",
    });
    await failing.start({ sessionId, questionId });
    await expect(
      failing.appendChunk(sessionId, {
        sequence: 0,
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "audio/webm",
      }),
    ).rejects.toThrow(/simulated chunk metadata failure/i);
    expect(await failing.get(sessionId)).toMatchObject({
      nextSequence: 0,
      chunks: [],
    });

    const restarted = new FileAudioSessionStore(root, {
      now: () => "2026-07-16T00:01:00.000Z",
    });
    await expect(
      restarted.appendChunk(sessionId, {
        sequence: 0,
        bytes: new Uint8Array([9, 9, 9]),
        mimeType: "audio/webm",
      }),
    ).rejects.toBeInstanceOf(RawAudioChunkConflictError);
    expect((await restarted.get(sessionId)).nextSequence).toBe(0);

    await expect(
      restarted.appendChunk(sessionId, {
        sequence: 0,
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "audio/webm",
      }),
    ).resolves.toMatchObject({ sequence: 0, bytes: 3, durable: true });
    expect(await restarted.get(sessionId)).toMatchObject({
      nextSequence: 1,
      chunks: [{ sequence: 0, bytes: 3 }],
    });
  });

  it("fails closed after a crash publishes chunk metadata before validation", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ultradyn-audio-published-crash-"),
    );
    let crashAfterPublication = true;
    const crashing = new FileAudioSessionStore(root, {
      metadataWriter: async (path, contents) => {
        await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
        const snapshot = JSON.parse(contents) as { chunks: unknown[] };
        if (snapshot.chunks.length === 1 && crashAfterPublication) {
          crashAfterPublication = false;
          throw new Error("simulated crash after chunk metadata publication");
        }
      },
      now: () => "2026-07-17T00:00:00.000Z",
    });
    await crashing.start({ sessionId, questionId });
    await expect(
      crashing.appendChunk(sessionId, {
        sequence: 0,
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "audio/webm",
      }),
    ).rejects.toThrow(/crash after chunk metadata publication/i);

    const chunkPath = join(
      root,
      questionId,
      sessionId,
      "chunks",
      "000000.part",
    );
    await writeFile(chunkPath, new Uint8Array([9, 9, 9]));
    const restarted = new FileAudioSessionStore(root, {
      now: () => "2026-07-17T00:01:00.000Z",
    });

    await expect(restarted.get(sessionId)).rejects.toThrow(
      /audio chunk|changed|conflict|digest|integrity/i,
    );
    await expect(
      restarted.appendChunk(sessionId, {
        sequence: 0,
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "audio/webm",
      }),
    ).rejects.toThrow(/audio chunk|changed|conflict|digest|integrity/i);
    const rawRecord = JSON.parse(
      await readFile(join(root, questionId, sessionId, "session.json"), "utf8"),
    ) as { chunks: unknown[]; nextSequence: number };
    expect(rawRecord).toMatchObject({ nextSequence: 0, chunks: [] });
  });

  it("does not expose pending append metadata without its matching journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-audio-lost-intent-"));
    let crashAfterPublication = true;
    const crashing = new FileAudioSessionStore(root, {
      metadataWriter: async (path, contents) => {
        await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
        const snapshot = JSON.parse(contents) as {
          pendingAppend?: unknown;
        };
        if (snapshot.pendingAppend && crashAfterPublication) {
          crashAfterPublication = false;
          throw new Error("simulated crash with pending append metadata");
        }
      },
    });
    await crashing.start({ sessionId, questionId });
    await expect(
      crashing.appendChunk(sessionId, {
        sequence: 0,
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "audio/webm",
      }),
    ).rejects.toThrow(/pending append metadata/i);
    await rm(join(root, questionId, sessionId, "append-intent.json"));

    await expect(
      new FileAudioSessionStore(root).get(sessionId),
    ).rejects.toThrow(/pending append|matching journal/i);
  });

  it("refuses to read an append-intent journal through a symbolic link", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-audio-intent-link-"));
    const externalRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-audio-intent-link-external-"),
    );
    const store = new FileAudioSessionStore(root, {
      now: () => "2026-07-17T00:00:00.000Z",
    });
    await store.start({ sessionId, questionId });
    const externalJournal = join(externalRoot, "append-intent.json");
    await writeFile(externalJournal, "{}\n");
    await symlink(
      externalJournal,
      join(root, questionId, sessionId, "append-intent.json"),
    );

    await expect(store.get(sessionId)).rejects.toThrow(
      /symbolic link|no-follow/i,
    );
    await expect(readFile(externalJournal, "utf8")).resolves.toBe("{}\n");
  });

  it("does not let a forged post-ack journal roll back committed chunk metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-audio-forged-intent-"));
    const externalRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-audio-forged-intent-external-"),
    );
    const store = new FileAudioSessionStore(root, {
      now: () => "2026-07-17T00:00:00.000Z",
    });
    const prior = await store.start({ sessionId, questionId });
    await store.appendChunk(sessionId, {
      sequence: 0,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/webm",
    });
    const published = await store.get(sessionId);
    const directory = join(root, questionId, sessionId);
    const chunkPath = join(directory, "chunks", "000000.part");
    const externalChunk = join(externalRoot, "owner.part");
    await writeFile(externalChunk, new Uint8Array([1, 2, 3]));
    await rename(chunkPath, `${chunkPath}.committed`);
    await symlink(externalChunk, chunkPath);
    const operationId = createHash("sha256")
      .update(
        JSON.stringify({
          schemaVersion: 2,
          sessionId,
          prior,
          chunk: published.chunks.at(-1),
        }),
        "utf8",
      )
      .digest("hex");
    const forgedPublished = {
      ...published,
      pendingAppend: { operationId },
    };
    const forgedIntentBody = {
      schemaVersion: 2,
      operationId,
      sessionId,
      prior,
      published: forgedPublished,
      committed: published,
    };
    await writeFile(
      join(directory, "append-intent.json"),
      `${JSON.stringify(
        {
          ...forgedIntentBody,
          integritySha256: createHash("sha256")
            .update(JSON.stringify(forgedIntentBody), "utf8")
            .digest("hex"),
        },
        null,
        2,
      )}\n`,
    );

    await expect(store.get(sessionId)).rejects.toThrow(
      /audio chunk|symbolic link|integrity/i,
    );
    const durableRecord = JSON.parse(
      await readFile(join(directory, "session.json"), "utf8"),
    ) as { nextSequence: number; chunks: unknown[] };
    expect(durableRecord).toMatchObject({
      nextSequence: 1,
      chunks: [expect.any(Object)],
    });
    expect((await readFile(externalChunk)).equals(Buffer.from([1, 2, 3]))).toBe(
      true,
    );
  });

  it("refuses to adopt a byte-identical unmanifested chunk through a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-audio-symlink-"));
    const externalRoot = await mkdtemp(
      join(tmpdir(), "ultradyn-audio-symlink-external-"),
    );
    const externalChunk = join(externalRoot, "owner.part");
    await writeFile(externalChunk, new Uint8Array([1, 2, 3]));
    const store = new FileAudioSessionStore(root, {
      now: () => "2026-07-16T00:00:00.000Z",
    });
    await store.start({ sessionId, questionId });
    const chunksRoot = join(root, questionId, sessionId, "chunks");
    await mkdir(chunksRoot);
    await symlink(externalChunk, join(chunksRoot, "000000.part"));

    await expect(
      store.appendChunk(sessionId, {
        sequence: 0,
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "audio/webm",
      }),
    ).rejects.toThrow(/symbolic link|regular file|conflict/i);

    expect(await store.get(sessionId)).toMatchObject({
      nextSequence: 0,
      chunks: [],
    });
    await expect(readFile(externalChunk)).resolves.toEqual(
      Buffer.from([1, 2, 3]),
    );
  });

  it("rejects an existing FIFO promptly without blocking on open", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-audio-fifo-"));
    const store = new FileAudioSessionStore(root, {
      now: () => "2026-07-17T00:00:00.000Z",
    });
    await store.start({ sessionId, questionId });
    const chunksRoot = join(root, questionId, sessionId, "chunks");
    const chunkPath = join(chunksRoot, "000000.part");
    await mkdir(chunksRoot);
    await execFile("mkfifo", [chunkPath]);
    const moduleUrl = new URL("./audio-session.ts", import.meta.url).href;
    const childProgram = `
      import { FileAudioSessionStore } from ${JSON.stringify(moduleUrl)};
      const store = new FileAudioSessionStore(${JSON.stringify(root)}, {
        now: () => "2026-07-17T00:00:00.000Z",
      });
      try {
        await store.appendChunk(${JSON.stringify(sessionId)}, {
          sequence: 0,
          bytes: new Uint8Array([1, 2, 3]),
          mimeType: "audio/webm",
        });
        console.error("unexpected FIFO acknowledgement");
        process.exitCode = 3;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    `;
    /**
     * B002: the guarantee under test is that appendChunk REFUSES a FIFO instead
     * of blocking forever in open(). execFile's timeout + SIGKILL already proves
     * that: a blocking open() is killed, execFile rejects, and this test fails.
     *
     * The previous formulation also asserted a 2000ms wall-clock bound measured
     * around the spawn. That measured process startup plus an in-process
     * TypeScript transform, not open() behaviour, so it failed under concurrent
     * test load (observed at 2069ms and 2132ms) while the code was correct.
     * A test that fails for reasons unrelated to its subject teaches people to
     * re-run the suite, which is how real failures start getting ignored.
     *
     * BE PRECISE ABOUT THE TRADE: this is not purely a redundancy removal. The
     * old bound also asserted PROMPTNESS, and that coverage is gone — only
     * non-blocking is still enforced. That is deliberate: promptness measured
     * this way is a property of the machine's spare capacity, not of the code,
     * so the assertion could not distinguish a slow refusal from a busy CI box.
     * If a genuine latency budget for refusal is ever wanted, measure inside the
     * child around the appendChunk call itself, where no spawn or transform cost
     * is included — do not restore a bound around the spawn.
     *
     * The timeout is set well above load noise but below vitest's per-test
     * timeout, so a genuine hang still fails here rather than stalling the run.
     */
    const result = await execFile(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", childProgram],
      { timeout: 10_000, killSignal: "SIGKILL" },
    );

    expect(result.stderr).toMatch(/regular file/i);
    expect(result.stderr).not.toContain("unexpected FIFO acknowledgement");
  });

  it("rejects existing directory and socket chunk paths without acknowledging metadata", async () => {
    for (const kind of ["directory", "socket"] as const) {
      const root = await mkdtemp(join(tmpdir(), `ua-${kind[0]}-`));
      const store = new FileAudioSessionStore(root, {
        now: () => "2026-07-17T00:00:00.000Z",
      });
      await store.start({ sessionId, questionId });
      const chunksRoot = join(root, questionId, sessionId, "chunks");
      const chunkPath = join(chunksRoot, "000000.part");
      await mkdir(chunksRoot);
      let closeSocket: (() => Promise<void>) | undefined;
      if (kind === "directory") {
        await mkdir(chunkPath);
      } else {
        const server = createServer();
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(chunkPath, () => resolve());
        });
        closeSocket = () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
      }
      const special = await lstat(chunkPath);
      expect(
        kind === "directory" ? special.isDirectory() : special.isSocket(),
        `${kind} fixture`,
      ).toBe(true);

      try {
        const outcome = await store
          .appendChunk(sessionId, {
            sequence: 0,
            bytes: new Uint8Array([1, 2, 3]),
            mimeType: "audio/webm",
          })
          .catch((error: unknown) => error);
        expect(outcome, kind).toBeInstanceOf(Error);
        expect((outcome as Error).message, kind).toMatch(
          /regular file|device|socket|enxio|enodev/i,
        );
      } finally {
        await closeSocket?.();
      }
      expect(await store.get(sessionId)).toMatchObject({
        nextSequence: 0,
        chunks: [],
      });
    }
  });

  it("refuses to adopt a byte-identical path replacement after opening the original chunk", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-audio-swap-"));
    const chunkPath = join(
      root,
      questionId,
      sessionId,
      "chunks",
      "000000.part",
    );
    let swapped = false;
    const store = new FileAudioSessionStore(root, {
      onExistingChunkOpened: async (openedPath) => {
        if (openedPath !== chunkPath || swapped) return;
        swapped = true;
        await rename(chunkPath, `${chunkPath}.displaced`);
        await writeFile(chunkPath, new Uint8Array([1, 2, 3]));
      },
      now: () => "2026-07-16T00:00:00.000Z",
    });
    await store.start({ sessionId, questionId });
    await mkdir(join(root, questionId, sessionId, "chunks"));
    await writeFile(chunkPath, new Uint8Array([1, 2, 3]));

    await expect(
      store.appendChunk(sessionId, {
        sequence: 0,
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "audio/webm",
      }),
    ).rejects.toThrow(/changed|replacement|conflict/i);

    expect(swapped).toBe(true);
    expect(await store.get(sessionId)).toMatchObject({
      nextSequence: 0,
      chunks: [],
    });
  });

  it("does not acknowledge an inspected chunk replaced during metadata publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-audio-publish-swap-"));
    const chunkPath = join(
      root,
      questionId,
      sessionId,
      "chunks",
      "000000.part",
    );
    const displacedPath = `${chunkPath}.inspected`;
    let swappedDuringPublication = false;
    const store = new FileAudioSessionStore(root, {
      metadataWriter: async (path, contents) => {
        const snapshot = JSON.parse(contents) as { chunks: unknown[] };
        if (snapshot.chunks.length === 1 && !swappedDuringPublication) {
          swappedDuringPublication = true;
          await rename(chunkPath, displacedPath);
          await writeFile(chunkPath, new Uint8Array([9, 9, 9]));
        }
        await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
      },
      now: () => "2026-07-17T00:00:00.000Z",
    });
    await store.start({ sessionId, questionId });
    await mkdir(join(root, questionId, sessionId, "chunks"));
    await writeFile(chunkPath, new Uint8Array([1, 2, 3]));

    const outcome = await store
      .appendChunk(sessionId, {
        sequence: 0,
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "audio/webm",
      })
      .catch((error: unknown) => error);
    const restarted = new FileAudioSessionStore(root, {
      now: () => "2026-07-17T00:01:00.000Z",
    });
    const recovered = await restarted.get(sessionId);

    expect(swappedDuringPublication).toBe(true);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/changed|replaced|inode/i);
    expect(recovered).toMatchObject({ nextSequence: 0, chunks: [] });
    await expect(readFile(displacedPath)).resolves.toEqual(
      Buffer.from([1, 2, 3]),
    );
    await expect(readFile(chunkPath)).resolves.toEqual(Buffer.from([9, 9, 9]));
  });

  it("rechecks a large recovered chunk pathname after the final descriptor read", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ultradyn-audio-final-read-swap-"),
    );
    const chunksRoot = join(root, questionId, sessionId, "chunks");
    const chunkPath = join(chunksRoot, "000000.part");
    const displacedPath = `${chunkPath}.inspected`;
    const replacementPath = `${chunkPath}.replacement`;
    const inspectedBytes = Buffer.alloc(8 * 1024 * 1024, 0x11);
    const replacementBytes = Buffer.alloc(inspectedBytes.byteLength, 0x22);
    const store = new FileAudioSessionStore(root, {
      now: () => "2026-07-17T00:00:00.000Z",
    });
    await store.start({ sessionId, questionId });
    await mkdir(chunksRoot);
    await writeFile(chunkPath, inspectedBytes);
    await writeFile(replacementPath, replacementBytes);

    const probe = await open(chunkPath, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      read: typeof probe.read;
    };
    const originalRead = prototype.read;
    const invokeOriginalRead = originalRead as unknown as (
      this: typeof probe,
      ...args: unknown[]
    ) => Promise<unknown>;
    await probe.close();
    let matchingReads = 0;
    let swappedAfterFinalRead = false;
    prototype.read = async function (this: typeof probe, ...args: unknown[]) {
      const result = await invokeOriginalRead.apply(this, args);
      if (args[2] === inspectedBytes.byteLength) {
        matchingReads += 1;
        if (matchingReads === 2) {
          await rename(chunkPath, displacedPath);
          await rename(replacementPath, chunkPath);
          swappedAfterFinalRead = true;
        }
      }
      return result;
    } as typeof probe.read;

    try {
      await expect(
        store.appendChunk(sessionId, {
          sequence: 0,
          bytes: inspectedBytes,
          mimeType: "audio/webm",
        }),
      ).rejects.toThrow(/changed|replaced|pathname|inode/i);
    } finally {
      prototype.read = originalRead;
    }

    expect(swappedAfterFinalRead).toBe(true);
    expect(await store.get(sessionId)).toMatchObject({
      nextSequence: 0,
      chunks: [],
    });
    expect((await readFile(displacedPath)).equals(inspectedBytes)).toBe(true);
    expect((await readFile(chunkPath)).equals(replacementBytes)).toBe(true);
  });

  it("makes the final pathname observation after the fifth descriptor stat", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultradyn-audio-fifth-stat-"));
    const chunksRoot = join(root, questionId, sessionId, "chunks");
    const chunkPath = join(chunksRoot, "000000.part");
    const displacedPath = `${chunkPath}.inspected`;
    const replacementPath = `${chunkPath}.replacement`;
    const inspectedBytes = Buffer.from([1, 2, 3]);
    const replacementBytes = Buffer.from([9, 9, 9]);
    const store = new FileAudioSessionStore(root, {
      now: () => "2026-07-17T00:00:00.000Z",
    });
    await store.start({ sessionId, questionId });
    await mkdir(chunksRoot);
    await writeFile(chunkPath, inspectedBytes);
    await writeFile(replacementPath, replacementBytes);
    const inspectedIdentity = await lstat(chunkPath);

    const probe = await open(chunkPath, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      stat: typeof probe.stat;
    };
    const originalStat = prototype.stat;
    const invokeOriginalStat = originalStat as unknown as (
      this: typeof probe,
      ...args: unknown[]
    ) => Promise<Awaited<ReturnType<typeof probe.stat>>>;
    await probe.close();
    let matchingStats = 0;
    let swappedAtFifthStat = false;
    prototype.stat = async function (this: typeof probe, ...args: unknown[]) {
      const result = await invokeOriginalStat.apply(this, args);
      if (
        result.dev === inspectedIdentity.dev &&
        result.ino === inspectedIdentity.ino
      ) {
        matchingStats += 1;
        if (matchingStats === 5) {
          await rename(chunkPath, displacedPath);
          await rename(replacementPath, chunkPath);
          swappedAtFifthStat = true;
        }
      }
      return result;
    } as typeof probe.stat;

    try {
      await expect(
        store.appendChunk(sessionId, {
          sequence: 0,
          bytes: inspectedBytes,
          mimeType: "audio/webm",
        }),
      ).rejects.toThrow(/changed|replaced|pathname|inode/i);
    } finally {
      prototype.stat = originalStat;
    }

    expect(swappedAtFifthStat).toBe(true);
    expect(await store.get(sessionId)).toMatchObject({
      nextSequence: 0,
      chunks: [],
    });
    expect((await readFile(displacedPath)).equals(inspectedBytes)).toBe(true);
    expect((await readFile(chunkPath)).equals(replacementBytes)).toBe(true);
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
