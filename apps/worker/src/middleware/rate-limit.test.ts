import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { rateLimitMiddleware } from './rate-limit.js';
import type { Env } from '../index.js';

function app() {
  const a = new Hono<Env>();
  a.use('*', rateLimitMiddleware);
  a.get('/api/protected', (c) => c.json({ success: true }));
  // Stand-in for the remote MCP endpoint: the limiter runs before auth, so all
  // that matters here is the shape of the path.
  a.post('/mcp/:token', (c) => c.json({ success: true }));
  return a;
}

const env = {} as Env['Bindings'];

// `path` is the raw request path, so percent escapes reach the limiter exactly
// as a client sent them.
function mcpRequest(token: string, ip: string, path = `/mcp/${token}`): Request {
  return new Request(`https://w.example.com${path}`, {
    method: 'POST',
    headers: { 'cf-connecting-ip': ip },
  });
}

// Freeze the clock so every request of a test lands in the same 1-minute
// window: the counts below are then exact, not "at some point it trips".
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('rate-limit IP ceiling (pre-auth token rotation)', () => {
  test('rotating unvalidated session cookies from one IP cannot bypass the limiter', async () => {
    // A unique IP isolates this test from the module-level store. Each request
    // uses a DIFFERENT bogus cookie, so the per-token bucket never trips — only
    // the per-IP ceiling (3000) should eventually return 429.
    const ip = '203.0.113.77';
    const a = app();
    let saw429 = false;

    for (let i = 0; i < 3001; i++) {
      const res = await a.request('/api/protected', {
        headers: {
          'cf-connecting-ip': ip,
          Cookie: `lh_admin_session=bogus-${i}`,
        },
      }, env);
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }

    expect(saw429).toBe(true);
  });

  test('rotating path tokens on /mcp/:token is stopped exactly at the ip-ceiling', { timeout: 30_000 }, async () => {
    // The path token is unvalidated at this point, exactly like the Bearer
    // token and the session cookie. Every request uses a DIFFERENT token so no
    // per-token bucket ever trips — only `ip-ceiling` (3000) can stop this.
    // Falling back to the `ip:` bucket would fail at request 101 instead.
    const ip = '203.0.113.90';
    const a = app();

    for (let i = 0; i < 3000; i++) {
      const res = await a.fetch(mcpRequest(`rotated-${i}`, ip), env);
      expect(res.status).toBe(200);
    }
    const res = await a.fetch(mcpRequest('rotated-3000', ip), env);
    expect(res.status).toBe(429);
  });

  test('a single legitimate token keeps its full allowance from one IP', async () => {
    const ip = '198.51.100.42';
    const a = app();
    // Well under both AUTHENTICATED_MAX and the IP ceiling.
    for (let i = 0; i < 50; i++) {
      const res = await a.request('/api/protected', {
        headers: { 'cf-connecting-ip': ip, Cookie: 'lh_admin_session=stable-token' },
      }, env);
      expect(res.status).toBe(200);
    }
  });
});

describe('rate-limit keying for /mcp/:token', () => {
  test('a single path token gets the authenticated allowance, not 100/min', async () => {
    const ip = '198.51.100.71';
    const a = app();
    // 100 was the unauthenticated cap: the 101st request used to be a 429.
    for (let i = 0; i < 150; i++) {
      const res = await a.fetch(mcpRequest('solo-tenant-key', ip), env);
      expect(res.status).toBe(200);
    }
  });

  test('two path tokens sharing one IP get separate 1000/min buckets', async () => {
    const ip = '198.51.100.72';
    const a = app();
    // Tenant A spends its whole allowance...
    for (let i = 0; i < 1000; i++) {
      const res = await a.fetch(mcpRequest('tenant-a-key', ip), env);
      expect(res.status).toBe(200);
    }
    expect((await a.fetch(mcpRequest('tenant-a-key', ip), env)).status).toBe(429);
    // ...while tenant B, behind the same NAT / egress IP, is unaffected.
    const res = await a.fetch(mcpRequest('tenant-b-key', ip), env);
    expect(res.status).toBe(200);
  });

  test('an unrelated Bearer header cannot move /mcp/<token> into a fresh bucket', async () => {
    const ip = '198.51.100.74';
    const a = app();
    // The route authenticates with the path token only, so the limiter must
    // count the path token even when some other Bearer value is attached.
    for (let i = 0; i < 1000; i++) {
      expect((await a.fetch(mcpRequest('path-wins-key', ip), env)).status).toBe(200);
    }
    const withBearer = new Request('https://w.example.com/mcp/path-wins-key', {
      method: 'POST',
      headers: { 'cf-connecting-ip': ip, Authorization: 'Bearer unrelated-key' },
    });
    expect((await a.fetch(withBearer, env)).status).toBe(429);
  });

  test('an empty path token still falls back to the IP-keyed bucket', async () => {
    const ip = '198.51.100.73';
    const a = app();

    // `/mcp/` and `/mcp//` carry no token, so they must not mint a `key:`
    // bucket — they stay on the shared `ip:` bucket (the route itself 404s).
    for (const path of ['/mcp/', '/mcp//']) {
      for (let i = 0; i < 50; i++) {
        await a.fetch(new Request(`https://w.example.com${path}`, {
          method: 'POST',
          headers: { 'cf-connecting-ip': ip },
        }), env);
      }
    }
    // The shared `ip:` bucket (100/min) is now spent for this IP.
    const res = await a.request('/api/protected', { headers: { 'cf-connecting-ip': ip } }, env);
    expect(res.status).toBe(429);
  });
});

describe('rate-limit keying for /mcp/:token follows Hono URL decoding', () => {
  test('percent-encoded and plain spellings of one token share a bucket', async () => {
    const ip = '198.51.100.81';
    const a = app();
    // `%65` is `e`: both paths authenticate as `encoding-owner-key`. Split
    // 500/500 so that separate buckets would never reach the 1000 cap.
    for (let i = 0; i < 500; i++) {
      expect((await a.fetch(mcpRequest('encoding-owner-key', ip), env)).status).toBe(200);
      expect((await a.fetch(mcpRequest('', ip, '/mcp/%65ncoding-owner-key'), env)).status).toBe(200);
    }
    expect((await a.fetch(mcpRequest('encoding-owner-key', ip), env)).status).toBe(429);
    expect((await a.fetch(mcpRequest('', ip, '/mcp/%65ncoding-owner-key'), env)).status).toBe(429);
  });

  test('the outer /mcp/<token> request and its inner Bearer calls share a bucket', async () => {
    const ip = '198.51.100.82';
    const a = app();
    // The MCP route hands the *decoded* token to its loopback calls as
    // `Authorization: Bearer <token>`, so both must count against one bucket.
    // `%73` (`s`) is undone by Hono's routing-path decodeURI, but `%2B` (`+`)
    // survives it and is only decoded by `c.req.param()` — both must be undone.
    const token = 'shared+with-bearer-key';
    const bearer = () =>
      a.request('/api/protected', {
        headers: { 'cf-connecting-ip': ip, Authorization: `Bearer ${token}` },
      }, env);
    const outer = () => a.fetch(mcpRequest('', ip, '/mcp/%73hared%2Bwith-bearer-key'), env);

    for (let i = 0; i < 500; i++) {
      expect((await outer()).status).toBe(200);
      expect((await bearer()).status).toBe(200);
    }
    expect((await outer()).status).toBe(429);
    expect((await bearer()).status).toBe(429);
  });

  test('an encoded /m%63p/<token> path is keyed by token, not the 100/min IP bucket', async () => {
    const ip = '198.51.100.83';
    const a = app();
    // Hono routes `/m%63p/...` to the MCP handler, so it must be limited like it.
    for (let i = 0; i < 150; i++) {
      const res = await a.fetch(mcpRequest('', ip, '/m%63p/alias-path-key'), env);
      expect(res.status).toBe(200);
    }
    // Nothing was charged to this IP's `ip:` bucket.
    const res = await a.request('/api/protected', { headers: { 'cf-connecting-ip': ip } }, env);
    expect(res.status).toBe(200);
  });

  test('a malformed percent escape does not throw and falls back to the IP bucket', async () => {
    const ip = '198.51.100.84';
    const a = app();
    // `%ZZ` is not an escape at all; `%E3%81` is a truncated UTF-8 sequence.
    for (const path of ['/mcp/bad%ZZtoken', '/mcp/bad%E3%81token']) {
      for (let i = 0; i < 50; i++) {
        const res = await a.fetch(mcpRequest('', ip, path), env);
        expect(res.status).toBe(200);
      }
    }
    // 100 requests spent the shared `ip:` bucket (100/min) for this IP.
    const res = await a.fetch(mcpRequest('', ip, '/mcp/bad%ZZtoken'), env);
    expect(res.status).toBe(429);
  });
});
