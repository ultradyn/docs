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
}

const NonEmptyStringSchema = z.string().trim().min(1);

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

const linkShape = {
  questionId: NonEmptyStringSchema,
  snapshotId: NonEmptyStringSchema,
  origin: z.enum(["human", "ingestion-generated", "reverse"]),
  systemActor: NonEmptyStringSchema.optional(),
  rawArtifactId: NonEmptyStringSchema,
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
