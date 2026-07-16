import { readdir } from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  AgentRuntime,
  loadAgentDefinition,
  type AgentDefinition,
} from "../agents/index.js";
import type { LlmProvider } from "../providers/index.js";

export interface AgentMcpOptions {
  definitionsRoot: string;
  provider: LlmProvider;
  name?: string;
  version?: string;
}

export async function createAgentMcpServer(
  options: AgentMcpOptions,
): Promise<McpServer> {
  const server = new McpServer({
    name: options.name ?? "ultradyn-docs",
    version: options.version ?? "0.1.0",
  });
  await registerAgentTools(server, options);
  return server;
}

async function registerAgentTools(
  server: McpServer,
  options: Pick<AgentMcpOptions, "definitionsRoot" | "provider">,
): Promise<string[]> {
  const definitions = await listAgentDefinitions(options.definitionsRoot);
  for (const definition of definitions) {
    registerAgentTool(server, definition, options);
  }
  return definitions.map((definition) => definition.name);
}

function registerAgentTool(
  server: McpServer,
  definition: AgentDefinition,
  options: Pick<AgentMcpOptions, "definitionsRoot" | "provider">,
): void {
  if (definition.outputSchema.type !== "object") {
    throw new Error(
      `Agent ${definition.name} must have an object output schema to be exposed as an MCP tool.`,
    );
  }
  const inputSchema = z.fromJSONSchema(
    definition.inputSchema as Parameters<typeof z.fromJSONSchema>[0],
  );
  const outputSchema = z.fromJSONSchema(
    definition.outputSchema as Parameters<typeof z.fromJSONSchema>[0],
  );
  server.registerTool(
    definition.name,
    {
      title: definition.name,
      description: definition.description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      if (!isRecord(input)) {
        throw new Error(`Agent ${definition.name} requires an object input.`);
      }
      const runtime = new AgentRuntime({
        definitionsRoot: options.definitionsRoot,
        provider: options.provider,
      });
      const output = await runtime.invoke(definition.name, input);
      if (!isRecord(output)) {
        throw new Error(
          `Agent ${definition.name} returned non-object structured content.`,
        );
      }
      return {
        structuredContent: output,
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  );
}

async function listAgentDefinitions(root: string): Promise<AgentDefinition[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries
    .filter(
      (entry) => entry.isDirectory() && /^[a-z][a-z0-9-]*$/u.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
  return Promise.all(names.map((name) => loadAgentDefinition(root, name)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
