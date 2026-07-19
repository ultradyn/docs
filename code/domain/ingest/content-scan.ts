import { z } from "zod";

export const ScanFindingKindSchema = z.enum(["secret", "pii"]);
export type ScanFindingKind = z.infer<typeof ScanFindingKindSchema>;

export const ScanActionSchema = z.enum([
  "allow",
  "redact",
  "quarantine",
  "block",
]);
export type ScanAction = z.infer<typeof ScanActionSchema>;

const NormalizedCoordsSchema = z
  .object({
    utf16Start: z.number().int().nonnegative(),
    utf16End: z.number().int().nonnegative(),
    lineStart: z.number().int().positive(),
    columnStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    columnEnd: z.number().int().positive(),
  })
  .strict();

const OriginalCoordsSchema = z
  .object({
    byteStart: z.number().int().nonnegative(),
    byteEnd: z.number().int().nonnegative(),
    lineStart: z.number().int().positive(),
    columnStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    columnEnd: z.number().int().positive(),
  })
  .strict();

/** Half-open locator-shaped span (mirrors LocatorSpan coordinates). */
export const ScanSpanSchema = z
  .object({
    kind: z.enum(["line", "cell", "span"]),
    normalized: NormalizedCoordsSchema,
    original: OriginalCoordsSchema,
    cell: z
      .object({
        row: z.number().int().positive(),
        column: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ScanSpan = z.infer<typeof ScanSpanSchema>;

/** Finding never carries matched value or surrounding text. */
export const ScanFindingSchema = z
  .object({
    kind: ScanFindingKindSchema,
    detectorId: z.string().min(1).max(128),
    span: ScanSpanSchema,
  })
  .strict();

export type ScanFinding = {
  readonly kind: ScanFindingKind;
  readonly detectorId: string;
  readonly span: ScanSpan;
};

export const ScanPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(128),
    defaultAction: ScanActionSchema,
    actionsByKind: z
      .object({
        secret: ScanActionSchema,
        pii: ScanActionSchema,
      })
      .strict(),
  })
  .strict();

export type ScanPolicy = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly defaultAction: ScanAction;
  readonly actionsByKind: {
    readonly secret: ScanAction;
    readonly pii: ScanAction;
  };
};

export const ScanVerdictOutcomeSchema = z.enum([
  "clean",
  "redacted",
  "quarantined",
  "blocked",
]);

export const ScanVerdictSchema = z
  .object({
    outcome: ScanVerdictOutcomeSchema,
    findings: z.array(ScanFindingSchema).max(1_024),
    appliedActions: z.array(ScanActionSchema).max(64),
  })
  .strict();

export type ScanVerdict = {
  readonly outcome: z.infer<typeof ScanVerdictOutcomeSchema>;
  readonly findings: readonly ScanFinding[];
  readonly appliedActions: readonly ScanAction[];
};
