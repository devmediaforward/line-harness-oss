import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type FetchImplementation,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { Env } from '../index.js';

/**
 * OAuth for the remote MCP endpoint `/mcp`: this Worker is the resource server
 * and Descope is the authorization server (RFC 9728 protected resource
 * metadata + Bearer access tokens).
 */
export interface DescopeMcpConfig {
  issuer: string;
  jwksUrl: string;
}

/**
 * Both values are public Worker vars. Either one missing (or empty) disables
 * the feature, so a deployment that has not configured Descope keeps serving
 * 404 on `/mcp` and the metadata paths.
 */
export function getDescopeMcpConfig(env: Env['Bindings']): DescopeMcpConfig | null {
  const issuer = env.DESCOPE_MCP_ISSUER;
  const jwksUrl = env.DESCOPE_JWKS_URL;
  if (!issuer || !jwksUrl) return null;
  return { issuer, jwksUrl };
}

/** Resolves the verification key set for a JWKS URL. */
export type JwksResolver = (jwksUrl: string) => JWTVerifyGetKey;

// One remote key set per JWKS URL, reused across requests. A JWKS is public
// data with no per-tenant state, so sharing it across requests in an isolate
// is safe, and it lets jose's own cache avoid refetching on every request.
const remoteJwksByUrl = new Map<string, JWTVerifyGetKey>();

// JWKS fetch guards, per URL. Workers cannot share an in-flight fetch (or any
// I/O object) across requests, so only numbers are shared here and each
// request builds its own Response:
// - after a failed fetch, no fetch until `retryAfter` (epoch ms);
// - while another request's fetch is in flight (started less than
//   JWKS_FETCH_IN_FLIGHT_MS ago), wait for its outcome instead of fetching.
// After a success, jose's own cooldown and cache max age limit refetches.
const JWKS_FETCH_FAILURE_BACKOFF_MS = 30_000;
// jose aborts a JWKS fetch after 5s, so a mark older than this is from a
// request that stopped midway. Marks expire on their own and are not cleared:
// after a failure the backoff is checked first, and after a success jose does
// not reload while cooling down (30s).
const JWKS_FETCH_IN_FLIGHT_MS = 6_000;
const JWKS_WAIT_POLL_MS = 25;
const jwksRetryAfterByUrl = new Map<string, number>();
const jwksFetchStartedAtByUrl = new Map<string, number>();

type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;

function jwksBackingOff(jwksUrl: string): boolean {
  const retryAfter = jwksRetryAfterByUrl.get(jwksUrl);
  return retryAfter !== undefined && Date.now() < retryAfter;
}

function jwksFetchInFlight(jwksUrl: string): boolean {
  const startedAt = jwksFetchStartedAtByUrl.get(jwksUrl);
  return startedAt !== undefined && Date.now() - startedAt < JWKS_FETCH_IN_FLIGHT_MS;
}

/** Same shape jose requires of a key set (dist/webapi/jwks/local.js isJWKSLike). */
function isJwksShaped(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const keys = (value as { keys?: unknown }).keys;
  return (
    Array.isArray(keys) &&
    keys.every((key) => typeof key === 'object' && key !== null && !Array.isArray(key))
  );
}

/**
 * jose's network call for one JWKS URL. Every fetch failure is recorded here
 * (network error, timeout, non-200, a body that is not a JSON key set), so a
 * failure while importing a key afterwards never starts the backoff.
 */
function guardedJwksFetch(jwksUrl: string, getRemote: () => RemoteJwks): FetchImplementation {
  return async (url, init) => {
    if (jwksBackingOff(jwksUrl)) throw new Error('JWKS fetch backing off after a failure');

    if (jwksFetchInFlight(jwksUrl)) {
      const deadline = Date.now() + JWKS_FETCH_IN_FLIGHT_MS;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, JWKS_WAIT_POLL_MS));
        if (jwksBackingOff(jwksUrl)) throw new Error('JWKS fetch backing off after a failure');
        // jose only reloads when not cooling down, so cooling down now means
        // the other fetch succeeded and these keys are the ones it got.
        const remote = getRemote();
        const data = remote.coolingDown ? remote.jwks() : undefined;
        if (data) {
          return new Response(JSON.stringify(data), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (Date.now() >= deadline) throw new Error('Timed out waiting for a JWKS fetch');
      }
    }

    jwksFetchStartedAtByUrl.set(jwksUrl, Date.now());
    const recordFailure = () =>
      jwksRetryAfterByUrl.set(jwksUrl, Date.now() + JWKS_FETCH_FAILURE_BACKOFF_MS);
    try {
      const response = await fetch(url, init);
      if (response.status !== 200) {
        recordFailure();
        return response;
      }
      const body = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = undefined;
      }
      if (!isJwksShaped(parsed)) recordFailure();
      return new Response(body, { status: 200, headers: response.headers });
    } catch (err) {
      recordFailure();
      throw err;
    }
  };
}

export const getRemoteJwks: JwksResolver = (jwksUrl) => {
  let jwks = remoteJwksByUrl.get(jwksUrl);
  if (!jwks) {
    const remote: RemoteJwks = createRemoteJWKSet(new URL(jwksUrl), {
      [customFetch]: guardedJwksFetch(jwksUrl, () => remote),
    });
    jwks = async (protectedHeader, token) => {
      if (jwksBackingOff(jwksUrl)) {
        // While backing off, keep verifying against keys jose fetched within
        // its cache max age (10 min), with no network. Older or absent keys
        // fail closed. Failures here never extend the backoff.
        const cached = remote.fresh ? remote.jwks() : undefined;
        if (!cached) throw new errors.JOSEError('JWKS fetch backing off after a failure');
        return createLocalJWKSet(cached)(protectedHeader, token);
      }
      return remote(protectedHeader, token);
    };
    remoteJwksByUrl.set(jwksUrl, jwks);
  }
  return jwks;
};

// Asymmetric signatures only. HMAC (HS*) would let anyone holding a public key
// forge tokens, and unsecured (`none`) tokens are never acceptable.
const ACCEPTED_ALGORITHMS = [
  'RS256', 'RS384', 'RS512',
  'PS256', 'PS384', 'PS512',
  'ES256', 'ES384', 'ES512',
  'EdDSA',
];

/**
 * Scopes an MCP client should request for `/mcp`. Claude takes these from the
 * 401 challenge (then from `scopes_supported` below). Without them, claude.ai
 * was bounced back before Descope's login screen, consistent with it asking
 * for the scopes in Descope's authorization server metadata: Descope rejects
 * `profile` / `email` / `phone` with `invalid_scope`, because an MCP Server
 * with no scopes of its own accepts only `openid` and `offline_access`.
 * `openid` is not requested: it makes Descope return an ID token as well, and
 * with it claude.ai failed right after login without ever calling `/mcp`
 * (consistent with its ID token issuer check). `offline_access` alone gets
 * the access token plus a refresh token.
 */
export const MCP_OAUTH_SCOPES = ['offline_access'] as const;

export function protectedResourceUrl(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/mcp`;
}

export function protectedResourceMetadataUrl(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/.well-known/oauth-protected-resource/mcp`;
}

/** RFC 9728 protected resource metadata for `/mcp`. */
export function protectedResourceMetadata(requestUrl: string, config: DescopeMcpConfig) {
  return {
    resource: protectedResourceUrl(requestUrl),
    authorization_servers: [config.issuer],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'LINE Harness',
  };
}

const DESCOPE_ID_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * The Descope project ID in a configured issuer: `/v1/apps/agentic/<projectId>/<serverId>`
 * (MCP server issuer) or `/v1/apps/<projectId>` (project issuer). `null` for
 * anything else, including an issuer with a query, fragment or trailing slash,
 * so an unexpected value never widens what is accepted.
 */
function descopeProjectId(issuer: string): string | null {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return null;
  }
  // Rejects anything URL parsing would normalise or drop (query, fragment,
  // userinfo, dot segments, ...): the value must already be in its plain form.
  if (`${url.origin}${url.pathname}` !== issuer) return null;
  const segments = url.pathname.split('/').slice(1);
  if (segments[0] !== 'v1' || segments[1] !== 'apps') return null;
  const ids =
    segments[2] === 'agentic'
      ? segments.length === 5 ? [segments[3], segments[4]] : null
      : segments.length === 3 ? [segments[2]] : null;
  if (!ids || !ids.every((id) => DESCOPE_ID_SEGMENT.test(id))) return null;
  return ids[0];
}

/**
 * Verify a Descope access token for this resource. Returns the claims, or
 * `null` for any failure (bad signature, wrong issuer/audience, expired,
 * disallowed algorithm, missing `sub`, unreachable JWKS, ...). The reason is
 * deliberately not surfaced so it cannot leak to the caller.
 *
 * Descope access tokens carry the project ID as `aud`, and a project mints
 * them under either the MCP server issuer or the project issuer (all signed
 * with the same project keys). So when the project ID can be read from the
 * configured issuer, `aud` may be the resource or the project ID, and `iss`
 * may be the configured issuer or that project's issuer, each matched
 * exactly. Otherwise only the configured issuer and the resource are accepted.
 */
export async function verifyDescopeAccessToken(
  token: string,
  options: {
    config: DescopeMcpConfig;
    audience: string;
    resolveJwks: JwksResolver;
    // TEMP(2026-09-30): Dev-only diagnosis of rejected claude.ai tokens. Remove after.
    diagnose?: boolean;
  },
): Promise<JWTPayload | null> {
  const { issuer } = options.config;
  const projectId = descopeProjectId(issuer);
  const issuers = projectId ? [issuer, `${new URL(issuer).origin}/v1/apps/${projectId}`] : [issuer];
  const audiences = projectId ? [options.audience, projectId] : [options.audience];
  try {
    const { payload } = await jwtVerify(token, options.resolveJwks(options.config.jwksUrl), {
      issuer: issuers,
      audience: audiences,
      algorithms: ACCEPTED_ALGORITHMS,
      clockTolerance: 5,
      // jwtVerify checks `exp` only when present; a token must carry one.
      requiredClaims: ['exp'],
    });
    // Covers both a missing and a non-string `sub`.
    if (typeof payload.sub !== 'string') {
      if (options.diagnose) logRejectedToken(token, 'sub is not a string', issuers, audiences);
      return null;
    }
    return payload;
  } catch (error) {
    if (options.diagnose) logRejectedToken(token, error, issuers, audiences);
    return null;
  }
}

// TEMP(2026-09-30): Dev-only diagnosis of rejected claude.ai tokens. Remove after.
// Prints only public facts (which check failed, header, iss/aud/azp/scope,
// claim names). Never the token, `sub` or `email` values.
function logRejectedToken(token: string, reason: unknown, issuers: string[], audiences: string[]) {
  let header: unknown = null;
  let claims: Record<string, unknown> | null = null;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    header = 'undecodable';
  }
  try {
    const p = decodeJwt(token);
    claims = {
      iss: p.iss,
      aud: p.aud,
      azp: p.azp,
      scope: p.scope,
      exp: p.exp,
      iat: p.iat,
      subIsString: typeof p.sub === 'string',
      claimNames: Object.keys(p),
    };
  } catch {
    claims = null;
  }
  const r =
    reason instanceof Error
      ? {
          name: reason.name,
          code: (reason as { code?: unknown }).code,
          claim: (reason as { claim?: unknown }).claim,
          message: reason.message,
        }
      : String(reason);
  console.log(
    '[mcp-auth-diag]',
    JSON.stringify({ reason: r, header, claims, expected: { issuers, audiences }, segments: token.split('.').length }),
  );
}
