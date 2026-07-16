import { z } from "zod";

import type { QuestionDetail, QuestionSummary } from "../shared/index.js";

export const LibrarianOutputSchema = z.object({
  status: z.enum(["answered", "insufficient"]),
  answer: z.string(),
  citations: z.array(
    z.object({
      path: z.string().min(1),
      claim: z.string().min(1),
    }),
  ),
  unsatisfiedGoals: z.array(z.string().min(1)),
});
export type LibrarianOutput = z.infer<typeof LibrarianOutputSchema>;

export const StructurerOutputSchema = z.object({
  title: z.string().min(1),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1),
        content: z.string().min(1),
      }),
    )
    .min(1),
  correctionsApplied: z.array(z.string()),
});
export type StructurerOutput = z.infer<typeof StructurerOutputSchema>;

const goalResultSchema = z.object({
  goal: z.string().min(1),
  status: z.enum(["satisfied", "unsatisfied", "uncertain", "deferred"]),
  rationale: z.string().min(1),
});

export const CriticOutputSchema = z.object({
  done: z.boolean(),
  goalResults: z.array(goalResultSchema),
  findings: z.array(
    z.object({
      category: z.enum(["goal-gap", "uncertainty", "contradiction", "depth"]),
      text: z.string().min(1),
      blocking: z.boolean(),
    }),
  ),
  deferredQuestions: z.array(
    z.object({
      question: z.string().min(1),
      goal: z.string().min(1),
      extraDetail: z.boolean(),
    }),
  ),
  contradictions: z.array(z.string().min(1)),
});
export type CriticOutput = z.infer<typeof CriticOutputSchema>;

export const IntegratorOutputSchema = z.object({
  edits: z
    .array(
      z.object({
        path: z.string().min(1),
        operation: z.enum(["create", "update"]),
        summary: z.string().min(1),
        content: z.string().min(1),
      }),
    )
    .min(1),
  mapUpdates: z.array(z.string()),
  rationale: z.string().min(1),
});
export type IntegratorOutput = z.infer<typeof IntegratorOutputSchema>;

export const ReviewerOutputSchema = z.object({
  approved: z.boolean(),
  findings: z.array(
    z.object({
      severity: z.enum(["blocking", "advisory"]),
      text: z.string().min(1),
    }),
  ),
});
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;

export const DiffSummarizerOutputSchema = z.object({
  summary: z.string().min(1),
  changes: z.array(z.string().min(1)).min(1),
  risks: z.array(z.string().min(1)),
});
export type DiffSummarizerOutput = z.infer<typeof DiffSummarizerOutputSchema>;

export const SimulatedAskerOutputSchema = z.object({
  satisfied: z.boolean(),
  reason: z.string().min(1),
  goalResults: z.array(
    z.object({
      goal: z.string().min(1),
      satisfied: z.boolean(),
      rationale: z.string().min(1),
    }),
  ),
});
export type SimulatedAskerOutput = z.infer<typeof SimulatedAskerOutputSchema>;

export function renderStructuredAnswer(output: StructurerOutput): string {
  const sections = output.sections
    .map(
      (section) => `## ${section.heading.trim()}\n\n${section.content.trim()}`,
    )
    .join("\n\n");
  return `# ${output.title.trim()}\n\n${sections}\n`;
}

export function criticEvaluation(
  output: CriticOutput,
  deferredChildren: QuestionSummary[],
  declaredGoals: string[],
): NonNullable<QuestionDetail["evaluation"]> {
  const expectedGoals = new Set(declaredGoals);
  const goalsAccountedFor =
    output.goalResults.length === expectedGoals.size &&
    [...expectedGoals].every(
      (goal) =>
        output.goalResults.filter((result) => result.goal === goal).length ===
        1,
    ) &&
    output.goalResults.every((result) => expectedGoals.has(result.goal));
  const goalsComplete = output.goalResults.every(
    (result) => result.status === "satisfied" || result.status === "deferred",
  );
  return {
    done:
      output.done &&
      goalsAccountedFor &&
      goalsComplete &&
      output.contradictions.length === 0,
    goalResults: output.goalResults,
    contradictions: [...output.contradictions],
    deferredChildren,
  };
}
