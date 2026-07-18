import { describe, expect, it } from "vitest";

import * as integration from "./index.js";

describe("integration public module surface", () => {
  it("exports only the deliberate change-request entry points", () => {
    expect(Object.keys(integration).sort()).toEqual([
      "ChangeRequestBlockedError",
      "LocalChangeRequestManager",
      "nodeFileReader",
      "validateIngestBundle",
    ]);
  });
});
