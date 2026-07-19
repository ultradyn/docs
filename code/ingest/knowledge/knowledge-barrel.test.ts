import { describe, expect, it } from "vitest";

import * as knowledge from "./index.js";

/**
 * Barrel discipline guard (T-22-01, re-affirmed T-22-03, generalised here).
 *
 * Testing-only in-memory stores must not be reachable from the production
 * barrel. A fake on the public surface is an invitation for a future task to
 * wire it into a real path, where it silently downgrades durability — the
 * failure is invisible because the types match.
 *
 * SCOPE — read before adding names here. This guard covers stores whose
 * in-memory form is testing-only. It deliberately does NOT cover
 * createInMemoryQuestionLinkStore or createInMemoryPolicyApprovalStore: both are
 * currently on their barrels as DELIBERATE, test-pinned decisions
 * (question-link-service.test.ts "public seams"; policy-barrel.test.ts "exports
 * both approval store implementations", from the T-13-01 plan Files list).
 * Whether those two should also come off is a cross-work-package policy
 * question tracked separately — it is not settled by this test, and this test
 * must not be read as having settled it.
 */
describe("knowledge barrel keeps testing-only stores off the public surface", () => {
  const testingOnlyFactories = [
    "createInMemoryEvidencePacketStore",
    "createInMemoryEvidenceVerdictStore",
    "createInMemoryClaimStore",
    "createInMemoryClaimReviewApplicationStore",
    "createInMemoryQuestionFacetReader",
  ] as const;

  for (const name of testingOnlyFactories) {
    it(`does not export ${name}`, () => {
      expect(
        (knowledge as Record<string, unknown>)[name],
        `${name} is testing-only; import it from its module path, not the barrel`,
      ).toBeUndefined();
    });
  }

  /**
   * Anti-vacuity: the assertions above would also pass if the barrel exported
   * nothing at all, or if these names were simply misspelled. Prove the barrel
   * is live and that the corresponding PRODUCTION factories are present, so an
   * absent-by-typo name cannot masquerade as absent-by-discipline.
   */
  it("still exports the production counterparts", () => {
    expect(typeof knowledge.createEvidenceService).toBe("function");
    expect(typeof knowledge.createFileEvidencePacketStore).toBe("function");
    expect(typeof knowledge.createEvidenceVerdictService).toBe("function");
    expect(typeof knowledge.createFileEvidenceVerdictStore).toBe("function");
    expect(typeof knowledge.createClaimRepository).toBe("function");
    expect(typeof knowledge.createClaimReviewService).toBe("function");
  });
});
