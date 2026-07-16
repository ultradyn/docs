import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { FixtureAgentLlmProvider, startAgentMcpStdioHost } from "./index.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const definitionsRoot = existsSync(join(repositoryRoot, "scaffold", "agents"))
  ? join(repositoryRoot, "scaffold", "agents")
  : join(repositoryRoot, "agents");

async function fixture(
  name: string,
  file: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(definitionsRoot, name, "fixtures", file), "utf8"),
  ) as Record<string, unknown>;
}

describe("agent MCP host", () => {
  it("lists all scaffold agents and calls a fixture-backed tool over MCP", async () => {
    const input = await fixture("diff-summarizer", "001-input.json");
    const expected = await fixture("diff-summarizer", "001-expected.json");
    const provider = new FixtureAgentLlmProvider(definitionsRoot);
    const client = new Client({ name: "ultradyn-mcp-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const server = await startAgentMcpStdioHost({
      definitionsRoot,
      provider,
      transport: serverTransport,
    });
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "agent-smith",
        "critic",
        "diff-summarizer",
        "goal-clerk",
        "integrator",
        "librarian",
        "matcher",
        "prioritizer",
        "registrar",
        "reviewer",
        "simulated-asker",
        "structurer",
      ]);
      expect(
        listed.tools.every((tool) => tool.inputSchema.type === "object"),
      ).toBe(true);

      const diffSummarizer = listed.tools.find(
        (tool) => tool.name === "diff-summarizer",
      );
      expect(diffSummarizer?.inputSchema).toMatchObject({
        type: "object",
        properties: { diff: {} },
        required: ["diff"],
      });
      expect(diffSummarizer?.outputSchema).toMatchObject({
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1 },
          changes: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          risks: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
        },
        required: ["summary", "changes", "risks"],
      });

      const critic = listed.tools.find((tool) => tool.name === "critic");
      expect(critic?.inputSchema).toMatchObject({
        properties: {
          question: {},
          goals: {},
          structuredAnswer: {},
          documentation: {},
        },
        required: ["question", "goals", "structuredAnswer", "documentation"],
      });
      expect(critic?.outputSchema).toMatchObject({
        properties: {
          done: { type: "boolean" },
          goalResults: { type: "array" },
          findings: { type: "array" },
          deferredQuestions: { type: "array" },
          contradictions: { type: "array" },
        },
        required: [
          "done",
          "goalResults",
          "findings",
          "deferredQuestions",
          "contradictions",
        ],
      });

      const result = await client.callTool({
        name: "diff-summarizer",
        arguments: input,
      });
      expect("structuredContent" in result && result.structuredContent).toEqual(
        expected,
      );
      expect("content" in result && result.content).toEqual([
        { type: "text", text: JSON.stringify(expected, null, 2) },
      ]);
      expect(provider.requests).toHaveLength(1);
      expect(JSON.parse(provider.requests[0]!.messages[0]!.content)).toEqual(
        input,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
