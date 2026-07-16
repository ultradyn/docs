import { describe, expect, it } from "vitest";

import {
  CriticOutputSchema,
  DiffSummarizerOutputSchema,
  LibrarianOutputSchema,
  StructurerOutputSchema,
  criticEvaluation,
  renderStructuredAnswer,
} from "./testing.js";

describe("server agent workflow adapters", () => {
  it("renders a schema-validated structurer result as readable Markdown", () => {
    const output = StructurerOutputSchema.parse({
      title: "Journal recovery",
      sections: [
        {
          heading: "Recovery point",
          content: "Replay the last verified checkpoint.",
        },
        { heading: "Incomplete tail", content: "Discard the partial record." },
      ],
      correctionsApplied: ["Use checksum-verified, not newest."],
    });

    expect(renderStructuredAnswer(output)).toBe(
      "# Journal recovery\n\n## Recovery point\n\nReplay the last verified checkpoint.\n\n## Incomplete tail\n\nDiscard the partial record.\n",
    );
  });

  it("never marks a critic round done while contradictions remain", () => {
    const output = CriticOutputSchema.parse({
      done: true,
      goalResults: [
        {
          goal: "implementation",
          status: "satisfied",
          rationale: "The algorithm is explicit.",
        },
      ],
      findings: [
        {
          category: "contradiction",
          text: "Two checkpoint sources claim authority.",
          blocking: true,
        },
      ],
      deferredQuestions: [],
      contradictions: ["Two checkpoint sources claim authority."],
    });

    expect(criticEvaluation(output, [], ["implementation"])).toMatchObject({
      done: false,
      contradictions: ["Two checkpoint sources claim authority."],
    });
  });

  it("requires exactly one critic result for every declared goal", () => {
    const missing = CriticOutputSchema.parse({
      done: true,
      goalResults: [],
      findings: [],
      deferredQuestions: [],
      contradictions: [],
    });
    const duplicate = CriticOutputSchema.parse({
      done: true,
      goalResults: [
        { goal: "implementation", status: "satisfied", rationale: "Explicit." },
        {
          goal: "implementation",
          status: "satisfied",
          rationale: "Still explicit.",
        },
      ],
      findings: [],
      deferredQuestions: [],
      contradictions: [],
    });

    expect(criticEvaluation(missing, [], ["implementation"]).done).toBe(false);
    expect(criticEvaluation(duplicate, [], ["implementation"]).done).toBe(
      false,
    );
  });

  it("rejects invented librarian citations that omit a repository path", () => {
    expect(() =>
      LibrarianOutputSchema.parse({
        status: "answered",
        answer: "Guess",
        citations: [{ claim: "No path" }],
        unsatisfiedGoals: [],
      }),
    ).toThrow();
  });

  it("requires a concrete diff-only summary contract", () => {
    expect(
      DiffSummarizerOutputSchema.parse({
        summary: "Adds the checkpoint replay procedure.",
        changes: ["Names the checksum-verified recovery point."],
        risks: [],
      }),
    ).toEqual({
      summary: "Adds the checkpoint replay procedure.",
      changes: ["Names the checksum-verified recovery point."],
      risks: [],
    });
    expect(() =>
      DiffSummarizerOutputSchema.parse({
        summary: "",
        changes: [],
        risks: [],
      }),
    ).toThrow();
  });
});
