import { describe, expect, it } from "vitest";

import { assessQuestionProposal } from "../ingest/knowledge/index.js";
import { createAdversarialQuestionProposalFixtures } from "../ingest/knowledge/fixtures/adversarial-question-proposals.js";

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) expectDeepFrozen(nested);
}

/**
 * Pure validity-gateway e2e: adversarial planner proposals cross the public
 * ingestion-knowledge barrel without inventing an agent runtime or server.
 */
describe("question admissibility fixture boundary", () => {
  it.each(createAdversarialQuestionProposalFixtures())(
    "$name",
    ({ input, expected }) => {
      expect(assessQuestionProposal(input)).toEqual(expected);
    },
  );

  it("creates isolated deeply frozen fixture graphs", () => {
    const first = createAdversarialQuestionProposalFixtures();
    const second = createAdversarialQuestionProposalFixtures();
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expectDeepFrozen(first);
    expectDeepFrozen(second);

    const before = assessQuestionProposal(second[0]?.input);
    expect(() =>
      (first as unknown as unknown[]).push({ name: "mutation" }),
    ).toThrow();
    expect(() =>
      (
        (first[0]?.input as { link: { sourceUnitIds: string[] } }).link
          .sourceUnitIds as string[]
      ).push("poison"),
    ).toThrow();

    expect(assessQuestionProposal(first[0]?.input)).toEqual(before);
    expect(assessQuestionProposal(second[0]?.input)).toEqual(before);
    expect(
      assessQuestionProposal(
        createAdversarialQuestionProposalFixtures()[0]?.input,
      ),
    ).toEqual(before);
  });
});
