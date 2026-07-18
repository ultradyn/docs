import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  Sha256,
  SourceFile,
  SourceSnapshot,
} from "../../domain/ingest/index.js";
import {
  ReplayCapsuleStore,
  deriveSourceSnapshotIdentity,
  type HashService,
  type RawArtifactStore,
  type SourceByteReader,
} from "../index.js";

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function digest(bytes: Uint8Array): Sha256 {
  return createHash("sha256").update(bytes).digest("hex") as Sha256;
}

const hashes: HashService = {
  sha256: (bytes) => Promise.resolve(digest(bytes)),
};

/**
 * Append-only store: an existing path may be rewritten only with identical
 * bytes, and there is deliberately no removal operation to model against.
 */
class MemoryRawArtifactStore implements RawArtifactStore {
  readonly artifacts = new Map<string, Uint8Array>();
  readonly operations: string[] = [];
  rejectOverwriteAt?: string;
  dropWriteAt?: string;
  corruptWriteAt?: string;
  swapAfterFirstRead?: string;
  #readCounts = new Map<string, number>();

  /** Arms the swap and forgets earlier reads, so counting starts from now. */
  armSwapAfterFirstRead(path: string): void {
    this.swapAfterFirstRead = path;
    this.#readCounts.clear();
  }
  interleavePublishes = false;
  corruptCustodyOnPublishConflict = false;
  #releaseFirstPublish?: () => void;
  #firstPublishWaiting?: Promise<void>;

  /** publish() reports success while betraying the final path. */
  publishLie?: { path: string; mode: "drop" | "corrupt" | "substitute" };

  /**
   * Test-only removal attempt, deliberately OUTSIDE RawArtifactStore and
   * ReplayCapsuleStore: an append-only store refuses removal, so this reports
   * IMMUTABLE_RAW_ARTIFACT and leaves the bytes bit-identical.
   */
  attemptUnlink(path: string): {
    ok: false;
    code: "IMMUTABLE_RAW_ARTIFACT" | "NOT_FOUND";
  } {
    // Append-only: a retained path refuses removal; an absent path is
    // distinguishable, so a passing test cannot be a constant.
    return this.artifacts.has(path)
      ? { ok: false, code: "IMMUTABLE_RAW_ARTIFACT" }
      : { ok: false, code: "NOT_FOUND" };
  }

  async read(path: string): Promise<Uint8Array | undefined> {
    this.operations.push(`read:${path}`);
    const seen = (this.#readCounts.get(path) ?? 0) + 1;
    this.#readCounts.set(path, seen);
    const bytes = this.artifacts.get(path)?.slice();
    // Any read after the first returns different bytes, so a second traversal
    // is detectable from public results alone.
    if (bytes && path === this.swapAfterFirstRead && seen > 1) {
      return text("swapped-on-second-read");
    }
    return bytes;
  }

  async write(
    path: string,
    bytes: Uint8Array,
  ): Promise<"written" | "identical" | "conflict"> {
    this.operations.push(`write:${path}`);
    if (path === this.rejectOverwriteAt) return "conflict";
    const existing = this.artifacts.get(path);
    if (existing !== undefined) {
      return Buffer.from(existing).equals(bytes) ? "identical" : "conflict";
    }
    // Acknowledge the write while dropping or corrupting it, as a lying
    // filesystem would.
    if (path === this.dropWriteAt) return "written";
    this.artifacts.set(
      path,
      path === this.corruptWriteAt ? text("corrupt") : bytes.slice(),
    );
    return "written";
  }

  async fsync(path: string): Promise<void> {
    this.operations.push(`fsync:${path}`);
  }

  async publish(
    source: string,
    finalPath: string,
  ): Promise<"published" | "conflict"> {
    this.operations.push(`publish:${source}->${finalPath}`);
    if (this.interleavePublishes) {
      if (this.#firstPublishWaiting === undefined) {
        this.#firstPublishWaiting = new Promise<void>((resolve) => {
          this.#releaseFirstPublish = resolve;
        });
        await this.#firstPublishWaiting;
      } else {
        this.#releaseFirstPublish?.();
      }
    }
    const staged = this.artifacts.get(source);
    if (staged === undefined) return "conflict";
    const existing = this.artifacts.get(finalPath);
    if (existing !== undefined) {
      if (this.corruptCustodyOnPublishConflict) {
        const custody = [...this.artifacts.keys()].find((path) =>
          path.startsWith("replay-capsules/blobs/"),
        );
        if (custody !== undefined)
          this.artifacts.set(custody, text("tampered"));
      }
      // Final publication is exclusive even for byte-identical staged input.
      return "conflict";
    }
    if (this.publishLie?.path === finalPath) {
      const { mode } = this.publishLie;
      // Acknowledge the publish, then betray the final path.
      if (mode === "corrupt") this.artifacts.set(finalPath, text("corrupt"));
      if (mode === "substitute") {
        this.artifacts.set(finalPath, text('{"schemaVersion":1}\n'));
      }
      return "published";
    }
    this.artifacts.set(finalPath, staged.slice());
    return "published";
  }
}

/** The transient upload area a capsule is sealed from; may vanish afterwards. */
class MemorySourceByteReader implements SourceByteReader {
  readonly files = new Map<string, Uint8Array>();
  failEveryRead = false;
  failAt?: "package" | "file";
  failAtFileId?: string | undefined;
  mutateAfterRead = false;
  recordHandedOut?: Uint8Array[];
  #package: Uint8Array | undefined;

  setPackage(bytes: Uint8Array): void {
    this.#package = bytes;
  }

  setFile(id: string, bytes: Uint8Array): void {
    this.files.set(id, bytes);
  }

  /** Simulates loss of the original upload after sealing. */
  discardUpload(): void {
    this.files.clear();
    this.#package = undefined;
  }

  readPackage(): Promise<Uint8Array | undefined> {
    if (this.failEveryRead || this.failAt === "package") {
      throw new Error("upload reader is unavailable");
    }
    const bytes = this.#package?.slice();
    if (bytes) this.recordHandedOut?.push(bytes);
    return Promise.resolve(bytes);
  }

  readFile(file: SourceFile): Promise<Uint8Array | undefined> {
    if (
      this.failEveryRead ||
      this.failAt === "file" ||
      this.failAtFileId === file.id
    ) {
      throw new Error("upload reader is unavailable");
    }
    const bytes = this.files.get(file.id)?.slice();
    if (bytes) this.recordHandedOut?.push(bytes);
    if (bytes && this.mutateAfterRead) {
      // Hand back a buffer we keep scribbling on.
      queueMicrotask(() => bytes.fill(0));
    }
    return Promise.resolve(bytes);
  }
}

const FIRST_FILE_BYTES = text("# readme\n");
const SECOND_FILE_BYTES = text("body text\n");
const PACKAGE_BYTES = text("package-archive-bytes");
const POLICY_ID = "policy-internal-docs";

/**
 * Fixtures derive their identities with the same canonical helpers the
 * snapshot plane qualifies with, so a test snapshot is content-bound by
 * construction rather than by hand-copied digest rules that could drift.
 */
async function buildSnapshot(
  overrides: { policyId?: string } = {},
): Promise<SourceSnapshot> {
  const policyId = overrides.policyId ?? POLICY_ID;
  const bare = [
    {
      schemaVersion: 1 as const,
      logicalPath: "docs/readme.md",
      mediaType: "text/markdown",
      size: FIRST_FILE_BYTES.byteLength,
      sha256: digest(FIRST_FILE_BYTES),
    },
    {
      schemaVersion: 1 as const,
      logicalPath: "docs/body.md",
      mediaType: "text/markdown",
      size: SECOND_FILE_BYTES.byteLength,
      sha256: digest(SECOND_FILE_BYTES),
    },
  ];
  const packageSha256 = digest(PACKAGE_BYTES);
  const {
    contentSha256,
    snapshotId: id,
    files,
  } = await deriveSourceSnapshotIdentity(hashes, {
    packageSha256,
    policyId,
    files: bare,
    exclusions: [],
  });
  return {
    schemaVersion: 1,
    id,
    packageSha256,
    contentSha256,
    policyId,
    files,
    exclusions: [],
    qualified: true,
  };
}

const SNAPSHOT = await buildSnapshot();
const SNAPSHOT_ID = SNAPSHOT.id;
const FIRST_FILE = SNAPSHOT.files[0]!;
const SECOND_FILE = SNAPSHOT.files[1]!;

function harness(snapshot: SourceSnapshot = SNAPSHOT): {
  store: MemoryRawArtifactStore;
  source: MemorySourceByteReader;
  capsules: ReplayCapsuleStore;
} {
  const store = new MemoryRawArtifactStore();
  const source = new MemorySourceByteReader();
  source.setPackage(PACKAGE_BYTES);
  source.setFile(snapshot.files[0]!.id, FIRST_FILE_BYTES);
  source.setFile(snapshot.files[1]!.id, SECOND_FILE_BYTES);
  return {
    store,
    source,
    capsules: new ReplayCapsuleStore({ store, hashes, source }),
  };
}

describe("ReplayCapsuleStore custody", () => {
  it("seals a content-addressed capsule and verifies every file hash", async () => {
    const { capsules, store } = harness();

    const sealed = await capsules.seal(SNAPSHOT);
    expect(sealed.ok).toBe(true);
    if (sealed.ok) {
      expect(sealed.value).toEqual({
        snapshotId: SNAPSHOT_ID,
        packageSha256: SNAPSHOT.packageSha256,
        filesVerified: 2,
        verified: true,
      });
    }

    // Custody is self-describing: each blob lives at the address of its own
    // digest, so a path fully determines its contents.
    for (const [file, bytes] of [
      [FIRST_FILE, FIRST_FILE_BYTES],
      [SECOND_FILE, SECOND_FILE_BYTES],
    ] as const) {
      const retained = store.artifacts.get(
        `replay-capsules/blobs/${file.sha256}.raw`,
      );
      expect(
        retained,
        `no blob retained for ${file.logicalPath}`,
      ).toBeDefined();
      if (retained) expect(digest(retained)).toBe(digest(bytes));
    }
    expect(
      store.artifacts.get(
        `replay-capsules/blobs/${SNAPSHOT.packageSha256}.raw`,
      ),
    ).toBeDefined();

    const verified = await capsules.verify(SNAPSHOT_ID);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.value.filesVerified).toBe(2);
  });

  it("replays retained bytes after the original upload is removed", async () => {
    const { capsules, source } = harness();
    expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

    source.discardUpload();

    const verified = await capsules.verify(SNAPSHOT_ID);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.value).toEqual({
        snapshotId: SNAPSHOT_ID,
        packageSha256: SNAPSHOT.packageSha256,
        filesVerified: 2,
        verified: true,
      });
    }

    const exported = await capsules.export(
      SNAPSHOT_ID,
      new MemoryRawArtifactStore(),
    );
    expect(exported.ok).toBe(true);
    if (exported.ok) expect(exported.value.filesVerified).toBe(2);
  });

  it("refuses promotion until a passing replay receipt exists", async () => {
    const { capsules } = harness();

    const unsealed = await capsules.authorisePromotion(SNAPSHOT_ID);
    expect(unsealed.ok).toBe(false);
    if (!unsealed.ok) expect(unsealed.code).toBe("REPLAY_UNVERIFIED");

    expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

    const authorised = await capsules.authorisePromotion(SNAPSHOT_ID);
    expect(authorised.ok).toBe(true);
    if (authorised.ok) expect(authorised.value.verified).toBe(true);
  });

  it("refuses promotion when retained bytes no longer match their digest", async () => {
    const { capsules, store } = harness();
    expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

    const blob = [...store.artifacts.keys()].find((path) =>
      path.includes(FIRST_FILE.sha256),
    );
    expect(blob).toBeDefined();
    if (blob) store.artifacts.set(blob, text("tampered"));

    const verified = await capsules.verify(SNAPSHOT_ID);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.code).toBe("DIGEST_MISMATCH");

    const promotion = await capsules.authorisePromotion(SNAPSHOT_ID);
    expect(promotion.ok).toBe(false);
    if (!promotion.ok) expect(promotion.code).toBe("DIGEST_MISMATCH");
  });

  it("reports IMMUTABLE_RAW_ARTIFACT when custody bytes would be overwritten", async () => {
    const { capsules, store } = harness();
    store.rejectOverwriteAt = `replay-capsules/blobs/${FIRST_FILE.sha256}.raw`;

    const sealed = await capsules.seal(SNAPSHOT);
    expect(sealed.ok).toBe(false);
    if (!sealed.ok) expect(sealed.code).toBe("IMMUTABLE_RAW_ARTIFACT");
  });

  it("re-sealing an identical snapshot is idempotent, not a conflict", async () => {
    const { capsules } = harness();
    const first = await capsules.seal(SNAPSHOT);
    const second = await capsules.seal(SNAPSHOT);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.value).toEqual(first.value);
  });

  it("adopts the verified winner when concurrent identical seals race for exclusive publication", async () => {
    const { store, source } = harness();
    store.interleavePublishes = true;
    const first = new ReplayCapsuleStore({ store, hashes, source });
    const second = new ReplayCapsuleStore({ store, hashes, source });

    const results = await Promise.all([
      first.seal(SNAPSHOT),
      second.seal(SNAPSHOT),
    ]);

    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual({
      ok: true,
      value: {
        snapshotId: SNAPSHOT_ID,
        packageSha256: SNAPSHOT.packageSha256,
        filesVerified: 2,
        verified: true,
      },
    });
  });

  it("does not issue a receipt when custody is corrupted during conflicting winner adoption", async () => {
    const { store, source } = harness();
    store.interleavePublishes = true;
    store.corruptCustodyOnPublishConflict = true;
    const first = new ReplayCapsuleStore({ store, hashes, source });
    const second = new ReplayCapsuleStore({ store, hashes, source });

    const results = await Promise.all([
      first.seal(SNAPSHOT),
      second.seal(SNAPSHOT),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ ok: false }),
      expect.objectContaining({ ok: false }),
    ]);
  });

  it("exposes retention metadata without any expiry authority", async () => {
    const { capsules } = harness();
    expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

    const retention = await capsules.retention(SNAPSHOT_ID);
    expect(retention.ok).toBe(true);
    if (retention.ok) {
      expect(retention.value).toEqual({
        snapshotId: SNAPSHOT_ID,
        fileCount: 2,
        // Package plus every file; the capsule marker is deliberately not
        // counted as retained source content.
        retainedBytes:
          PACKAGE_BYTES.byteLength +
          FIRST_FILE_BYTES.byteLength +
          SECOND_FILE_BYTES.byteLength,
        policy: "retain-indefinitely",
        deletionAuthorised: false,
      });
    }
  });

  it("refuses upload bytes whose package digest is not the snapshot's", async () => {
    const { capsules, source, store } = harness();
    source.setPackage(text("a different archive"));

    const sealed = await capsules.seal(SNAPSHOT);
    expect(sealed.ok).toBe(false);
    if (!sealed.ok) expect(sealed.code).toBe("DIGEST_MISMATCH");
    // Nothing may be marked as custody when the package failed its binding.
    expect(
      [...store.artifacts.keys()].some((path) => path.endsWith("capsule.json")),
    ).toBe(false);
  });

  it("cannot produce a verified receipt behind a silently dropped write", async () => {
    const { capsules, store } = harness();
    store.dropWriteAt = `replay-capsules/blobs/${SECOND_FILE.sha256}.raw`;

    const sealed = await capsules.seal(SNAPSHOT);
    expect(sealed.ok).toBe(false);

    // The capsule marker must not exist, so a later verify cannot adopt a
    // half-retained capsule as replayable custody.
    expect(
      [...store.artifacts.keys()].some((path) => path.endsWith("capsule.json")),
    ).toBe(false);
    const verified = await capsules.verify(SNAPSHOT_ID);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.code).toBe("CAPSULE_NOT_FOUND");
  });

  it("cannot produce a verified receipt behind a silently corrupted write", async () => {
    const { capsules, store } = harness();
    store.corruptWriteAt = `replay-capsules/blobs/${SECOND_FILE.sha256}.raw`;

    const sealed = await capsules.seal(SNAPSHOT);
    expect(sealed.ok).toBe(false);
    if (!sealed.ok) expect(sealed.code).toBe("DIGEST_MISMATCH");
    expect(
      [...store.artifacts.keys()].some((path) => path.endsWith("capsule.json")),
    ).toBe(false);
  });

  it("cannot issue a receipt when the staged capsule marker is corrupt", async () => {
    const { capsules, store } = harness();
    store.corruptWriteAt = `replay-capsules/${SNAPSHOT_ID}/.staged/capsule.json`;

    const sealed = await capsules.seal(SNAPSHOT);
    expect(sealed.ok).toBe(false);
    if (!sealed.ok) expect(sealed.code).toBe("PARTIAL_WRITE");
  });

  it("rejects a snapshot whose id does not match its own content", async () => {
    const { capsules, source } = harness();
    expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

    const rebound = {
      ...SNAPSHOT,
      policyId: "policy-rebound",
    } satisfies SourceSnapshot;
    source.setPackage(PACKAGE_BYTES);
    source.setFile(FIRST_FILE.id, FIRST_FILE_BYTES);
    source.setFile(SECOND_FILE.id, SECOND_FILE_BYTES);

    const second = await capsules.seal(rebound);
    // Changing policy changes the content digest, so the supplied id is no
    // longer content-bound. That is caught before any custody write, which is
    // strictly earlier and more precise than a storage-level conflict.
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("DIGEST_MISMATCH");
  });

  it("never consults the upload reader outside seal", async () => {
    const { capsules, source } = harness();
    expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

    source.failEveryRead = true;
    expect((await capsules.verify(SNAPSHOT_ID)).ok).toBe(true);
    expect((await capsules.retention(SNAPSHOT_ID)).ok).toBe(true);
    expect((await capsules.authorisePromotion(SNAPSHOT_ID)).ok).toBe(true);
    expect(
      (await capsules.export(SNAPSHOT_ID, new MemoryRawArtifactStore())).ok,
    ).toBe(true);
  });

  it("refuses export when the destination capsule marker cannot be re-read", async () => {
    const { capsules } = harness();
    expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

    const destination = new MemoryRawArtifactStore();
    destination.corruptWriteAt = `replay-capsules/${SNAPSHOT_ID}/.staged/capsule.json`;

    const exported = await capsules.export(SNAPSHOT_ID, destination);
    expect(exported.ok).toBe(false);
    if (!exported.ok) expect(exported.code).toBe("PARTIAL_WRITE");
  });

  it.each(["drop", "corrupt", "substitute"] as const)(
    "refuses a receipt when publish lies by %s on the final marker",
    async (mode) => {
      const { capsules, store } = harness();
      store.publishLie = {
        path: `replay-capsules/${SNAPSHOT_ID}/capsule.json`,
        mode,
      };

      const sealed = await capsules.seal(SNAPSHOT);
      expect(sealed.ok).toBe(false);
      if (!sealed.ok) {
        expect(["PARTIAL_WRITE", "CAPSULE_CORRUPT"]).toContain(sealed.code);
      }
      // And nothing may later treat the betrayed marker as valid custody.
      expect((await capsules.verify(SNAPSHOT_ID)).ok).toBe(false);
    },
  );

  it.each(["drop", "corrupt", "substitute"] as const)(
    "refuses an export when the destination publish lies by %s",
    async (mode) => {
      const { capsules } = harness();
      expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

      const destination = new MemoryRawArtifactStore();
      destination.publishLie = {
        path: `replay-capsules/${SNAPSHOT_ID}/capsule.json`,
        mode,
      };
      const exported = await capsules.export(SNAPSHOT_ID, destination);
      expect(exported.ok).toBe(false);
      if (!exported.ok) {
        expect(["PARTIAL_WRITE", "CAPSULE_CORRUPT"]).toContain(exported.code);
      }
    },
  );

  it.each(["drop", "corrupt"] as const)(
    "refuses an export when a destination blob is %s",
    async (mode) => {
      const { capsules } = harness();
      expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

      const destination = new MemoryRawArtifactStore();
      const blob = `replay-capsules/blobs/${FIRST_FILE.sha256}.raw`;
      if (mode === "drop") destination.dropWriteAt = blob;
      else destination.corruptWriteAt = blob;

      const exported = await capsules.export(SNAPSHOT_ID, destination);
      expect(exported.ok).toBe(false);
      if (!exported.ok) expect(exported.code).toBe("DIGEST_MISMATCH");
    },
  );

  // The tamper matrix edits a decoded manifest as loosely-typed JSON.
  interface TamperTarget {
    snapshot: {
      id: string;
      contentSha256: string;
      policyId: string;
      files: { logicalPath: string; size: number }[];
      exclusions: {
        logicalPath: string;
        mediaType: string;
        size: number;
        reason: string;
      }[];
    };
  }

  it.each([
    ["omits a file", (m: TamperTarget) => m.snapshot.files.pop()],
    [
      "changes snapshotId",
      (m: TamperTarget) => (m.snapshot.id = `snap-${"b".repeat(64)}`),
    ],
    [
      "changes contentSha",
      (m: TamperTarget) => (m.snapshot.contentSha256 = "c".repeat(64)),
    ],
    [
      "changes policy",
      (m: TamperTarget) => (m.snapshot.policyId = "policy-tampered"),
    ],
    [
      "changes a path",
      (m: TamperTarget) => (m.snapshot.files[0]!.logicalPath = "docs/moved.md"),
    ],
    [
      "adds an exclusion",
      (m: TamperTarget) =>
        m.snapshot.exclusions.push({
          logicalPath: "x",
          mediaType: "text/plain",
          size: 1,
          reason: "injected",
        }),
    ],
    [
      "changes file metadata",
      (m: TamperTarget) => (m.snapshot.files[0]!.size = 9999),
    ],
  ])("treats a manifest that %s as corrupt", async (_label, tamper) => {
    const { capsules, store } = harness();
    expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

    const path = `replay-capsules/${SNAPSHOT_ID}/capsule.json`;
    const manifest = JSON.parse(
      new TextDecoder().decode(store.artifacts.get(path)!),
    ) as TamperTarget;
    tamper(manifest);
    store.artifacts.set(
      path,
      new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
    );

    const verified = await capsules.verify(SNAPSHOT_ID);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.code).toBe("CAPSULE_CORRUPT");
    const promotion = await capsules.authorisePromotion(SNAPSHOT_ID);
    expect(promotion.ok).toBe(false);
  });

  it("rejects a non-canonical but semantically equal manifest", async () => {
    const { capsules, store } = harness();
    expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

    const path = `replay-capsules/${SNAPSHOT_ID}/capsule.json`;
    const manifest = JSON.parse(
      new TextDecoder().decode(store.artifacts.get(path)!),
    ) as Record<string, unknown>;
    // Same content, non-canonical encoding (compact whitespace).
    store.artifacts.set(
      path,
      new TextEncoder().encode(JSON.stringify(manifest)),
    );

    const verified = await capsules.verify(SNAPSHOT_ID);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.code).toBe("CAPSULE_CORRUPT");
  });

  it("rejects a snapshot carrying unknown fields before any custody write", async () => {
    const { capsules, store } = harness();
    const sealed = await capsules.seal({
      ...SNAPSHOT,
      injected: true,
    } as unknown as SourceSnapshot);
    expect(sealed.ok).toBe(false);
    if (!sealed.ok) expect(sealed.code).toBe("INVALID_SNAPSHOT");
    expect(store.artifacts.size).toBe(0);
  });

  it("reseals idempotently for a semantically identical object in another key order", async () => {
    const { capsules } = harness();
    expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

    // Same values, different insertion order: canonicalisation must absorb it.
    const reordered = {
      qualified: true,
      exclusions: SNAPSHOT.exclusions,
      files: SNAPSHOT.files.map((file) => ({
        sha256: file.sha256,
        size: file.size,
        mediaType: file.mediaType,
        logicalPath: file.logicalPath,
        snapshotId: file.snapshotId,
        id: file.id,
        schemaVersion: file.schemaVersion,
      })),
      policyId: SNAPSHOT.policyId,
      contentSha256: SNAPSHOT.contentSha256,
      packageSha256: SNAPSHOT.packageSha256,
      id: SNAPSHOT.id,
      schemaVersion: SNAPSHOT.schemaVersion,
    } as SourceSnapshot;
    const resealed = await capsules.seal(reordered);
    expect(resealed.ok).toBe(true);
  });

  it.each(["package", "file"] as const)(
    "returns a typed failure when the %s reader throws",
    async (position) => {
      const { capsules, source, store } = harness();
      source.failAt = position;

      const sealed = await capsules.seal(SNAPSHOT);
      expect(sealed.ok).toBe(false);
      if (!sealed.ok) expect(sealed.code).toBe("SOURCE_UNAVAILABLE");
      expect(
        [...store.artifacts.keys()].some((p) => p.endsWith("capsule.json")),
      ).toBe(false);
    },
  );

  it("ignores caller mutation of the snapshot after validation", async () => {
    const { capsules, store } = harness();
    const mutable: SourceSnapshot = {
      ...SNAPSHOT,
      files: SNAPSHOT.files.map((file) => ({ ...file })),
      exclusions: [...SNAPSHOT.exclusions],
    };

    const sealing = capsules.seal(mutable);
    // Mutate the caller's object while seal is mid-flight.
    (mutable.files as SourceFile[]).pop();
    (mutable as { policyId: string }).policyId = "policy-swapped";

    const sealed = await sealing;
    expect(sealed.ok).toBe(true);
    // Custody reflects the validated clone, not the mutated caller object.
    if (sealed.ok) expect(sealed.value.filesVerified).toBe(2);
    expect(
      store.artifacts.get(`replay-capsules/blobs/${SECOND_FILE.sha256}.raw`),
    ).toBeDefined();
    const verified = await capsules.verify(SNAPSHOT_ID);
    expect(verified.ok).toBe(true);
  });

  it("fails closed when a reader mutates at handoff, before any copy", async () => {
    const { capsules, store, source } = harness();
    // The reader keeps ownership and zeroes the buffer in the same microtask
    // turn as its return. A caller-side copy cannot win that race, so the
    // guarantee is not "absorb it" but "never let it poison custody": the
    // digest check must reject the bytes and write no marker.
    source.mutateAfterRead = true;

    const sealed = await capsules.seal(SNAPSHOT);
    expect(sealed.ok).toBe(false);
    if (!sealed.ok) expect(sealed.code).toBe("DIGEST_MISMATCH");
    expect(
      [...store.artifacts.keys()].some((p) => p.endsWith("capsule.json")),
    ).toBe(false);

    // Once the reader behaves, the same snapshot seals cleanly.
    source.mutateAfterRead = false;
    expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);
    const retained = store.artifacts.get(
      `replay-capsules/blobs/${FIRST_FILE.sha256}.raw`,
    );
    expect(retained && digest(retained)).toBe(FIRST_FILE.sha256);
  });

  // handedOut order is package, first file, later file - so each case targets a
  // distinct buffer and none of them is merely the one that happens to exist
  // first during sequential sealing.
  it.each([
    ["package", 0],
    ["first file", 1],
    ["later file", 2],
  ] as const)(
    "keeps custody stable when the %s buffer is mutated after settlement",
    async (_label, target) => {
      const handedOut: Uint8Array[] = [];
      const store = new MemoryRawArtifactStore();
      const source = new MemorySourceByteReader();
      source.setPackage(PACKAGE_BYTES);
      source.setFile(FIRST_FILE.id, FIRST_FILE_BYTES);
      source.setFile(SECOND_FILE.id, SECOND_FILE_BYTES);
      source.recordHandedOut = handedOut;

      // Hashing is delayed, so the mutation lands after THIS target's promise
      // has settled while seal is still in flight. A borrowed-buffer
      // implementation would retain the zeroed bytes; an immediate-copy
      // implementation is unaffected.
      let mutated = false;
      const delayedHashes: HashService = {
        sha256: async (bytes) => {
          const settled = handedOut[target];
          if (!mutated && settled !== undefined) {
            mutated = true;
            settled.fill(0);
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
          return digest(bytes);
        },
      };

      const capsules = new ReplayCapsuleStore({
        store,
        hashes: delayedHashes,
        source,
      });
      const sealed = await capsules.seal(SNAPSHOT);
      // The targeted buffer really was handed out and really was zeroed.
      expect(mutated).toBe(true);
      expect(handedOut[target]!.every((byte) => byte === 0)).toBe(true);
      expect(sealed.ok).toBe(true);

      // Custody holds the ORIGINAL bytes for every artifact, including the
      // mutated one.
      const expected: readonly (readonly [Sha256, Uint8Array])[] = [
        [SNAPSHOT.packageSha256, PACKAGE_BYTES],
        [FIRST_FILE.sha256, FIRST_FILE_BYTES],
        [SECOND_FILE.sha256, SECOND_FILE_BYTES],
      ];
      for (const [sha256, bytes] of expected) {
        const retained = store.artifacts.get(
          `replay-capsules/blobs/${sha256}.raw`,
        );
        expect(retained).toBeDefined();
        if (retained) expect(digest(retained)).toBe(digest(bytes));
      }
      expect((await capsules.verify(SNAPSHOT_ID)).ok).toBe(true);
    },
  );

  it("reads each retained blob once during retention", async () => {
    const { capsules, store } = harness();
    expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

    // Bytes change between a first and any second read. A single-traversal
    // retention never observes the swap; a two-pass one would.
    store.armSwapAfterFirstRead(
      `replay-capsules/blobs/${SECOND_FILE.sha256}.raw`,
    );
    const retention = await capsules.retention(SNAPSHOT_ID);
    expect(retention.ok).toBe(true);
    if (retention.ok) {
      expect(retention.value.retainedBytes).toBe(
        PACKAGE_BYTES.byteLength +
          FIRST_FILE_BYTES.byteLength +
          SECOND_FILE_BYTES.byteLength,
      );
    }
  });

  it.each(["missing", "truncated", "corrupt"] as const)(
    "refuses retention when a later retained file is %s",
    async (mode) => {
      const { capsules, store } = harness();
      expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

      // Target the LATER file specifically, so an implementation that only
      // checks the first blob cannot pass.
      const key = `replay-capsules/blobs/${SECOND_FILE.sha256}.raw`;
      if (mode === "missing") store.artifacts.delete(key);
      if (mode === "truncated") store.artifacts.set(key, text("bo"));
      if (mode === "corrupt") store.artifacts.set(key, text("corrupted!!"));

      const retention = await capsules.retention(SNAPSHOT_ID);
      expect(retention.ok).toBe(false);
      if (!retention.ok) {
        expect(["CAPSULE_NOT_FOUND", "DIGEST_MISMATCH"]).toContain(
          retention.code,
        );
      }
    },
  );

  it("returns a typed failure when a LATER file read throws after earlier writes", async () => {
    const { capsules, source, store } = harness();
    source.failAtFileId = SECOND_FILE.id;

    const sealed = await capsules.seal(SNAPSHOT);
    expect(sealed.ok).toBe(false);
    if (!sealed.ok) expect(sealed.code).toBe("SOURCE_UNAVAILABLE");
    // No marker, so the partial custody is inert; the earlier blob is a
    // harmless stale stage that a retry adopts idempotently.
    expect(
      [...store.artifacts.keys()].some((p) => p.endsWith("capsule.json")),
    ).toBe(false);
    source.failAtFileId = undefined;
    expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);
  });

  it.each(["package", "first", "later"] as const)(
    "refuses an export when the %s destination blob is corrupt",
    async (position) => {
      const { capsules } = harness();
      expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

      const sha =
        position === "package"
          ? SNAPSHOT.packageSha256
          : position === "first"
            ? FIRST_FILE.sha256
            : SECOND_FILE.sha256;
      const destination = new MemoryRawArtifactStore();
      destination.corruptWriteAt = `replay-capsules/blobs/${sha}.raw`;

      const exported = await capsules.export(SNAPSHOT_ID, destination);
      expect(exported.ok).toBe(false);
      if (!exported.ok) expect(exported.code).toBe("DIGEST_MISMATCH");
    },
  );

  it("reports a missing capsule instead of inventing custody", async () => {
    const { capsules } = harness();
    const missing = await capsules.verify(SNAPSHOT_ID);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("CAPSULE_NOT_FOUND");

    const retention = await capsules.retention(SNAPSHOT_ID);
    expect(retention.ok).toBe(false);
    if (!retention.ok) expect(retention.code).toBe("CAPSULE_NOT_FOUND");
  });
});

describe("ReplayCapsuleStore has no deletion authority", () => {
  // Compile-time guard: this alias fails to typecheck if any deletion-capable
  // member is ever added to the public type. Deletion is T-10-04, blocked on
  // ADR-0007 (source-custody deletion) and Max's D9 retention ratification.
  type AssertNever<T extends never> = T;
  type ForbiddenMember = Extract<
    keyof ReplayCapsuleStore,
    "delete" | "erase" | "purge" | "unlink" | "remove" | "destroy" | "expire"
  >;
  type NoDeletionMember = AssertNever<ForbiddenMember>;

  it("exposes no deletion member at runtime", () => {
    const { capsules } = harness();
    const guarded: NoDeletionMember[] = [];
    expect(guarded).toEqual([]);

    for (const forbidden of [
      "delete",
      "erase",
      "purge",
      "unlink",
      "remove",
      "destroy",
      "expire",
    ]) {
      expect(forbidden in capsules, `${forbidden} must not exist`).toBe(false);
      expect(
        Reflect.has(Object.getPrototypeOf(capsules) as object, forbidden),
        `${forbidden} must not exist on the prototype`,
      ).toBe(false);
    }
  });

  it("survives an out-of-band attempt to remove retained bytes", async () => {
    const { capsules, store } = harness();
    expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

    // Sabotage is applied directly to the fake, deliberately OUTSIDE the
    // RawArtifactStore interface, so neither ReplayCapsuleStore nor the
    // production store contract gains removal authority for this test.
    const blobKey = `replay-capsules/blobs/${FIRST_FILE.sha256}.raw`;
    const survivor = store.artifacts.get(blobKey);
    expect(survivor).toBeDefined();

    // A REAL retained path refuses removal and keeps its exact bytes...
    expect(store.artifacts.has(blobKey)).toBe(true);
    expect(store.attemptUnlink(blobKey)).toEqual({
      ok: false,
      code: "IMMUTABLE_RAW_ARTIFACT",
    });
    // ...and an absent path is reported differently, so this assertion is
    // path-specific rather than a constant.
    expect(store.attemptUnlink("replay-capsules/blobs/absent.raw")).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(Buffer.from(store.artifacts.get(blobKey)!).equals(survivor!)).toBe(
      true,
    );
    expect((await capsules.verify(SNAPSHOT_ID)).ok).toBe(true);

    // Overwrite refusal exercised through the real RawArtifactStore seam with
    // genuinely different bytes, not via the reseal fast path.
    await expect(store.write(blobKey, text("different bytes"))).resolves.toBe(
      "conflict",
    );
    const staged = `${blobKey}.attempt`;
    await expect(store.write(staged, text("different bytes"))).resolves.toBe(
      "written",
    );
    await expect(store.publish(staged, blobKey)).resolves.toBe("conflict");
    expect(Buffer.from(store.artifacts.get(blobKey)!).equals(survivor!)).toBe(
      true,
    );
    // Custody still verifies after both refused attempts.
    expect((await capsules.verify(SNAPSHOT_ID)).ok).toBe(true);
  });

  it("keeps custody replayable across its whole surface", async () => {
    const { capsules, source } = harness();
    expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

    source.discardUpload();
    expect((await capsules.verify(SNAPSHOT_ID)).ok).toBe(true);
    expect(
      (await capsules.export(SNAPSHOT_ID, new MemoryRawArtifactStore())).ok,
    ).toBe(true);
    expect((await capsules.retention(SNAPSHOT_ID)).ok).toBe(true);
    expect((await capsules.authorisePromotion(SNAPSHOT_ID)).ok).toBe(true);
    expect((await capsules.verify(SNAPSHOT_ID)).ok).toBe(true);
  });
});
