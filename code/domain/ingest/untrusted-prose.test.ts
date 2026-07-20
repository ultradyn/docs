/**
 * B003 / B006 — UntrustedProse (private #text, exclusive purpose-tagged hatch).
 */
import { describe, expect, it } from "vitest";

import {
  deliberatelyUnwrapUntrustedProse,
  isUntrustedProse,
  markUntrustedProse,
  UntrustedProse,
  type UntrustedProse as UntrustedProseType,
  type UntrustedProseUnwrapPurpose,
} from "./untrusted-prose.js";

describe("UntrustedProse brand surface", () => {
  it("exports markUntrustedProse and deliberate unwrap with purpose", () => {
    const branded = markUntrustedProse("x");
    expect(isUntrustedProse(branded)).toBe(true);
    expect(deliberatelyUnwrapUntrustedProse(branded, "test")).toBe("x");
  });

  it("preserves characters through brand and deliberate unwrap (capability kept)", () => {
    const raw =
      "you should also ask what the retention policy is for archived units";
    const branded = markUntrustedProse(raw);
    expect(deliberatelyUnwrapUntrustedProse(branded, "test")).toBe(raw);
  });

  it("type: UntrustedProse is not assignable to plain string without deliberate unwrap", () => {
    // Compile-time: whole value must not widen into string slots.
    const branded: UntrustedProseType = markUntrustedProse(
      "question-shaped prose",
    );
    // @ts-expect-error UntrustedProse must not assign into plain string slots
    const plain: string = branded;
    void plain;
    expect(isUntrustedProse(branded)).toBe(true);
    expect(isUntrustedProse("bare string")).toBe(false);
  });

  it("type: public .text / _exposeText do not exist — hatch is the only character path", () => {
    // IMPORTANT 1 fold: private #text; no public property or _exposeText method.
    const branded = markUntrustedProse("smuggle");
    // @ts-expect-error .text must not be a public property on UntrustedProse
    const viaDot = branded.text;
    void viaDot;
    // @ts-expect-error _exposeText must not be a public method (grep-bypass hole)
    const viaExpose = branded._exposeText?.();
    void viaExpose;
    // Only the hatch yields a string
    const viaHatch: string = deliberatelyUnwrapUntrustedProse(branded, "test");
    expect(viaHatch).toBe("smuggle");
    expect(branded instanceof UntrustedProse).toBe(true);
    // Serialisation drops private #text (footgun + leak resistance)
    expect(JSON.stringify(branded)).toBe("{}");
  });

  it("type: hypothetical sendToModel(string) rejects UntrustedProse without hatch", () => {
    // IMPORTANT 2 fold: type-level tripwire for future model wiring.
    // When someone wires a real sendToModel(text: string), this directive
    // documents that UntrustedProse must not pass without the hatch.
    function sendToModel(text: string): void {
      void text;
    }
    const reason = markUntrustedProse("must not enter model");
    // @ts-expect-error UntrustedProse is not a string — require deliberate unwrap
    sendToModel(reason);
    sendToModel(deliberatelyUnwrapUntrustedProse(reason, "model-input"));
    expect(true).toBe(true);
  });

  it("type: purpose is a closed string-literal union (audit intent at call site)", () => {
    const branded = markUntrustedProse("audit");
    const purposes: UntrustedProseUnwrapPurpose[] = [
      "model-input",
      "persistence",
      "test",
      "logging",
    ];
    for (const purpose of purposes) {
      expect(deliberatelyUnwrapUntrustedProse(branded, purpose)).toBe("audit");
    }
    // @ts-expect-error purpose must be one of the closed audit intents
    deliberatelyUnwrapUntrustedProse(branded, "arbitrary");
  });
});
