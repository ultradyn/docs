import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { createAgentMcpServer, type AgentMcpOptions } from "./agent-mcp.js";

export async function startAgentMcpStdioHost(
  options: AgentMcpOptions & { transport?: Transport },
): Promise<McpServer> {
  const server = await createAgentMcpServer(options);
  await server.connect(options.transport ?? new StdioServerTransport());
  return server;
}
