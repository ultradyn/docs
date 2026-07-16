import { describe, expect, it } from "vitest";

import * as server from "./index.js";

describe("server public module surface", () => {
  it("exports only the deliberate production entry points", () => {
    expect(Object.keys(server).sort()).toEqual([
      "EventHub",
      "ProviderRuntimeFactory",
      "ServiceError",
      "buildServer",
      "createDefaultProviderRuntimeFactory",
      "createDemoServices",
      "createLocalServices",
      "localDataRootForRepository",
      "startUltradynServer",
    ]);
  });
});
