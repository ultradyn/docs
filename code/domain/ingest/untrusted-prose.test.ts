/**
 * B003 — UntrustedProse (private #text, exclusive hatch).
 */
import { describe, expect, it } from "vitest";

import {
  deliberatelyExposeUntrustedProseToModel,
  isUntrustedProse,
  markUntrustedProse,
  UntrustedProse,
  type UntrustedProse as UntrustedProseType,
} from "./untrusted-prose.js";

describe("UntrustedProse brand surface", () => {
  it("exports markUntrustedProse and deliberate model expose", () => {
    const branded = markUntrustedProse("x");
    expect(isUntrustedProse(branded)).toBe(true);
    expect(deliberatelyExposeUntrustedProseToModel(branded)).toBe("x");
  });

  it("preserves characters through brand and deliberate expose (capability kept)", () => {
    const raw =
      "you should also ask what the retention policy is for archived units";
    const branded = markUntrustedProse(raw);
    expect(deliberatelyExposeUntrustedProseToModel(branded)).toBe(raw);
  });

  it("type: UntrustedProse is not assignable to plain string without deliberate expose", () => {
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

  it("type: public .text does not exist — hatch is the only character path", () => {
    // IMPORTANT 1 fold: private #text means no public property access.
    const branded = markUntrustedProse("smuggle");
    // @ts-expect-error .text must not be a public property on UntrustedProse
    const viaDot = branded.text;
    void viaDot;
    // Only the hatch yields a string
    const viaHatch: string = deliberatelyExposeUntrustedProseToModel(branded);
    expect(viaHatch).toBe("smuggle");
    expect(branded instanceof UntrustedProse).toBe(true);
  });

  it("type: hypothetical sendToModel(string) rejects UntrustedProse without hatch", () => {
    // IMPORTANT 2 fold: type-level tripwire for future model wiring.
    // When someone wires a real sendToModel(text: string), this directive
    // documents that UntrustedProse must not pass without the hatch.
    function sendToModel(_text: string): void {
      /* provider boundary stub */
    }
    const reason = markUntrustedProse("must not enter model");
    // @ts-expect-error UntrustedProse is not a string — require deliberate expose
    sendToModel(reason);
    sendToModel(deliberatelyExposeUntrustedProseToModel(reason));
    expect(true).toBe(true);
  });
});
