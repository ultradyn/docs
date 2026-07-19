import { describe, expect, it } from "vitest";

import {
  EvidenceVerdictSchema,
  EvidenceVerdictIdSchema,
  ReferenceClassificationSchema,
  FacetStateSchema,
  TerminalVerdictSchema,
  BoundedFollowUpSchema,
  canonicalVerdictPayloadDigest,
} from "./evidence-verdict.js";

const VALID_ID = "evv-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PACKET_ID = "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const QUESTION_ID = "q-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UNIT_A = "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DIGEST = "a".repeat(64);

/**
 * River T-21-02 binding: protocol/schema enums win over plan shorthand.
 * material = packet role primary (not a classification token).
 */
function baseVerdict(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    id: VALID_ID,
    questionId: QUESTION_ID,
    packetId: PACKET_ID,
    packetVersion: 1,
    version: 1,
    referenceReviews: [
      {
        unitId: UNIT_A,
        classification: "necessary_primary",
        reason: "Defines the subject.",
      },
    ],
    facetStates: [
      {
        facetId: "purpose",
        state: "satisfied",
        sourceUnitIds: [UNIT_A],
        reason: "Direct definition.",
      },
    ],
    verdict: "accepted",
    criticisms: [] as string[],
    followUpRequest: null,
    packetDigest: DIGEST,
    ...overrides,
  };
}

describe("EvidenceVerdict domain exports (River protocol enums)", () => {
  it("exports EvidenceVerdictSchema with safeParse", () => {
    expect(typeof EvidenceVerdictSchema?.safeParse).toBe("function");
  });

  it("exports EvidenceVerdictIdSchema with evv- brand only", () => {
    expect(EvidenceVerdictIdSchema.safeParse(VALID_ID).success).toBe(true);
    expect(
      EvidenceVerdictIdSchema.safeParse("pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV")
        .success,
    ).toBe(false);
    expect(
      EvidenceVerdictIdSchema.safeParse("evp-01ARZ3NDEKTSV4RRFFQ69G5FAV")
        .success,
    ).toBe(false);
    expect(
      EvidenceVerdictIdSchema.safeParse("evr-01ARZ3NDEKTSV4RRFFQ69G5FAV")
        .success,
    ).toBe(false);
  });

  it("reference classification enum is closed protocol set (not plan shorthand)", () => {
    const allowed = [
      "necessary_primary",
      "necessary_qualifying",
      "useful_example",
      "context_only",
      "redundant",
      "irrelevant",
      "wrong_scope",
      "deprecated_for_scope",
      "conflicting",
      "unverifiable",
    ] as const;
    for (const value of allowed) {
      expect(ReferenceClassificationSchema.safeParse(value).success).toBe(true);
    }
    for (const bad of ["material", "supporting", "obsolete", "primary"]) {
      expect(ReferenceClassificationSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("facet state enum is closed protocol set", () => {
    const allowed = [
      "satisfied",
      "partial",
      "missing",
      "conflicting",
      "ambiguous_scope",
      "unsupported_in_snapshot",
      "not_applicable",
    ] as const;
    for (const value of allowed) {
      expect(FacetStateSchema.safeParse(value).success).toBe(true);
    }
    expect(FacetStateSchema.safeParse("unsatisfied").success).toBe(false);
    expect(FacetStateSchema.safeParse("uncertain").success).toBe(false);
  });

  it("terminal verdict enum is closed protocol set (includes search_incomplete)", () => {
    const allowed = [
      "accepted",
      "needs_more_evidence",
      "ambiguous_scope",
      "conflicting_or_deprecated",
      "no_supported_answer",
      "human_authority_required",
      "source_processing_blocked",
      "search_incomplete",
    ] as const;
    for (const value of allowed) {
      expect(TerminalVerdictSchema.safeParse(value).success).toBe(true);
    }
    expect(TerminalVerdictSchema.safeParse("refine").success).toBe(false);
    expect(TerminalVerdictSchema.safeParse("contradiction").success).toBe(
      false,
    );
  });

  it("accepts a complete valid accepted verdict with packetId (not evidencePacketId only)", () => {
    expect(EvidenceVerdictSchema.safeParse(baseVerdict()).success).toBe(true);
    // snake_case agent fields are not durable TS shape
    expect(
      EvidenceVerdictSchema.safeParse({
        ...baseVerdict(),
        evidence_packet_id: PACKET_ID,
      }).success,
    ).toBe(false);
  });

  it("rejects legacy placeholder {schemaVersion,id} alone", () => {
    expect(
      EvidenceVerdictSchema.safeParse({
        schemaVersion: 1,
        id: VALID_ID,
      }).success,
    ).toBe(false);
  });

  it("requires packetId, packetVersion, packetDigest binding", () => {
    for (const key of ["packetId", "packetVersion", "packetDigest"] as const) {
      const copy = baseVerdict();
      delete (copy as Record<string, unknown>)[key];
      expect(EvidenceVerdictSchema.safeParse(copy).success).toBe(false);
    }
  });

  it("rejects unknown keys and child-proposal smuggling fields", () => {
    for (const bad of [
      { childQuestionProposals: [{ text: "why?" }] },
      { childQuestions: ["spawn"] },
      { proposedChildren: [] },
      { evil: true },
    ]) {
      expect(
        EvidenceVerdictSchema.safeParse(baseVerdict(bad)).success,
      ).toBe(false);
    }
  });

  it("requires non-empty reason strings on reviews and facet states", () => {
    expect(
      EvidenceVerdictSchema.safeParse(
        baseVerdict({
          referenceReviews: [
            { unitId: UNIT_A, classification: "irrelevant", reason: "" },
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      EvidenceVerdictSchema.safeParse(
        baseVerdict({
          facetStates: [{ facetId: "purpose", state: "missing", reason: "" }],
        }),
      ).success,
    ).toBe(false);
  });

  it("BoundedFollowUpSchema is strict (no additionalProperties / children)", () => {
    const ok = {
      missingFacetIds: ["auth-failure"],
      requiredSearch: {
        subject: "token validation errors",
        scope: "public API v2",
        exclusions: ["client SDK retry"],
      },
      whyCurrentPacketFails: "No unit covers failure modes.",
    };
    expect(BoundedFollowUpSchema.safeParse(ok).success).toBe(true);
    expect(BoundedFollowUpSchema.safeParse({}).success).toBe(false);
    expect(
      BoundedFollowUpSchema.safeParse({
        ...ok,
        childQuestions: ["spawn?"],
      }).success,
    ).toBe(false);
    // JSON-schema-open freeform keys rejected
    expect(
      BoundedFollowUpSchema.safeParse({
        ...ok,
        arbitraryAgentField: true,
      }).success,
    ).toBe(false);
  });

  it("canonicalVerdictPayloadDigest is fixed-field not key-order sensitive", () => {
    const a = {
      questionId: QUESTION_ID,
      packetId: PACKET_ID,
      packetVersion: 1,
      packetDigest: DIGEST,
      referenceReviews: [
        {
          unitId: UNIT_A,
          classification: "necessary_primary" as const,
          reason: "r",
        },
      ],
      facetStates: [
        {
          facetId: "purpose",
          state: "satisfied" as const,
          sourceUnitIds: [UNIT_A],
          reason: "r",
        },
      ],
      verdict: "accepted" as const,
      criticisms: [] as string[],
      followUpRequest: null as null,
    };
    const b = {
      criticisms: [],
      verdict: "accepted" as const,
      followUpRequest: null as null,
      facetStates: [
        {
          reason: "r",
          state: "satisfied" as const,
          facetId: "purpose",
          sourceUnitIds: [UNIT_A],
        },
      ],
      referenceReviews: [
        {
          reason: "r",
          classification: "necessary_primary" as const,
          unitId: UNIT_A,
        },
      ],
      packetDigest: DIGEST,
      packetVersion: 1,
      packetId: PACKET_ID,
      questionId: QUESTION_ID,
    };
    expect(canonicalVerdictPayloadDigest(a)).toBe(
      canonicalVerdictPayloadDigest(b),
    );
    expect(canonicalVerdictPayloadDigest(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalVerdictPayloadDigest(a)).not.toBe(
      canonicalVerdictPayloadDigest({ ...a, criticisms: ["different"] }),
    );
  });
});
