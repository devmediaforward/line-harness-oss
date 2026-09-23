import { beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { createMcpRoute } from './mcp.js';
import { authMiddleware } from '../middleware/auth.js';
import type { Env } from '../index.js';

const ORIGIN = 'https://w.example.com';
const RESOURCE = `${ORIGIN}/mcp`;
const METADATA_URL = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const ISSUER = 'https://api.descope.com/v1/apps/agentic/P1/M1';
const JWKS_URL = 'https://api.descope.com/P1/.well-known/jwks.json';
const ENV_OWNER_KEY = 'env-owner-key';

const CHALLENGE = `Bearer resource_metadata="${METADATA_URL}"`;
const INVALID_CHALLENGE = `${CHALLENGE}, error="invalid_token"`;

type StaffRow = {
  id: string;
  name: string;
  email: string | null;
  role: 'owner' | 'admin' | 'staff';
  api_key: string;
  is_active: number;
};

const ALICE: StaffRow = {
  id: 's-alice',
  name: 'Alice',
  email: 'alice@example.com',
  role: 'staff',
  api_key: 'staff-alice-key',
  is_active: 1,
};

/**
 * D1 stand-in that answers the two queries this path makes: the email lookup
 * (outer request) and getStaffByApiKey (authMiddleware on loopback calls).
 * Every prepared statement is recorded so tests can count D1 queries.
 */
function makeEnv(rows: StaffRow[], vars: Partial<Env['Bindings']> = {}) {
  const queries: string[] = [];
  const env = {
    API_KEY: ENV_OWNER_KEY,
    DESCOPE_MCP_ISSUER: ISSUER,
    DESCOPE_JWKS_URL: JWKS_URL,
    ...vars,
    DB: {
      prepare: (sql: string) => {
        queries.push(sql);
        return {
          bind: (...params: unknown[]) => ({
            first: async () =>
              sql.includes('api_key = ?')
                ? rows.find((r) => r.api_key === params[0] && r.is_active === 1) ?? null
                : null,
            all: async () => {
              if (!sql.includes('LOWER(email) = ?')) throw new Error(`unexpected query: ${sql}`);
              const hits = rows
                .filter((r) => r.is_active === 1 && r.email?.toLowerCase() === params[0])
                .slice(0, 2);
              return { results: hits, success: true, meta: {} };
            },
          }),
        };
      },
    },
  } as unknown as Env['Bindings'];
  return { env, queries };
}

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};
const TOOLS_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const LIST_TAGS = {
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'manage_tags', arguments: { action: 'list' } },
};

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES384');
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'k1', alg: 'ES384', use: 'sig' }] });
  otherPrivateKey = (await generateKeyPair('ES384')).privateKey;
});

type SignOptions = {
  iss?: string;
  aud?: string | string[];
  sub?: string | null;
  exp?: number | string;
  key?: CryptoKey;
};

/** A Descope-shaped access token; `claims` override/extend the payload. */
function sign(claims: JWTPayload = {}, o: SignOptions = {}): Promise<string> {
  const jwt = new SignJWT({ email: ALICE.email, ...claims })
    .setProtectedHeader({ alg: 'ES384', kid: 'k1' })
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? RESOURCE)
    .setIssuedAt()
    .setExpirationTime(o.exp ?? '5m');
  if (o.sub !== null) jwt.setSubject(o.sub ?? 'U-alice');
  return jwt.sign(o.key ?? privateKey);
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function validPayload(): JWTPayload {
  const now = Math.floor(Date.now() / 1000);
  return { iss: ISSUER, aud: RESOURCE, sub: 'U-alice', email: ALICE.email, iat: now, exp: now + 300 };
}

type Seen = { auth: string | null; staff: unknown };

function makeApp() {
  const app = new Hono<Env>();
  const seen: Seen[] = [];
  const jwksUrls: string[] = [];
  // Same order as index.ts: MCP routes first, then authMiddleware guarding
  // the API the tools call back into.
  app.route(
    '/',
    createMcpRoute((r, e, x) => app.fetch(r, e, x), {
      resolveJwks: (url) => {
        jwksUrls.push(url);
        return jwks;
      },
    }),
  );
  app.use('*', authMiddleware);
  app.get('/api/tags', (c) => {
    seen.push({ auth: c.req.header('Authorization') ?? null, staff: c.get('staff') });
    return c.json({ success: true, data: [{ id: 't1', name: 'vip', color: '#000', createdAt: '' }] });
  });
  // Stand-in for the SPA fallback: a disabled /mcp must never reach it.
  app.notFound((c) => c.html('<html>spa</html>'));
  return { app, seen, jwksUrls };
}

function postMcp(body: unknown, token?: string, url = RESOURCE): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /mcp with a Descope access token', () => {
  it('serves initialize and tools/list for exactly one matching active staff', async () => {
    const { app, jwksUrls } = makeApp();
    const { env, queries } = makeEnv([ALICE]);
    const token = await sign();

    const initRes = await app.fetch(postMcp(INITIALIZE, token), env, execCtx);
    expect(initRes.status).toBe(200);
    const init = (await initRes.json()) as any;
    expect(init.result.serverInfo.name).toBe('line-harness');

    const listRes = await app.fetch(postMcp(TOOLS_LIST, token), env, execCtx);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as any;
    const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('manage_tags');
    expect(names).toContain('send_message');

    // One D1 query per request (the email lookup), keys from the configured URL.
    expect(queries).toHaveLength(2);
    expect(queries.every((q) => q.includes('LOWER(email) = ?'))).toBe(true);
    expect(jwksUrls).toEqual([JWKS_URL, JWKS_URL]);
  });

  it("runs tool API calls with the matched staff member's own api_key and role", async () => {
    const { app, seen } = makeApp();
    const { env } = makeEnv([ALICE]);

    const res = await app.fetch(postMcp(LIST_TAGS, await sign()), env, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content[0].text).toContain('vip');

    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe(`Bearer ${ALICE.api_key}`);
    expect(seen[0].auth).not.toContain(ENV_OWNER_KEY);
    expect(seen[0].staff).toEqual({ id: ALICE.id, name: ALICE.name, role: 'staff' });
    // The staff key never appears in the MCP response itself.
    expect(JSON.stringify(body)).not.toContain(ALICE.api_key);
  });

  it('accepts an audience array that contains the resource', async () => {
    const { app } = makeApp();
    const { env } = makeEnv([ALICE]);
    const token = await sign({}, { aud: ['https://other.example.com', RESOURCE] });
    const res = await app.fetch(postMcp(TOOLS_LIST, token), env, execCtx);
    expect(res.status).toBe(200);
  });

  it('accepts email_verified: true', async () => {
    const { app } = makeApp();
    const { env } = makeEnv([ALICE]);
    const res = await app.fetch(postMcp(LIST_TAGS, await sign({ email_verified: true })), env, execCtx);
    expect(res.status).toBe(200);
  });

  it('matches the email claim case-insensitively after trimming', async () => {
    const { app } = makeApp();
    const { env } = makeEnv([{ ...ALICE, email: 'Alice@Example.COM' }]);
    const token = await sign({ email: '  ALICE@example.com ' });
    const res = await app.fetch(postMcp(TOOLS_LIST, token), env, execCtx);
    expect(res.status).toBe(200);
  });

  describe('401 with a challenge', () => {
    it('without an Authorization header', async () => {
      const { app } = makeApp();
      const { env, queries } = makeEnv([ALICE]);
      for (const req of [
        postMcp(TOOLS_LIST),
        new Request(RESOURCE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Basic dXNlcjpwYXNz' },
          body: JSON.stringify(TOOLS_LIST),
        }),
        postMcp(TOOLS_LIST, ''),
      ]) {
        const res = await app.fetch(req, env, execCtx);
        expect(res.status).toBe(401);
        expect(res.headers.get('WWW-Authenticate')).toBe(CHALLENGE);
        expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' });
      }
      expect(queries).toHaveLength(0);
    });

    const invalid: Array<[string, () => Promise<string>]> = [
      ['a wrong issuer', () => sign({}, { iss: 'https://api.descope.com/v1/apps/agentic/P1/OTHER' })],
      ['a wrong audience', () => sign({}, { aud: 'https://w.example.com/mcp/other' })],
      ['an audience for another origin', () => sign({}, { aud: 'https://evil.example.com/mcp' })],
      ['an expired token', () => sign({}, { exp: Math.floor(Date.now() / 1000) - 60 })],
      [
        'no exp claim',
        () => {
          const payload = validPayload();
          delete payload.exp;
          return new SignJWT(payload).setProtectedHeader({ alg: 'ES384', kid: 'k1' }).sign(privateKey);
        },
      ],
      ['a signature from another key', () => sign({}, { key: otherPrivateKey })],
      ['no sub claim', () => sign({}, { sub: null })],
      ['a non-string sub claim', () => sign({ sub: 123 as unknown as string }, { sub: null })],
      ['alg none', async () => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(validPayload())}.`],
      [
        'HS256',
        () =>
          new SignJWT(validPayload())
            .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
            .sign(new TextEncoder().encode('a-shared-secret-that-is-32-bytes!')),
      ],
      ['garbage', async () => 'not-a-jwt'],
    ];

    for (const [label, makeToken] of invalid) {
      it(`for ${label}`, async () => {
        const { app, seen } = makeApp();
        const { env, queries } = makeEnv([ALICE]);
        const res = await app.fetch(postMcp(LIST_TAGS, await makeToken()), env, execCtx);
        expect(res.status).toBe(401);
        expect(res.headers.get('WWW-Authenticate')).toBe(INVALID_CHALLENGE);
        expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' });
        expect(queries).toHaveLength(0);
        expect(seen).toHaveLength(0);
      });
    }
  });

  it('rejects HS256 even when the key resolver could supply an HMAC secret', async () => {
    // Pins the algorithm allowlist itself: without it, a resolver that hands
    // back a symmetric secret would make a forged HS256 token verify.
    const secret = new TextEncoder().encode('a-shared-secret-that-is-32-bytes!');
    const app = new Hono<Env>();
    app.route(
      '/',
      createMcpRoute((r, e, x) => app.fetch(r, e, x), {
        resolveJwks: () => async (header, token) => (header.alg === 'HS256' ? secret : jwks(header, token)),
      }),
    );
    const { env, queries } = makeEnv([ALICE]);
    const token = await new SignJWT(validPayload())
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .sign(secret);
    const res = await app.fetch(postMcp(TOOLS_LIST, token), env, execCtx);
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(INVALID_CHALLENGE);
    expect(queries).toHaveLength(0);
  });

  describe('403 unless exactly one active staff matches', () => {
    const cases: Array<[string, StaffRow[], JWTPayload]> = [
      ['no email claim', [ALICE], { email: undefined }],
      ['a non-string email claim', [ALICE], { email: ['alice@example.com'] }],
      ['a blank email claim', [ALICE], { email: '   ' }],
      ['an email explicitly marked unverified', [ALICE], { email_verified: false }],
      ['no matching staff', [{ ...ALICE, email: 'bob@example.com' }], {}],
      ['two matching staff', [ALICE, { ...ALICE, id: 's-alice-2', api_key: 'staff-alice-key-2' }], {}],
      ['only an inactive staff', [{ ...ALICE, is_active: 0 }], {}],
    ];

    for (const [label, rows, claims] of cases) {
      it(`for ${label}`, async () => {
        const { app, seen } = makeApp();
        const { env } = makeEnv(rows);
        const res = await app.fetch(postMcp(LIST_TAGS, await sign(claims)), env, execCtx);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ success: false, error: 'Forbidden' });
        expect(seen).toHaveLength(0);
      });
    }
  });

  it('405s on GET and DELETE', async () => {
    const { app } = makeApp();
    const { env } = makeEnv([ALICE]);
    for (const method of ['GET', 'DELETE']) {
      const res = await app.fetch(new Request(RESOURCE, { method }), env, execCtx);
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ success: false, error: 'Method Not Allowed' });
    }
  });

  it('leaves /mcp/<apiKey> working alongside it', async () => {
    const { app } = makeApp();
    const { env } = makeEnv([ALICE]);
    const res = await app.fetch(postMcp(TOOLS_LIST, undefined, `${ORIGIN}/mcp/${ALICE.api_key}`), env, execCtx);
    expect(res.status).toBe(200);
  });
});

const PRM_PATHS = [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/mcp/.well-known/oauth-protected-resource',
];

describe('protected resource metadata', () => {
  it('serves the same document on all three paths, derived from the request origin', async () => {
    const { app } = makeApp();
    const { env } = makeEnv([ALICE]);
    for (const path of PRM_PATHS) {
      const res = await app.fetch(new Request(`https://other.example.org${path}`), env, execCtx);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
      expect(await res.json()).toEqual({
        resource: 'https://other.example.org/mcp',
        authorization_servers: [ISSUER],
        bearer_methods_supported: ['header'],
        resource_name: 'LINE Harness',
      });
    }
  });
});

describe('Descope vars not configured', () => {
  const unset: Array<[string, Partial<Env['Bindings']>]> = [
    ['neither var', { DESCOPE_MCP_ISSUER: undefined, DESCOPE_JWKS_URL: undefined }],
    ['only the issuer', { DESCOPE_JWKS_URL: undefined }],
    ['only the JWKS URL', { DESCOPE_MCP_ISSUER: undefined }],
    ['empty strings', { DESCOPE_MCP_ISSUER: '', DESCOPE_JWKS_URL: '' }],
  ];

  for (const [label, vars] of unset) {
    it(`404s JSON on /mcp and the metadata paths with ${label}`, async () => {
      const { app } = makeApp();
      const { env, queries } = makeEnv([ALICE], vars);
      const requests = [
        postMcp(TOOLS_LIST, await sign()),
        new Request(RESOURCE, { method: 'GET' }),
        new Request(RESOURCE, { method: 'DELETE' }),
        ...PRM_PATHS.map((p) => new Request(`${ORIGIN}${p}`)),
      ];
      for (const req of requests) {
        const res = await app.fetch(req, env, execCtx);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ success: false, error: 'Not Found' });
      }
      expect(queries).toHaveLength(0);
    });
  }
});
