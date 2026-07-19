import { describe, expect, it } from "vitest";

import {
  DEFAULT_EVIDENCE_PACKET_LIMITS,
  EvidencePacketSchema,
  EvidenceReferenceRoleSchema,
  EvidenceReferenceSchema,
  canonicalPacketPayloadDigest,
} from "./evidence-packet.js";

describe("EvidencePacket domain exports", () => {
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

  it("role enum is closed minimal primary|supporting only", () => {
    expect(EvidenceReferenceRoleSchema.safeParse("primary").success).toBe(true);
    expect(EvidenceReferenceRoleSchema.safeParse("supporting").success).toBe(
      true,
    );
    expect(EvidenceReferenceRoleSchema.safeParse("contradicting").success).toBe(
      false,
    );
    expect(EvidenceReferenceRoleSchema.safeParse("background").success).toBe(
      false,
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

  it("requires receiptDigest on the packet schema", () => {
    const without = {
      schemaVersion: 1,
      id: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      questionId: "q-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      version: 1,
      references: [],
      receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      limits: { maxReferences: 1, maxFacetsPerReference: 1 },
    };
    expect(EvidencePacketSchema.safeParse(without).success).toBe(false);
    expect(
      EvidencePacketSchema.safeParse({
        ...without,
        receiptDigest: "a".repeat(64),
      }).success,
    ).toBe(true);
  });

  it("rejects malformed packet id brands including epkt-", () => {
    const base = {
      schemaVersion: 1,
      questionId: "q-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      version: 1,
      references: [],
      receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      receiptDigest: "a".repeat(64),
      limits: { maxReferences: 1, maxFacetsPerReference: 1 },
    };
    expect(
      EvidencePacketSchema.safeParse({
        ...base,
        id: "epkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }).success,
    ).toBe(false);
    expect(
      EvidencePacketSchema.safeParse({
        ...base,
        id: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }).success,
    ).toBe(true);
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

  it("canonicalPacketPayloadDigest is stable under object key reorder", () => {
    const refs = [
      {
        snapshotId: `snap-${"b".repeat(64)}` as never,
        fileId: `file-${"a".repeat(64)}` as never,
        unitId: "unit-01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
        fileSha256: "a".repeat(64) as never,
        unitSha256: "b".repeat(64) as never,
        role: "primary" as const,
        facetIds: ["z", "a"],
      },
    ];
    const left = canonicalPacketPayloadDigest({
      schemaVersion: 1,
      id: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      questionId: "q-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      version: 1,
      references: refs,
      receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      receiptDigest: "c".repeat(64),
      limits: { maxReferences: 256, maxFacetsPerReference: 32 },
    });
    const right = canonicalPacketPayloadDigest({
      limits: { maxReferences: 256, maxFacetsPerReference: 32 },
      receiptDigest: "c".repeat(64),
      receiptId: "rcpt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      references: refs,
      version: 1,
      questionId: "q-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      id: "pkt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      schemaVersion: 1,
    });
    expect(left).toBe(right);
  });
});
