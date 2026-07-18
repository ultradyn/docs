import { z } from "zod";

export { registerIngestSchemas } from "./ingest/index.js";

const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .regex(
    /T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u,
  );
export const SafeSlugSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/i);
const ulid = "[0-9A-HJKMNP-TV-Z]{26}";

export const IdSchemas = {
  question: z.string().regex(new RegExp(`^q-${ulid}$`)),
  answer: z.string().regex(new RegExp(`^ans-${ulid}$`)),
  finding: z.string().regex(new RegExp(`^f-${ulid}$`)),
  artifact: z.string().regex(new RegExp(`^art-${ulid}$`)),
  changeRequest: z.string().regex(new RegExp(`^cr-${ulid}$`)),
  audioSession: z.string().regex(new RegExp(`^aud-${ulid}$`)),
} as const;

export const QuestionStateSchema = z.enum([
  "asked",
  "logged",
  "active",
  "deferred",
  "in-answer",
  "integrating",
  "merged",
  "accepted",
  "reopened",
]);
export type QuestionState = z.infer<typeof QuestionStateSchema>;

export const QueueBucketSchema = z.enum(["active", "deferred", "answered"]);
export type QueueBucket = z.infer<typeof QueueBucketSchema>;

export const PriorityTierSchema = z.enum(["P1", "P2", "P3", "P4", "P5"]);
export type PriorityTier = z.infer<typeof PriorityTierSchema>;

export const AskerSchema = z
  .object({
    id: SafeSlugSchema,
    displayName: z.string().min(1).max(160).optional(),
    acceptance: z.enum(["pending", "accepted", "rejected", "timed-out"]),
    decidedAt: isoDateTime.optional(),
    rawReason: z.string().min(1).optional(),
  })
  .strict();
export type Asker = z.infer<typeof AskerSchema>;

export const QuestionOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("raw") }).strict(),
  z
    .object({
      kind: z.literal("generated"),
      parentQuestionId: IdSchemas.question,
      findingId: IdSchemas.finding,
      goal: SafeSlugSchema,
    })
    .strict(),
]);
export type QuestionOrigin = z.infer<typeof QuestionOriginSchema>;

export const ProvenanceEventSchema = z
  .object({
    at: isoDateTime,
    type: z.enum([
      "logged",
      "prioritized",
      "state-transitioned",
      "asker-attached",
      "priority-overridden",
      "raw-artifact-appended",
      "derived-artifact-written",
      "accepted",
      "timeout-accepted",
      "rejected",
      "repaired",
    ]),
    by: z.string().min(1).max(160),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ProvenanceEvent = z.infer<typeof ProvenanceEventSchema>;

export const QuestionRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdSchemas.question,
    title: z.string().min(1).max(240),
    question: z.string().min(1),
    state: QuestionStateSchema,
    tier: PriorityTierSchema,
    priorityRationale: z.string().min(1),
    prioritySource: z.enum(["rule", "override"]),
    goals: z.array(SafeSlugSchema).min(1),
    tags: z.array(SafeSlugSchema),
    askers: z.array(AskerSchema).min(1),
    origin: QuestionOriginSchema,
    depth: z.number().int().nonnegative(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    revision: z.number().int().nonnegative(),
    provenance: z.array(ProvenanceEventSchema),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.origin.kind === "raw" && record.depth !== 0) {
      context.addIssue({
        code: "custom",
        path: ["depth"],
        message: "Raw questions must have depth 0.",
      });
    }
    if (record.origin.kind === "generated" && record.depth < 1) {
      context.addIssue({
        code: "custom",
        path: ["depth"],
        message: "Generated questions must have depth of at least 1.",
      });
    }
    const askerIds = new Set(record.askers.map((asker) => asker.id));
    if (askerIds.size !== record.askers.length) {
      context.addIssue({
        code: "custom",
        path: ["askers"],
        message: "A question cannot contain the same asker twice.",
      });
    }
    if (new Set(record.goals).size !== record.goals.length) {
      context.addIssue({
        code: "custom",
        path: ["goals"],
        message: "Declared goals must be unique.",
      });
    }
  });
export type QuestionRecord = z.infer<typeof QuestionRecordSchema>;

export const QuestionIndexRowSchema = z.object({
  id: IdSchemas.question,
  title: z.string().min(1).max(240),
  state: QuestionStateSchema,
  tier: PriorityTierSchema,
  goals: z.array(SafeSlugSchema).min(1),
  tags: z.array(SafeSlugSchema),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  revision: z.number().int().nonnegative(),
  askerCount: z.number().int().positive(),
  priorityRationale: z.string().min(1),
});
export type QuestionIndexRow = z.infer<typeof QuestionIndexRowSchema>;

export const RawArtifactKindSchema = z.enum([
  "question",
  "chatlog",
  "rejection",
  "transcript",
  "correction",
]);
export type RawArtifactKind = z.infer<typeof RawArtifactKindSchema>;

export const RawArtifactManifestEntrySchema = z
  .object({
    path: z.string().min(1),
    kind: RawArtifactKindSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
    createdAt: isoDateTime,
  })
  .strict();
export type RawArtifactManifestEntry = z.infer<
  typeof RawArtifactManifestEntrySchema
>;

export const RawArtifactManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifacts: z.array(RawArtifactManifestEntrySchema),
  })
  .strict();
export type RawArtifactManifest = z.infer<typeof RawArtifactManifestSchema>;
