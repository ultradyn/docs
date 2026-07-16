import { describe, expect, it } from "vitest";

import { bestQuestionMatch } from "./testing.js";

describe("deterministic question matcher", () => {
  const candidates = [
    {
      id: "recovery",
      question:
        "How does the relay recover after an interrupted journal write?",
    },
    {
      id: "settings",
      question: "Where are personal appearance settings stored?",
    },
  ];

  it("matches conservative paraphrases without merging unrelated questions", () => {
    expect(
      bestQuestionMatch(
        "What happens when a relay journal write is interrupted during recovery?",
        candidates,
      )?.id,
    ).toBe("recovery");
    expect(
      bestQuestionMatch("Which OAuth scopes are required?", candidates),
    ).toBeUndefined();
  });
});
