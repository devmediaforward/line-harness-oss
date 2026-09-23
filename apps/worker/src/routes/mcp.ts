import { Hono } from 'hono';
import {
  createServer,
  createToolContext,
  WebStandardStreamableHTTPServerTransport,
} from '@line-harness/mcp-server/server';
import { authenticateApiToken } from '../middleware/auth.js';
import { getClientIp } from '../middleware/rate-limit.js';
import type { Env } from '../index.js';

/**
 * Hono's own `app.fetch`. Passing it in (rather than importing `app`) avoids a
 * circular import between index.ts and this module.
 */
type AppFetch = (
  request: Request,
  env?: Env['Bindings'] | Record<string, never>,
  executionCtx?: ExecutionContext,
) => Response | Promise<Response>;

const UNAUTHORIZED = { success: false, error: 'Unauthorized' } as const;

/**
 * Remote MCP endpoint: `POST /mcp/<apiKey>`.
 *
 * Paste the URL into an MCP client (e.g. a Claude custom connector) and the
 * full tool set is available with no local config file. The API key travels in
 * the path because MCP clients that only accept a URL cannot send an
 * Authorization header — see the security note below.
 *
 * Isolate safety: a Cloudflare isolate is reused across requests from
 * different tenants, so every piece of per-tenant state is created inside the
 * handler and captured only by that request's closures. Nothing (client,
 * context, server, transport) is stored at module scope.
 *
 * Cost: the SDK client dispatches through `app.fetch`, so API calls made by a
 * tool re-enter this same isolate instead of leaving as billable subrequests.
 */
export function createMcpRoute(appFetch: AppFetch): Hono<Env> {
  const mcp = new Hono<Env>();

  mcp.post('/mcp/:token', async (c) => {
    const token = c.req.param('token');
    // Same resolver as the normal auth middleware (staff key -> API_KEY ->
    // LEGACY_API_KEY), so /mcp/:token accepts exactly the credentials the rest
    // of the API accepts. Using getStaffByApiKey alone rejected env-key owners.
    const staff = await authenticateApiToken(c, token);
    if (!staff) return c.json(UNAUTHORIZED, 401);

    const env = c.env;
    const executionCtx = c.executionCtx;
    // Resolved from the *outer* request only. Internal loopback requests carry
    // no client IP, so without this every tenant's tool calls would share the
    // `ip-ceiling:0.0.0.0` bucket and throttle each other.
    const clientIp = getClientIp(c);

    const toolContext = createToolContext({
      apiUrl: new URL(c.req.url).origin,
      apiKey: token,
      fetch: (input, init) => {
        const request = new Request(input, init);
        request.headers.set('cf-connecting-ip', clientIp);
        return Promise.resolve(appFetch(request, env, executionCtx));
      },
    });

    const server = createServer(toolContext);
    const transport = new WebStandardStreamableHTTPServerTransport({
      // Stateless: one server + transport per HTTP request. Sessions would
      // have to live in isolate memory, which is neither shared across
      // isolates nor safe to reuse across tenants.
      sessionIdGenerator: undefined,
      // Plain JSON replies instead of SSE — an SSE stream would hold the
      // Worker request open with nothing to push in stateless mode.
      enableJsonResponse: true,
    });

    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  // The Streamable HTTP spec allows a server without server-initiated
  // messages to refuse the GET stream and the DELETE session teardown.
  mcp.on(['GET', 'DELETE'], '/mcp/:token', (c) =>
    c.json({ success: false, error: 'Method Not Allowed' }, 405),
  );

  return mcp;
}
