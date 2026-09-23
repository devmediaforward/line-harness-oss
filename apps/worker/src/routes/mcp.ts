import { Hono, type Context } from 'hono';
import {
  createServer,
  createToolContext,
  WebStandardStreamableHTTPServerTransport,
} from '@line-harness/mcp-server/server';
import { getActiveStaffByEmail } from '@line-crm/db';
import { authenticateApiToken } from '../middleware/auth.js';
import { getClientIp } from '../middleware/rate-limit.js';
import {
  getDescopeMcpConfig,
  getRemoteJwks,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  protectedResourceUrl,
  verifyDescopeAccessToken,
  type JwksResolver,
} from '../lib/mcp-oauth.js';
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
const FORBIDDEN = { success: false, error: 'Forbidden' } as const;
const NOT_FOUND = { success: false, error: 'Not Found' } as const;
const METHOD_NOT_ALLOWED = { success: false, error: 'Method Not Allowed' } as const;

export interface McpRouteOptions {
  /**
   * Key set resolver for Descope access tokens. Defaults to a cached remote
   * JWKS; tests pass a local key set instead.
   */
  resolveJwks?: JwksResolver;
}

/**
 * Run one stateless MCP exchange whose tools call the API as `apiKey`.
 * Shared by both endpoints so they differ only in how they authenticate.
 */
async function serveMcp(c: Context<Env>, apiKey: string, appFetch: AppFetch): Promise<Response> {
  const env = c.env;
  const executionCtx = c.executionCtx;
  // Resolved from the *outer* request only. Internal loopback requests carry
  // no client IP, so without this every tenant's tool calls would share the
  // `ip-ceiling:0.0.0.0` bucket and throttle each other.
  const clientIp = getClientIp(c);

  const toolContext = createToolContext({
    apiUrl: new URL(c.req.url).origin,
    apiKey,
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
}

/**
 * RFC 6750 challenge pointing the client at the protected resource metadata,
 * which is how an MCP client discovers where to log in.
 */
function bearerChallenge(c: Context<Env>, invalidToken: boolean): Response {
  let challenge = `Bearer resource_metadata="${protectedResourceMetadataUrl(c.req.url)}"`;
  if (invalidToken) challenge += ', error="invalid_token"';
  return c.json(UNAUTHORIZED, 401, { 'WWW-Authenticate': challenge });
}

/**
 * Remote MCP endpoints.
 *
 * - `POST /mcp/<apiKey>`: paste the URL into an MCP client (e.g. a Claude
 *   custom connector) and the full tool set is available with no local config
 *   file. The API key travels in the path because MCP clients that only accept
 *   a URL cannot send an Authorization header.
 * - `POST /mcp`: OAuth. Descope issues the access token, this Worker verifies
 *   it and maps its `email` claim to exactly one active staff member, whose
 *   own API key (and therefore role) the tools then run with. Disabled (404)
 *   unless DESCOPE_MCP_ISSUER and DESCOPE_JWKS_URL are both set.
 *
 * Isolate safety: a Cloudflare isolate is reused across requests from
 * different tenants, so every piece of per-tenant state is created inside the
 * handler and captured only by that request's closures. Nothing (client,
 * context, server, transport) is stored at module scope. The only module-scope
 * state is the Descope JWKS cache, which holds public keys.
 *
 * Cost: the SDK client dispatches through `app.fetch`, so API calls made by a
 * tool re-enter this same isolate instead of leaving as billable subrequests.
 */
export function createMcpRoute(appFetch: AppFetch, options: McpRouteOptions = {}): Hono<Env> {
  const resolveJwks = options.resolveJwks ?? getRemoteJwks;
  const mcp = new Hono<Env>();

  mcp.post('/mcp/:token', async (c) => {
    const token = c.req.param('token');
    // Same resolver as the normal auth middleware (staff key -> API_KEY ->
    // LEGACY_API_KEY), so /mcp/:token accepts exactly the credentials the rest
    // of the API accepts. Using getStaffByApiKey alone rejected env-key owners.
    const staff = await authenticateApiToken(c, token);
    if (!staff) return c.json(UNAUTHORIZED, 401);
    return serveMcp(c, token, appFetch);
  });

  // The Streamable HTTP spec allows a server without server-initiated
  // messages to refuse the GET stream and the DELETE session teardown.
  mcp.on(['GET', 'DELETE'], '/mcp/:token', (c) => c.json(METHOD_NOT_ALLOWED, 405));

  // RFC 9728 metadata. The canonical location for resource `<origin>/mcp` is
  // `/.well-known/oauth-protected-resource/mcp`; the other two are the root
  // form and the location Descope's documentation uses.
  mcp.on(
    'GET',
    [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/mcp/.well-known/oauth-protected-resource',
    ],
    (c) => {
      const config = getDescopeMcpConfig(c.env);
      if (!config) return c.json(NOT_FOUND, 404);
      return c.json(protectedResourceMetadata(c.req.url, config), 200, {
        'Cache-Control': 'public, max-age=300',
      });
    },
  );

  mcp.all('/mcp', async (c) => {
    const config = getDescopeMcpConfig(c.env);
    if (!config) return c.json(NOT_FOUND, 404);
    if (c.req.method !== 'POST') return c.json(METHOD_NOT_ALLOWED, 405);

    const authHeader = c.req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
    if (!token) return bearerChallenge(c, false);

    const claims = await verifyDescopeAccessToken(token, {
      config,
      audience: protectedResourceUrl(c.req.url),
      resolveJwks,
    });
    if (!claims) return bearerChallenge(c, true);

    // The token proves who logged in to Descope; the staff table decides what
    // they may do. Only an unambiguous match on an active staff member passes.
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (!email) return c.json(FORBIDDEN, 403);
    // Descope may not put `email_verified` in MCP access tokens at all, so its
    // absence is tolerated (sign-up is invite-only); an explicit `false` is not.
    if (claims.email_verified === false) return c.json(FORBIDDEN, 403);
    const matches = await getActiveStaffByEmail(c.env.DB, email);
    if (matches.length !== 1) return c.json(FORBIDDEN, 403);

    // Run the tools with that staff member's own key, so the API enforces
    // their role. Never use env API_KEY here: it is the owner key and would
    // escalate every Descope user to owner.
    return serveMcp(c, matches[0].api_key, appFetch);
  });

  return mcp;
}
