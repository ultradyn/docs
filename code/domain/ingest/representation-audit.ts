import { z } from "zod";

import { SourceRepresentationIdSchema } from "./id-schemas.js";
import type { SourceRepresentationKind } from "./representation-records.js";
import type { SourceRepresentationId } from "./types.js";

export const FormatTierSchema = z.enum(["A", "B", "C", "D"]);
export type FormatTier = z.infer<typeof FormatTierSchema>;

export const RepresentationAuditCheckSchema = z.enum([
  "mapping",
  "render",
  "structure",
]);
export type RepresentationAuditCheck = z.infer<
  typeof RepresentationAuditCheckSchema
>;

const SourceRepresentationKindSchema = z.enum([
  "markdown",
  "text",
  "code",
  "json",
  "yaml",
  "csv",
]);

export const RepresentationCapabilitySchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    version: z.number().safe().int().positive(),
    representationKind: SourceRepresentationKindSchema,
    tier: FormatTierSchema,
    requiredChecks: z
      .array(RepresentationAuditCheckSchema)
      .min(1)
      .superRefine((checks, context) => {
        if (new Set(checks).size !== checks.length) {
          context.addIssue({
            code: "custom",
            message: "checks must be unique",
          });
        }
        const sorted = [...checks].sort();
        if (checks.some((check, index) => check !== sorted[index])) {
          context.addIssue({
            code: "custom",
            message: "checks must be sorted",
          });
        }
      }),
  })
  .strict();

export interface RepresentationCapability {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: number;
  readonly representationKind: SourceRepresentationKind;
  readonly tier: FormatTier;
  readonly requiredChecks: readonly RepresentationAuditCheck[];
}

export const RepresentationAuditFindingCodeSchema = z.enum([
  "INVALID_CAPABILITY",
  "CAPABILITY_KIND_MISMATCH",
  "CAPABILITY_VERSION_UNSUPPORTED",
  "CAPABILITY_CHECK_UNSUPPORTED",
  "TIER_REQUIRES_RENDER_AUDIT",
  "TIER_REQUIRES_UNIT_VERIFICATION",
  "TIER_UNSUPPORTED",
  "LOCATOR_MISSING",
  "LOCATOR_KIND_MISMATCH",
  "LOCATOR_INTERVAL_INVALID",
  "LOCATOR_OUT_OF_BOUNDS",
  "LOCATOR_ORDER_INVALID",
  "LOCATOR_OVERLAP",
  "LOCATOR_POSITION_MISMATCH",
  "ORIGINAL_POSITION_INVALID",
  "MAPPING_COVERAGE_GAP",
  "CSV_CELL_ORDER_INVALID",
]);
export type RepresentationAuditFindingCode = z.infer<
  typeof RepresentationAuditFindingCodeSchema
>;

export const RepresentationAuditFindingSchema = z
  .object({
    code: RepresentationAuditFindingCodeSchema,
    severity: z.enum(["error", "warning"]),
    message: z.string().min(1),
    locatorIndex: z.number().safe().int().nonnegative().optional(),
    cell: z
      .object({
        row: z.number().safe().int().positive(),
        column: z.number().safe().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface RepresentationAuditFinding {
  readonly code: RepresentationAuditFindingCode;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly locatorIndex?: number;
  readonly cell?: {
    readonly row: number;
    readonly column: number;
  };
}

export const RepresentationCapabilityRefSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("resolved"),
        id: z.string().min(1),
        version: z.number().safe().int().positive(),
      })
      .strict(),
    z.object({ status: z.literal("unresolved") }).strict(),
  ],
);

export type RepresentationCapabilityRef =
  | {
      readonly status: "resolved";
      readonly id: string;
      readonly version: number;
    }
  | { readonly status: "unresolved" };

const STRUCTURAL_FINDING_CODES = new Set<RepresentationAuditFindingCode>([
  "LOCATOR_MISSING",
  "LOCATOR_KIND_MISMATCH",
  "MAPPING_COVERAGE_GAP",
  "CSV_CELL_ORDER_INVALID",
]);

const MAPPING_FINDING_CODES = new Set<RepresentationAuditFindingCode>([
  "LOCATOR_INTERVAL_INVALID",
  "LOCATOR_OUT_OF_BOUNDS",
  "LOCATOR_ORDER_INVALID",
  "LOCATOR_OVERLAP",
  "LOCATOR_POSITION_MISMATCH",
  "ORIGINAL_POSITION_INVALID",
]);

export const RepresentationAuditSchema = z
  .object({
    schemaVersion: z.literal(1),
    representationId: SourceRepresentationIdSchema,
    capability: RepresentationCapabilityRefSchema,
    tier: FormatTierSchema,
    structuralPass: z.boolean(),
    mappingPass: z.boolean(),
    humanVerified: z.literal(false),
    claimEligible: z.boolean(),
    findings: z.array(RepresentationAuditFindingSchema),
  })
  .strict()
  .superRefine((audit, context) => {
    const errors = audit.findings.filter(
      (finding) => finding.severity === "error",
    );
    const structuralPass = !errors.some((finding) =>
      STRUCTURAL_FINDING_CODES.has(finding.code),
    );
    const mappingPass = !errors.some((finding) =>
      MAPPING_FINDING_CODES.has(finding.code),
    );

    if (audit.structuralPass !== structuralPass) {
      context.addIssue({
        code: "custom",
        path: ["structuralPass"],
        message: "must agree with structural findings",
      });
    }
    if (audit.mappingPass !== mappingPass) {
      context.addIssue({
        code: "custom",
        path: ["mappingPass"],
        message: "must agree with mapping findings",
      });
    }

    const claimEligible =
      audit.tier === "A" &&
      audit.capability.status === "resolved" &&
      structuralPass &&
      mappingPass &&
      errors.length === 0;
    if (audit.claimEligible !== claimEligible) {
      context.addIssue({
        code: "custom",
        path: ["claimEligible"],
        message: "must equal derived Tier A policy",
      });
    }
  });

export interface RepresentationAudit {
  readonly schemaVersion: 1;
  readonly representationId: SourceRepresentationId;
  readonly capability: RepresentationCapabilityRef;
  readonly tier: FormatTier;
  readonly structuralPass: boolean;
  readonly mappingPass: boolean;
  readonly humanVerified: false;
  readonly claimEligible: boolean;
  readonly findings: readonly RepresentationAuditFinding[];
}
