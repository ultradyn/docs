import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { IdGenerator } from "../../domain/index.js";
import {
  SourceFileSchema,
  SourceSnapshotSchema,
  type Sha256,
} from "../../domain/ingest/index.js";
import {
  sourceFileIdentityDigest,
  sourceSnapshotContentDigest,
  SourceSnapshotService,
  type HashService,
  type RawArtifactStore,
} from "../index.js";

class MemoryRawArtifactStore implements RawArtifactStore {
  readonly artifacts = new Map<string, Uint8Array>();
  readonly synced: string[] = [];
  readonly operations: string[] = [];
  failWriteAt?: number;
  dropWriteAt?: number;
  corruptWriteAt?: number;
  failFsyncAt?: number;
  failPublish = false;
  acknowledgePublishThenFail = false;
  dropPublishedDestination = false;
  corruptPublishedDestination = false;
  corruptReplayOnPublishConflict = false;
  interleavePublishes = false;
  writeAttempts = 0;
  fsyncAttempts = 0;
  publishWins = 0;
  publishConflicts = 0;
  #releaseFirstPublish?: () => void;
  #firstPublishWaiting?: Promise<void>;

  async read(path: string): Promise<Uint8Array | undefined> {
    this.operations.push(`read:${path}`);
    const bytes = this.artifacts.get(path);
    return bytes === undefined ? undefined : bytes.slice();
  }

  async write(
    path: string,
    bytes: Uint8Array,
  ): Promise<"written" | "identical" | "conflict"> {
    this.writeAttempts += 1;
    this.operations.push(`write:${path}`);
    if (this.writeAttempts === this.failWriteAt) {
      throw new Error(`injected write failure at ${path}`);
    }
    const existing = this.artifacts.get(path);
    if (existing !== undefined) {
      return Buffer.from(existing).equals(bytes) ? "identical" : "conflict";
    }
    if (this.writeAttempts === this.dropWriteAt) return "written";
    this.artifacts.set(
      path,
      this.writeAttempts === this.corruptWriteAt
        ? text("corrupt")
        : bytes.slice(),
    );
    return "written";
  }

  async fsync(path: string): Promise<void> {
    this.fsyncAttempts += 1;
    this.operations.push(`fsync:${path}`);
    if (this.fsyncAttempts === this.failFsyncAt) {
      throw new Error(`injected fsync failure at ${path}`);
    }
    this.synced.push(path);
  }

  async publish(
    source: string,
    finalPath: string,
  ): Promise<"published" | "conflict"> {
    this.operations.push(`publish:${source}->${finalPath}`);
    if (this.failPublish) throw new Error("injected publish failure");
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
    if (this.artifacts.has(finalPath)) {
      this.publishConflicts += 1;
      if (this.corruptReplayOnPublishConflict) {
        const replayPath = [...this.artifacts.keys()].find((path) =>
          path.endsWith("/package.raw"),
        );
        if (replayPath !== undefined)
          this.artifacts.set(replayPath, text("wrong"));
      }
      return "conflict";
    }
    const bytes = this.artifacts.get(source);
    if (bytes === undefined)
      throw new Error(`missing staged artifact ${source}`);
    if (!this.dropPublishedDestination) {
      this.artifacts.set(
        finalPath,
        this.corruptPublishedDestination ? text("corrupt") : bytes.slice(),
      );
    }
    this.publishWins += 1;
    if (this.acknowledgePublishThenFail) {
      throw new Error("injected lost publish acknowledgement");
    }
    return "published";
  }
}

const hashes: HashService = {
  async sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex") as Sha256;
  },
};

function digest(text: string): Sha256 {
  return createHash("sha256").update(text).digest("hex") as Sha256;
}

function ids(): IdGenerator {
  let sequence = 0;
  return {
    next: () => `art-test-${++sequence}`,
  };
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function input() {
  return {
    preflight: {
      entries: [
        {
          logicalPath: "docs/Guide.md",
          mediaType: "text/markdown",
          size: 5,
          included: true,
          reason: "included by docs/**",
        },
      ],
    },
    policyId: "policy-source-docs",
    package: { bytes: text("package-v1"), sha256: digest("package-v1") },
    files: [
      {
        logicalPath: "docs/Guide.md",
        bytes: text("guide"),
        sha256: digest("guide"),
      },
    ],
  };
}

describe("SourceSnapshotService", () => {
  it("pins the extracted canonical helpers to service-produced identity", async () => {
    // Extraction-only guard: the exported helpers must reproduce, exactly, the
    // identity that SourceSnapshotService assigns to a qualified snapshot. If
    // the helpers and the qualification path ever drift, a replay capsule
    // could vouch for a snapshot the snapshot plane would reject.
    const store = new MemoryRawArtifactStore();
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });

    const created = await service.create(input());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const snapshot = created.value;

    const contentSha256 = await sourceSnapshotContentDigest(hashes, {
      packageSha256: snapshot.packageSha256,
      policyId: snapshot.policyId,
      files: snapshot.files,
      exclusions: snapshot.exclusions,
    });
    expect(contentSha256).toBe(snapshot.contentSha256);
    expect(`snap-${contentSha256}`).toBe(snapshot.id);

    for (const file of snapshot.files) {
      const identity = await sourceFileIdentityDigest(
        hashes,
        snapshot.id,
        file,
      );
      expect(`file-${identity}`).toBe(file.id);
      expect(file.snapshotId).toBe(snapshot.id);
    }
  });

  it("returns the same qualified snapshot for the same package and policy", async () => {
    const store = new MemoryRawArtifactStore();
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });

    const first = await service.create(input());
    const second = await service.create(input());

    expect(first).toMatchObject({ ok: true, value: { qualified: true } });
    expect(second).toEqual(first);
    const qualificationPublish = store.operations.findIndex((operation) =>
      operation.match(
        /^publish:.*\/manifest\.staged\.json->source-snapshots\/[^.][^/]*\/manifest\.json$/,
      ),
    );
    expect(qualificationPublish).toBeGreaterThan(0);
    expect(store.operations.slice(0, qualificationPublish).slice(-2)).toEqual([
      expect.stringMatching(/^fsync:.*\/manifest\.staged\.json$/),
      expect.stringMatching(/^read:.*\/manifest\.staged\.json$/),
    ]);
    expect(
      store.operations.some((operation) =>
        operation.match(/^write:source-snapshots\/[^.][^/]*\/manifest\.json$/),
      ),
    ).toBe(false);
    expect(
      store.operations.some((operation) =>
        operation.match(/^fsync:source-snapshots\/[^.][^/]*\/manifest\.json$/),
      ),
    ).toBe(false);
  });

  it("verifies the declared package and every included file digest", async () => {
    const store = new MemoryRawArtifactStore();
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });
    const mismatchedPackage = input();
    mismatchedPackage.package.sha256 = digest("different-package");

    await expect(service.create(mismatchedPackage)).resolves.toMatchObject({
      ok: false,
      code: "DIGEST_MISMATCH",
    });

    const mismatchedFile = input();
    mismatchedFile.files[0]!.sha256 = digest("different-file");
    await expect(service.create(mismatchedFile)).resolves.toMatchObject({
      ok: false,
      code: "DIGEST_MISMATCH",
    });
    expect(
      [...store.artifacts.keys()].filter((path) =>
        path.endsWith("manifest.json"),
      ),
    ).toEqual([]);
  });

  it("leaves no qualified manifest when the third file write fails", async () => {
    const store = new MemoryRawArtifactStore();
    store.failWriteAt = 5;
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });
    const source = input();
    source.preflight.entries = [
      ...source.preflight.entries,
      {
        logicalPath: "docs/Second.md",
        mediaType: "text/markdown",
        size: 6,
        included: true,
        reason: "included by docs/**",
      },
      {
        logicalPath: "README.md",
        mediaType: "text/markdown",
        size: 6,
        included: true,
        reason: "included by README.md",
      },
    ];
    source.files = [
      ...source.files,
      {
        logicalPath: "docs/Second.md",
        bytes: text("second"),
        sha256: digest("second"),
      },
      {
        logicalPath: "README.md",
        bytes: text("readme"),
        sha256: digest("readme"),
      },
    ];

    await expect(service.create(source)).resolves.toMatchObject({
      ok: false,
      code: "PARTIAL_WRITE",
    });
    expect(
      [...store.artifacts.keys()].filter((path) =>
        path.endsWith("manifest.json"),
      ),
    ).toEqual([]);
  });

  it.each([1, 2, 3, 4, 5, 6])(
    "never qualifies when append number %i fails",
    async (failedAppend) => {
      const store = new MemoryRawArtifactStore();
      store.failWriteAt = failedAppend;
      const service = new SourceSnapshotService({ store, hashes, ids: ids() });
      const source = input();
      source.preflight.entries = [
        ...source.preflight.entries,
        {
          logicalPath: "docs/Second.md",
          mediaType: "text/markdown",
          size: 6,
          included: true,
          reason: "included by docs/**",
        },
        {
          logicalPath: "README.md",
          mediaType: "text/markdown",
          size: 6,
          included: true,
          reason: "included by README.md",
        },
      ];
      source.files = [
        ...source.files,
        {
          logicalPath: "docs/Second.md",
          bytes: text("second"),
          sha256: digest("second"),
        },
        {
          logicalPath: "README.md",
          bytes: text("readme"),
          sha256: digest("readme"),
        },
      ];

      await expect(service.create(source)).resolves.toMatchObject({
        ok: false,
        code: "PARTIAL_WRITE",
      });
      expect(
        [...store.artifacts.keys()].filter((path) =>
          path.endsWith("manifest.json"),
        ),
      ).toEqual([]);
    },
  );

  it.each([1, 2, 3, 4])(
    "does not qualify when fsync number %i fails",
    async (failedFsync) => {
      const store = new MemoryRawArtifactStore();
      store.failFsyncAt = failedFsync;
      const service = new SourceSnapshotService({ store, hashes, ids: ids() });

      await expect(service.create(input())).resolves.toMatchObject({
        ok: false,
        code: "PARTIAL_WRITE",
      });
      expect(
        [...store.artifacts.keys()].filter((path) =>
          path.match(/^source-snapshots\/[^.][^/]*\/manifest\.json$/),
        ),
      ).toEqual([]);
    },
  );

  it.each([1, 2, 3, 4])(
    "rereads and rejects silently dropped write %s before qualification",
    async (mode) => {
      const store = new MemoryRawArtifactStore();
      store.dropWriteAt = mode;
      const service = new SourceSnapshotService({ store, hashes, ids: ids() });

      await expect(service.create(input())).resolves.toMatchObject({
        ok: false,
        code: "PARTIAL_WRITE",
      });
      expect(
        [...store.artifacts.keys()].filter((path) =>
          path.match(/^source-snapshots\/[^.][^/]*\/manifest\.json$/),
        ),
      ).toEqual([]);
    },
  );

  it.each([1, 2, 3, 4])(
    "rereads and rejects silently corrupted write %s before qualification",
    async (position) => {
      const store = new MemoryRawArtifactStore();
      store.corruptWriteAt = position;
      const service = new SourceSnapshotService({ store, hashes, ids: ids() });

      await expect(service.create(input())).resolves.toMatchObject({
        ok: false,
        code: "PARTIAL_WRITE",
      });
      expect(
        [...store.artifacts.keys()].filter((path) =>
          path.match(/^source-snapshots\/[^.][^/]*\/manifest\.json$/),
        ),
      ).toEqual([]);
    },
  );

  it("uses the exact durable qualification operation order", async () => {
    const store = new MemoryRawArtifactStore();
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });

    await expect(service.create(input())).resolves.toMatchObject({ ok: true });

    expect(store.operations).toEqual([
      expect.stringMatching(/^read:.*\/intent\.json$/),
      expect.stringMatching(/^read:.*\/intent\.json$/),
      expect.stringMatching(/^write:.*\/intent\.json$/),
      expect.stringMatching(/^fsync:.*\/intent\.json$/),
      expect.stringMatching(/^read:.*\/intent\.json$/),
      expect.stringMatching(/^read:source-snapshots\/[^/]+\/manifest\.json$/),
      expect.stringMatching(/^read:.*\/package\.raw$/),
      expect.stringMatching(/^write:.*\/package\.raw$/),
      expect.stringMatching(/^fsync:.*\/package\.raw$/),
      expect.stringMatching(/^read:.*\/files\/[^/]+\.raw$/),
      expect.stringMatching(/^write:.*\/files\/[^/]+\.raw$/),
      expect.stringMatching(/^fsync:.*\/files\/[^/]+\.raw$/),
      expect.stringMatching(/^read:.*\/package\.raw$/),
      expect.stringMatching(/^read:.*\/files\/[^/]+\.raw$/),
      expect.stringMatching(/^read:.*\/manifest\.staged\.json$/),
      expect.stringMatching(/^write:.*\/manifest\.staged\.json$/),
      expect.stringMatching(/^fsync:.*\/manifest\.staged\.json$/),
      expect.stringMatching(/^read:.*\/manifest\.staged\.json$/),
      expect.stringMatching(
        /^publish:.*\/manifest\.staged\.json->source-snapshots\/[^/]+\/manifest\.json$/,
      ),
      expect.stringMatching(/^read:source-snapshots\/[^/]+\/manifest\.json$/),
      expect.stringMatching(/^read:source-snapshots\/[^/]+\/manifest\.json$/),
      expect.stringMatching(/^read:.*\/intent\.json$/),
      expect.stringMatching(/^read:.*\/package\.raw$/),
      expect.stringMatching(/^read:.*\/files\/[^/]+\.raw$/),
    ]);
    const packageWrite = store.operations.findIndex(
      (operation) =>
        operation.endsWith("/package.raw") && operation.startsWith("write:"),
    );
    const packageFsync = store.operations.findIndex(
      (operation) =>
        operation.endsWith("/package.raw") && operation.startsWith("fsync:"),
    );
    const packageRead = store.operations.findIndex(
      (operation, index) =>
        index > packageFsync &&
        operation.endsWith("/package.raw") &&
        operation.startsWith("read:"),
    );
    const fileWrite = store.operations.findIndex(
      (operation) =>
        operation.includes("/files/") && operation.startsWith("write:"),
    );
    const fileFsync = store.operations.findIndex(
      (operation) =>
        operation.includes("/files/") && operation.startsWith("fsync:"),
    );
    const fileRead = store.operations.findIndex(
      (operation, index) =>
        index > fileFsync &&
        operation.includes("/files/") &&
        operation.startsWith("read:"),
    );
    const stagedManifestWrite = store.operations.findIndex(
      (operation) =>
        operation.endsWith("/manifest.staged.json") &&
        operation.startsWith("write:"),
    );
    const stagedManifestFsync = store.operations.findIndex(
      (operation) =>
        operation.endsWith("/manifest.staged.json") &&
        operation.startsWith("fsync:"),
    );
    const stagedManifestRead = store.operations.findIndex(
      (operation, index) =>
        index > stagedManifestFsync &&
        operation.endsWith("/manifest.staged.json") &&
        operation.startsWith("read:"),
    );
    const publish = store.operations.findIndex((operation) =>
      operation.startsWith("publish:"),
    );
    expect([
      packageWrite,
      packageFsync,
      fileWrite,
      fileFsync,
      packageRead,
      fileRead,
      stagedManifestWrite,
      stagedManifestFsync,
      stagedManifestRead,
      publish,
    ]).toEqual(Array.from({ length: 10 }, () => expect.any(Number)));
    expect(packageWrite).toBeLessThan(packageFsync);
    expect(packageFsync).toBeLessThan(fileWrite);
    expect(fileWrite).toBeLessThan(fileFsync);
    expect(fileFsync).toBeLessThan(packageRead);
    expect(packageRead).toBeLessThan(fileRead);
    expect(fileRead).toBeLessThan(stagedManifestWrite);
    expect(stagedManifestWrite).toBeLessThan(stagedManifestFsync);
    expect(stagedManifestFsync).toBeLessThan(stagedManifestRead);
    expect(stagedManifestRead).toBeLessThan(publish);
  });

  it.each(["dropped", "corrupted"] as const)(
    "rereads and rejects a %s published destination before returning qualified",
    async (failure) => {
      const store = new MemoryRawArtifactStore();
      store.dropPublishedDestination = failure === "dropped";
      store.corruptPublishedDestination = failure === "corrupted";
      const service = new SourceSnapshotService({ store, hashes, ids: ids() });

      await expect(service.create(input())).resolves.toMatchObject({
        ok: false,
        code: "PARTIAL_WRITE",
      });
    },
  );

  it("rereads every replay byte after a successful publish before returning qualified", async () => {
    const store = new MemoryRawArtifactStore();
    const originalPublish = store.publish.bind(store);
    store.publish = async (source, finalPath) => {
      const outcome = await originalPublish(source, finalPath);
      const replayPath = [...store.artifacts.keys()].find((path) =>
        path.endsWith("/package.raw"),
      );
      if (replayPath !== undefined)
        store.artifacts.set(replayPath, text("wrong"));
      return outcome;
    };
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });

    await expect(service.create(input())).resolves.toMatchObject({
      ok: false,
      code: "PARTIAL_WRITE",
    });
  });

  it("does not qualify when atomic publication fails", async () => {
    const store = new MemoryRawArtifactStore();
    store.failPublish = true;
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });

    await expect(service.create(input())).resolves.toMatchObject({
      ok: false,
      code: "PARTIAL_WRITE",
    });
    expect(
      [...store.artifacts.keys()].filter((path) =>
        path.match(/^source-snapshots\/[^.][^/]*\/manifest\.json$/),
      ),
    ).toEqual([]);
  });

  it("reports a conflict when exclusion provenance differs for the same package and policy", async () => {
    const store = new MemoryRawArtifactStore();
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });
    const original = input();
    original.preflight.entries = [
      ...original.preflight.entries,
      {
        logicalPath: "private/ignored.txt",
        mediaType: "text/plain",
        size: 7,
        included: false,
        reason: "excluded by private/**",
      },
    ];
    await expect(service.create(original)).resolves.toMatchObject({ ok: true });
    const changed = input();
    changed.preflight.entries = [
      ...changed.preflight.entries,
      {
        logicalPath: "private/ignored.txt",
        mediaType: "text/plain",
        size: 7,
        included: false,
        reason: "excluded by a changed policy receipt",
      },
    ];

    await expect(service.create(changed)).resolves.toMatchObject({
      ok: false,
      code: "SNAPSHOT_CONFLICT",
    });
  });

  it("reports conflicts without overwriting stale transaction bytes", async () => {
    const store = new MemoryRawArtifactStore();
    store.failWriteAt = 2;
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });
    await service.create(input());
    const before = new Map(store.artifacts);
    delete store.failWriteAt;
    const changed = input();
    changed.files[0] = {
      logicalPath: "docs/Guide.md",
      bytes: text("other"),
      sha256: digest("other"),
    };

    await expect(service.create(changed)).resolves.toMatchObject({
      ok: false,
      code: "SNAPSHOT_CONFLICT",
    });
    expect(store.artifacts).toEqual(before);
  });

  it("concurrent service instances take the typed publish conflict path and adopt its verified winner", async () => {
    const store = new MemoryRawArtifactStore();
    store.interleavePublishes = true;
    const first = new SourceSnapshotService({ store, hashes, ids: ids() });
    const second = new SourceSnapshotService({
      store,
      hashes,
      ids: {
        next: () => "a-distinct-id-stream-that-must-not-change-content-ids",
      },
    });

    const results = await Promise.all([
      first.create(input()),
      second.create(input()),
    ]);

    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ ok: true, value: { qualified: true } });
    expect(store.publishWins).toBe(1);
    expect(store.publishConflicts).toBe(1);
    expect(
      new Set(
        store.operations
          .filter((operation) => operation.startsWith("publish:"))
          .map((operation) => operation.split("->")[0]),
      ).size,
    ).toBe(2);
  });

  it("fully verifies an existing winner before conflict adoption", async () => {
    const store = new MemoryRawArtifactStore();
    store.interleavePublishes = true;
    store.corruptReplayOnPublishConflict = true;
    const first = new SourceSnapshotService({ store, hashes, ids: ids() });
    const second = new SourceSnapshotService({ store, hashes, ids: ids() });

    const results = await Promise.all([
      first.create(input()),
      second.create(input()),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ ok: false, code: "PARTIAL_WRITE" }),
      expect.objectContaining({ ok: false, code: "PARTIAL_WRITE" }),
    ]);
    expect(store.publishConflicts).toBe(1);
  });

  it("recovers when atomic publication succeeds but its acknowledgement is lost", async () => {
    const store = new MemoryRawArtifactStore();
    store.acknowledgePublishThenFail = true;
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });

    await expect(service.create(input())).resolves.toMatchObject({
      ok: true,
      value: { qualified: true },
    });
    store.acknowledgePublishThenFail = false;

    await expect(service.create(input())).resolves.toMatchObject({
      ok: true,
      value: { qualified: true },
    });
    expect(store.publishWins).toBe(1);
  });

  it("recovers a stale partial transaction deterministically", async () => {
    const store = new MemoryRawArtifactStore();
    store.failWriteAt = 2;
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });

    await expect(service.create(input())).resolves.toMatchObject({
      ok: false,
      code: "PARTIAL_WRITE",
    });
    expect(
      [...store.artifacts.keys()].filter((path) =>
        path.endsWith("manifest.json"),
      ),
    ).toEqual([]);

    delete store.failWriteAt;
    const recovered = await service.create(input());
    const repeated = await service.create(input());
    expect(recovered).toMatchObject({ ok: true, value: { qualified: true } });
    expect(repeated).toEqual(recovered);
  });

  it.each([
    ["mutated file", "file", "mutated"],
    ["missing file", "file", "missing"],
    ["mutated package", "package", "mutated"],
    ["missing package", "package", "missing"],
  ] as const)(
    "verify detects %s replay bytes",
    async (_description, artifact, failure) => {
      const store = new MemoryRawArtifactStore();
      const service = new SourceSnapshotService({ store, hashes, ids: ids() });
      const created = await service.create(input());
      if (!created.ok) throw new Error(created.message);
      const replayPath = [...store.artifacts.keys()].find((path) =>
        artifact === "file"
          ? path.includes("/files/")
          : path.endsWith("/package.raw"),
      );
      if (replayPath === undefined)
        throw new Error("expected staged replay bytes");
      if (failure === "missing") store.artifacts.delete(replayPath);
      else store.artifacts.set(replayPath, text("wrong"));

      await expect(service.verify(created.value.id)).rejects.toThrow(
        /missing or modified/,
      );
    },
  );

  it("rejects a fully coherent rebind substituted at the old qualified identity", async () => {
    const store = new MemoryRawArtifactStore();
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });
    const created = await service.create(input());
    if (!created.ok) throw new Error(created.message);
    const intentPath = [...store.artifacts.keys()].find((path) =>
      path.endsWith("/intent.json"),
    );
    const finalPath = [...store.artifacts.keys()].find((path) =>
      path.match(/^source-snapshots\/[^.][^/]*\/manifest\.json$/),
    );
    const oldFilePath = [...store.artifacts.keys()].find((path) =>
      path.includes("/files/"),
    );
    if (
      intentPath === undefined ||
      finalPath === undefined ||
      oldFilePath === undefined
    ) {
      throw new Error("expected published custody records");
    }
    const decode = (path: string) =>
      JSON.parse(new TextDecoder().decode(store.artifacts.get(path)));
    const intent = decode(intentPath);
    const originalFile = intent.files[0];
    const reboundFileContent = {
      schemaVersion: 1,
      logicalPath: "docs/Rebound.md",
      mediaType: originalFile.mediaType,
      size: originalFile.size,
      sha256: originalFile.sha256,
    };
    const reboundContentSha256 = await hashes.sha256(
      text(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            packageSha256: intent.packageSha256,
            policyId: intent.policyId,
            files: [reboundFileContent],
            exclusions: intent.exclusions,
            qualified: true,
          },
          null,
          2,
        )}\n`,
      ),
    );
    const reboundSnapshotId = `snap-${reboundContentSha256}`;
    const reboundFileIdentity = {
      schemaVersion: 1,
      snapshotId: reboundSnapshotId,
      logicalPath: reboundFileContent.logicalPath,
      mediaType: reboundFileContent.mediaType,
      size: reboundFileContent.size,
      sha256: reboundFileContent.sha256,
    };
    const reboundFileSha256 = await hashes.sha256(
      text(`${JSON.stringify(reboundFileIdentity, null, 2)}\n`),
    );
    const reboundFile = {
      schemaVersion: 1,
      id: `file-${reboundFileSha256}`,
      snapshotId: reboundSnapshotId,
      logicalPath: reboundFileContent.logicalPath,
      mediaType: reboundFileContent.mediaType,
      size: reboundFileContent.size,
      sha256: reboundFileContent.sha256,
    };
    const reboundIntent = {
      ...intent,
      snapshotId: reboundSnapshotId,
      contentSha256: reboundContentSha256,
      files: [reboundFile],
    };
    const reboundManifest = {
      schemaVersion: 1,
      id: reboundSnapshotId,
      packageSha256: intent.packageSha256,
      contentSha256: reboundContentSha256,
      policyId: intent.policyId,
      files: [reboundFile],
      exclusions: intent.exclusions,
      qualified: true,
    };
    const newFilePath = oldFilePath.replace(originalFile.id, reboundFile.id);
    store.artifacts.set(newFilePath, store.artifacts.get(oldFilePath)!);
    store.artifacts.delete(oldFilePath);
    store.artifacts.set(
      intentPath,
      text(`${JSON.stringify(reboundIntent, null, 2)}\n`),
    );
    store.artifacts.set(
      finalPath,
      text(`${JSON.stringify(reboundManifest, null, 2)}\n`),
    );

    await expect(service.verify(created.value.id)).rejects.toThrow(
      /manifest has the wrong id/,
    );
  });

  it.each([
    "file id",
    "snapshot id",
    "snapshot prefix",
    "moved bytes",
  ] as const)("rejects coherent custody mutation of %s", async (mutation) => {
    const store = new MemoryRawArtifactStore();
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });
    const created = await service.create(input());
    if (!created.ok) throw new Error(created.message);
    const intentPath = [...store.artifacts.keys()].find((path) =>
      path.endsWith("/intent.json"),
    );
    const finalPath = [...store.artifacts.keys()].find((path) =>
      path.match(/^source-snapshots\/[^.][^/]*\/manifest\.json$/),
    );
    const filePath = [...store.artifacts.keys()].find((path) =>
      path.includes("/files/"),
    );
    if (
      intentPath === undefined ||
      finalPath === undefined ||
      filePath === undefined
    ) {
      throw new Error("expected published custody records");
    }
    const decode = (path: string) =>
      JSON.parse(new TextDecoder().decode(store.artifacts.get(path)));
    const intent = decode(intentPath);
    const manifest = decode(finalPath);
    if (mutation === "file id") {
      intent.files[0].id = `file-${"0".repeat(64)}`;
      manifest.files[0].id = intent.files[0].id;
      const movedPath = filePath.replace(
        /file-[a-f0-9]{64}/,
        intent.files[0].id,
      );
      store.artifacts.set(movedPath, store.artifacts.get(filePath)!);
      store.artifacts.delete(filePath);
    } else if (mutation === "moved bytes") {
      const movedPath = `${filePath}.copied`;
      store.artifacts.set(movedPath, store.artifacts.get(filePath)!);
      store.artifacts.delete(filePath);
    } else {
      const replacement =
        mutation === "snapshot prefix"
          ? `snapshot-${created.value.contentSha256}`
          : `snap-${"0".repeat(64)}`;
      intent.snapshotId = replacement;
      intent.files[0].snapshotId = replacement;
      manifest.id = replacement;
      manifest.files[0].snapshotId = replacement;
    }
    store.artifacts.set(
      intentPath,
      text(`${JSON.stringify(intent, null, 2)}\n`),
    );
    store.artifacts.set(
      finalPath,
      text(`${JSON.stringify(manifest, null, 2)}\n`),
    );

    await expect(service.verify(created.value.id)).rejects.toThrow();
  });

  it("verify detects mutation of the qualified manifest", async () => {
    const store = new MemoryRawArtifactStore();
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });
    const created = await service.create(input());
    if (!created.ok) throw new Error(created.message);
    const manifestPath = [...store.artifacts.keys()].find(
      (path) =>
        path.startsWith(`source-snapshots/${created.value.id}/`) &&
        path.endsWith("manifest.json"),
    );
    if (manifestPath === undefined)
      throw new Error("expected qualified manifest");
    store.artifacts.set(
      manifestPath,
      text(
        `${JSON.stringify({ ...created.value, policyId: "attacker-policy" }, null, 2)}\n`,
      ),
    );

    await expect(service.verify(created.value.id)).rejects.toThrow(
      /modified or unbound/,
    );
  });

  it("produces byte-identical canonical records across distinct ID streams", async () => {
    const firstStore = new MemoryRawArtifactStore();
    const secondStore = new MemoryRawArtifactStore();
    const first = new SourceSnapshotService({
      store: firstStore,
      hashes,
      ids: { next: () => "attempt-first" },
    });
    const second = new SourceSnapshotService({
      store: secondStore,
      hashes,
      ids: { next: () => "attempt-second" },
    });

    const firstResult = await first.create(input());
    const secondResult = await second.create(input());
    expect(firstResult).toEqual(secondResult);
    const canonicalBytes = (store: MemoryRawArtifactStore, suffix: string) => {
      const path = [...store.artifacts.keys()].find((candidate) =>
        candidate.endsWith(suffix),
      );
      if (path === undefined) throw new Error(`missing canonical ${suffix}`);
      return store.artifacts.get(path);
    };
    expect(canonicalBytes(firstStore, "/intent.json")).toEqual(
      canonicalBytes(secondStore, "/intent.json"),
    );
    expect(canonicalBytes(firstStore, "/manifest.json")).toEqual(
      canonicalBytes(secondStore, "/manifest.json"),
    );
  });

  it("derives exact canonical snapshot and file identities from all bound content", async () => {
    const store = new MemoryRawArtifactStore();
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });
    const created = await service.create(input());
    if (!created.ok) throw new Error(created.message);

    expect(created.value.id).toBe(`snap-${created.value.contentSha256}`);
    const file = created.value.files[0]!;
    const expectedFileDigest = await hashes.sha256(
      text(
        `${JSON.stringify(
          {
            schemaVersion: file.schemaVersion,
            snapshotId: created.value.id,
            logicalPath: file.logicalPath,
            mediaType: file.mediaType,
            size: file.size,
            sha256: file.sha256,
          },
          null,
          2,
        )}\n`,
      ),
    );
    expect(file.id).toBe(`file-${expectedFileDigest}`);
  });

  it("rejects uppercase SHA-256 values in a private persisted intent", async () => {
    const store = new MemoryRawArtifactStore();
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });
    const created = await service.create(input());
    if (!created.ok) throw new Error(created.message);
    const intentPath = [...store.artifacts.keys()].find((path) =>
      path.endsWith("/intent.json"),
    );
    if (intentPath === undefined) throw new Error("expected persisted intent");
    const intent = JSON.parse(
      new TextDecoder().decode(store.artifacts.get(intentPath)),
    );
    intent.packageSha256 = intent.packageSha256.toUpperCase();
    store.artifacts.set(
      intentPath,
      text(`${JSON.stringify(intent, null, 2)}\n`),
    );

    await expect(service.verify(created.value.id)).rejects.toThrow(
      /intent is invalid/,
    );
  });

  it("rejects uppercase SHA-256 values at the public schema boundary", () => {
    const validFile = {
      schemaVersion: 1,
      id: `file-${"d".repeat(64)}`,
      snapshotId: `snap-${"b".repeat(64)}`,
      logicalPath: "docs/Guide.md",
      mediaType: "text/markdown",
      size: 5,
      sha256: "a".repeat(64),
    };

    expect(SourceFileSchema.safeParse(validFile).success).toBe(true);
    expect(
      SourceFileSchema.safeParse({
        ...validFile,
        sha256: validFile.sha256.toUpperCase(),
      }).success,
    ).toBe(false);
  });

  it("returns canonical versioned source records through the public domain schema", async () => {
    const store = new MemoryRawArtifactStore();
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });
    const created = await service.create(input());

    expect(created).toMatchObject({
      ok: true,
      value: { schemaVersion: 1, files: [{ schemaVersion: 1 }] },
    });
    if (!created.ok) throw new Error(created.message);
    expect(SourceSnapshotSchema.safeParse(created.value).success).toBe(true);
    expect(SourceFileSchema.safeParse(created.value.files[0]).success).toBe(
      true,
    );
  });

  it("retains excluded preflight entries explicitly without persisting their bytes", async () => {
    const store = new MemoryRawArtifactStore();
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });
    const source = input();
    source.preflight.entries = [
      ...source.preflight.entries,
      {
        logicalPath: "private/ignored.txt",
        mediaType: "text/plain",
        size: 7,
        included: false,
        reason: "excluded by private/**",
      },
    ];

    const created = await service.create(source);

    expect(created).toMatchObject({
      ok: true,
      value: {
        exclusions: [
          {
            logicalPath: "private/ignored.txt",
            mediaType: "text/plain",
            size: 7,
            reason: "excluded by private/**",
          },
        ],
      },
    });
  });

  it("preserves original logical paths from successful preflight provenance", async () => {
    const store = new MemoryRawArtifactStore();
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });
    const created = await service.create(input());

    expect(created).toMatchObject({
      ok: true,
      value: { files: [{ logicalPath: "docs/Guide.md" }] },
    });
  });
});
