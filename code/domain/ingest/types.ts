export type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type SnapshotId = Brand<string, "SnapshotId">;
export type SourceFileId = Brand<string, "SourceFileId">;
export type SourceRepresentationId = Brand<string, "SourceRepresentationId">;
export type SourceUnitId = Brand<string, "SourceUnitId">;
export type QuestionId = Brand<string, "QuestionId">;
export type ObligationId = Brand<string, "ObligationId">;
export type EvidencePacketId = Brand<string, "EvidencePacketId">;
export type EvidenceVerdictId = Brand<string, "EvidenceVerdictId">;
export type ClaimId = Brand<string, "ClaimId">;
export type GraphRevision = Brand<number, "GraphRevision">;
export type Sha256 = Brand<string, "Sha256">;

export type IngestResult<T, Code extends string> =
  { ok: true; value: T } | { ok: false; code: Code; message: string };
