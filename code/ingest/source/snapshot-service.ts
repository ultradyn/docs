import type { IdGenerator } from "../../domain/index.js";
import {
  type IngestResult,
  type ReplayReceipt,
  type Sha256,
  type SnapshotId,
  type SourceExclusion,
  type SourceFile,
  type SourceFileId,
  SourceSnapshotSchema,
  type SourceSnapshot,
} from "../../domain/ingest/index.js";
import { z } from "zod";
import type { PreflightManifest } from "./preflight.js";

export type StageWriteOutcome = "written" | "identical" | "conflict";
export type PublishOutcome = "published" | "conflict";

/**
 * Staging writes are append-only. publish atomically and exclusively exposes a
 * fully-synced staged artifact at its final path.
 */
export interface RawArtifactStore {
  read(path: string): Promise<Uint8Array | undefined>;
  write(path: string, bytes: Uint8Array): Promise<StageWriteOutcome>;
  fsync(path: string): Promise<void>;
  publish(source: string, finalPath: string): Promise<PublishOutcome>;
}

export interface HashService {
  sha256(bytes: Uint8Array): Promise<Sha256>;
}

export interface SnapshotPackage {
  bytes: Uint8Array;
  sha256: Sha256;
}

export interface SnapshotInputFile {
  logicalPath: string;
  bytes: Uint8Array;
  sha256: Sha256;
}

export interface CreateSourceSnapshotInput {
  preflight: PreflightManifest;
  policyId: string;
  package: SnapshotPackage;
  files: readonly SnapshotInputFile[];
}

export type SnapshotCreateErrorCode =
  "DIGEST_MISMATCH" | "PARTIAL_WRITE" | "SNAPSHOT_CONFLICT";

export interface SourceSnapshotServiceDependencies {
  store: RawArtifactStore;
  hashes: HashService;
  ids: IdGenerator;
}

interface SnapshotIntent {
  schemaVersion: 1;
  idempotencyKey: Sha256;
  snapshotId: SnapshotId;
  packageSha256: Sha256;
  contentSha256: Sha256;
  policyId: string;
  files: readonly SourceFile[];
  exclusions: readonly SourceExclusion[];
}

class SnapshotConflictError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceFileSchema = SourceSnapshotSchema.shape.files.element;
const snapshotIntentSchema = z
  .object({
    schemaVersion: z.literal(1),
    idempotencyKey: sha256Schema,
    snapshotId: z.string().min(1),
    packageSha256: sha256Schema,
    contentSha256: sha256Schema,
    policyId: z.string().min(1),
    files: z.array(sourceFileSchema),
    exclusions: SourceSnapshotSchema.shape.exclusions,
  })
  .strict();

function manifestPath(id: SnapshotId): string {
  return `source-snapshots/${id}/manifest.json`;
}

function transactionRoot(idempotencyKey: Sha256): string {
  return `source-snapshots/.transactions/${idempotencyKey}`;
}

function intentPath(idempotencyKey: Sha256): string {
  return `${transactionRoot(idempotencyKey)}/intent.json`;
}

function stagedManifestPath(idempotencyKey: Sha256, attemptId: string): string {
  return `${transactionRoot(idempotencyKey)}/attempts/${attemptId}/manifest.staged.json`;
}

function packagePath(idempotencyKey: Sha256): string {
  return `${transactionRoot(idempotencyKey)}/package.raw`;
}

function filePath(idempotencyKey: Sha256, file: SourceFile): string {
  return `${transactionRoot(idempotencyKey)}/files/${file.id}.raw`;
}

function serialize(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The canonical content-address rules for source snapshots. These are exported
 * so that every custody surface (snapshot qualification and replay capsules
 * alike) derives identity from one definition; a second copy of these rules
 * could drift and let a capsule vouch for a snapshot the snapshot plane would
 * reject.
 */
export interface SourceSnapshotContentInput {
  packageSha256: Sha256;
  policyId: string;
  files: readonly {
    logicalPath: string;
    mediaType: string;
    size: number;
    sha256: Sha256;
  }[];
  exclusions: readonly SourceExclusion[];
}

export interface SourceSnapshotIdentity {
  contentSha256: Sha256;
  snapshotId: SnapshotId;
  files: readonly SourceFile[];
}

/**
 * Projects a file into canonical field order. Identity must never depend on
 * the insertion order of a caller's object literal.
 */
function canonicalFile(file: {
  logicalPath: string;
  mediaType: string;
  size: number;
  sha256: Sha256;
}): {
  schemaVersion: 1;
  logicalPath: string;
  mediaType: string;
  size: number;
  sha256: Sha256;
} {
  return {
    schemaVersion: 1,
    logicalPath: file.logicalPath,
    mediaType: file.mediaType,
    size: file.size,
    sha256: file.sha256,
  };
}

/** Projects an exclusion into canonical field order, for the same reason. */
function canonicalExclusion(exclusion: SourceExclusion): SourceExclusion {
  return {
    logicalPath: exclusion.logicalPath,
    mediaType: exclusion.mediaType,
    size: exclusion.size,
    reason: exclusion.reason,
  };
}

/**
 * The single canonical identity derivation for source snapshots: content
 * digest, content-derived snapshot id, and every content-derived file id.
 *
 * Both the snapshot plane (qualification) and the replay plane (custody) call
 * this one implementation. A second copy of these rules could drift and let a
 * capsule vouch for a snapshot the snapshot plane would reject.
 */
export async function deriveSourceSnapshotIdentity(
  hashes: HashService,
  input: SourceSnapshotContentInput,
): Promise<SourceSnapshotIdentity> {
  const files = input.files.map(canonicalFile);
  const contentSha256 = await hashes.sha256(
    serialize({
      schemaVersion: 1,
      packageSha256: input.packageSha256,
      policyId: input.policyId,
      files,
      exclusions: input.exclusions.map(canonicalExclusion),
      qualified: true,
    }),
  );
  const snapshotId = `snap-${contentSha256}` as SnapshotId;

  const identified: SourceFile[] = [];
  for (const file of files) {
    const identity = await hashes.sha256(
      serialize({
        schemaVersion: file.schemaVersion,
        snapshotId,
        logicalPath: file.logicalPath,
        mediaType: file.mediaType,
        size: file.size,
        sha256: file.sha256,
      }),
    );
    identified.push({
      schemaVersion: 1,
      id: `file-${identity}` as SourceFileId,
      snapshotId,
      logicalPath: file.logicalPath,
      mediaType: file.mediaType,
      size: file.size,
      sha256: file.sha256,
    });
  }
  return { contentSha256, snapshotId, files: identified };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(right);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function snapshotFromIntent(intent: SnapshotIntent): SourceSnapshot {
  return {
    schemaVersion: 1,
    id: intent.snapshotId,
    packageSha256: intent.packageSha256,
    contentSha256: intent.contentSha256,
    policyId: intent.policyId,
    files: intent.files,
    exclusions: intent.exclusions,
    qualified: true,
  };
}

function parseSnapshot(bytes: Uint8Array): SourceSnapshot {
  const parsed = SourceSnapshotSchema.safeParse(
    JSON.parse(decoder.decode(bytes)),
  );
  if (!parsed.success) {
    throw new Error("qualified source snapshot manifest is invalid");
  }
  if (parsed.data.files.some((file) => file.snapshotId !== parsed.data.id)) {
    throw new Error("qualified source snapshot manifest has invalid files");
  }
  return parsed.data as unknown as SourceSnapshot;
}

export class SourceSnapshotService {
  readonly #store: RawArtifactStore;
  readonly #hashes: HashService;
  readonly #ids: IdGenerator;

  constructor(dependencies: SourceSnapshotServiceDependencies) {
    this.#store = dependencies.store;
    this.#hashes = dependencies.hashes;
    // IDs from this stream name only ephemeral publication attempts. Portable
    // snapshot and file identities are derived exclusively from bound content.
    this.#ids = dependencies.ids;
  }

  async create(
    input: CreateSourceSnapshotInput,
  ): Promise<IngestResult<SourceSnapshot, SnapshotCreateErrorCode>> {
    const packageDigest = await this.#hashes.sha256(input.package.bytes);
    if (packageDigest !== input.package.sha256) {
      return this.#digestMismatch(
        "source package digest does not match its declared digest",
      );
    }

    const included = input.preflight.entries.filter((entry) => entry.included);
    if (included.length !== input.files.length) {
      return this.#digestMismatch(
        "snapshot files do not match the successful preflight manifest",
      );
    }

    const verifiedFiles: Array<{
      logicalPath: string;
      mediaType: string;
      size: number;
      sha256: Sha256;
      bytes: Uint8Array;
    }> = [];
    const usedInputs = new Set<SnapshotInputFile>();
    for (const entry of included) {
      const matches = input.files.filter(
        (candidate) => candidate.logicalPath === entry.logicalPath,
      );
      const source = matches[0];
      if (
        matches.length !== 1 ||
        source === undefined ||
        usedInputs.has(source) ||
        source.bytes.byteLength !== entry.size ||
        (await this.#hashes.sha256(source.bytes)) !== source.sha256
      ) {
        return this.#digestMismatch(
          `source file digest or provenance mismatch: ${entry.logicalPath}`,
        );
      }
      usedInputs.add(source);
      verifiedFiles.push({
        logicalPath: entry.logicalPath,
        mediaType: entry.mediaType,
        size: entry.size,
        sha256: source.sha256,
        bytes: source.bytes,
      });
    }

    const idempotencyKey = await this.#hashes.sha256(
      encoder.encode(`${packageDigest}\0${input.policyId}`),
    );

    try {
      let intent = await this.#readIntent(idempotencyKey);
      if (intent === undefined) {
        const exclusions = input.preflight.entries
          .filter((entry) => !entry.included)
          .map(({ logicalPath, mediaType, size, reason }) => ({
            logicalPath,
            mediaType,
            size,
            reason,
          }));
        const { contentSha256, snapshotId, files } =
          await deriveSourceSnapshotIdentity(this.#hashes, {
            packageSha256: packageDigest,
            policyId: input.policyId,
            files: verifiedFiles,
            exclusions,
          });
        const proposed: SnapshotIntent = {
          schemaVersion: 1,
          idempotencyKey,
          snapshotId,
          packageSha256: packageDigest,
          contentSha256,
          policyId: input.policyId,
          files,
          exclusions,
        };
        try {
          await this.#appendDurably(
            intentPath(idempotencyKey),
            serialize(proposed),
          );
          intent = await this.#readIntent(idempotencyKey);
          if (intent === undefined || !sameJson(intent, proposed)) {
            throw new Error("persisted snapshot intent failed verification");
          }
        } catch (error) {
          if (!(error instanceof SnapshotConflictError)) throw error;
          // A concurrent creator may have won the exclusive append. Adopt its
          // deterministic intent only if it describes the exact same input.
          intent = await this.#readIntent(idempotencyKey);
          if (intent === undefined) throw error;
        }
      }
      if (
        !this.#intentMatchesInput(
          intent,
          input.policyId,
          packageDigest,
          verifiedFiles,
          input.preflight.entries
            .filter((entry) => !entry.included)
            .map(({ logicalPath, mediaType, size, reason }) => ({
              logicalPath,
              mediaType,
              size,
              reason,
            })),
        )
      ) {
        throw new SnapshotConflictError(
          "package and policy already identify different snapshot contents",
        );
      }

      const snapshot = snapshotFromIntent(intent);
      const existingManifest = await this.#store.read(
        manifestPath(snapshot.id),
      );
      if (existingManifest !== undefined) {
        const published = parseSnapshot(existingManifest);
        if (!sameJson(published, snapshot)) {
          throw new SnapshotConflictError(
            "qualified snapshot manifest conflicts with its transaction intent",
          );
        }
        await this.verify(snapshot.id);
        return { ok: true, value: published };
      }

      await this.#appendDurably(
        packagePath(idempotencyKey),
        input.package.bytes,
      );
      for (let index = 0; index < intent.files.length; index += 1) {
        await this.#appendDurably(
          filePath(idempotencyKey, intent.files[index]!),
          verifiedFiles[index]!.bytes,
        );
      }
      await this.#verifyPersistedReplay(idempotencyKey, snapshot);

      // The portable manifest is the sole qualification marker. Its staged
      // bytes are durable before one exclusive atomic publication exposes it.
      const stagedManifest = stagedManifestPath(
        idempotencyKey,
        this.#ids.next("artifact"),
      );
      const manifestBytes = serialize(snapshot);
      await this.#appendDurably(stagedManifest, manifestBytes);
      const persistedManifest = await this.#store.read(stagedManifest);
      if (
        persistedManifest === undefined ||
        (await this.#hashes.sha256(persistedManifest)) !==
          (await this.#hashes.sha256(manifestBytes)) ||
        !equalBytes(persistedManifest, manifestBytes) ||
        !sameJson(parseSnapshot(persistedManifest), snapshot)
      ) {
        throw new Error("persisted source manifest failed verification");
      }
      let outcome: PublishOutcome;
      try {
        outcome = await this.#store.publish(
          stagedManifest,
          manifestPath(snapshot.id),
        );
      } catch (error) {
        const publishedBytes = await this.#store.read(
          manifestPath(snapshot.id),
        );
        if (publishedBytes === undefined) throw error;
        const published = parseSnapshot(publishedBytes);
        if (!sameJson(published, snapshot)) {
          throw new SnapshotConflictError(
            "qualified snapshot manifest conflicts after publication uncertainty",
          );
        }
        await this.verify(snapshot.id);
        return { ok: true, value: published };
      }
      const publishedBytes = await this.#store.read(manifestPath(snapshot.id));
      if (publishedBytes === undefined) {
        throw new Error("published snapshot manifest is not readable");
      }
      const published = parseSnapshot(publishedBytes);
      if (!sameJson(published, snapshot)) {
        throw new SnapshotConflictError(
          outcome === "conflict"
            ? "qualified snapshot manifest conflicts with staged snapshot"
            : "published snapshot manifest conflicts with staged snapshot",
        );
      }
      await this.verify(snapshot.id);
      return { ok: true, value: published };
    } catch (error) {
      if (error instanceof SnapshotConflictError) {
        return {
          ok: false,
          code: "SNAPSHOT_CONFLICT",
          message: error.message,
        };
      }
      return {
        ok: false,
        code: "PARTIAL_WRITE",
        message: `source snapshot could not be published: ${String(error)}`,
      };
    }
  }

  async verify(id: SnapshotId): Promise<ReplayReceipt> {
    const manifestBytes = await this.#store.read(manifestPath(id));
    if (manifestBytes === undefined) {
      throw new Error(`qualified source snapshot manifest is missing: ${id}`);
    }
    const snapshot = parseSnapshot(manifestBytes);
    if (snapshot.id !== id) {
      throw new Error(
        `qualified source snapshot manifest has the wrong id: ${id}`,
      );
    }

    const idempotencyKey = await this.#hashes.sha256(
      encoder.encode(`${snapshot.packageSha256}\0${snapshot.policyId}`),
    );
    const intent = await this.#readIntent(idempotencyKey);
    if (
      intent === undefined ||
      !sameJson(snapshot, snapshotFromIntent(intent))
    ) {
      throw new Error(`source snapshot manifest is modified or unbound: ${id}`);
    }
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
      throw new Error(`source snapshot content binding is invalid: ${id}`);
    }
    if (!sameJson(identity.files, snapshot.files)) {
      throw new Error(
        `source snapshot file identity binding is invalid: ${id}`,
      );
    }

    const packageBytes = await this.#store.read(packagePath(idempotencyKey));
    if (
      packageBytes === undefined ||
      (await this.#hashes.sha256(packageBytes)) !== snapshot.packageSha256
    ) {
      throw new Error(`source snapshot package is missing or modified: ${id}`);
    }
    for (const file of snapshot.files) {
      const bytes = await this.#store.read(filePath(idempotencyKey, file));
      if (
        bytes === undefined ||
        bytes.byteLength !== file.size ||
        (await this.#hashes.sha256(bytes)) !== file.sha256
      ) {
        throw new Error(
          `source snapshot file is missing or modified: ${file.logicalPath}`,
        );
      }
    }
    return {
      snapshotId: id,
      packageSha256: snapshot.packageSha256,
      filesVerified: snapshot.files.length,
      verified: true,
    };
  }

  #digestMismatch(
    message: string,
  ): IngestResult<SourceSnapshot, SnapshotCreateErrorCode> {
    return { ok: false, code: "DIGEST_MISMATCH", message };
  }

  async #readIntent(
    idempotencyKey: Sha256,
  ): Promise<SnapshotIntent | undefined> {
    const bytes = await this.#store.read(intentPath(idempotencyKey));
    if (bytes === undefined) return undefined;
    const parsed = snapshotIntentSchema.safeParse(
      JSON.parse(decoder.decode(bytes)),
    );
    if (
      !parsed.success ||
      parsed.data.idempotencyKey !== idempotencyKey ||
      parsed.data.files.some(
        (file) => file.snapshotId !== parsed.data.snapshotId,
      )
    ) {
      throw new SnapshotConflictError("snapshot transaction intent is invalid");
    }
    const value = parsed.data as unknown as SnapshotIntent;
    const identity = await deriveSourceSnapshotIdentity(this.#hashes, {
      packageSha256: value.packageSha256,
      policyId: value.policyId,
      files: value.files,
      exclusions: value.exclusions,
    });
    if (
      identity.contentSha256 !== value.contentSha256 ||
      value.snapshotId !== identity.snapshotId
    ) {
      throw new SnapshotConflictError(
        "snapshot transaction intent has an invalid content binding",
      );
    }
    return value;
  }

  #intentMatchesInput(
    intent: SnapshotIntent,
    policyId: string,
    packageSha256: Sha256,
    files: readonly {
      logicalPath: string;
      mediaType: string;
      size: number;
      sha256: Sha256;
    }[],
    exclusions: readonly SourceExclusion[],
  ): boolean {
    return (
      intent.policyId === policyId &&
      intent.packageSha256 === packageSha256 &&
      intent.files.length === files.length &&
      sameJson(intent.exclusions, exclusions) &&
      intent.files.every((record, index) => {
        const source = files[index]!;
        return (
          record.snapshotId === intent.snapshotId &&
          record.logicalPath === source.logicalPath &&
          record.mediaType === source.mediaType &&
          record.size === source.size &&
          record.sha256 === source.sha256
        );
      })
    );
  }

  async #verifyPersistedReplay(
    idempotencyKey: Sha256,
    snapshot: SourceSnapshot,
  ): Promise<void> {
    const packageBytes = await this.#store.read(packagePath(idempotencyKey));
    if (
      packageBytes === undefined ||
      (await this.#hashes.sha256(packageBytes)) !== snapshot.packageSha256
    ) {
      throw new Error("persisted source package failed verification");
    }
    for (const file of snapshot.files) {
      const bytes = await this.#store.read(filePath(idempotencyKey, file));
      if (
        bytes === undefined ||
        bytes.byteLength !== file.size ||
        (await this.#hashes.sha256(bytes)) !== file.sha256
      ) {
        throw new Error(
          `persisted source file failed verification: ${file.logicalPath}`,
        );
      }
    }
  }

  async #appendDurably(path: string, bytes: Uint8Array): Promise<void> {
    const existing = await this.#store.read(path);
    if (existing !== undefined) {
      if (!equalBytes(existing, bytes)) {
        throw new SnapshotConflictError(`append-only conflict at ${path}`);
      }
      await this.#store.fsync(path);
      return;
    }
    const outcome = await this.#store.write(path, bytes);
    if (outcome === "conflict") {
      throw new SnapshotConflictError(`append-only conflict at ${path}`);
    }
    await this.#store.fsync(path);
  }
}
