import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from '../index.js';

// ── モック ─────────────────────────────────────────────────────────────────
// DB の中身(batch・条件付き書き込み・シナリオの始め直し)は packages/db/test/friend-sync.test.ts が
// 本物の SQLite で確かめる。ここはルートの振る舞い(検証・認証・友だちの作成・応答・イベント)を確かめる。
const dbMocks = {
  getStaffByApiKey: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getLineAccounts: vi.fn(),
  getTagsByNames: vi.fn(),
  createFriendForSync: vi.fn(),
  applyFriendSync: vi.fn(),
  // friend_add 系・シナリオ系が呼ばれていないことの確認用(呼ばれたらテストで検知する)
  getScenarios: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  upsertFriend: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const eventBusMocks = { fireEvent: vi.fn() };
vi.mock('../services/event-bus.js', () => eventBusMocks);

const lineMocks = { getProfile: vi.fn(), pushMessage: vi.fn(), tokens: [] as string[] };
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation((token: string) => {
    lineMocks.tokens.push(token);
    return { getProfile: lineMocks.getProfile, pushMessage: lineMocks.pushMessage };
  }),
}));

const { friendSync } = await import('./friend-sync.js');
const { authMiddleware } = await import('../middleware/auth.js');
const { rateLimitMiddleware } = await import('../middleware/rate-limit.js');
const { resolveCorsOrigin } = await import('../middleware/admin-auth-config.js');

// ── アプリ(index.ts と同じ順序: CORS → レート制限 → 認証 → ルート) ──────────

function buildApp() {
  const app = new Hono<Env>();
  app.use('*', cors({
    origin: (origin, c) => resolveCorsOrigin(c.env, origin, c.req.url),
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'x-admin-api-key'],
    maxAge: 600,
  }));
  app.use('*', rateLimitMiddleware);
  app.use('*', authMiddleware);
  app.route('/', friendSync);
  return app;
}

const USER_ID = 'U0123456789abcdef0123456789abcdef';
const ENV = {
  DB: {} as D1Database,
  LINE_CHANNEL_SECRET: 'env-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-token',
  API_KEY: 'env-owner-key',
} as unknown as Env['Bindings'];

function put(
  body: unknown,
  opts: {
    path?: string;
    auth?: string | null;
    host?: string;
    raw?: string;
    ctx?: ExecutionContext;
    contentLength?: number;
  } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = opts.auth === undefined ? 'staff-key' : opts.auth;
  if (auth) headers.Authorization = `Bearer ${auth}`;
  if (opts.contentLength !== undefined) headers['Content-Length'] = String(opts.contentLength);
  return buildApp().request(
    `https://${opts.host ?? 'store-binding.invalid'}${opts.path ?? `/api/friend-sync/${USER_ID}`}`,
    {
      method: 'PUT',
      headers,
      body: opts.raw ?? JSON.stringify(body),
    },
    ENV,
    opts.ctx,
  );
}

function tag(id: string, name: string) {
  return { id, name, color: '#000', created_at: '2026-10-16T00:00:00.000+09:00' };
}

function friendRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'friend-1',
    line_user_id: USER_ID,
    display_name: 'Alice',
    picture_url: null,
    status_message: null,
    is_following: 1,
    line_account_id: null,
    metadata: '{}',
    ...overrides,
  };
}

const applied = (overrides: Record<string, unknown> = {}) => ({
  tagsAdded: [],
  tagsRemoved: [],
  reattached: false,
  reattachRemoved: false,
  scenarioBusy: false,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  lineMocks.tokens.length = 0;
  dbMocks.getStaffByApiKey.mockImplementation(async (_db: unknown, token: string) =>
    token === 'staff-key' ? { id: 's1', name: 'Store', role: 'staff' } : null,
  );
  dbMocks.getFriendByLineUserId.mockResolvedValue(friendRow());
  dbMocks.getLineAccounts.mockResolvedValue([]);
  dbMocks.getTagsByNames.mockImplementation(async (_db: unknown, names: string[]) =>
    names.filter((n) => n !== '存在しない').map((n) => tag(`tag-${n}`, n)),
  );
  dbMocks.createFriendForSync.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => ({
    friend: friendRow({
      id: 'friend-new',
      display_name: input.displayName,
      is_following: input.isFollowing ? 1 : 0,
      line_account_id: input.lineAccountId,
    }),
    created: true,
  }));
  dbMocks.applyFriendSync.mockResolvedValue(applied());
  eventBusMocks.fireEvent.mockResolvedValue(undefined);
  lineMocks.getProfile.mockResolvedValue({ userId: USER_ID, displayName: 'Alice', pictureUrl: 'https://p/a.png' });
});

describe('認証・権限', () => {
  test('API キー無し → 401', async () => {
    const res = await put({}, { auth: null });
    expect(res.status).toBe(401);
    expect(dbMocks.applyFriendSync).not.toHaveBeenCalled();
  });

  test('知らない API キー → 401', async () => {
    const res = await put({}, { auth: 'wrong-key' });
    expect(res.status).toBe(401);
  });

  test('staff 役割のキーで通る', async () => {
    const res = await put({});
    expect(res.status).toBe(200);
  });

  test('役割が不明(staff が付かない)なら 403', async () => {
    const app = new Hono<Env>();
    app.route('/', friendSync);
    const res = await app.request(
      `https://x.invalid/api/friend-sync/${USER_ID}`,
      { method: 'PUT', body: '{}' },
      ENV,
    );
    expect(res.status).toBe(403);
  });
});

describe('サービスバインディング経由(Origin なし・任意のホスト)', () => {
  test('Origin ヘッダ無し・知らないホストでも CORS・レート制限・認証に弾かれず 200', async () => {
    const res = await put({}, { host: 'anything.internal.example' });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Remaining')).not.toBeNull();
  });

  test('ADMIN_ORIGIN を設定した環境でも、Origin 無しの呼び出しは通る', async () => {
    const res = await buildApp().request(
      `https://store.invalid/api/friend-sync/${USER_ID}`,
      { method: 'PUT', headers: { Authorization: 'Bearer staff-key' }, body: '{}' },
      { ...ENV, ADMIN_ORIGIN: 'https://admin.example.com', ADMIN_ALLOW_CROSS_SITE: 'true' } as Env['Bindings'],
    );
    expect(res.status).toBe(200);
  });
});

describe('入力の検証(400)', () => {
  test.each([
    ['短い', 'U123'],
    ['大文字の 16 進', 'U0123456789ABCDEF0123456789ABCDEF'],
    ['U で始まらない', 'X0123456789abcdef0123456789abcdef'],
    ['長すぎる', 'U0123456789abcdef0123456789abcdef0'],
  ])('lineUserId の形が違う(%s) → 400', async (_label, id) => {
    const res = await put({}, { path: `/api/friend-sync/${id}` });
    expect(res.status).toBe(400);
    expect(dbMocks.getFriendByLineUserId).not.toHaveBeenCalled();
  });

  test('JSON でない本文 → 400', async () => {
    expect((await put(null, { raw: '{not json' })).status).toBe(400);
  });

  test('本文が配列 → 400', async () => {
    expect((await put([])).status).toBe(400);
  });

  test('metadata がオブジェクトでない → 400', async () => {
    expect((await put({ metadata: [] })).status).toBe(400);
    expect((await put({ metadata: 'x' })).status).toBe(400);
  });

  test('metadata のキーに危険な文字 → 400', async () => {
    expect((await put({ metadata: { 'a"b': 1 } })).status).toBe(400);
    expect((await put({ metadata: { 'a.b': 1 } })).status).toBe(400);
    expect((await put({ metadata: { '': 1 } })).status).toBe(400);
  });

  test('metadata が大きすぎる → 400', async () => {
    const res = await put({ metadata: { redentStore: { memo: 'x'.repeat(17 * 1024) } } });
    expect(res.status).toBe(400);
  });

  test('metadata のキーは最大 20 個(21 個目で 400)', async () => {
    const make = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    expect((await put({ metadata: make(20) })).status).toBe(200);
    expect((await put({ metadata: make(21) })).status).toBe(400);
    expect((await put({ metadata: make(50) })).status).toBe(400);
  });

  test.each(['__proto__', 'constructor', 'prototype'])('metadata のキー %s は 400', async (key) => {
    // オブジェクトリテラルの __proto__ はプロトタイプ指定になるので、生の JSON で送る
    const res = await put(null, { raw: `{"metadata":{"${key}":{"x":1}}}` });
    expect(res.status).toBe(400);
    expect(dbMocks.applyFriendSync).not.toHaveBeenCalled();
  });

  test('metadata の値の入れ子は最大 10 段(11 段で 400)', async () => {
    const nest = (levels: number): unknown => {
      let v: unknown = 'leaf';
      for (let i = 0; i < levels; i++) v = { a: v };
      return v;
    };
    expect((await put({ metadata: { redentStore: nest(10) } })).status).toBe(200); // 値が 10 段
    expect((await put({ metadata: { redentStore: nest(11) } })).status).toBe(400);
    expect((await put(null, { raw: '{"metadata":{"k":' + '['.repeat(10) + ']'.repeat(10) + '}}' })).status).toBe(200);
    const arrays = '['.repeat(11) + ']'.repeat(11);
    expect((await put(null, { raw: `{"metadata":{"k":${arrays}}}` })).status).toBe(400);
    const veryDeep = '['.repeat(5000) + ']'.repeat(5000);
    expect((await put(null, { raw: `{"metadata":{"k":${veryDeep}}}` })).status).toBe(400);
  });

  test('本文は 64 KiB まで(ちょうどは通り、1 バイト超で 400)', async () => {
    const wrap = (n: number) => `{"pad":"${'a'.repeat(n)}"}`;
    const overhead = new TextEncoder().encode(wrap(0)).byteLength;
    const exact = wrap(64 * 1024 - overhead);
    expect(new TextEncoder().encode(exact).byteLength).toBe(64 * 1024);
    expect((await put(null, { raw: exact })).status).toBe(200);
    expect((await put(null, { raw: wrap(64 * 1024 - overhead + 1) })).status).toBe(400);
  });

  test('Content-Length が 64 KiB を超えるなら、本文を読む前に 400(本文が小さくても)', async () => {
    const res = await put({}, { contentLength: 64 * 1024 + 1 });
    expect(res.status).toBe(400);
    expect(dbMocks.applyFriendSync).not.toHaveBeenCalled();
    // 範囲内の Content-Length は通常どおり
    expect((await put({}, { contentLength: 2 })).status).toBe(200);
  });

  test('tags は 50 件まで(51 件目で 400)', async () => {
    const make = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`tag${i}`, true]));
    expect((await put({ tags: make(50) })).status).toBe(200);
    expect((await put({ tags: make(51) })).status).toBe(400);
  });

  test('reattach.key は 200 文字まで(201 文字で 400)', async () => {
    expect((await put({ reattach: { tag: '【来店】', key: 'k'.repeat(200) } })).status).toBe(200);
    expect((await put({ reattach: { tag: '【来店】', key: 'k'.repeat(201) } })).status).toBe(400);
  });

  test('tags の値が真偽値でない → 400', async () => {
    expect((await put({ tags: { 会員: 'yes' } })).status).toBe(400);
    expect((await put({ tags: ['会員'] })).status).toBe(400);
  });

  test('reattach の形が違う → 400', async () => {
    expect((await put({ reattach: { tag: '【来店】' } })).status).toBe(400);
    expect((await put({ reattach: { tag: '【来店】', key: '' } })).status).toBe(400);
    expect((await put({ reattach: '【来店】' })).status).toBe(400);
  });

  test('tags と reattach が同じタグを指す → 400', async () => {
    const res = await put({ tags: { '【来店】': true }, reattach: { tag: '【来店】', key: 'v1' } });
    expect(res.status).toBe(400);
    expect(dbMocks.applyFriendSync).not.toHaveBeenCalled();
  });
});

describe('設定の誤り(422): 存在しないタグ', () => {
  test('tags に無い名前 → 422・足りない名前を返す・何も書かない・友だちも作らない', async () => {
    dbMocks.getFriendByLineUserId.mockResolvedValue(null);
    const res = await put({ tags: { 会員: true, 存在しない: true } });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { missingTags: string[] };
    expect(json.missingTags).toEqual(['存在しない']);
    expect(dbMocks.applyFriendSync).not.toHaveBeenCalled();
    expect(dbMocks.createFriendForSync).not.toHaveBeenCalled();
    expect(lineMocks.getProfile).not.toHaveBeenCalled();
  });

  test('reattach.tag が無い → 422', async () => {
    const res = await put({ reattach: { tag: '存在しない', key: 'v1' } });
    expect(res.status).toBe(422);
    expect(dbMocks.applyFriendSync).not.toHaveBeenCalled();
  });
});

describe('友だちの記録が無いとき', () => {
  beforeEach(() => {
    dbMocks.getFriendByLineUserId.mockResolvedValue(null);
  });

  test('プロフィール 200 → 友だちとして作る(is_following=1・表示名つき)', async () => {
    const res = await put({});
    expect(res.status).toBe(200);
    expect(dbMocks.createFriendForSync).toHaveBeenCalledWith(expect.anything(), {
      lineUserId: USER_ID,
      displayName: 'Alice',
      pictureUrl: 'https://p/a.png',
      statusMessage: null,
      isFollowing: true,
      lineAccountId: null,
    });
    expect(await res.json()).toEqual({
      friendId: 'friend-new',
      created: true,
      isFollowing: true,
      tagsAdded: [],
      tagsRemoved: [],
      reattached: false,
    });
    // line_accounts が空(Dev)なら環境変数のトークンを使う
    expect(lineMocks.tokens).toEqual(['env-token']);
  });

  test('プロフィール 404 → 友だちでない記録として作る(is_following=0・表示名なし)', async () => {
    lineMocks.getProfile.mockRejectedValue(new Error('LINE API error: 404 Not Found — {"message":"Not found"}'));
    const res = await put({});
    expect(res.status).toBe(200);
    expect(dbMocks.createFriendForSync).toHaveBeenCalledWith(expect.anything(), {
      lineUserId: USER_ID,
      displayName: null,
      pictureUrl: null,
      statusMessage: null,
      isFollowing: false,
      lineAccountId: null,
    });
    const json = (await res.json()) as { created: boolean; isFollowing: boolean };
    expect(json.created).toBe(true);
    expect(json.isFollowing).toBe(false);
  });

  test.each([
    ['5xx', new Error('LINE API error: 500 Internal Server Error — ')],
    ['429', new Error('LINE API error: 429 Too Many Requests — ')],
    ['401(トークン不正)', new Error('LINE API error: 401 Unauthorized — ')],
    // 404 の判定は「ステータスが 404」だけ。本文や別の数字に 404 が混じっていても友だちでない扱いにしない
    ['5xx で本文に 404 を含む', new Error('LINE API error: 500 Internal Server Error — {"detail":"upstream 404"}')],
    ['403', new Error('LINE API error: 403 Forbidden — 404')],
    ['4040 のような別の数字', new Error('LINE API error: 4040 Weird — ')],
    ['エラー文に 404 だけ', new Error('upstream returned 404')],
    ['通信エラー', new TypeError('fetch failed')],
  ])('プロフィールの失敗(%s) → 503・友だちを作らない・何も書かない', async (_label, error) => {
    lineMocks.getProfile.mockRejectedValue(error);
    const res = await put({ metadata: { redentStore: { customerId: 'c1' } }, tags: { 会員: true } });
    expect(res.status).toBe(503);
    expect(dbMocks.createFriendForSync).not.toHaveBeenCalled();
    expect(dbMocks.applyFriendSync).not.toHaveBeenCalled();
    expect(eventBusMocks.fireEvent).not.toHaveBeenCalled();
  });

  test('LINE_CHANNEL_SECRET が一致する有効なアカウントがあれば、その id とトークンを使う(webhook と同じ決め方)', async () => {
    dbMocks.getLineAccounts.mockResolvedValue([
      { id: 'acc-other', is_active: 1, channel_secret: 'other', channel_access_token: 'other-token' },
      { id: 'acc-off', is_active: 0, channel_secret: 'env-secret', channel_access_token: 'off-token' },
      { id: 'acc-main', is_active: 1, channel_secret: 'env-secret', channel_access_token: 'main-token' },
    ]);
    const res = await put({});
    expect(res.status).toBe(200);
    expect(lineMocks.tokens).toEqual(['main-token']);
    expect(dbMocks.createFriendForSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lineAccountId: 'acc-main' }),
    );
  });

  test('作ったことで friend_add のシナリオ・あいさつ・友だち追加イベントは動かない', async () => {
    const res = await put({});
    expect(res.status).toBe(200);
    expect(dbMocks.getScenarios).not.toHaveBeenCalled();
    expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();
    expect(dbMocks.upsertFriend).not.toHaveBeenCalled();
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
    expect(eventBusMocks.fireEvent).not.toHaveBeenCalled();
  });

  test('同時に別の経路が先に作っていたら created=false', async () => {
    dbMocks.createFriendForSync.mockResolvedValue({ friend: friendRow({ id: 'friend-raced' }), created: false });
    const res = await put({});
    expect(((await res.json()) as { created: boolean; friendId: string })).toMatchObject({
      created: false,
      friendId: 'friend-raced',
    });
  });
});

describe('既存の友だち', () => {
  test('LINE のプロフィール API を呼ばず、作らない', async () => {
    const res = await put({ tags: { 会員: true } });
    expect(res.status).toBe(200);
    expect(lineMocks.getProfile).not.toHaveBeenCalled();
    expect(dbMocks.createFriendForSync).not.toHaveBeenCalled();
    expect(((await res.json()) as { created: boolean; friendId: string })).toMatchObject({
      created: false,
      friendId: 'friend-1',
    });
  });

  test('友だちでない記録(is_following=0)の人も、そのまま isFollowing=false で返す(変えない)', async () => {
    dbMocks.getFriendByLineUserId.mockResolvedValue(friendRow({ is_following: 0 }));
    const res = await put({});
    expect(((await res.json()) as { isFollowing: boolean }).isFollowing).toBe(false);
  });
});

describe('同期の内容と応答', () => {
  test('metadata・tags・reattach をそのまま applyFriendSync に渡す(タグは名前から id に解決)', async () => {
    dbMocks.applyFriendSync.mockResolvedValue(
      applied({
        tagsAdded: [tag('tag-会員', '会員')],
        tagsRemoved: [tag('tag-次回予約あり', '次回予約あり')],
        reattached: true,
        reattachRemoved: true,
      }),
    );
    const res = await put({
      metadata: { redentStore: { customerId: 'c1', memberNo: 'A1B2C3' } },
      tags: { 会員: true, 次回予約あり: false },
      reattach: { tag: '【来店】', key: 'visit-1' },
    });
    expect(res.status).toBe(200);
    expect(dbMocks.applyFriendSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'friend-1' }),
      {
        metadata: { redentStore: { customerId: 'c1', memberNo: 'A1B2C3' } },
        tags: [
          { tag: expect.objectContaining({ id: 'tag-会員', name: '会員' }), attached: true },
          { tag: expect.objectContaining({ id: 'tag-次回予約あり' }), attached: false },
        ],
        reattach: { tag: expect.objectContaining({ id: 'tag-【来店】' }), key: 'visit-1' },
      },
    );
    expect(await res.json()).toEqual({
      friendId: 'friend-1',
      created: false,
      isFollowing: true,
      tagsAdded: ['会員'],
      tagsRemoved: ['次回予約あり'],
      reattached: true,
    });
  });

  test('metadata の null(キー削除)をそのまま渡す', async () => {
    await put({ metadata: { redentStore: null } });
    expect(dbMocks.applyFriendSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ metadata: { redentStore: null } }),
    );
  });

  test('本文が空のオブジェクトでも 200(友だちの記録だけ確かめる)', async () => {
    const res = await put({});
    expect(res.status).toBe(200);
  });

  test('実際に変わったものだけ tag_change を撃つ(手動の付け外しと同じイベント)', async () => {
    dbMocks.applyFriendSync.mockResolvedValue(
      applied({
        tagsAdded: [tag('tag-会員', '会員')],
        tagsRemoved: [tag('tag-次回予約あり', '次回予約あり')],
        reattached: true,
        reattachRemoved: true,
      }),
    );
    await put({
      tags: { 会員: true, 次回予約あり: false },
      reattach: { tag: '【来店】', key: 'visit-1' },
    });
    expect(eventBusMocks.fireEvent.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['tag_change', { friendId: 'friend-1', eventData: { tagId: 'tag-次回予約あり', action: 'remove' } }],
      ['tag_change', { friendId: 'friend-1', eventData: { tagId: 'tag-会員', action: 'add' } }],
      ['tag_change', { friendId: 'friend-1', eventData: { tagId: 'tag-【来店】', action: 'remove' } }],
      ['tag_change', { friendId: 'friend-1', eventData: { tagId: 'tag-【来店】', action: 'add' } }],
    ]);
  });

  test('2 回目(何も変わらない)ではイベントを撃たない', async () => {
    const res = await put({ tags: { 会員: true }, reattach: { tag: '【来店】', key: 'visit-1' } });
    expect(res.status).toBe(200);
    expect(eventBusMocks.fireEvent).not.toHaveBeenCalled();
    expect(((await res.json()) as { reattached: boolean }).reattached).toBe(false);
  });

  test('イベントの処理が失敗しても、書き込み済みなので 200 を返す', async () => {
    dbMocks.applyFriendSync.mockResolvedValue(applied({ tagsAdded: [tag('tag-会員', '会員')] }));
    eventBusMocks.fireEvent.mockRejectedValue(new Error('boom'));
    const res = await put({ tags: { 会員: true } });
    expect(res.status).toBe(200);
  });

  test('DB の書き込みが失敗したら 500(店舗システムが送り直す)・イベントは撃たない', async () => {
    dbMocks.applyFriendSync.mockRejectedValue(new Error('D1_ERROR'));
    const res = await put({ tags: { 会員: true } });
    expect(res.status).toBe(500);
    expect(eventBusMocks.fireEvent).not.toHaveBeenCalled();
  });
});

describe('付け直し先のシナリオが送信中(scenario_busy)', () => {
  test('applyFriendSync が scenarioBusy を返したら 503・error=scenario_busy・イベントは撃たない', async () => {
    dbMocks.applyFriendSync.mockResolvedValue(applied({ scenarioBusy: true }));
    const res = await put({ reattach: { tag: '【来店】', key: 'visit-1' } });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('scenario_busy');
    expect(eventBusMocks.fireEvent).not.toHaveBeenCalled();
  });
});

describe('tag_change は応答を待たせない(waitUntil)', () => {
  function fakeCtx() {
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: vi.fn((p: Promise<unknown>) => {
        pending.push(p);
      }),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    return { ctx, pending };
  }

  test('ExecutionContext があるとき、fireEvent の完了を待たずに応答し、イベントは waitUntil に載る', async () => {
    dbMocks.applyFriendSync.mockResolvedValue(applied({ tagsAdded: [tag('tag-会員', '会員')] }));
    let release!: () => void;
    eventBusMocks.fireEvent.mockImplementation(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const { ctx, pending } = fakeCtx();

    const res = await put({ tags: { 会員: true } }, { ctx });

    expect(res.status).toBe(200); // fireEvent がまだ終わっていないのに応答できた
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(eventBusMocks.fireEvent).toHaveBeenCalledTimes(1);
    release();
    await Promise.all(pending);
  });

  test('waitUntil に載せたイベントが失敗しても、拒否されたままにならない(握りつぶす)', async () => {
    dbMocks.applyFriendSync.mockResolvedValue(applied({ tagsAdded: [tag('tag-会員', '会員')] }));
    eventBusMocks.fireEvent.mockRejectedValue(new Error('boom'));
    const { ctx, pending } = fakeCtx();
    const res = await put({ tags: { 会員: true } }, { ctx });
    expect(res.status).toBe(200);
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });

  test('ExecutionContext が無い環境では、その場で待つ(応答の前に fireEvent が終わっている)', async () => {
    dbMocks.applyFriendSync.mockResolvedValue(applied({ tagsAdded: [tag('tag-会員', '会員')] }));
    let finished = false;
    eventBusMocks.fireEvent.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      finished = true;
    });
    const res = await put({ tags: { 会員: true } });
    expect(res.status).toBe(200);
    expect(finished).toBe(true);
  });
});
