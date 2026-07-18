import type { Sha256, SnapshotId, SourceFileId } from "./types.js";

export interface SourceFile {
  id: SourceFileId;
  snapshotId: SnapshotId;
  logicalPath: string;
  mediaType: string;
  size: number;
  sha256: Sha256;
}

export interface SourceSnapshot {
  schemaVersion: 1;
  id: SnapshotId;
  packageSha256: Sha256;
  policyId: string;
  files: readonly SourceFile[];
  qualified: true;
}

export interface ReplayReceipt {
  snapshotId: SnapshotId;
  packageSha256: Sha256;
  filesVerified: number;
  verified: true;
}
