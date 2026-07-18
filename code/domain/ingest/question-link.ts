import { z } from "zod";

export type QuestionLinkOrigin = "human" | "ingestion-generated" | "reverse";

export interface IngestionQuestionLink {
  schemaVersion: 1;
  questionId: string;
  snapshotId: string;
  origin: QuestionLinkOrigin;
  systemActor?: string | undefined;
  rawArtifactId: string;
  generation: number;
  sourceUnitIds: readonly string[];
  createdRevision: number;
}

export interface QuestionLinkStore {
  get(questionId: string): Promise<IngestionQuestionLink | undefined>;
  create(link: IngestionQuestionLink): Promise<boolean>;
  /**
   * Runs `operation` under the store's exclusive section so a caller can make
   * a read-validate-create sequence atomic against concurrent mutators.
   * Reentrant for callers already inside the section.
   */
  locked<T>(operation: () => Promise<T>): Promise<T>;
}

const NonEmptyStringSchema = z.string().trim().min(1);

// Mirrors IdSchemas in ../schemas.ts; duplicated locally because importing
// ../schemas.js from here would close an ESM evaluation cycle (schemas.ts
// re-exports this module's schema via ./ingest/index.js).
const ULID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";
const QuestionIdSchema = z.string().regex(new RegExp(`^q-${ULID_PATTERN}$`));
const RawArtifactIdSchema = z
  .string()
  .regex(new RegExp(`^art-${ULID_PATTERN}$`));

// System-created links (N6): non-human origins must name the acting system and
// carry source-unit provenance; human demand carries neither.
function refineOrigin(
  link: {
    origin: QuestionLinkOrigin;
    systemActor?: string | undefined;
    sourceUnitIds: readonly string[];
    generation: number;
  },
  context: {
    addIssue(issue: {
      code: "custom";
      path: (string | number)[];
      message: string;
    }): void;
  },
): void {
  if (link.origin === "human") {
    if (link.systemActor !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["systemActor"],
        message: "Human links must not declare a system actor.",
      });
    }
    if (link.generation !== 0) {
      context.addIssue({
        code: "custom",
        path: ["generation"],
        message: "Human links are generation 0.",
      });
    }
    if (link.sourceUnitIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["sourceUnitIds"],
        message: "Human links must not declare source-unit provenance.",
      });
    }
    return;
  }
  if (link.systemActor === undefined) {
    context.addIssue({
      code: "custom",
      path: ["systemActor"],
      message: `Links with origin ${link.origin} require a system actor.`,
    });
  }
  if (link.sourceUnitIds.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["sourceUnitIds"],
      message: `Links with origin ${link.origin} require source-unit provenance.`,
    });
  }
  if (link.origin === "ingestion-generated" && link.generation < 1) {
    context.addIssue({
      code: "custom",
      path: ["generation"],
      message: "Ingestion-generated links require generation of at least 1.",
    });
  }
}

// snapshotId and sourceUnitIds are format-checked only: the snapshot and
// source-unit repositories do not exist yet (WP-10/WP-12), so referential
// existence is a documented deferred boundary owned by the graph/validity
// gateway (T-30-01) once those planes land. questionId and rawArtifactId
// reference records that DO exist today and must match their ID formats.
const linkShape = {
  questionId: QuestionIdSchema,
  snapshotId: NonEmptyStringSchema,
  origin: z.enum(["human", "ingestion-generated", "reverse"]),
  systemActor: NonEmptyStringSchema.optional(),
  rawArtifactId: RawArtifactIdSchema,
  generation: z.number().int().nonnegative(),
  sourceUnitIds: z.array(NonEmptyStringSchema),
};

// Strict shape: wording, canonical-origin, and lifecycle fields are unknown
// keys here, so the link surface cannot smuggle question mutations.
export const QuestionLinkInputSchema = z
  .object(linkShape)
  .strict()
  .superRefine(refineOrigin);
export type QuestionLinkInput = z.infer<typeof QuestionLinkInputSchema>;

export const IngestionQuestionLinkSchema: z.ZodType<IngestionQuestionLink> = z
  .object({
    schemaVersion: z.literal(1),
    ...linkShape,
    createdRevision: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine(refineOrigin);
