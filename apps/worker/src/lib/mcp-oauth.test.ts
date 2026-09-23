import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SignJWT,
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  errors,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from 'jose';
import { getRemoteJwks, verifyDescopeAccessToken } from './mcp-oauth.js';

const ISSUER = 'https://api.descope.com/v1/apps/agentic/P1/M1';
const AUDIENCE = 'https://w.example.com/mcp';

let privateKey: CryptoKey;
let publicJwks: { keys: JWK[] };

beforeAll(async () => {
  const pair = await generateKeyPair('ES384');
  privateKey = pair.privateKey;
  publicJwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES384', use: 'sig' }] };
});

function sign(kid = 'k1', key: CryptoKey = privateKey): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES384', kid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject('U-alice')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

// getRemoteJwks keeps per-URL state for the life of the module, so every test
// uses its own JWKS URL.
let urlSeq = 0;
function nextJwksUrl(): string {
  urlSeq += 1;
  return `https://jwks${urlSeq}.example.com/.well-known/jwks.json`;
}

function verify(token: string, jwksUrl: string) {
  return verifyDescopeAccessToken(token, {
    config: { issuer: ISSUER, jwksUrl },
    audience: AUDIENCE,
    resolveJwks: getRemoteJwks,
  });
}

type Reply = () => Response | Promise<Response>;

/** Stubs global fetch with one reply per JWKS URL and counts calls per URL. */
function stubFetch(replies: Record<string, Reply>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      const reply = replies[url];
      if (!reply) throw new Error(`unexpected fetch: ${url}`);
      return reply();
    }),
  );
  return { count: (url: string) => calls.filter((u) => u === url).length };
}

const ok: Reply = () => new Response(JSON.stringify(publicJwks), { status: 200 });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Delays a reply so concurrent requests overlap with the fetch in flight. */
const delayed = (reply: Reply, ms = 50): Reply => async () => {
  await sleep(ms);
  return reply();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // jose (dist/webapi/jwks/remote.js isCloudflareWorkers) keys its Workers
  // behaviour, which does not share an in-flight fetch, off this user agent.
  vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("runs jose on its Workers path, where concurrent reloads don't share a fetch", async () => {
  const calls: string[] = [];
  const remote = createRemoteJWKSet(new URL('https://jose-check.example.com/jwks.json'), {
    [customFetch]: async (url) => {
      calls.push(url);
      return delayed(ok)();
    },
  });
  await Promise.all([remote.reload(), remote.reload()]);
  expect(calls).toHaveLength(2);
});

describe('getRemoteJwks failure backoff', () => {
  it('stops fetching for 30 seconds after a 503, then fetches again', async () => {
    const url = nextJwksUrl();
    let status = 503;
    const fetches = stubFetch({
      [url]: () =>
        status === 200 ? ok() : new Response('unavailable', { status }),
    });
    const token = await sign();

    expect(await verify(token, url)).toBeNull();
    expect(fetches.count(url)).toBe(1);

    vi.setSystemTime(Date.now() + 10_000);
    expect(await verify(token, url)).toBeNull();
    vi.setSystemTime(Date.now() + 19_000);
    expect(await verify(token, url)).toBeNull();
    expect(fetches.count(url)).toBe(1);

    status = 200;
    vi.setSystemTime(Date.now() + 1_001);
    expect(await verify(token, url)).toMatchObject({ sub: 'U-alice' });
    expect(fetches.count(url)).toBe(2);
  });

  const failures: Array<[string, Reply]> = [
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['JSON that is not a key set', () => new Response(JSON.stringify({ keys: 'nope' }), { status: 200 })],
  ];

  for (const [label, reply] of failures) {
    it(`also backs off after ${label}`, async () => {
      const url = nextJwksUrl();
      const fetches = stubFetch({ [url]: reply });
      const token = await sign();

      expect(await verify(token, url)).toBeNull();
      expect(await verify(token, url)).toBeNull();
      expect(fetches.count(url)).toBe(1);
    });
  }

  it('does not back off when the fetch succeeded but the kid is unknown', async () => {
    const url = nextJwksUrl();
    const fetches = stubFetch({ [url]: ok });
    const valid = await sign();
    const unknownKid = await sign('forged');

    expect(await verify(valid, url)).toMatchObject({ sub: 'U-alice' });
    expect(fetches.count(url)).toBe(1);

    // Within jose's cooldown: no refetch for the unknown kid.
    vi.setSystemTime(Date.now() + 25_000);
    expect(await verify(unknownKid, url)).toBeNull();
    expect(fetches.count(url)).toBe(1);
    expect(await verify(valid, url)).toMatchObject({ sub: 'U-alice' });

    // After jose's cooldown (and within 30s of the unknown kid above, so a
    // backoff wrongly started by it would show) the unknown kid triggers one
    // successful refetch.
    vi.setSystemTime(Date.now() + 6_000);
    expect(await verify(unknownKid, url)).toBeNull();
    expect(fetches.count(url)).toBe(2);
    expect(await verify(valid, url)).toMatchObject({ sub: 'U-alice' });
    expect(fetches.count(url)).toBe(2);
  });

  describe('while backing off after a refetch failed', () => {
    /**
     * Fetches the key set once, then makes a refetch (triggered by an unknown
     * kid once jose's cooldown has passed) fail with 503 so the URL backs off.
     */
    async function backingOffWithCachedKeys() {
      const url = nextJwksUrl();
      let status = 200;
      const fetches = stubFetch({
        [url]: () => (status === 200 ? ok() : new Response('unavailable', { status })),
      });
      const valid = await sign();
      const unknownKid = await sign('forged');

      expect(await verify(valid, url)).toMatchObject({ sub: 'U-alice' });
      status = 503;
      vi.setSystemTime(Date.now() + 31_000);
      expect(await verify(unknownKid, url)).toBeNull();
      expect(fetches.count(url)).toBe(2);
      return { url, fetches, valid, unknownKid };
    }

    it('still accepts a known kid from the cached keys with no fetch', async () => {
      const { url, fetches, valid } = await backingOffWithCachedKeys();

      vi.setSystemTime(Date.now() + 10_000);
      expect(await verify(valid, url)).toMatchObject({ sub: 'U-alice' });
      vi.setSystemTime(Date.now() + 19_000);
      expect(await verify(valid, url)).toMatchObject({ sub: 'U-alice' });
      expect(fetches.count(url)).toBe(2);
    });

    it('rejects an unknown kid with no fetch and without extending the backoff', async () => {
      const { url, fetches, valid, unknownKid } = await backingOffWithCachedKeys();

      vi.setSystemTime(Date.now() + 20_000);
      expect(await verify(unknownKid, url)).toBeNull();
      expect(await verify(unknownKid, url)).toBeNull();
      expect(fetches.count(url)).toBe(2);

      // The backoff still ends 30s after the failed fetch: the next unknown
      // kid is allowed one refetch (503 again).
      vi.setSystemTime(Date.now() + 10_001);
      expect(await verify(unknownKid, url)).toBeNull();
      expect(fetches.count(url)).toBe(3);
      expect(await verify(valid, url)).toMatchObject({ sub: 'U-alice' });
      expect(fetches.count(url)).toBe(3);
    });

    it('fails closed once the cached keys are older than the 10-minute cache max age', async () => {
      const { url, fetches, valid } = await backingOffWithCachedKeys();

      // 10 minutes after the successful fetch; the source is still down.
      vi.setSystemTime(Date.now() + 570_000);
      expect(await verify(valid, url)).toBeNull();
      expect(fetches.count(url)).toBe(3);

      vi.setSystemTime(Date.now() + 10_000);
      expect(await verify(valid, url)).toBeNull();
      expect(fetches.count(url)).toBe(3);
    });
  });

  it('keeps the backoff separate per JWKS URL', async () => {
    const failing = nextJwksUrl();
    const healthy = nextJwksUrl();
    const fetches = stubFetch({
      [failing]: () => new Response('unavailable', { status: 503 }),
      [healthy]: ok,
    });
    const token = await sign();

    expect(await verify(token, failing)).toBeNull();
    expect(await verify(token, healthy)).toMatchObject({ sub: 'U-alice' });
    expect(fetches.count(failing)).toBe(1);
    expect(fetches.count(healthy)).toBe(1);
  });
});

describe('getRemoteJwks concurrent fetches', () => {
  it('fetches once for 20 concurrent requests on an empty cache', async () => {
    const url = nextJwksUrl();
    const fetches = stubFetch({ [url]: delayed(ok) });
    const valid = await sign();
    const unknownKid = await sign('forged');

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => verify(i % 2 === 0 ? valid : unknownKid, url)),
    );

    expect(fetches.count(url)).toBe(1);
    results.forEach((result, i) => {
      if (i % 2 === 0) expect(result).toMatchObject({ sub: 'U-alice' });
      else expect(result).toBeNull();
    });
  });

  it('fails the waiting requests with no fetch when the fetch in flight gets a 503', async () => {
    const url = nextJwksUrl();
    const fetches = stubFetch({ [url]: delayed(() => new Response('unavailable', { status: 503 })) });
    const valid = await sign();

    const results = await Promise.all(Array.from({ length: 5 }, () => verify(valid, url)));
    expect(results).toEqual([null, null, null, null, null]);
    expect(fetches.count(url)).toBe(1);

    vi.setSystemTime(Date.now() + 10_000);
    expect(await verify(valid, url)).toBeNull();
    vi.setSystemTime(Date.now() + 19_000);
    expect(await verify(valid, url)).toBeNull();
    expect(fetches.count(url)).toBe(1);
  });

  it('makes waiting requests use the keys the fetch in flight got, not older cached ones', async () => {
    const rotated = await generateKeyPair('ES384');
    const rotatedJwks = {
      keys: [{ ...(await exportJWK(rotated.publicKey)), kid: 'k2', alg: 'ES384', use: 'sig' }],
    };
    const url = nextJwksUrl();
    let current = publicJwks;
    const fetches = stubFetch({
      [url]: delayed(() => new Response(JSON.stringify(current), { status: 200 })),
    });
    const retired = await sign('k1');
    const start = Date.now();
    expect(await verify(retired, url)).toMatchObject({ sub: 'U-alice' });

    // Past the cache max age, k1 has been rotated out for k2. A k2 token
    // starts the refetch; a k1 token arriving meanwhile waits for it.
    current = rotatedJwks;
    vi.setSystemTime(start + 601_000);
    const [fresh, stale] = await Promise.all([
      verify(await sign('k2', rotated.privateKey), url),
      verify(retired, url),
    ]);
    expect(fresh).toMatchObject({ sub: 'U-alice' });
    expect(stale).toBeNull();
    expect(fetches.count(url)).toBe(2);
  });

  it('lets a new request fetch once the in-flight mark is older than 6 seconds', async () => {
    const url = nextJwksUrl();
    let hang = true;
    // The first fetch never settles, as when the request that started it
    // stopped midway.
    const fetches = stubFetch({ [url]: () => (hang ? new Promise<Response>(() => {}) : ok()) });
    const valid = await sign();

    void verify(valid, url);
    await vi.waitFor(() => expect(fetches.count(url)).toBe(1));

    // A request arriving meanwhile waits, and gives up 6 seconds later.
    const waiting = verify(valid, url);
    await sleep(30);
    hang = false;
    vi.setSystemTime(Date.now() + 6_001);
    expect(await waiting).toBeNull();
    expect(fetches.count(url)).toBe(1);

    // The mark has expired, so the next request fetches for itself.
    expect(await verify(valid, url)).toMatchObject({ sub: 'U-alice' });
    expect(fetches.count(url)).toBe(2);
  });
});

describe('getRemoteJwks with a key that fails to import', () => {
  // A P-384 key whose coordinates are not a point: importing it throws a
  // WebCrypto error, not a jose one.
  const brokenJwk: JWK = { kty: 'EC', crv: 'P-384', x: 'AAAA', y: 'AAAA', kid: 'bad', alg: 'ES384', use: 'sig' };

  it('does not back off, before or after the cache max age', async () => {
    const jwksWithBroken = { keys: [brokenJwk, ...publicJwks.keys] };
    const importError = await createLocalJWKSet(jwksWithBroken)({ alg: 'ES384', kid: 'bad' }).catch((e) => e);
    expect(importError).toBeInstanceOf(Error);
    expect(importError).not.toBeInstanceOf(errors.JOSEError);

    const url = nextJwksUrl();
    const fetches = stubFetch({
      [url]: () => new Response(JSON.stringify(jwksWithBroken), { status: 200 }),
    });
    const valid = await sign();
    const bad = await sign('bad');
    const start = Date.now();

    expect(await verify(valid, url)).toMatchObject({ sub: 'U-alice' });
    expect(await verify(bad, url)).toBeNull();
    expect(await verify(valid, url)).toMatchObject({ sub: 'U-alice' });
    expect(fetches.count(url)).toBe(1);

    // Near the end of the cache max age a bad-kid token must not start a
    // backoff that would outlive the cache and lock out valid tokens.
    vi.setSystemTime(start + 590_000);
    expect(await verify(bad, url)).toBeNull();
    expect(fetches.count(url)).toBe(1);
    vi.setSystemTime(start + 601_000);
    expect(await verify(valid, url)).toMatchObject({ sub: 'U-alice' });
    expect(fetches.count(url)).toBe(2);
  });
});
