import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createMcpRoute } from './mcp.js';
import { rateLimitMiddleware } from '../middleware/rate-limit.js';
import type { Env } from '../index.js';

const STAFF = { id: 's1', name: 'Owner', role: 'owner', api_key: 'good-key', is_active: 1 };

function makeEnv(): Env['Bindings'] {
  return {
    DB: {
      prepare: (_sql: string) => ({
        bind: (key: string) => ({
          first: async () => (key === 'good-key' ? STAFF : null),
        }),
      }),
    },
  } as unknown as Env['Bindings'];
}

/** staff_members exists but is empty — the current state of the dev D1. */
function makeEmptyStaffEnv(extra: Record<string, string> = {}): Env['Bindings'] {
  return {
    DB: { prepare: (_sql: string) => ({ bind: () => ({ first: async () => null }) }) },
    ...extra,
  } as unknown as Env['Bindings'];
}

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function post(body: unknown, token = 'good-key', headers: Record<string, string> = {}) {
  return new Request(`https://w.example.com/mcp/${token}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};

const LIST_TAGS = {
  jsonrpc: '2.0',
  id: 20,
  method: 'tools/call',
  params: { name: 'manage_tags', arguments: { action: 'list' } },
};

describe('remote MCP endpoint', () => {
  it('401s on an unknown token', async () => {
    const app = new Hono<Env>();
    app.route('/', createMcpRoute((r, e, x) => app.fetch(r, e, x)));
    const res = await app.fetch(post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }, 'bad-key'), makeEnv(), execCtx);
    expect(res.status).toBe(401);
  });

  it('serves initialize and tools/list statelessly', async () => {
    const app = new Hono<Env>();
    app.route('/', createMcpRoute((r, e, x) => app.fetch(r, e, x)));

    const initRes = await app.fetch(post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }), makeEnv(), execCtx);
    expect(initRes.status).toBe(200);
    const init = await initRes.json() as any;
    expect(init.result.serverInfo.name).toBe('line-harness');
    expect(initRes.headers.get('mcp-session-id')).toBeNull();

    const listRes = await app.fetch(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), makeEnv(), execCtx);
    const list = await listRes.json() as any;
    const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('send_message');
    expect(names).toContain('manage_tags');
    expect(names).toContain('account_summary');
    expect(names).toContain('get_inflow_analytics');
  });

  it('routes tool API calls through app.fetch, never global fetch', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const app = new Hono<Env>();
    let seenAuth: string | null = null;
    let seenUrl = '';
    app.get('/api/tags', (c) => {
      seenAuth = c.req.header('Authorization') ?? null;
      seenUrl = c.req.url;
      return c.json({ success: true, data: [{ id: 't1', name: 'vip', color: '#000', createdAt: '' }] });
    });
    app.route('/', createMcpRoute((r, e, x) => app.fetch(r, e, x)));

    const res = await app.fetch(
      post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'manage_tags', arguments: { action: 'list' } } }),
      makeEnv(),
      execCtx,
    );
    const body = await res.json() as any;
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content[0].text).toContain('vip');
    expect(seenAuth).toBe('Bearer good-key');
    expect(seenUrl).toBe('https://w.example.com/api/tags');
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it('keeps per-request tokens isolated across two requests in one isolate', async () => {
    const app = new Hono<Env>();
    const seen: string[] = [];
    app.get('/api/tags', (c) => {
      seen.push(c.req.header('Authorization') ?? 'none');
      return c.json({ success: true, data: [] });
    });
    app.route('/', createMcpRoute((r, e, x) => app.fetch(r, e, x)));

    const env = {
      DB: {
        prepare: () => ({ bind: (key: string) => ({ first: async () => ({ ...STAFF, api_key: key }) }) }),
      },
    } as unknown as Env['Bindings'];

    const call = { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'manage_tags', arguments: { action: 'list' } } };
    await app.fetch(post(call, 'tenant-a'), env, execCtx);
    await app.fetch(post(call, 'tenant-b'), env, execCtx);
    expect(seen).toEqual(['Bearer tenant-a', 'Bearer tenant-b']);
  });

  it('accepts the env API_KEY owner when staff_members is empty', async () => {
    const app = new Hono<Env>();
    app.route('/', createMcpRoute((r, e, x) => app.fetch(r, e, x)));
    const env = makeEmptyStaffEnv({ API_KEY: 'env-owner-key' });

    const res = await app.fetch(post(INITIALIZE, 'env-owner-key'), env, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.serverInfo.name).toBe('line-harness');

    const bad = await app.fetch(post(INITIALIZE, 'nope'), env, execCtx);
    expect(bad.status).toBe(401);
  });

  it('still accepts a staff api key', async () => {
    const app = new Hono<Env>();
    app.route('/', createMcpRoute((r, e, x) => app.fetch(r, e, x)));
    const res = await app.fetch(post(INITIALIZE, 'good-key'), makeEnv(), execCtx);
    expect(res.status).toBe(200);
  });

  it('forwards the outer client IP onto the internal loopback request', async () => {
    const app = new Hono<Env>();
    let seenIp: string | null = null;
    app.get('/api/tags', (c) => {
      seenIp = c.req.header('cf-connecting-ip') ?? null;
      return c.json({ success: true, data: [] });
    });
    app.route('/', createMcpRoute((r, e, x) => app.fetch(r, e, x)));

    await app.fetch(
      post(LIST_TAGS, 'good-key', { 'cf-connecting-ip': '203.0.113.7' }),
      makeEnv(),
      execCtx,
    );
    expect(seenIp).toBe('203.0.113.7');
  });

  it('does not let one tenant exhaust the ip-ceiling for unrelated callers', { timeout: 60_000 }, async () => {
    const app = new Hono<Env>();
    app.use('*', rateLimitMiddleware);
    app.get('/api/tags', (c) =>
      c.json({ success: true, data: [{ id: 't1', name: 'vip', color: '#000', createdAt: '' }] }),
    );
    app.route('/', createMcpRoute((r, e, x) => app.fetch(r, e, x)));
    const env = makeEnv();

    // Internal loopback traffic from three other tenants: Bearer-authenticated
    // but with no client IP, so all of it lands in `ip-ceiling:0.0.0.0`.
    // 3 x 1000 == IP_CEILING_MAX, exhausting that shared bucket.
    for (const key of ['tenant-a', 'tenant-b', 'tenant-c']) {
      for (let i = 0; i < 1000; i++) {
        await app.fetch(
          new Request('https://w.example.com/api/tags', {
            headers: { Authorization: `Bearer ${key}` },
          }),
          env,
          execCtx,
        );
      }
    }
    const exhausted = await app.fetch(
      new Request('https://w.example.com/api/tags', {
        headers: { Authorization: 'Bearer tenant-d' },
      }),
      env,
      execCtx,
    );
    expect(exhausted.status).toBe(429);

    // A fourth, unrelated caller with a real IP must still get a working tool
    // call: its internal request is accounted to its own IP, not 0.0.0.0.
    const res = await app.fetch(
      post(LIST_TAGS, 'good-key', { 'cf-connecting-ip': '198.51.100.4' }),
      env,
      execCtx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content[0].text).toContain('vip');
  });

  describe('get_inflow_analytics', () => {
    const ROUTES = [
      { id: 'er_lp', refCode: 'lp-a', name: 'LP A', isActive: true },
      { id: 'er_zero', refCode: 'new-campaign', name: 'New Campaign', isActive: false },
      { id: 'er_slash', refCode: 'a b/c', name: 'Slash Route', isActive: true },
    ];

    function callInflow(args: Record<string, unknown>) {
      return post({ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'get_inflow_analytics', arguments: args } });
    }

    function makeApp() {
      const app = new Hono<Env>();
      const calls = { summary: [] as string[], detail: [] as string[], refParams: [] as string[], funnel: [] as string[], list: 0 };
      app.get('/api/analytics/ref-summary', (c) => {
        calls.summary.push(c.req.url);
        return c.json({
          success: true,
          data: {
            routes: [
              { refCode: 'lp-a', name: 'LP A', friendCount: 3, clickCount: 5, latestAt: '2026-10-01 10:00:00' },
              { refCode: 'x-uuid', name: null, friendCount: 7, clickCount: 0, latestAt: '2026-10-02 10:00:00' },
            ],
            totalFriends: 15,
            friendsWithRef: 10,
            friendsWithoutRef: 5,
          },
        });
      });
      app.get('/api/analytics/ref/:refCode', (c) => {
        const refCode = c.req.param('refCode');
        calls.detail.push(c.req.url);
        calls.refParams.push(refCode);
        const registered = ROUTES.find((r) => r.refCode === refCode);
        const friends = refCode === 'dup'
          ? [
              { id: 'f0', displayName: 'F0', trackedAt: '2026-10-03 10:00:00' },
              { id: 'f0', displayName: 'F0', trackedAt: '2026-10-01 10:00:00' },
              { id: 'f1', displayName: 'F1', trackedAt: null },
            ]
          : Array.from({ length: 4 }, (_, i) => ({ id: `f${i}`, displayName: `F${i}`, trackedAt: null }));
        return c.json({ success: true, data: { refCode, name: registered?.name ?? null, friends } });
      });
      app.get('/api/entry-routes', (c) => {
        calls.list += 1;
        return c.json({ success: true, data: ROUTES });
      });
      app.get('/api/entry-routes/:id/funnel', (c) => {
        calls.funnel.push(c.req.param('id'));
        return c.json({ success: true, data: { click_count: 12, friend_add_count: 4, form_submission_count: 2, cv_count: 1 } });
      });
      app.route('/', createMcpRoute((r, e, x) => app.fetch(r, e, x)));
      return { app, calls };
    }

    async function run(app: Hono<Env>, args: Record<string, unknown>) {
      const res = await app.fetch(callInflow(args), makeEnv(), execCtx);
      const body = await res.json() as any;
      expect(body.result.isError).toBeFalsy();
      return JSON.parse(body.result.content[0].text);
    }

    it('summary merges registered zero-friend routes and unregistered refs', async () => {
      const { app, calls } = makeApp();
      const out = await run(app, { accountId: 'acc_1' });
      expect(out.success).toBe(true);
      expect(calls.summary).toEqual(['https://w.example.com/api/analytics/ref-summary?lineAccountId=acc_1']);
      expect(calls.list).toBe(1);
      expect(calls.funnel).toEqual([]);
      expect(out.totals).toEqual({ totalFriends: 15, friendsWithRef: 10, friendsWithoutRef: 5 });
      expect(typeof out.note).toBe('string');
      expect(out.routes.map((r: any) => r.refCode)).toEqual(['x-uuid', 'lp-a', 'new-campaign', 'a b/c']);

      const unregistered = out.routes.find((r: any) => r.refCode === 'x-uuid');
      expect(unregistered).toMatchObject({ registered: false, name: null, friendCount: 7 });
      expect(unregistered).not.toHaveProperty('isActive');

      const zero = out.routes.find((r: any) => r.refCode === 'new-campaign');
      expect(zero).toEqual({
        refCode: 'new-campaign',
        name: 'New Campaign',
        registered: true,
        isActive: false,
        friendCount: 0,
        clickCount: 0,
        latestAt: null,
        inflowUrl: 'https://w.example.com/r/new-campaign',
      });

      expect(out.routes.find((r: any) => r.refCode === 'lp-a')).toMatchObject({ registered: true, isActive: true, friendCount: 3 });
      expect(out.routes.find((r: any) => r.refCode === 'a b/c').inflowUrl).toBe('https://w.example.com/r/a%20b%2Fc');
    });

    it('detail for a registered ref returns camelCase funnel, truncates, and calls funnel once', async () => {
      const { app, calls } = makeApp();
      const out = await run(app, { refCode: 'lp-a', limit: 2 });
      expect(calls.funnel).toEqual(['er_lp']);
      expect(calls.list).toBe(1);
      expect(calls.detail).toEqual(['https://w.example.com/api/analytics/ref/lp-a']);
      expect(out).toMatchObject({
        success: true,
        refCode: 'lp-a',
        name: 'LP A',
        registered: true,
        isActive: true,
        inflowUrl: 'https://w.example.com/r/lp-a',
        funnel: { clicks: 12, friendAdds: 4, formSubmissions: 2, conversions: 1 },
        friendCount: 4,
        truncated: true,
      });
      expect(out.friends.map((f: any) => f.id)).toEqual(['f0', 'f1']);
    });

    it('detail for an unregistered ref returns null funnel without calling the funnel API', async () => {
      const { app, calls } = makeApp();
      const out = await run(app, { refCode: 'x-uuid' });
      expect(calls.funnel).toEqual([]);
      expect(out).toMatchObject({ registered: false, name: null, funnel: null, friendCount: 4, truncated: false });
      expect(out).not.toHaveProperty('isActive');
      expect(out.friends).toHaveLength(4);
    });

    it('detail counts each friend once even when the API repeats them per click', async () => {
      const { app } = makeApp();
      const out = await run(app, { refCode: 'dup' });
      expect(out.friendCount).toBe(2);
      expect(out.friends).toEqual([
        { id: 'f0', displayName: 'F0', trackedAt: '2026-10-03 10:00:00' },
        { id: 'f1', displayName: 'F1', trackedAt: null },
      ]);
      expect(out.truncated).toBe(false);
    });

    it('encodes refCode so slashes and spaces do not break the detail path', async () => {
      const { app, calls } = makeApp();
      const out = await run(app, { refCode: 'a b/c' });
      expect(calls.detail).toEqual(['https://w.example.com/api/analytics/ref/a%20b%2Fc']);
      expect(calls.refParams).toEqual(['a b/c']);
      expect(calls.funnel).toEqual(['er_slash']);
      expect(out).toMatchObject({ refCode: 'a b/c', registered: true, inflowUrl: 'https://w.example.com/r/a%20b%2Fc' });
    });
  });

  it('405s on GET and DELETE', async () => {
    const app = new Hono<Env>();
    app.route('/', createMcpRoute((r, e, x) => app.fetch(r, e, x)));
    for (const method of ['GET', 'DELETE']) {
      const res = await app.fetch(new Request('https://w.example.com/mcp/good-key', { method }), makeEnv(), execCtx);
      expect(res.status).toBe(405);
    }
  });
});
