import { describe, expect, it } from "vitest";

import * as mcp from "./index.js";

describe("MCP public module surface", () => {
  it("exports only the deliberate host entry points", () => {
    expect(Object.keys(mcp).sort()).toEqual([
      "FixtureAgentLlmProvider",
      "createAgentMcpServer",
      "startAgentMcpStdioHost",
    ]);
  });
});
