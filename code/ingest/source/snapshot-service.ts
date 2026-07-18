import type { IdGenerator } from "../../domain/index.js";
import {
  type IngestResult,
  type ReplayReceipt,
  type Sha256,
  type SnapshotId,
  type SourceFile,
  type SourceFileId,
  type SourceSnapshot,
} from "../../domain/ingest/index.js";
import type { PreflightManifest } from "./preflight.js";

/** Append is atomic, append-only, and publishes no bytes when it rejects. */
export interface RawArtifactStore {
  read(path: string): Promise<Uint8Array | undefined>;
  append(path: string, bytes: Uint8Array): Promise<void>;
  fsync(path: string): Promise<void>;
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
  policyId: string;
  files: readonly SourceFile[];
}

class SnapshotConflictError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function manifestPath(id: SnapshotId): string {
  return `source-snapshots/${id}/manifest.json`;
}

function transactionRoot(idempotencyKey: Sha256): string {
  return `source-snapshots/.transactions/${idempotencyKey}`;
}

function intentPath(idempotencyKey: Sha256): string {
  return `${transactionRoot(idempotencyKey)}/intent.json`;
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
    policyId: intent.policyId,
    files: intent.files,
    qualified: true,
  };
}

function parseSnapshot(bytes: Uint8Array): SourceSnapshot {
  const value = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  if (
    keys !== "files,id,packageSha256,policyId,qualified,schemaVersion" ||
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    !/^[a-f0-9]{64}$/.test(String(value.packageSha256)) ||
    typeof value.policyId !== "string" ||
    value.policyId.length === 0 ||
    value.qualified !== true ||
    !Array.isArray(value.files)
  ) {
    throw new Error("qualified source snapshot manifest is invalid");
  }
  for (const file of value.files) {
    if (
      typeof file !== "object" ||
      file === null ||
      Object.keys(file).sort().join(",") !==
        "id,logicalPath,mediaType,sha256,size,snapshotId" ||
      typeof file.id !== "string" ||
      file.snapshotId !== value.id ||
      typeof file.logicalPath !== "string" ||
      file.logicalPath.length === 0 ||
      typeof file.mediaType !== "string" ||
      file.mediaType.length === 0 ||
      !Number.isSafeInteger(file.size) ||
      Number(file.size) < 0 ||
      !/^[a-f0-9]{64}$/.test(String(file.sha256))
    ) {
      throw new Error("qualified source snapshot manifest has invalid files");
    }
  }
  return value as unknown as SourceSnapshot;
}

export class SourceSnapshotService {
  readonly #store: RawArtifactStore;
  readonly #hashes: HashService;
  readonly #ids: IdGenerator;

  constructor(dependencies: SourceSnapshotServiceDependencies) {
    this.#store = dependencies.store;
    this.#hashes = dependencies.hashes;
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
        const snapshotId = this.#ids.next("artifact") as SnapshotId;
        const proposed: SnapshotIntent = {
          schemaVersion: 1,
          idempotencyKey,
          snapshotId,
          packageSha256: packageDigest,
          policyId: input.policyId,
          files: verifiedFiles.map((file) => ({
            id: this.#ids.next("artifact") as SourceFileId,
            snapshotId,
            logicalPath: file.logicalPath,
            mediaType: file.mediaType,
            size: file.size,
            sha256: file.sha256,
          })),
        };
        try {
          await this.#appendDurably(
            intentPath(idempotencyKey),
            serialize(proposed),
          );
          intent = proposed;
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
        await this.#store.fsync(manifestPath(snapshot.id));
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

      // The portable manifest is the sole qualification marker. It is appended
      // only after every transaction byte has been hash-checked and fsynced.
      await this.#appendDurably(manifestPath(snapshot.id), serialize(snapshot));
      return { ok: true, value: snapshot };
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
    const value = JSON.parse(decoder.decode(bytes)) as SnapshotIntent;
    if (
      value.schemaVersion !== 1 ||
      value.idempotencyKey !== idempotencyKey ||
      typeof value.snapshotId !== "string" ||
      typeof value.packageSha256 !== "string" ||
      typeof value.policyId !== "string" ||
      !Array.isArray(value.files)
    ) {
      throw new SnapshotConflictError("snapshot transaction intent is invalid");
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
  ): boolean {
    return (
      intent.policyId === policyId &&
      intent.packageSha256 === packageSha256 &&
      intent.files.length === files.length &&
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

  async #appendDurably(path: string, bytes: Uint8Array): Promise<void> {
    const existing = await this.#store.read(path);
    if (existing !== undefined) {
      if (!equalBytes(existing, bytes)) {
        throw new SnapshotConflictError(`append-only conflict at ${path}`);
      }
      await this.#store.fsync(path);
      return;
    }
    await this.#store.append(path, bytes);
    await this.#store.fsync(path);
  }
}
