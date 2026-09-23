import { LineHarness } from "@line-harness/sdk";

/**
 * Configuration needed to talk to a LINE Harness deployment.
 *
 * `fetch` is injectable so a host that must not issue a real network
 * request (a Cloudflare Worker calling back into itself) can dispatch
 * in-process instead of over the network.
 */
export interface ToolContextConfig {
  apiUrl: string;
  apiKey: string;
  lineAccountId?: string;
  fetch?: typeof fetch;
}

/**
 * Per-request dependencies handed to every tool/resource registration.
 *
 * This object is created once per MCP server instance and passed down
 * explicitly. Nothing is cached at module scope: a Cloudflare Worker
 * isolate is reused across requests from different tenants, so a shared
 * singleton would leak one tenant's API key into another's session.
 */
export interface ToolContext {
  client: LineHarness;
  apiUrl: string;
  apiKey: string;
  fetch: typeof fetch;
}

export function createToolContext(config: ToolContextConfig): ToolContext {
  const apiUrl = config.apiUrl.replace(/\/$/, "");
  const fetchImpl = config.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  return {
    client: new LineHarness({
      apiUrl,
      apiKey: config.apiKey,
      lineAccountId: config.lineAccountId,
      fetch: fetchImpl,
    }),
    apiUrl,
    apiKey: config.apiKey,
    fetch: fetchImpl,
  };
}
