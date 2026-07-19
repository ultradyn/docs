import { describe, expect, it } from "vitest";

import * as ingest from "./index.js";

/**
 * The plan's Files list for T-13-01 requires code/ingest/index.ts to export the
 * policy seam. Without it the run gate is unreachable from the package barrel:
 * inert by lack of export, not merely by lack of caller.
 */
describe("the ingest package exposes the policy seam", () => {
  it("exports the policy service factory", () => {
    expect(typeof ingest.createPolicyService).toBe("function");
  });

  it("exports both approval store implementations", () => {
    expect(typeof ingest.createInMemoryPolicyApprovalStore).toBe("function");
    expect(typeof ingest.createFilePolicyApprovalStore).toBe("function");
  });

  it("exports the portable approval root", () => {
    expect(ingest.POLICY_APPROVAL_ROOT).toBe("ingest/policy-approvals");
  });

  it("exposes no deletion capability from the package barrel", () => {
    for (const name of Object.keys(ingest)) {
      expect(name).not.toMatch(/delete|erase|purge|unlink|revoke/iu);
    }
  });
});
