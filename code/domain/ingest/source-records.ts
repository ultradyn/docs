import type { Sha256, SnapshotId, SourceFileId } from "./types.js";

export interface SourceFile {
  schemaVersion: 1;
  id: SourceFileId;
  snapshotId: SnapshotId;
  logicalPath: string;
  mediaType: string;
  size: number;
  sha256: Sha256;
}

export interface SourceExclusion {
  logicalPath: string;
  mediaType: string;
  size: number;
  reason: string;
}

export interface SourceSnapshot {
  schemaVersion: 1;
  id: SnapshotId;
  packageSha256: Sha256;
  contentSha256: Sha256;
  policyId: string;
  files: readonly SourceFile[];
  exclusions: readonly SourceExclusion[];
  qualified: true;
}

export interface ReplayReceipt {
  snapshotId: SnapshotId;
  packageSha256: Sha256;
  filesVerified: number;
  verified: true;
}
