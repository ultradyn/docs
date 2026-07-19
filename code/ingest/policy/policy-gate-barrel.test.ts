import { describe, expect, it } from "vitest";

import * as policy from "./index.js";

/**
 * The gate is public; the testing fakes (attestation authority, unit-access
 * resolver) must never be reachable from the package barrel — a public
 * capability hook on a policy gate is an invitation to weaken it.
 */
describe("the policy barrel exposes the gate but not the test seam", () => {
  it("exports the gate factory", () => {
    expect(typeof policy.createPolicyGate).toBe("function");
  });

  it("does not export any testing fake", () => {
    for (const name of Object.keys(policy)) {
      expect(name).not.toMatch(/fake|forTests|testing|integrityAttestation/iu);
    }
  });
});
