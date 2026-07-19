import { describe, expect, it } from "vitest";

import {
  DEFAULT_EVIDENCE_PACKET_LIMITS,
  EvidencePacketSchema,
  EvidenceReferenceRoleSchema,
  EvidenceReferenceSchema,
} from "./evidence-packet.js";

describe("EvidencePacket domain exports (RED)", () => {
  it("exports EvidencePacketSchema", () => {
    expect(typeof EvidencePacketSchema?.safeParse).toBe("function");
  });

  it("exports EvidenceReferenceSchema", () => {
    expect(typeof EvidenceReferenceSchema?.safeParse).toBe("function");
  });

  it("exports DEFAULT_EVIDENCE_PACKET_LIMITS with positive budgets", () => {
    expect(DEFAULT_EVIDENCE_PACKET_LIMITS?.maxReferences).toBeGreaterThan(0);
    expect(
      DEFAULT_EVIDENCE_PACKET_LIMITS?.maxFacetsPerReference,
    ).toBeGreaterThan(0);
  });

  it("role enum is closed (rejects material if not in set)", () => {
    expect(EvidenceReferenceRoleSchema.safeParse("primary").success).toBe(true);
    expect(EvidenceReferenceRoleSchema.safeParse("supporting").success).toBe(
      true,
    );
    expect(EvidenceReferenceRoleSchema.safeParse("material").success).toBe(
      false,
    );
  });

  it("rejects legacy placeholder {schemaVersion,id} alone", () => {
    expect(
      EvidencePacketSchema.safeParse({
        schemaVersion: 1,
        id: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys on references (strict)", () => {
    expect(
      EvidenceReferenceSchema.safeParse({
        snapshotId: `snap-${"b".repeat(64)}`,
        fileId: `file-${"a".repeat(64)}`,
        unitId: "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV",
        fileSha256: "a".repeat(64),
        unitSha256: "b".repeat(64),
        role: "primary",
        facetIds: [],
        extra: true,
      }).success,
    ).toBe(false);
  });
});
