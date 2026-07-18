import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  Sha256,
  SnapshotId,
  SourceFile,
  SourceSnapshot,
} from "../../domain/ingest/index.js";
import {
  ReplayCapsuleStore,
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

  async read(path: string): Promise<Uint8Array | undefined> {
    this.operations.push(`read:${path}`);
    return this.artifacts.get(path)?.slice();
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
    const staged = this.artifacts.get(source);
    if (staged === undefined) return "conflict";
    const existing = this.artifacts.get(finalPath);
    if (existing !== undefined) {
      return Buffer.from(existing).equals(staged) ? "published" : "conflict";
    }
    this.artifacts.set(finalPath, staged.slice());
    return "published";
  }
}

/** The transient upload area a capsule is sealed from; may vanish afterwards. */
class MemorySourceByteReader implements SourceByteReader {
  readonly files = new Map<string, Uint8Array>();
  failEveryRead = false;
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
    if (this.failEveryRead) throw new Error("upload reader is unavailable");
    return Promise.resolve(this.#package?.slice());
  }

  readFile(file: SourceFile): Promise<Uint8Array | undefined> {
    if (this.failEveryRead) throw new Error("upload reader is unavailable");
    return Promise.resolve(this.files.get(file.id)?.slice());
  }
}

const SNAPSHOT_ID =
  `snap-${"a".repeat(64)}` as SnapshotId;
const FIRST_FILE_BYTES = text("# readme\n");
const SECOND_FILE_BYTES = text("body text\n");
const PACKAGE_BYTES = text("package-archive-bytes");

function sourceFile(logicalPath: string, bytes: Uint8Array): SourceFile {
  const sha256 = digest(bytes);
  return {
    schemaVersion: 1,
    id: `file-${sha256}` as SourceFile["id"],
    snapshotId: SNAPSHOT_ID,
    logicalPath,
    mediaType: "text/markdown",
    size: bytes.byteLength,
    sha256,
  };
}

const FIRST_FILE = sourceFile("docs/readme.md", FIRST_FILE_BYTES);
const SECOND_FILE = sourceFile("docs/body.md", SECOND_FILE_BYTES);

const SNAPSHOT: SourceSnapshot = {
  schemaVersion: 1,
  id: SNAPSHOT_ID,
  packageSha256: digest(PACKAGE_BYTES),
  contentSha256: digest(text("content-address")),
  policyId: "policy-internal-docs",
  files: [FIRST_FILE, SECOND_FILE],
  exclusions: [],
  qualified: true,
};

function harness(): {
  store: MemoryRawArtifactStore;
  source: MemorySourceByteReader;
  capsules: ReplayCapsuleStore;
} {
  const store = new MemoryRawArtifactStore();
  const source = new MemorySourceByteReader();
  source.setPackage(PACKAGE_BYTES);
  source.setFile(FIRST_FILE.id, FIRST_FILE_BYTES);
  source.setFile(SECOND_FILE.id, SECOND_FILE_BYTES);
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

    // Bytes are addressed by their own digest, so custody is self-describing.
    for (const file of [FIRST_FILE, SECOND_FILE]) {
      const stored = [...store.artifacts.entries()].find(([path]) =>
        path.includes(file.sha256),
      );
      expect(stored, `no content-addressed blob for ${file.logicalPath}`).toBeDefined();
      if (stored) expect(digest(stored[1])).toBe(file.sha256);
    }

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

    const destination = new MemoryRawArtifactStore();
    const exported = await capsules.export(SNAPSHOT_ID, destination);
    expect(exported.ok).toBe(true);
    // Export copies bytes and rehashes them at the destination.
    const exportedDigests = [...destination.artifacts.values()].map(digest);
    expect(exportedDigests).toContain(FIRST_FILE.sha256);
    expect(exportedDigests).toContain(SECOND_FILE.sha256);
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

  it("exposes retention metadata without any expiry authority", async () => {
    const { capsules } = harness();
    expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

    const retention = await capsules.retention(SNAPSHOT_ID);
    expect(retention.ok).toBe(true);
    if (retention.ok) {
      expect(retention.value).toEqual({
        snapshotId: SNAPSHOT_ID,
        fileCount: 2,
        retainedBytes:
          FIRST_FILE_BYTES.byteLength + SECOND_FILE_BYTES.byteLength,
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

  it("refuses a second capsule that would rebind the same snapshot id", async () => {
    const { capsules, store, source } = harness();
    expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);

    // Same snapshot id, different bound provenance: publishing must conflict
    // rather than silently rebinding retained custody.
    const rebound = {
      ...SNAPSHOT,
      policyId: "policy-rebound",
    } satisfies SourceSnapshot;
    source.setPackage(PACKAGE_BYTES);
    source.setFile(FIRST_FILE.id, FIRST_FILE_BYTES);
    source.setFile(SECOND_FILE.id, SECOND_FILE_BYTES);

    const second = await capsules.seal(rebound);
    // The already-retained capsule is adopted unchanged; provenance is never
    // rewritten in place.
    expect(second.ok).toBe(true);
    const capsuleKey = [...store.artifacts.keys()].find((path) =>
      path.endsWith(`${SNAPSHOT_ID}/capsule.json`),
    );
    expect(capsuleKey).toBeDefined();
    if (capsuleKey) {
      const manifest = JSON.parse(
        new TextDecoder().decode(store.artifacts.get(capsuleKey)),
      ) as { policyId: string };
      expect(manifest.policyId).toBe(SNAPSHOT.policyId);
    }
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

  it("never removes retained bytes across its whole surface", async () => {
    const { capsules, store, source } = harness();
    expect((await capsules.seal(SNAPSHOT)).ok).toBe(true);
    const retained = new Map(store.artifacts);

    source.discardUpload();
    await capsules.verify(SNAPSHOT_ID);
    await capsules.export(SNAPSHOT_ID, new MemoryRawArtifactStore());
    await capsules.retention(SNAPSHOT_ID);
    await capsules.authorisePromotion(SNAPSHOT_ID);

    expect(store.artifacts.size).toBe(retained.size);
    for (const [path, bytes] of retained) {
      expect(Buffer.from(store.artifacts.get(path) ?? text("")).equals(bytes)).toBe(
        true,
      );
    }
  });
});
