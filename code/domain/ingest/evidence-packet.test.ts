import { describe, expect, it } from "vitest";

import {
  EvidencePacketSchema,
  EvidenceReferenceSchema,
  DEFAULT_EVIDENCE_PACKET_LIMITS,
} from "./evidence-packet.js";

describe("EvidencePacket domain exports (RED)", () => {
  it("exports EvidencePacketSchema", () => {
    expect(typeof EvidencePacketSchema?.safeParse).toBe("function");
  });
  it("exports EvidenceReferenceSchema", () => {
    expect(typeof EvidenceReferenceSchema?.safeParse).toBe("function");
  });
  it("exports DEFAULT_EVIDENCE_PACKET_LIMITS", () => {
    expect(DEFAULT_EVIDENCE_PACKET_LIMITS?.maxReferences).toBeGreaterThan(0);
  });
});
