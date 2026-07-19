import { describe, expect, it } from "vitest";

import {
  REPAIR_REVIEW_STATES,
  allowedRepairReviewActions,
  repairReviewState,
} from "./review-contract.js";

const ACTOR = "alex.review-1";
const OTHER = "sam.review-2";

function projection(overrides: Record<string, unknown> = {}) {
  return {
    repairId: "rpr-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    state: "proposed" as const,
    proposedBy: ACTOR,
    revision: 2,
    invalidatedUnitCount: 5,
    ...overrides,
  };
}

describe("repair review states are a closed vocabulary", () => {
  it("pins the review state list", () => {
    expect(REPAIR_REVIEW_STATES).toEqual([
      "proposed",
      "approved",
      "rejected",
      "unavailable",
    ]);
  });

  it("maps a proposal projection to the proposed state", () => {
    expect(repairReviewState(projection())).toBe("proposed");
  });

  it("maps a missing projection to unavailable rather than empty", () => {
    // An outage must be distinguishable from "no repair", so the UI cannot
    // silently present a broken fetch as an absent proposal.
    expect(repairReviewState(undefined)).toBe("unavailable");
  });

  it("maps terminal projections to their terminal states", () => {
    expect(repairReviewState(projection({ state: "approved" }))).toBe(
      "approved",
    );
    expect(repairReviewState(projection({ state: "rejected" }))).toBe(
      "rejected",
    );
  });
});

describe("review actions never permit editing a proposal", () => {
  it("offers approve and reject to an authorised reviewer", () => {
    expect(
      allowedRepairReviewActions(projection(), {
        viewer: OTHER,
        isAuthorisedHuman: true,
      }),
    ).toEqual(["approve", "reject"]);
  });

  it("never offers an edit action in any state", () => {
    for (const state of REPAIR_REVIEW_STATES) {
      const actions = allowedRepairReviewActions(projection({ state }), {
        viewer: OTHER,
        isAuthorisedHuman: true,
      });
      expect(actions).not.toContain("edit");
      expect(actions).not.toContain("amend");
    }
  });

  it("offers nothing once the repair is terminal", () => {
    for (const state of ["approved", "rejected"] as const) {
      expect(
        allowedRepairReviewActions(projection({ state }), {
          viewer: OTHER,
          isAuthorisedHuman: true,
        }),
      ).toEqual([]);
    }
  });

  it("offers nothing to an unauthorised viewer", () => {
    expect(
      allowedRepairReviewActions(projection(), {
        viewer: OTHER,
        isAuthorisedHuman: false,
      }),
    ).toEqual([]);
  });

  it("offers nothing while the projection is unavailable", () => {
    expect(
      allowedRepairReviewActions(undefined, {
        viewer: OTHER,
        isAuthorisedHuman: true,
      }),
    ).toEqual([]);
  });

  it("does not offer self approval to the proposer", () => {
    // The proposer may still reject their own proposal; they may not approve it.
    expect(
      allowedRepairReviewActions(projection(), {
        viewer: ACTOR,
        isAuthorisedHuman: true,
      }),
    ).toEqual(["reject"]);
  });
});
