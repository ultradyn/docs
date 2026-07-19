import { describe, expect, it } from "vitest";

import {
  REPAIR_HTTP_STATUS_BY_FAILURE,
  RepairApprovalRequestSchema,
  RepairProposalRequestSchema,
  RepairRejectionRequestSchema,
  RepairReviewResponseSchema,
  repairFailureResponse,
} from "./representation-repair-contract.js";

const ACTOR = "alex.review-1";
const REPAIR_ID = "rpr-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REPRESENTATION_ID = "repr-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CORRECTED_TEXT = "A considerably longer corrected intro paragraph.";

function proposalRequest(overrides: Record<string, unknown> = {}) {
  return {
    representationId: REPRESENTATION_ID,
    correctedArtifactId: "cor-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    proposedBy: ACTOR,
    reason: "Extraction dropped the intro paragraph.",
    expectedRevision: 1,
    idempotencyKey: "repair-guide-intro-1",
    ...overrides,
  };
}

describe("repair request contracts are strict", () => {
  it("accepts a well formed proposal request", () => {
    expect(RepairProposalRequestSchema.parse(proposalRequest())).toMatchObject({
      representationId: REPRESENTATION_ID,
    });
  });

  it("rejects unknown fields on a proposal request", () => {
    expect(
      RepairProposalRequestSchema.safeParse({
        ...proposalRequest(),
        force: true,
      }).success,
    ).toBe(false);
  });

  it("refuses corrected source text on the wire", () => {
    // Corrected bytes reach the server as an artifact reference, never inline,
    // so the HTTP surface cannot become a second custody path.
    expect(
      RepairProposalRequestSchema.safeParse({
        ...proposalRequest(),
        correctedText: CORRECTED_TEXT,
      }).success,
    ).toBe(false);
  });

  it("requires a nonblank rationale on every mutating request", () => {
    expect(
      RepairProposalRequestSchema.safeParse({
        ...proposalRequest(),
        reason: "   ",
      }).success,
    ).toBe(false);
    expect(
      RepairApprovalRequestSchema.safeParse({
        repairId: REPAIR_ID,
        approvedBy: ACTOR,
        reason: "",
        expectedRevision: 1,
      }).success,
    ).toBe(false);
    expect(
      RepairRejectionRequestSchema.safeParse({
        repairId: REPAIR_ID,
        rejectedBy: ACTOR,
        reason: "\t",
      }).success,
    ).toBe(false);
  });

  it("requires a stable actor handle", () => {
    expect(
      RepairApprovalRequestSchema.safeParse({
        repairId: REPAIR_ID,
        approvedBy: "Not A Handle",
        reason: "Verified against the original document.",
        expectedRevision: 1,
      }).success,
    ).toBe(false);
  });
});

describe("repair failures map to stable HTTP statuses", () => {
  it("pins the failure to status mapping", () => {
    expect(REPAIR_HTTP_STATUS_BY_FAILURE).toEqual({
      REPAIR_NOT_FOUND: 404,
      REPRESENTATION_NOT_FOUND: 404,
      REVISION_CONFLICT: 409,
      IDEMPOTENCY_CONFLICT: 409,
      ALREADY_TERMINAL: 409,
      INVALID_CORRECTION: 422,
      AUDIT_REJECTED: 422,
      UNITIZATION_REJECTED: 422,
      APPROVER_NOT_AUTHORIZED: 403,
      CUSTODY_FAILURE: 500,
    });
  });

  it("never leaks corrected or source text in a failure body", () => {
    const response = repairFailureResponse(
      "INVALID_CORRECTION",
      `Rejected correction: ${CORRECTED_TEXT}`,
    );
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).not.toContain(CORRECTED_TEXT);
    expect(JSON.stringify(response.body)).not.toContain("corrected intro");
  });

  it("returns a stable machine readable code rather than prose only", () => {
    const response = repairFailureResponse("REVISION_CONFLICT", "stale");
    expect(response.body).toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("distinguishes an unauthorised approver from a missing repair", () => {
    expect(repairFailureResponse("APPROVER_NOT_AUTHORIZED", "no").status).toBe(
      403,
    );
    expect(repairFailureResponse("REPAIR_NOT_FOUND", "no").status).toBe(404);
  });
});

describe("repair review response is projection only", () => {
  it("accepts a review projection carrying no source text", () => {
    expect(
      RepairReviewResponseSchema.parse({
        repairId: REPAIR_ID,
        state: "proposed",
        representationId: REPRESENTATION_ID,
        correctionArtifactId: "cor-01ARZ3NDEKTSV4RRFFQ69G5FAV",
        proposedBy: ACTOR,
        reason: "Extraction dropped the intro paragraph.",
        revision: 2,
        invalidatedUnitCount: 0,
      }),
    ).toMatchObject({ state: "proposed" });
  });

  it("rejects a review projection carrying representation text", () => {
    expect(
      RepairReviewResponseSchema.safeParse({
        repairId: REPAIR_ID,
        state: "proposed",
        representationId: REPRESENTATION_ID,
        correctionArtifactId: "cor-01ARZ3NDEKTSV4RRFFQ69G5FAV",
        proposedBy: ACTOR,
        reason: "Extraction dropped the intro paragraph.",
        revision: 2,
        invalidatedUnitCount: 0,
        normalizedText: CORRECTED_TEXT,
      }).success,
    ).toBe(false);
  });
});
