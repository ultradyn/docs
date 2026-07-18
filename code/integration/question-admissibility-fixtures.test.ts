import { describe, expect, it } from "vitest";

import { assessQuestionProposal } from "../ingest/knowledge/index.js";
import { ADVERSARIAL_QUESTION_PROPOSAL_FIXTURES } from "../ingest/knowledge/fixtures/adversarial-question-proposals.js";

/**
 * Pure validity-gateway e2e: adversarial planner proposals cross the public
 * ingestion-knowledge barrel without inventing an agent runtime or server.
 */
describe("question admissibility fixture boundary", () => {
  it.each(ADVERSARIAL_QUESTION_PROPOSAL_FIXTURES)(
    "$name",
    ({ input, expected }) => {
      expect(assessQuestionProposal(input)).toEqual(expected);
    },
  );
});
