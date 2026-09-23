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

  it('405s on GET and DELETE', async () => {
    const app = new Hono<Env>();
    app.route('/', createMcpRoute((r, e, x) => app.fetch(r, e, x)));
    for (const method of ['GET', 'DELETE']) {
      const res = await app.fetch(new Request('https://w.example.com/mcp/good-key', { method }), makeEnv(), execCtx);
      expect(res.status).toBe(405);
    }
  });
});
