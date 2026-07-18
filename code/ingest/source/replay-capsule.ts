import type {
  IngestResult,
  ReplayReceipt,
  Sha256,
  SnapshotId,
  SourceFile,
  SourceSnapshot,
} from "../../domain/ingest/index.js";
import type { HashService, RawArtifactStore } from "./snapshot-service.js";

/**
 * Reads the transient upload representation a capsule is sealed from. The
 * upload area is owned by whoever staged the snapshot and may disappear once
 * custody is established; every guarantee after sealing is served from the
 * capsule's own retained bytes, never from here.
 */
export interface SourceByteReader {
  readPackage(snapshot: SourceSnapshot): Promise<Uint8Array | undefined>;
  readFile(file: SourceFile): Promise<Uint8Array | undefined>;
}

export type ReplayCapsuleErrorCode =
  | "IMMUTABLE_RAW_ARTIFACT"
  | "CAPSULE_NOT_FOUND"
  | "DIGEST_MISMATCH"
  | "SOURCE_UNAVAILABLE"
  | "REPLAY_UNVERIFIED";

export interface RetentionState {
  snapshotId: SnapshotId;
  fileCount: number;
  retainedBytes: number;
  /**
   * Capsules are retained indefinitely. Authorised erasure is deliberately
   * absent from this module: it is backlog task T-10-04, blocked on
   * docs/adr/0007-source-custody-deletion.md and on Max's ratification of the
   * D9 retention default. Until both land, no code path here may remove,
   * expire, or overwrite retained bytes.
   */
  policy: "retain-indefinitely";
  deletionAuthorised: false;
}

export interface ReplayCapsuleStoreDependencies {
  store: RawArtifactStore;
  hashes: HashService;
  source: SourceByteReader;
}

interface CapsuleFileRecord {
  logicalPath: string;
  sha256: Sha256;
  size: number;
}

/**
 * Binds the capsule to the exact snapshot identity it replays: changing any
 * bound field yields a different capsule rather than mutating this one.
 */
interface CapsuleManifest {
  schemaVersion: 1;
  snapshotId: SnapshotId;
  contentSha256: Sha256;
  packageSha256: Sha256;
  policyId: string;
  files: readonly CapsuleFileRecord[];
  exclusions: readonly {
    logicalPath: string;
    mediaType: string;
    size: number;
    reason: string;
  }[];
}

const CAPSULE_ROOT = "replay-capsules";

function blobPath(sha256: Sha256): string {
  return `${CAPSULE_ROOT}/blobs/${sha256}.raw`;
}

function capsulePath(snapshotId: SnapshotId): string {
  return `${CAPSULE_ROOT}/${snapshotId}/capsule.json`;
}

function stagedCapsulePath(snapshotId: SnapshotId): string {
  return `${CAPSULE_ROOT}/${snapshotId}/.staged/capsule.json`;
}

function failure(
  code: ReplayCapsuleErrorCode,
  message: string,
): { ok: false; code: ReplayCapsuleErrorCode; message: string } {
  return { ok: false, code, message };
}

/** Every content address a capsule retains: its package plus each file. */
function capsuleDigests(manifest: CapsuleManifest): readonly Sha256[] {
  return [manifest.packageSha256, ...manifest.files.map((file) => file.sha256)];
}

function serialize(manifest: CapsuleManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

function isCapsuleManifest(value: unknown): value is CapsuleManifest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.snapshotId === "string" &&
    typeof candidate.contentSha256 === "string" &&
    typeof candidate.packageSha256 === "string" &&
    typeof candidate.policyId === "string" &&
    Array.isArray(candidate.files) &&
    Array.isArray(candidate.exclusions)
  );
}

/**
 * Seals, verifies, exports, and retains immutable replay capsules.
 *
 * Custody bytes are content-addressed, so a path fully determines its
 * contents: re-sealing identical input is idempotent, and any attempt to place
 * different bytes at an existing path is refused by the append-only store as
 * IMMUTABLE_RAW_ARTIFACT rather than silently overwriting.
 *
 * This type has no deletion authority by design (see RetentionState.policy).
 */
export class ReplayCapsuleStore {
  readonly #store: RawArtifactStore;
  readonly #hashes: HashService;
  readonly #source: SourceByteReader;

  constructor(dependencies: ReplayCapsuleStoreDependencies) {
    this.#store = dependencies.store;
    this.#hashes = dependencies.hashes;
    this.#source = dependencies.source;
  }

  async seal(
    snapshot: SourceSnapshot,
  ): Promise<IngestResult<ReplayReceipt, ReplayCapsuleErrorCode>> {
    const existing = await this.#readManifest(snapshot.id);
    if (existing !== undefined) return this.#verifyManifest(existing);

    // The package is re-hashed against the snapshot's own digest, so upload
    // bytes that drifted from the qualified snapshot can never enter custody.
    const packageBytes = await this.#source.readPackage(snapshot);
    if (packageBytes === undefined) {
      return failure(
        "SOURCE_UNAVAILABLE",
        `upload package for ${snapshot.id} is no longer readable`,
      );
    }
    if ((await this.#hashes.sha256(packageBytes)) !== snapshot.packageSha256) {
      return failure(
        "DIGEST_MISMATCH",
        `upload package for ${snapshot.id} does not match its snapshot digest`,
      );
    }
    const retained = await this.#retain(snapshot.packageSha256, packageBytes);
    if (!retained.ok) return retained;

    const files: CapsuleFileRecord[] = [];
    for (const file of snapshot.files) {
      const bytes = await this.#source.readFile(file);
      if (bytes === undefined) {
        return failure(
          "SOURCE_UNAVAILABLE",
          `upload bytes for ${file.logicalPath} are no longer readable`,
        );
      }
      const sha256 = await this.#hashes.sha256(bytes);
      if (sha256 !== file.sha256) {
        return failure(
          "DIGEST_MISMATCH",
          `upload bytes for ${file.logicalPath} do not match the snapshot digest`,
        );
      }
      const blob = await this.#retain(sha256, bytes);
      if (!blob.ok) return blob;
      files.push({
        logicalPath: file.logicalPath,
        sha256,
        size: bytes.byteLength,
      });
    }

    const manifest: CapsuleManifest = {
      schemaVersion: 1,
      snapshotId: snapshot.id,
      contentSha256: snapshot.contentSha256,
      packageSha256: snapshot.packageSha256,
      policyId: snapshot.policyId,
      files,
      exclusions: snapshot.exclusions.map((exclusion) => ({ ...exclusion })),
    };

    // Every retained blob is read back and re-hashed BEFORE the capsule marker
    // exists, so a silently dropped or corrupted write can never be sealed
    // behind a marker that later reports a verified receipt.
    const retainedBytesVerified = await this.#verifyRetainedBytes(manifest);
    if (!retainedBytesVerified.ok) return retainedBytesVerified;

    const published = await this.#publishCapsule(snapshot.id, manifest);
    if (!published.ok) return published;

    return this.#verifyManifest(manifest);
  }

  async verify(
    snapshotId: SnapshotId,
  ): Promise<IngestResult<ReplayReceipt, ReplayCapsuleErrorCode>> {
    const manifest = await this.#readManifest(snapshotId);
    if (manifest === undefined) {
      return failure(
        "CAPSULE_NOT_FOUND",
        `no replay capsule is retained for ${snapshotId}`,
      );
    }
    return this.#verifyManifest(manifest);
  }

  /**
   * Copies retained bytes into another append-only store and rehashes every
   * artifact at the destination, so an export is only reported successful when
   * the copy is provably identical.
   */
  async export(
    snapshotId: SnapshotId,
    destination: RawArtifactStore,
  ): Promise<IngestResult<ReplayReceipt, ReplayCapsuleErrorCode>> {
    const manifest = await this.#readManifest(snapshotId);
    if (manifest === undefined) {
      return failure(
        "CAPSULE_NOT_FOUND",
        `no replay capsule is retained for ${snapshotId}`,
      );
    }

    for (const sha256 of capsuleDigests(manifest)) {
      const bytes = await this.#store.read(blobPath(sha256));
      if (bytes === undefined) {
        return failure(
          "CAPSULE_NOT_FOUND",
          `retained bytes ${sha256} are missing from custody`,
        );
      }
      if ((await this.#hashes.sha256(bytes)) !== sha256) {
        return failure(
          "DIGEST_MISMATCH",
          `retained bytes ${sha256} failed verification before export`,
        );
      }
      const outcome = await destination.write(blobPath(sha256), bytes);
      if (outcome === "conflict") {
        return failure(
          "IMMUTABLE_RAW_ARTIFACT",
          `destination already holds different bytes at ${blobPath(sha256)}`,
        );
      }
      await destination.fsync(blobPath(sha256));

      const copied = await destination.read(blobPath(sha256));
      if (copied === undefined || (await this.#hashes.sha256(copied)) !== sha256) {
        return failure(
          "DIGEST_MISMATCH",
          `exported copy of ${sha256} does not rehash to its content address`,
        );
      }
    }

    const capsuleBytes = await this.#store.read(capsulePath(snapshotId));
    if (capsuleBytes !== undefined) {
      const outcome = await destination.write(
        capsulePath(snapshotId),
        capsuleBytes,
      );
      if (outcome === "conflict") {
        return failure(
          "IMMUTABLE_RAW_ARTIFACT",
          `destination already holds a different capsule for ${snapshotId}`,
        );
      }
      await destination.fsync(capsulePath(snapshotId));
    }

    return this.#verifyManifest(manifest);
  }

  async retention(
    snapshotId: SnapshotId,
  ): Promise<IngestResult<RetentionState, ReplayCapsuleErrorCode>> {
    const manifest = await this.#readManifest(snapshotId);
    if (manifest === undefined) {
      return failure(
        "CAPSULE_NOT_FOUND",
        `no replay capsule is retained for ${snapshotId}`,
      );
    }
    return {
      ok: true,
      value: {
        snapshotId,
        fileCount: manifest.files.length,
        retainedBytes: manifest.files.reduce((total, f) => total + f.size, 0),
        policy: "retain-indefinitely",
        deletionAuthorised: false,
      },
    };
  }

  /**
   * The promotion gate: a snapshot may only be promoted when its capsule
   * currently verifies, so promotion can never outrun replayable custody.
   */
  async authorisePromotion(
    snapshotId: SnapshotId,
  ): Promise<IngestResult<ReplayReceipt, ReplayCapsuleErrorCode>> {
    const manifest = await this.#readManifest(snapshotId);
    if (manifest === undefined) {
      return failure(
        "REPLAY_UNVERIFIED",
        `promotion requires a sealed replay capsule for ${snapshotId}`,
      );
    }
    return this.#verifyManifest(manifest);
  }

  async #verifyRetainedBytes(
    manifest: CapsuleManifest,
  ): Promise<IngestResult<true, ReplayCapsuleErrorCode>> {
    for (const sha256 of capsuleDigests(manifest)) {
      const bytes = await this.#store.read(blobPath(sha256));
      if (bytes === undefined) {
        return failure(
          "CAPSULE_NOT_FOUND",
          `retained bytes ${sha256} are missing from custody`,
        );
      }
      if ((await this.#hashes.sha256(bytes)) !== sha256) {
        return failure(
          "DIGEST_MISMATCH",
          `retained bytes ${sha256} no longer match their content address`,
        );
      }
    }
    return { ok: true, value: true };
  }

  /** Stages then atomically publishes the capsule marker as the last step. */
  async #publishCapsule(
    snapshotId: SnapshotId,
    manifest: CapsuleManifest,
  ): Promise<IngestResult<true, ReplayCapsuleErrorCode>> {
    const staged = stagedCapsulePath(snapshotId);
    const written = await this.#retainAt(staged, serialize(manifest));
    if (!written.ok) return written;
    const outcome = await this.#store.publish(staged, capsulePath(snapshotId));
    if (outcome === "conflict") {
      return failure(
        "IMMUTABLE_RAW_ARTIFACT",
        `a different replay capsule is already retained for ${snapshotId}`,
      );
    }
    return { ok: true, value: true };
  }

  async #verifyManifest(
    manifest: CapsuleManifest,
  ): Promise<IngestResult<ReplayReceipt, ReplayCapsuleErrorCode>> {
    const verified = await this.#verifyRetainedBytes(manifest);
    if (!verified.ok) return verified;
    return {
      ok: true,
      value: {
        snapshotId: manifest.snapshotId,
        packageSha256: manifest.packageSha256,
        filesVerified: manifest.files.length,
        verified: true,
      },
    };
  }

  async #readManifest(
    snapshotId: SnapshotId,
  ): Promise<CapsuleManifest | undefined> {
    const bytes = await this.#store.read(capsulePath(snapshotId));
    if (bytes === undefined) return undefined;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isCapsuleManifest(parsed) ? parsed : undefined;
  }

  #retain(
    sha256: Sha256,
    bytes: Uint8Array,
  ): Promise<IngestResult<true, ReplayCapsuleErrorCode>> {
    return this.#retainAt(blobPath(sha256), bytes);
  }

  async #retainAt(
    path: string,
    bytes: Uint8Array,
  ): Promise<IngestResult<true, ReplayCapsuleErrorCode>> {
    const outcome = await this.#store.write(path, bytes);
    if (outcome === "conflict") {
      return failure(
        "IMMUTABLE_RAW_ARTIFACT",
        `refusing to overwrite retained custody bytes at ${path}`,
      );
    }
    await this.#store.fsync(path);
    return { ok: true, value: true };
  }
}
