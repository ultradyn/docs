import type { z } from "zod";
import { RepresentationAuditSchema } from "./representation-audit.js";
import type { IngestResult } from "./types.js";

import {
  AnswerCompositionSchema,
  ClaimReviewSchema,
  ClaimSchema,
  CoverageObligationSchema,
  EvidencePacketSchema,
  EvidenceVerdictSchema,
  GraphEventSchema,
  IngestionQuestionLinkSchema,
  PolicyProfileSchema,
  SearchReceiptSchema,
  SealedClaimPackSchema,
  SourceFileSchema,
  SourceRepresentationSchema,
  SourceSnapshotSchema,
  SourceUnitSchema,
} from "./schemas.js";

const schemas = {
  PolicyProfile: PolicyProfileSchema,
  SourceSnapshot: SourceSnapshotSchema,
  SourceFile: SourceFileSchema,
  SourceRepresentation: SourceRepresentationSchema,
  RepresentationAudit: RepresentationAuditSchema,
  SourceUnit: SourceUnitSchema,
  SearchReceipt: SearchReceiptSchema,
  IngestionQuestionLink: IngestionQuestionLinkSchema,
  CoverageObligation: CoverageObligationSchema,
  EvidencePacket: EvidencePacketSchema,
  EvidenceVerdict: EvidenceVerdictSchema,
  Claim: ClaimSchema,
  ClaimReview: ClaimReviewSchema,
  GraphEvent: GraphEventSchema,
  SealedClaimPack: SealedClaimPackSchema,
  AnswerComposition: AnswerCompositionSchema,
} satisfies Record<string, z.ZodType>;

export type IngestSchemaName = keyof typeof schemas;

export interface IngestSchemaRegistry {
  get(name: IngestSchemaName, version: 1): z.ZodType;
  names(): readonly IngestSchemaName[];
}

export const ingestSchemaRegistry: IngestSchemaRegistry = {
  get(name, version) {
    const schema: z.ZodType | undefined = schemas[name];
    if (version !== 1 || !schema) {
      throw new Error(`UNKNOWN_SCHEMA: ${name} version ${version}`);
    }
    return schema;
  },
  names() {
    return Object.keys(schemas) as IngestSchemaName[];
  },
};

export function validateIngestRecord<T>(
  name: IngestSchemaName,
  version: 1,
  input: unknown,
): IngestResult<T, "UNKNOWN_SCHEMA" | "INVALID_RECORD"> {
  let schema: z.ZodType;
  try {
    schema = ingestSchemaRegistry.get(name, version);
  } catch (error) {
    return { ok: false, code: "UNKNOWN_SCHEMA", message: String(error) };
  }

  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data as T };

  return {
    ok: false,
    code: "INVALID_RECORD",
    message: parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; "),
  };
}

export function registerIngestSchemas(): void {
  // The curated registry is closed at module load time. Portable JSON-Schema
  // registration is added by T-01-03 after dialect parity fixtures exist.
}
