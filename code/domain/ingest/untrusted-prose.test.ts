/**
 * B003 — UntrustedProse brand (RED-first).
 *
 * Compile-time control: free-text critic justifications travel branded so
 * accidental model round-trip fails the build without deliberate expose.
 */
import { describe, expect, it } from "vitest";

import {
  deliberatelyExposeUntrustedProseToModel,
  isUntrustedProse,
  markUntrustedProse,
  type UntrustedProse,
} from "./untrusted-prose.js";

describe("UntrustedProse brand surface", () => {
  it("exports markUntrustedProse and deliberate model expose", () => {
    // Discriminating: must exercise behaviour (not bare typeof on throw stubs).
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
    // Compile-time guard — object wrapper must not widen into string slots.
    // If this becomes assignable, @ts-expect-error is unused and tsc fails.
    const branded: UntrustedProse = markUntrustedProse("question-shaped prose");
    // @ts-expect-error UntrustedProse must not silently assign into plain string slots
    const plain: string = branded;
    void plain;
    expect(isUntrustedProse(branded)).toBe(true);
    expect(isUntrustedProse("bare string")).toBe(false);
  });
});
