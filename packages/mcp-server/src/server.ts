import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "./tools/index.js";
import { registerAllResources } from "./resources/index.js";
import type { ToolContext } from "./context.js";

export const SERVER_NAME = "line-harness";
/** Keep in sync with package.json's `version`. */
export const SERVER_VERSION = "0.18.0";

/**
 * Build a fully registered MCP server bound to a single tenant's context.
 *
 * Runtime-agnostic: no `node:fs` / `node:path` / `node:url` / `process.env`,
 * so it also runs inside a Cloudflare Worker. Call it once per MCP session —
 * the returned server closes over `ctx`, and nothing is shared at module scope.
 */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerAllTools(server, ctx);
  registerAllResources(server, ctx);

  return server;
}

export { createToolContext } from "./context.js";
export type { ToolContext, ToolContextConfig } from "./context.js";

// Re-exported so hosts can serve this server over Streamable HTTP without
// taking a direct dependency on @modelcontextprotocol/sdk (keeping a single
// resolved copy of the protocol SDK across the workspace).
export { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
