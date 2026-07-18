import { z } from "zod";

export type DataClass =
  | "public"
  | "internal"
  | "confidential"
  | "prohibited";

export interface PolicyProfile {
  schemaVersion: 1;
  id: string;
  approved: boolean;
  dataClass: DataClass;
  include: readonly string[];
  exclude: readonly string[];
  allowedMediaTypes: readonly string[];
  allowedProcessors: readonly string[];
  allowedStorage: readonly string[];
  retentionDays: number;
  accessClass: string;
  maxFiles: number;
  maxFileBytes: number;
  maxExpandedBytes: number;
}

const NonEmptyStringSchema = z.string().trim().min(1);
const NonEmptyStringListSchema = z.array(NonEmptyStringSchema).min(1);
const PositiveIntegerSchema = z.number().int().positive();

export const PolicyProfileSchema: z.ZodType<PolicyProfile> = z
  .object({
    schemaVersion: z.literal(1),
    id: NonEmptyStringSchema,
    approved: z.literal(true),
    dataClass: z.enum(["public", "internal", "confidential"]),
    include: NonEmptyStringListSchema,
    exclude: z.array(NonEmptyStringSchema),
    allowedMediaTypes: NonEmptyStringListSchema,
    allowedProcessors: NonEmptyStringListSchema,
    allowedStorage: NonEmptyStringListSchema,
    retentionDays: PositiveIntegerSchema,
    accessClass: NonEmptyStringSchema,
    maxFiles: PositiveIntegerSchema,
    maxFileBytes: PositiveIntegerSchema,
    maxExpandedBytes: PositiveIntegerSchema,
  })
  .strict()
  .superRefine((profile, context) => {
    const excluded = new Set(profile.exclude);
    const overlap = [...new Set(profile.include.filter((path) => excluded.has(path)))].sort();
    if (overlap.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["exclude"],
        message: `include/exclude overlap: ${overlap.join(", ")}`,
      });
    }
  });
