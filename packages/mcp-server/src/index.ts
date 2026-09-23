#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createToolContext } from "./context.js";
import { createServer } from "./server.js";

function buildContextFromEnv() {
  const apiUrl = process.env.LINE_HARNESS_API_URL;
  const apiKey = process.env.LINE_HARNESS_API_KEY;
  const accountId = process.env.LINE_HARNESS_ACCOUNT_ID;

  if (!apiUrl) {
    throw new Error("LINE_HARNESS_API_URL environment variable is required");
  }
  if (!apiKey) {
    throw new Error("LINE_HARNESS_API_KEY environment variable is required");
  }

  return createToolContext({ apiUrl, apiKey, lineAccountId: accountId });
}

async function main() {
  const server = createServer(buildContextFromEnv());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("LINE Harness MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
