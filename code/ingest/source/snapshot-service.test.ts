import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { IdGenerator } from "../../domain/index.js";
import type { Sha256 } from "../../domain/ingest/index.js";
import {
  SourceSnapshotService,
  type HashService,
  type RawArtifactStore,
} from "../index.js";

class MemoryRawArtifactStore implements RawArtifactStore {
  readonly artifacts = new Map<string, Uint8Array>();
  readonly synced: string[] = [];
  readonly operations: string[] = [];
  failAppendAt?: number;
  appendAttempts = 0;

  async read(path: string): Promise<Uint8Array | undefined> {
    const bytes = this.artifacts.get(path);
    return bytes === undefined ? undefined : bytes.slice();
  }

  async append(path: string, bytes: Uint8Array): Promise<void> {
    this.appendAttempts += 1;
    this.operations.push(`append:${path}`);
    if (this.appendAttempts === this.failAppendAt) {
      throw new Error(`injected append failure at ${path}`);
    }
    const existing = this.artifacts.get(path);
    if (existing !== undefined) {
      if (!Buffer.from(existing).equals(bytes)) {
        throw new Error(`append-only conflict at ${path}`);
      }
      return;
    }
    this.artifacts.set(path, bytes.slice());
  }

  async fsync(path: string): Promise<void> {
    if (!this.artifacts.has(path)) throw new Error(`missing artifact ${path}`);
    this.synced.push(path);
    this.operations.push(`fsync:${path}`);
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
  it("returns the same qualified snapshot for the same package and policy", async () => {
    const store = new MemoryRawArtifactStore();
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });

    const first = await service.create(input());
    const second = await service.create(input());

    expect(first).toMatchObject({ ok: true, value: { qualified: true } });
    expect(second).toEqual(first);
    const qualificationAppend = store.operations.findIndex((operation) =>
      operation.match(/^append:source-snapshots\/[^.][^/]*\/manifest\.json$/),
    );
    expect(qualificationAppend).toBeGreaterThan(0);
    expect(
      store.operations
        .slice(0, qualificationAppend)
        .filter((operation) => operation.startsWith("fsync:")),
    ).toHaveLength(3);
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
    store.failAppendAt = 5;
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
      store.failAppendAt = failedAppend;
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

  it("reports conflicts without overwriting stale transaction bytes", async () => {
    const store = new MemoryRawArtifactStore();
    store.failAppendAt = 2;
    const service = new SourceSnapshotService({ store, hashes, ids: ids() });
    await service.create(input());
    const before = new Map(store.artifacts);
    delete store.failAppendAt;
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

  it("recovers a stale partial transaction deterministically", async () => {
    const store = new MemoryRawArtifactStore();
    store.failAppendAt = 2;
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

    delete store.failAppendAt;
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
