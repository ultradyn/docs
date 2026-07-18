import { z } from "zod";

import type {
  IngestResult,
  ReplayReceipt,
  Sha256,
  SnapshotId,
  SourceFile,
  SourceSnapshot,
} from "../../domain/ingest/index.js";
import { SourceSnapshotSchema } from "../../domain/ingest/index.js";
import {
  deriveSourceSnapshotIdentity,
  type HashService,
  type RawArtifactStore,
} from "./snapshot-service.js";

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
  | "CAPSULE_CORRUPT"
  | "DIGEST_MISMATCH"
  | "PARTIAL_WRITE"
  | "SNAPSHOT_CONFLICT"
  | "INVALID_SNAPSHOT"
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

/**
 * The capsule carries the whole canonical SourceSnapshot rather than a lossy
 * projection, and is validated by a strict schema on every read. A hand-written
 * shape check would let a tampered manifest drop files or rebind identity and
 * still satisfy blob-only verification.
 */
const CapsuleManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshot: SourceSnapshotSchema,
  })
  .strict();

/**
 * The schema validates the runtime shape; the branded domain types carry the
 * compile-time identity guarantees, so the validated value is narrowed to the
 * canonical `SourceSnapshot` interface.
 */
interface CapsuleManifest {
  schemaVersion: 1;
  snapshot: SourceSnapshot;
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
  return [
    manifest.snapshot.packageSha256,
    ...manifest.snapshot.files.map((file) => file.sha256),
  ];
}

/**
 * Projects a snapshot into canonical field order. Both the digest and the
 * stored bytes are derived from this projection, so two semantically identical
 * caller objects with different insertion order canonicalize to the same
 * capsule and re-seal idempotently.
 */
/** Canonical field order for a fully identified file. */
function canonicalFileRecord(file: SourceFile): SourceFile {
  return {
    schemaVersion: 1,
    id: file.id,
    snapshotId: file.snapshotId,
    logicalPath: file.logicalPath,
    mediaType: file.mediaType,
    size: file.size,
    sha256: file.sha256,
  };
}

function canonicalSnapshot(
  snapshot: SourceSnapshot,
  files: readonly SourceFile[],
): SourceSnapshot {
  return {
    schemaVersion: 1,
    id: snapshot.id,
    packageSha256: snapshot.packageSha256,
    contentSha256: snapshot.contentSha256,
    policyId: snapshot.policyId,
    files,
    exclusions: snapshot.exclusions.map((exclusion) => ({
      logicalPath: exclusion.logicalPath,
      mediaType: exclusion.mediaType,
      size: exclusion.size,
      reason: exclusion.reason,
    })),
    qualified: true,
  };
}

function serialize(manifest: CapsuleManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
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
    input: SourceSnapshot,
  ): Promise<IngestResult<ReplayReceipt, ReplayCapsuleErrorCode>> {
    // Strict-parse the caller's snapshot BEFORE any custody write, so unknown
    // or malformed fields are rejected with a typed result rather than being
    // partially retained.
    const parsedInput = SourceSnapshotSchema.safeParse(input);
    if (!parsedInput.success) {
      return failure(
        "INVALID_SNAPSHOT",
        `snapshot failed strict validation: ${parsedInput.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
          )
          .join("; ")}`,
      );
    }

    // From here on the caller's object is never read again: `owned` is Zod's
    // own clone, so a caller mutating their snapshot mid-flight cannot change
    // what we hash, compare, or retain.
    const owned = parsedInput.data as unknown as SourceSnapshot;
    const identity = await this.#deriveIdentity(owned);
    if (!identity.ok) {
      return failure(
        "DIGEST_MISMATCH",
        `refusing to seal a snapshot whose identity is not content-bound: ${owned.id}`,
      );
    }
    const snapshot = identity.value;

    // Re-sealing adopts retained custody only when the proposed snapshot is
    // canonically identical. Retained provenance is never rewritten, so a
    // caller whose input disagrees learns it rather than silently inheriting
    // someone else's capsule.
    const retainedBytes = await this.#store.read(capsulePath(snapshot.id));
    if (retainedBytes !== undefined) {
      const existing = await this.#readManifest(snapshot.id);
      if (!existing.ok) return existing;
      // Byte comparison against the canonical serialization: comparing parsed
      // objects would be key-order sensitive and could report a spurious
      // conflict for an identical re-seal.
      const proposed = serialize({ schemaVersion: 1, snapshot });
      // Defence in depth: content addressing means a canonical capsule bound
      // to this id must already have this exact content, so this branch is
      // unreachable short of a hash collision or a store that returns bytes
      // from another key. It is retained so such a store fails loudly.
      if (!Buffer.from(retainedBytes).equals(Buffer.from(proposed))) {
        return failure(
          "SNAPSHOT_CONFLICT",
          `a different snapshot is already retained for ${snapshot.id}`,
        );
      }
      return this.#verifyManifest(existing.value);
    }

    // The package is re-hashed against the snapshot's own digest, so upload
    // bytes that drifted from the qualified snapshot can never enter custody.
    let packageBytes: Uint8Array | undefined;
    try {
      const supplied = await this.#source.readPackage(snapshot);
      // Copy immediately: a reader may hand back a buffer it still owns and
      // could mutate while we await hashing or storage.
      packageBytes =
        supplied === undefined ? undefined : Uint8Array.from(supplied);
    } catch (error) {
      return failure(
        "SOURCE_UNAVAILABLE",
        `upload package for ${snapshot.id} could not be read: ${String(error)}`,
      );
    }
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

    for (const file of snapshot.files) {
      let bytes: Uint8Array | undefined;
      try {
        const supplied = await this.#source.readFile(file);
        bytes = supplied === undefined ? undefined : Uint8Array.from(supplied);
      } catch (error) {
        return failure(
          "SOURCE_UNAVAILABLE",
          `upload bytes for ${file.logicalPath} could not be read: ${String(error)}`,
        );
      }
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
      // The declared size is bound too: a manifest may not claim a size that
      // disagrees with the bytes actually retained.
      if (bytes.byteLength !== file.size) {
        return failure(
          "DIGEST_MISMATCH",
          `upload bytes for ${file.logicalPath} do not match the declared size`,
        );
      }
      const blob = await this.#retain(sha256, bytes);
      if (!blob.ok) return blob;
    }

    const manifest: CapsuleManifest = { schemaVersion: 1, snapshot };

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
    if (!manifest.ok) return manifest;
    return this.#verifyManifest(manifest.value);
  }

  /**
   * Copies retained bytes into another append-only store and re-reads the
   * result there: the source is verified first, every artifact is written
   * exclusively, and both the destination blobs and the destination marker are
   * re-read and re-verified before an export is reported successful.
   */
  async export(
    snapshotId: SnapshotId,
    destination: RawArtifactStore,
  ): Promise<IngestResult<ReplayReceipt, ReplayCapsuleErrorCode>> {
    const read = await this.#readManifest(snapshotId);
    if (!read.ok) return read;
    const manifest = read.value;

    // Never export custody that does not currently verify at the source.
    const sourceVerified = await this.#verifyRetainedBytes(manifest);
    if (!sourceVerified.ok) return sourceVerified;

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
      if (
        copied === undefined ||
        (await this.#hashes.sha256(copied)) !== sha256
      ) {
        return failure(
          "DIGEST_MISMATCH",
          `exported copy of ${sha256} does not rehash to its content address`,
        );
      }
    }

    const capsuleBytes = await this.#store.read(capsulePath(snapshotId));
    if (capsuleBytes === undefined) {
      return failure(
        "CAPSULE_NOT_FOUND",
        `capsule marker for ${snapshotId} disappeared during export`,
      );
    }
    const staged = stagedCapsulePath(snapshotId);
    const stagedOutcome = await destination.write(staged, capsuleBytes);
    if (stagedOutcome === "conflict") {
      return failure(
        "IMMUTABLE_RAW_ARTIFACT",
        `destination already holds a different staged capsule for ${snapshotId}`,
      );
    }
    await destination.fsync(staged);
    const publishOutcome = await destination.publish(
      staged,
      capsulePath(snapshotId),
    );
    if (publishOutcome === "conflict") {
      return failure(
        "IMMUTABLE_RAW_ARTIFACT",
        `destination already holds a different capsule for ${snapshotId}`,
      );
    }

    // Re-read the destination marker through the same strict path used at the
    // source, so a destination that drops or corrupts it cannot be reported as
    // a successful export.
    const confirmed = await this.#confirmPublishedMarker(
      snapshotId,
      capsuleBytes,
      destination,
    );
    if (!confirmed.ok) return confirmed;

    return this.#verifyManifest(manifest);
  }

  async retention(
    snapshotId: SnapshotId,
  ): Promise<IngestResult<RetentionState, ReplayCapsuleErrorCode>> {
    const read = await this.#readManifest(snapshotId);
    if (!read.ok) return read;
    const snapshot = read.value.snapshot;

    // Custody is verified before it is measured, so retention can never report
    // a stale size for bytes that are missing, truncated, or corrupt.
    const verified = await this.#verifyRetainedBytes(read.value);
    if (!verified.ok) return verified;

    // Sizes are measured from the retained blobs themselves, not trusted from
    // the manifest, and each file's actual length must match what it declares.
    const packageBytes = await this.#store.read(
      blobPath(snapshot.packageSha256),
    );
    if (packageBytes === undefined) {
      return failure(
        "CAPSULE_NOT_FOUND",
        `retained package bytes are missing for ${snapshotId}`,
      );
    }
    let retainedBytes = packageBytes.byteLength;
    for (const file of snapshot.files) {
      const bytes = await this.#store.read(blobPath(file.sha256));
      if (bytes === undefined) {
        return failure(
          "CAPSULE_NOT_FOUND",
          `retained bytes are missing for ${file.logicalPath}`,
        );
      }
      if (bytes.byteLength !== file.size) {
        return failure(
          "DIGEST_MISMATCH",
          `retained bytes for ${file.logicalPath} are ${bytes.byteLength}, manifest declares ${file.size}`,
        );
      }
      retainedBytes += bytes.byteLength;
    }

    return {
      ok: true,
      value: {
        snapshotId,
        fileCount: snapshot.files.length,
        // Package plus every file. The capsule marker describes custody rather
        // than being retained source content, so it is deliberately excluded.
        retainedBytes,
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
    if (!manifest.ok) {
      return manifest.code === "CAPSULE_NOT_FOUND"
        ? failure(
            "REPLAY_UNVERIFIED",
            `promotion requires a sealed replay capsule for ${snapshotId}`,
          )
        : manifest;
    }
    return this.#verifyManifest(manifest.value);
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

  /**
   * Stages then atomically publishes the capsule marker as the last step, and
   * re-reads the published marker before reporting success: a store that
   * acknowledges a publish while dropping, corrupting, or substituting the
   * final bytes must not be able to produce a sealed capsule.
   */
  async #publishCapsule(
    snapshotId: SnapshotId,
    manifest: CapsuleManifest,
  ): Promise<IngestResult<true, ReplayCapsuleErrorCode>> {
    const staged = stagedCapsulePath(snapshotId);
    const written = await this.#retainAt(staged, serialize(manifest));
    if (!written.ok) return written;
    const outcome = await this.#store.publish(staged, capsulePath(snapshotId));
    if (outcome === "conflict") {
      // Publication is exclusive: an identical contender loses the marker
      // race too. It may adopt that winner only after the same readback,
      // strict parsing, and exact-byte comparison used for its own publish,
      // followed by a full custody verification.
      const confirmed = await this.#confirmPublishedMarker(
        snapshotId,
        serialize(manifest),
        this.#store,
      );
      if (!confirmed.ok) {
        return failure(
          "IMMUTABLE_RAW_ARTIFACT",
          `a different replay capsule is already retained for ${snapshotId}`,
        );
      }
      const winner = await this.#readManifest(snapshotId);
      if (!winner.ok) {
        return failure(
          "IMMUTABLE_RAW_ARTIFACT",
          `a different replay capsule is already retained for ${snapshotId}`,
        );
      }
      const verified = await this.#verifyManifest(winner.value);
      if (!verified.ok) {
        return failure(
          "IMMUTABLE_RAW_ARTIFACT",
          `the retained replay capsule for ${snapshotId} failed custody verification`,
        );
      }
      return { ok: true, value: true };
    }
    return this.#confirmPublishedMarker(
      snapshotId,
      serialize(manifest),
      this.#store,
    );
  }

  /** Re-reads a published marker and proves it is exactly what was intended. */
  async #confirmPublishedMarker(
    snapshotId: SnapshotId,
    intendedBytes: Uint8Array,
    store: RawArtifactStore,
  ): Promise<IngestResult<true, ReplayCapsuleErrorCode>> {
    // Compare the stored bytes to the intended serialization. Comparing parsed
    // objects would be order-sensitive and could mask a substituted marker that
    // happens to parse; bytes are exact.
    const stored = await store.read(capsulePath(snapshotId));
    if (stored === undefined) {
      return failure(
        "PARTIAL_WRITE",
        `capsule marker for ${snapshotId} was acknowledged but is not readable`,
      );
    }
    if (!Buffer.from(stored).equals(Buffer.from(intendedBytes))) {
      return failure(
        "PARTIAL_WRITE",
        `published capsule marker for ${snapshotId} differs from the sealed manifest`,
      );
    }

    // And re-read it through the strict path, so the published marker is also
    // proven schema-valid and content-bound, not merely byte-equal.
    const published = await this.#readManifest(snapshotId, store);
    if (!published.ok) {
      return published.code === "CAPSULE_NOT_FOUND"
        ? failure(
            "PARTIAL_WRITE",
            `capsule marker for ${snapshotId} was acknowledged but is not readable`,
          )
        : published;
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
        snapshotId: manifest.snapshot.id,
        packageSha256: manifest.snapshot.packageSha256,
        filesVerified: manifest.snapshot.files.length,
        verified: true,
      },
    };
  }

  /**
   * Reads a capsule manifest through the strict schema and re-derives its
   * identity from its own content using the snapshot plane's canonical rules,
   * so a manifest that was edited in place — dropped files, rebound policy,
   * swapped snapshot id — is rejected rather than trusted.
   */
  async #readManifest(
    snapshotId: SnapshotId,
    store: RawArtifactStore = this.#store,
  ): Promise<IngestResult<CapsuleManifest, ReplayCapsuleErrorCode>> {
    const bytes = await store.read(capsulePath(snapshotId));
    if (bytes === undefined) {
      return failure(
        "CAPSULE_NOT_FOUND",
        `no replay capsule is retained for ${snapshotId}`,
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      return failure(
        "CAPSULE_CORRUPT",
        `replay capsule for ${snapshotId} is not readable JSON: ${String(error)}`,
      );
    }

    const parsed = CapsuleManifestSchema.safeParse(decoded);
    if (!parsed.success) {
      return failure(
        "CAPSULE_CORRUPT",
        `replay capsule for ${snapshotId} failed strict validation: ${parsed.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
          )
          .join("; ")}`,
      );
    }

    // Schema validation establishes the runtime shape; identity verification
    // below re-derives every branded identifier from content, which is what
    // actually earns the branded narrowing.
    const manifest: CapsuleManifest = {
      schemaVersion: 1,
      snapshot: parsed.data.snapshot as unknown as SourceSnapshot,
    };

    const bound = await this.#deriveIdentity(manifest.snapshot);
    if (!bound.ok) return bound;
    if (bound.value.id !== snapshotId) {
      return failure(
        "CAPSULE_CORRUPT",
        `replay capsule at ${snapshotId} is bound to ${bound.value.id}`,
      );
    }

    // Stored bytes must be exactly the canonical serialization. Reordered keys
    // or non-canonical whitespace are treated as corruption, not accepted, so
    // there is exactly one byte representation of any given capsule.
    const canonical: CapsuleManifest = {
      schemaVersion: 1,
      snapshot: bound.value,
    };
    if (!Buffer.from(bytes).equals(Buffer.from(serialize(canonical)))) {
      return failure(
        "CAPSULE_CORRUPT",
        `replay capsule for ${snapshotId} is not in canonical form`,
      );
    }
    return { ok: true, value: canonical };
  }

  /**
   * Recomputes the content-derived snapshot id, content digest, and every file
   * identity using the same canonical rules the snapshot plane qualifies with.
   */
  /**
   * Re-derives identity from content and returns the canonical projection of
   * the snapshot. Callers use the returned value so that both digests and
   * stored bytes are independent of the caller's field order.
   */
  async #deriveIdentity(
    snapshot: SourceSnapshot,
  ): Promise<IngestResult<SourceSnapshot, ReplayCapsuleErrorCode>> {
    const identity = await deriveSourceSnapshotIdentity(this.#hashes, {
      packageSha256: snapshot.packageSha256,
      policyId: snapshot.policyId,
      files: snapshot.files,
      exclusions: snapshot.exclusions,
    });
    if (
      identity.contentSha256 !== snapshot.contentSha256 ||
      snapshot.id !== identity.snapshotId
    ) {
      return failure(
        "CAPSULE_CORRUPT",
        `snapshot content binding is invalid for ${snapshot.id}`,
      );
    }
    // Every file id, path, media type, size and digest must match what the
    // canonical derivation produces, so metadata tampering cannot survive.
    // Compare canonical-to-canonical: the caller's field order must not
    // decide whether identity matches.
    if (
      JSON.stringify(identity.files) !==
      JSON.stringify(snapshot.files.map(canonicalFileRecord))
    ) {
      return failure(
        "CAPSULE_CORRUPT",
        `snapshot file identity binding is invalid for ${snapshot.id}`,
      );
    }
    return { ok: true, value: canonicalSnapshot(snapshot, identity.files) };
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
