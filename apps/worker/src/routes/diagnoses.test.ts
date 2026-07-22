import { describe, expect, test, beforeEach, vi } from 'vitest';
import redentJson from '@line-crm/db/seeds/redent-diagnosis.json';
import type { DiagnosisAnswers, DiagnosisDefinition } from '@line-crm/shared';

// ── モック ─────────────────────────────────────────────────────────────────
// ルートが使う @line-crm/db ヘルパーを全てモック(実 DB は raw クエリのみ叩く)。
const dbMocks = {
  getDiagnoses: vi.fn(),
  getDiagnosisById: vi.fn(),
  getDiagnosisBySlug: vi.fn(),
  createDiagnosis: vi.fn(),
  updateDiagnosis: vi.fn(),
  deleteDiagnosis: vi.fn(),
  getDiagnosisSubmissions: vi.fn(),
  countDiagnosisSubmissions: vi.fn(),
  getDiagnosisSubmissionById: vi.fn(),
  getDiagnosisSubmissionByShareToken: vi.fn(),
  getDiagnosisSubmissionByRequestId: vi.fn(),
  createDiagnosisSubmission: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getLineAccountById: vi.fn(),
  addTagToFriend: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  createTag: vi.fn(),
  jstNow: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const liffAuthMocks = { verifyCallerLineUserId: vi.fn() };
vi.mock('../services/liff-auth.js', () => liffAuthMocks);

const lineMocks = { pushMessage: vi.fn() };
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(() => ({ pushMessage: lineMocks.pushMessage })),
}));

const { diagnoses } = await import('./diagnoses.js');
const { runDiagnosis } = await import('../services/diagnosis/engine.js');

const redentDef = redentJson as unknown as DiagnosisDefinition;

// ── フィクスチャ ───────────────────────────────────────────────────────────

function makeDiagRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'diag-1',
    name: "Re'Dent 清潔感診断",
    slug: 'redent-cleanliness',
    definition: JSON.stringify(redentDef),
    definition_version: 3,
    is_active: 1,
    submit_count: 5,
    created_at: '2026-01-01T00:00:00+09:00',
    updated_at: '2026-02-01T00:00:00+09:00',
    ...overrides,
  };
}

function makeFriend(overrides: Record<string, unknown> = {}) {
  return {
    id: 'friend-1',
    line_user_id: 'U_alice',
    display_name: 'Alice',
    picture_url: null,
    status_message: null,
    is_following: 1,
    user_id: null,
    line_account_id: null,
    metadata: '{}',
    first_tracked_link_id: null,
    created_at: '2026-01-01T00:00:00+09:00',
    updated_at: '2026-01-01T00:00:00+09:00',
    ...overrides,
  };
}

/** 全問デフォルト値(=1: 悩みなし)+ 一部上書き */
function answersWith(overrides: Record<string, number> = {}): DiagnosisAnswers {
  const answers: DiagnosisAnswers = {};
  for (const q of redentDef.questions) answers[q.id] = 1;
  return { ...answers, ...overrides };
}

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

interface DbState {
  lastSubmitted?: Array<{ diagnosis_id: string; last_submitted_at: string | null }>;
  statsResults?: Array<{ result: string }>;
  /** 設定時、一括タグ SELECT が問い合わせた全タグ名をこの id にマップして返す(既存タグ扱い)。 */
  tagExistsId?: string;
  /** 設定時、名前単体 SELECT(createTag 失敗後の引き直し)がこの id を返す。 */
  tagReselectId?: string;
}

/** ルートが直接叩く raw クエリだけを担う最小 D1 モック。 */
function makeDb(state: DbState = {}): D1Database {
  return {
    prepare(sql: string) {
      let boundParams: unknown[] = [];
      const stmt = {
        bind(...params: unknown[]) {
          boundParams = params;
          return stmt;
        },
        async first<T>() {
          if (sql.includes('SELECT id FROM tags WHERE name')) {
            return (state.tagReselectId ? { id: state.tagReselectId } : null) as T | null;
          }
          return null as T | null;
        },
        async all<T>() {
          if (sql.includes('GROUP BY diagnosis_id')) {
            return { results: (state.lastSubmitted ?? []) as T[] };
          }
          if (sql.includes('SELECT result FROM diagnosis_submissions')) {
            return { results: (state.statsResults ?? []) as T[] };
          }
          if (sql.includes('SELECT id, name FROM tags WHERE name IN')) {
            const rows = state.tagExistsId
              ? boundParams.map((name) => ({ id: state.tagExistsId, name }))
              : [];
            return { results: rows as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function makeEnv(dbState: DbState = {}) {
  return {
    DB: makeDb(dbState),
    LINE_CHANNEL_ACCESS_TOKEN: 'env-token',
    WORKER_URL: 'https://worker.example.com',
    LINE_LOGIN_CHANNEL_ID: 'login-ch',
  };
}

function req(
  method: string,
  path: string,
  opts: { dbState?: DbState; body?: unknown; auth?: string } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.auth) headers['Authorization'] = `Bearer ${opts.auth}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  return diagnoses.request(
    `https://worker.example.com${path}`,
    init,
    makeEnv(opts.dbState),
    executionCtx,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getDiagnoses.mockResolvedValue([]);
  dbMocks.getDiagnosisById.mockResolvedValue(null);
  dbMocks.getDiagnosisBySlug.mockResolvedValue(null);
  dbMocks.createDiagnosis.mockResolvedValue(makeDiagRow());
  dbMocks.updateDiagnosis.mockResolvedValue(makeDiagRow());
  dbMocks.deleteDiagnosis.mockResolvedValue(undefined);
  dbMocks.getDiagnosisSubmissions.mockResolvedValue([]);
  dbMocks.countDiagnosisSubmissions.mockResolvedValue(0);
  dbMocks.getDiagnosisSubmissionById.mockResolvedValue(null);
  dbMocks.getDiagnosisSubmissionByShareToken.mockResolvedValue(null);
  dbMocks.getDiagnosisSubmissionByRequestId.mockResolvedValue(null);
  dbMocks.createDiagnosisSubmission.mockResolvedValue({
    id: 'sub-1',
    diagnosis_id: 'diag-1',
    friend_id: 'friend-1',
    line_user_id: 'U_alice',
    definition_version: 3,
    answers: '{}',
    result: '{}',
    share_token: 'share-tok',
    request_id: null,
    created_at: '2026-07-16T00:00:00+09:00',
  });
  dbMocks.getFriendByLineUserId.mockResolvedValue(null);
  dbMocks.getLineAccountById.mockResolvedValue(undefined);
  dbMocks.addTagToFriend.mockResolvedValue(undefined);
  dbMocks.enrollFriendInScenario.mockResolvedValue(null);
  dbMocks.createTag.mockResolvedValue({ id: 'tag-1', name: 'x', color: '#000', created_at: '' });
  dbMocks.jstNow.mockReturnValue('2026-07-16T00:00:00+09:00');
  liffAuthMocks.verifyCallerLineUserId.mockResolvedValue(null);
  lineMocks.pushMessage.mockResolvedValue(undefined);
});

// ── 管理系: 一覧 / CRUD ─────────────────────────────────────────────────────

describe('GET /api/diagnoses', () => {
  test('一覧に直近回答日時をマージ(definition は含めない)', async () => {
    dbMocks.getDiagnoses.mockResolvedValue([makeDiagRow(), makeDiagRow({ id: 'diag-2' })]);
    const res = await req('GET', '/api/diagnoses', {
      dbState: { lastSubmitted: [{ diagnosis_id: 'diag-1', last_submitted_at: '2026-07-10T00:00:00+09:00' }] },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(json.data).toHaveLength(2);
    expect(json.data[0].lastSubmittedAt).toBe('2026-07-10T00:00:00+09:00');
    expect(json.data[1].lastSubmittedAt).toBeNull();
    expect(json.data[0].definition).toBeUndefined();
    expect(json.data[0].submitCount).toBe(5);
  });
});

describe('POST /api/diagnoses (作成)', () => {
  test('妥当な定義で 201', async () => {
    const res = await req('POST', '/api/diagnoses', {
      body: { name: "Re'Dent 清潔感診断", slug: 'redent-cleanliness', definition: redentDef },
    });
    expect(res.status).toBe(201);
    expect(dbMocks.createDiagnosis).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "Re'Dent 清潔感診断", slug: 'redent-cleanliness' }),
    );
    const json = (await res.json()) as { data: { definition: unknown } };
    expect(json.data.definition).toBeTruthy();
  });

  test('壊れた定義は日本語エラーで 400(保存しない)', async () => {
    const res = await req('POST', '/api/diagnoses', {
      body: { name: 'x', definition: { meta: {} } },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { errors: string[] };
    expect(Array.isArray(json.errors)).toBe(true);
    expect(json.errors.length).toBeGreaterThan(0);
    expect(dbMocks.createDiagnosis).not.toHaveBeenCalled();
  });

  test('name 無しは 400', async () => {
    const res = await req('POST', '/api/diagnoses', { body: { definition: redentDef } });
    expect(res.status).toBe(400);
    expect(dbMocks.createDiagnosis).not.toHaveBeenCalled();
  });

  test('512KB 超の definition は 413', async () => {
    const bloated = { ...redentDef, _pad: 'x'.repeat(520 * 1024) };
    const res = await req('POST', '/api/diagnoses', { body: { name: 'x', definition: bloated } });
    expect(res.status).toBe(413);
    expect(dbMocks.createDiagnosis).not.toHaveBeenCalled();
  });
});

describe('GET/PUT/DELETE /api/diagnoses/:id', () => {
  test('GET 詳細は definition を含む', async () => {
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow());
    const res = await req('GET', '/api/diagnoses/diag-1');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { definition: { meta: { name: string } } } };
    expect(json.data.definition.meta.name).toBe("Re'Dent 清潔感診断");
  });

  test('GET 存在しない → 404', async () => {
    const res = await req('GET', '/api/diagnoses/missing');
    expect(res.status).toBe(404);
  });

  test('PUT: name のみ更新は definition を渡さない', async () => {
    dbMocks.updateDiagnosis.mockResolvedValue(makeDiagRow({ name: '新名称' }));
    const res = await req('PUT', '/api/diagnoses/diag-1', { body: { name: '新名称' } });
    expect(res.status).toBe(200);
    expect(dbMocks.updateDiagnosis).toHaveBeenCalledWith(
      expect.anything(),
      'diag-1',
      expect.not.objectContaining({ definition: expect.anything() }),
    );
  });

  test('PUT: 壊れた definition は 400', async () => {
    const res = await req('PUT', '/api/diagnoses/diag-1', { body: { definition: { meta: {} } } });
    expect(res.status).toBe(400);
    expect(dbMocks.updateDiagnosis).not.toHaveBeenCalled();
  });

  test('DELETE 存在すれば削除', async () => {
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow());
    const res = await req('DELETE', '/api/diagnoses/diag-1');
    expect(res.status).toBe(200);
    expect(dbMocks.deleteDiagnosis).toHaveBeenCalledWith(expect.anything(), 'diag-1');
  });

  test('DELETE 存在しない → 404', async () => {
    const res = await req('DELETE', '/api/diagnoses/missing');
    expect(res.status).toBe(404);
    expect(dbMocks.deleteDiagnosis).not.toHaveBeenCalled();
  });
});

describe('POST /api/diagnoses/validate', () => {
  test('壊れた定義 → valid:false + 日本語エラー', async () => {
    const res = await req('POST', '/api/diagnoses/validate', { body: { definition: { meta: {} } } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { valid: boolean; errors: string[] } };
    expect(json.data.valid).toBe(false);
    expect(json.data.errors.length).toBeGreaterThan(0);
  });

  test('妥当な定義 → valid:true', async () => {
    const res = await req('POST', '/api/diagnoses/validate', { body: { definition: redentDef } });
    const json = (await res.json()) as { data: { valid: boolean; errors: string[] } };
    expect(json.data.valid).toBe(true);
    expect(json.data.errors).toHaveLength(0);
  });
});

describe('POST /api/diagnoses/:id/preview', () => {
  test('妥当な回答 → result を返す(保存しない)', async () => {
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow());
    const res = await req('POST', '/api/diagnoses/diag-1/preview', { body: { answers: answersWith() } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { result: { rank: string; emptyState: boolean } } };
    expect(json.data.result.rank).toBe('S'); // 全問1(悩みなし)→ S
    expect(json.data.result.emptyState).toBe(true);
    expect(dbMocks.createDiagnosisSubmission).not.toHaveBeenCalled();
  });

  test('回答不足 → 400', async () => {
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow());
    const res = await req('POST', '/api/diagnoses/diag-1/preview', { body: { answers: {} } });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/diagnoses/:id/submissions', () => {
  test('ページング + summary(rank/score/friend 名)', async () => {
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow());
    dbMocks.getDiagnosisSubmissions.mockResolvedValue([
      {
        id: 's1',
        diagnosis_id: 'diag-1',
        friend_id: 'f1',
        friend_name: 'Alice',
        line_user_id: 'U1',
        definition_version: 3,
        answers: '{}',
        result: JSON.stringify({ rank: 'B', totalScore: 46 }),
        share_token: 'tok1',
        created_at: '2026-07-01',
      },
    ]);
    dbMocks.countDiagnosisSubmissions.mockResolvedValue(1);
    const res = await req('GET', '/api/diagnoses/diag-1/submissions?limit=10&offset=0');
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: Array<{ rank: string; totalScore: number; friendName: string }>;
      pagination: { total: number; limit: number; offset: number };
    };
    expect(json.data[0]).toMatchObject({ rank: 'B', totalScore: 46, friendName: 'Alice' });
    expect(json.pagination).toEqual({ total: 1, limit: 10, offset: 0 });
  });
});

describe('GET /api/diagnoses/:id/submissions/:sid', () => {
  test('answers + result を返す', async () => {
    dbMocks.getDiagnosisSubmissionById.mockResolvedValue({
      id: 's1',
      diagnosis_id: 'diag-1',
      friend_id: 'f1',
      line_user_id: 'U1',
      definition_version: 3,
      answers: JSON.stringify({ T1: 4 }),
      result: JSON.stringify({ rank: 'B' }),
      share_token: 'tok1',
      created_at: '2026-07-01',
    });
    const res = await req('GET', '/api/diagnoses/diag-1/submissions/s1');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { answers: Record<string, number>; result: { rank: string } } };
    expect(json.data.answers.T1).toBe(4);
    expect(json.data.result.rank).toBe('B');
  });

  test('別診断の submission は 404', async () => {
    dbMocks.getDiagnosisSubmissionById.mockResolvedValue({
      id: 's1',
      diagnosis_id: 'other',
      answers: '{}',
      result: '{}',
      share_token: null,
      line_user_id: null,
      friend_id: null,
      definition_version: 1,
      created_at: '',
    });
    const res = await req('GET', '/api/diagnoses/diag-1/submissions/s1');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/diagnoses/:id/stats', () => {
  test('result スナップショットを走査して集計', async () => {
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow());
    const results = [
      { rank: 'S', totalScore: 100, axisScores: [{ axisId: 'body', score: 5 }, { axisId: 'skin', score: 5 }], tags: [], cards: [] },
      { rank: 'B', totalScore: 46, axisScores: [{ axisId: 'body', score: 2 }, { axisId: 'skin', score: 4 }], tags: [{ tag: '顔(ヒゲ)' }], cards: [{ title: '上半身セット' }] },
      { rank: 'B', totalScore: 55, axisScores: [{ axisId: 'body', score: 3 }, { axisId: 'skin', score: 3 }], tags: [{ tag: '顔(ヒゲ)' }, { tag: '脇' }], cards: [{ title: '上半身セット' }] },
    ];
    const res = await req('GET', '/api/diagnoses/diag-1/stats', {
      dbState: { statsResults: results.map((r) => ({ result: JSON.stringify(r) })) },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        total: number;
        rankDistribution: Record<string, number>;
        scoreHistogram: Array<{ bucket: string; count: number }>;
        axisAverages: Array<{ axisId: string; avg: number }>;
        tagCounts: Array<{ tag: string; count: number }>;
        cardCounts: Array<{ title: string; count: number }>;
      };
    };
    expect(data.total).toBe(3);
    expect(data.rankDistribution.B).toBe(2);
    expect(data.rankDistribution.S).toBe(1);
    expect(data.rankDistribution.D).toBe(0); // 未出現ランクも 0 で含む
    expect(data.scoreHistogram.find((b) => b.bucket === '100')?.count).toBe(1);
    expect(data.scoreHistogram.find((b) => b.bucket === '40-49')?.count).toBe(1);
    expect(data.axisAverages.find((a) => a.axisId === 'body')?.avg).toBeCloseTo(3.33, 2);
    expect(data.tagCounts[0]).toEqual({ tag: '顔(ヒゲ)', count: 2 });
    expect(data.cardCounts[0]).toEqual({ title: '上半身セット', count: 2 });
  });
});

// ── LIFF 系 ─────────────────────────────────────────────────────────────────

describe('GET /api/liff/diagnoses/:slug', () => {
  test('questions/axes/answerScale/meta のみ返し、recommendation/scoring を秘匿', async () => {
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow());
    const res = await req('GET', '/api/liff/diagnoses/redent-cleanliness');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.meta).toBeTruthy();
    expect(json.axes).toBeTruthy();
    expect(json.answerScale).toBeTruthy();
    expect(json.questions).toBeTruthy();
    expect(json.recommendation).toBeUndefined();
    expect(json.scoring).toBeUndefined();
    expect(json.resultPage).toBeUndefined();
    expect(json.share).toBeUndefined();
    expect(json.sideEffects).toBeUndefined();
  });

  test('inactive は 404', async () => {
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow({ is_active: 0 }));
    const res = await req('GET', '/api/liff/diagnoses/redent-cleanliness');
    expect(res.status).toBe(404);
  });

  test('存在しない slug は 404', async () => {
    const res = await req('GET', '/api/liff/diagnoses/missing');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/liff/diagnoses/:slug/submissions', () => {
  test('正常: share_token 付与・result 返却・shareUrl・count++ はヘルパー内', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_alice');
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow());
    dbMocks.getFriendByLineUserId.mockResolvedValue(makeFriend());
    const res = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: answersWith() },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { submissionId: string; result: { rank: string }; shareUrl: string };
    expect(json.submissionId).toBe('sub-1');
    expect(json.result.rank).toBe('S');
    // shareUrl は生成した share_token(createDiagnosisSubmission に渡した値)から組む。
    expect(dbMocks.createDiagnosisSubmission).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        diagnosisId: 'diag-1',
        lineUserId: 'U_alice',
        definitionVersion: 3,
        shareToken: expect.any(String),
      }),
    );
    const submitArg = dbMocks.createDiagnosisSubmission.mock.calls[0][1] as { shareToken: string };
    expect(json.shareUrl).toBe(`https://worker.example.com/d/${submitArg.shareToken}`);
  });

  test('未認証(idToken 無効)は 401', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue(null);
    const res = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      body: { answers: answersWith() },
    });
    expect(res.status).toBe(401);
    expect(dbMocks.createDiagnosisSubmission).not.toHaveBeenCalled();
  });

  test('inactive は 404', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_alice');
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow({ is_active: 0 }));
    const res = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: answersWith() },
    });
    expect(res.status).toBe(404);
  });

  test('回答不足は 400(人間可読メッセージ)', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_alice');
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow());
    const res = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: {} },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('回答が不足しています');
    expect(dbMocks.createDiagnosisSubmission).not.toHaveBeenCalled();
  });

  test('sendResultMessage=true で Flex を push', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_alice');
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow());
    dbMocks.getFriendByLineUserId.mockResolvedValue(makeFriend());
    const res = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: answersWith() },
    });
    expect(res.status).toBe(200);
    expect(lineMocks.pushMessage).toHaveBeenCalledTimes(1);
    const [to, messages] = lineMocks.pushMessage.mock.calls[0] as [string, Array<{ type: string }>];
    expect(to).toBe('U_alice');
    expect(messages[0].type).toBe('flex');
  });

  test('副作用が throw しても submission は成功(200)', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_alice');
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow());
    dbMocks.getFriendByLineUserId.mockResolvedValue(makeFriend());
    lineMocks.pushMessage.mockRejectedValueOnce(new Error('push boom'));
    const res = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: answersWith() },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { rank: string } };
    expect(json.result.rank).toBe('S');
  });

  test('friend 未解決でも保存し 200(push はスキップ)', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_ghost');
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow());
    dbMocks.getFriendByLineUserId.mockResolvedValue(null);
    const res = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: answersWith() },
    });
    expect(res.status).toBe(200);
    expect(dbMocks.createDiagnosisSubmission).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ friendId: null, lineUserId: 'U_ghost' }),
    );
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
  });
});

describe('POST submissions 副作用フレーム (addTags / enrollScenarioId)', () => {
  function defWith(sideEffects: Record<string, unknown>): string {
    return JSON.stringify({
      ...redentDef,
      sideEffects: {
        sendResultMessage: false,
        addTags: false,
        enrollScenarioId: null,
        saveToMetadata: false,
        ...sideEffects,
      },
    });
  }

  test('addTags=true: 既存タグ名にマッチして付与(createTag は呼ばない)', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_alice');
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow({ definition: defWith({ addTags: true }) }));
    dbMocks.getFriendByLineUserId.mockResolvedValue(makeFriend());
    const res = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: answersWith({ T1: 5 }) }, // 顔(ヒゲ) タグを立てる
      dbState: { tagExistsId: 'tag-existing' },
    });
    expect(res.status).toBe(200);
    expect(dbMocks.addTagToFriend).toHaveBeenCalledWith(expect.anything(), 'friend-1', 'tag-existing');
    expect(dbMocks.createTag).not.toHaveBeenCalled();
    expect(lineMocks.pushMessage).not.toHaveBeenCalled(); // sendResultMessage=false
  });

  test('addTags=true: 未知タグ名は createTag で自動作成して付与', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_alice');
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow({ definition: defWith({ addTags: true }) }));
    dbMocks.getFriendByLineUserId.mockResolvedValue(makeFriend());
    const res = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: answersWith({ T1: 5 }) },
      dbState: {}, // 既存タグなし → createTag で自動作成
    });
    expect(res.status).toBe(200);
    expect(dbMocks.createTag).toHaveBeenCalled();
    expect(dbMocks.addTagToFriend).toHaveBeenCalledWith(expect.anything(), 'friend-1', 'tag-1');
  });

  test('enrollScenarioId 指定でシナリオ起動', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_alice');
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow({ definition: defWith({ enrollScenarioId: 'scenario-9' }) }));
    dbMocks.getFriendByLineUserId.mockResolvedValue(makeFriend());
    const res = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: answersWith() },
    });
    expect(res.status).toBe(200);
    expect(dbMocks.enrollFriendInScenario).toHaveBeenCalledWith(expect.anything(), 'friend-1', 'scenario-9');
  });

  test('addTags: createTag が UNIQUE 違反 → 名前で引き直して付与(並行作成の吸収)', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_alice');
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow({ definition: defWith({ addTags: true }) }));
    dbMocks.getFriendByLineUserId.mockResolvedValue(makeFriend());
    dbMocks.createTag.mockRejectedValue(new Error('D1_ERROR: UNIQUE constraint failed: tags.name'));
    const res = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: answersWith({ T1: 5 }) }, // 悩みタグを立てる
      dbState: { tagReselectId: 'tag-reselected' }, // 一括 SELECT は空、引き直しで見つかる
    });
    expect(res.status).toBe(200);
    expect(dbMocks.addTagToFriend).toHaveBeenCalledWith(expect.anything(), 'friend-1', 'tag-reselected');
  });

  test('addTags: createTag も引き直しも失敗ならそのタグをスキップし submission は 200', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_alice');
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow({ definition: defWith({ addTags: true }) }));
    dbMocks.getFriendByLineUserId.mockResolvedValue(makeFriend());
    dbMocks.createTag.mockRejectedValue(new Error('D1_ERROR: UNIQUE constraint failed: tags.name'));
    const res = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: answersWith({ T1: 5 }) },
      dbState: {}, // 一括 SELECT も引き直しも空 → 付与できないがクラッシュしない
    });
    expect(res.status).toBe(200);
    expect(dbMocks.addTagToFriend).not.toHaveBeenCalled();
  });
});

describe('POST submissions 冪等化 (requestId)', () => {
  function makeExistingSub(overrides: Record<string, unknown> = {}) {
    return {
      id: 'sub-existing',
      diagnosis_id: 'diag-1',
      friend_id: 'friend-1',
      line_user_id: 'U_alice',
      definition_version: 3,
      answers: '{}',
      result: JSON.stringify({ rank: 'S', totalScore: 100 }),
      share_token: 'tok-existing',
      request_id: 'req-1',
      created_at: '2026-07-16T00:00:00+09:00',
      ...overrides,
    };
  }

  test('同一 requestId の2回目は採点・保存・push をせず同じ submissionId を返す', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_alice');
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow());
    dbMocks.getFriendByLineUserId.mockResolvedValue(makeFriend());

    // 1回目: requestId 既存なし → 通常保存 + push
    dbMocks.getDiagnosisSubmissionByRequestId.mockResolvedValueOnce(null);
    const res1 = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: answersWith(), requestId: 'req-1' },
    });
    expect(res1.status).toBe(200);
    const j1 = (await res1.json()) as { submissionId: string };
    expect(dbMocks.createDiagnosisSubmission).toHaveBeenCalledTimes(1);
    expect(dbMocks.createDiagnosisSubmission).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requestId: 'req-1' }),
    );
    expect(lineMocks.pushMessage).toHaveBeenCalledTimes(1);

    // 2回目: 同じ requestId → 既存を返す(採点・保存・push なし)
    dbMocks.getDiagnosisSubmissionByRequestId.mockResolvedValueOnce(makeExistingSub({ id: j1.submissionId }));
    const res2 = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: answersWith(), requestId: 'req-1' },
    });
    expect(res2.status).toBe(200);
    const j2 = (await res2.json()) as { submissionId: string; shareUrl: string };
    expect(j2.submissionId).toBe(j1.submissionId);
    expect(j2.shareUrl).toBe('https://worker.example.com/d/tok-existing');
    expect(dbMocks.createDiagnosisSubmission).toHaveBeenCalledTimes(1); // 増えない
    expect(lineMocks.pushMessage).toHaveBeenCalledTimes(1); // 増えない
  });

  test('別人の requestId 再利用は 409(保存・push なし)', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_bob');
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow());
    dbMocks.getFriendByLineUserId.mockResolvedValue(makeFriend());
    dbMocks.getDiagnosisSubmissionByRequestId.mockResolvedValue(makeExistingSub({ line_user_id: 'U_alice' }));
    const res = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: answersWith(), requestId: 'req-1' },
    });
    expect(res.status).toBe(409);
    expect(dbMocks.createDiagnosisSubmission).not.toHaveBeenCalled();
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
  });

  test('requestId 無しの旧クライアントは冪等チェックせず従来動作', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_alice');
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow());
    dbMocks.getFriendByLineUserId.mockResolvedValue(makeFriend());
    const res = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: answersWith() },
    });
    expect(res.status).toBe(200);
    expect(dbMocks.getDiagnosisSubmissionByRequestId).not.toHaveBeenCalled();
    expect(dbMocks.createDiagnosisSubmission).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requestId: null }),
    );
  });

  test.each([
    ['空文字', ''],
    ['65文字超', 'x'.repeat(65)],
    ['非文字列(数値)', 12345],
    ['非文字列(オブジェクト)', { a: 1 }],
  ])('requestId が存在するが不正(%s)は 400(保存・冪等チェックなし)', async (_label, bad) => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_alice');
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow());
    dbMocks.getFriendByLineUserId.mockResolvedValue(makeFriend());
    const res = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: answersWith(), requestId: bad },
    });
    expect(res.status).toBe(400);
    expect(dbMocks.getDiagnosisSubmissionByRequestId).not.toHaveBeenCalled();
    expect(dbMocks.createDiagnosisSubmission).not.toHaveBeenCalled();
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
  });

  test('64文字ちょうどの requestId は受理される(境界)', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_alice');
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow());
    dbMocks.getFriendByLineUserId.mockResolvedValue(makeFriend());
    const id64 = 'a'.repeat(64);
    const res = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: answersWith(), requestId: id64 },
    });
    expect(res.status).toBe(200);
    expect(dbMocks.createDiagnosisSubmission).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requestId: id64 }),
    );
  });

  test('並行 INSERT が UNIQUE 違反 → 既存を引き直して副作用なしで返す', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_alice');
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow());
    dbMocks.getFriendByLineUserId.mockResolvedValue(makeFriend());
    // pre-check では未存在 → INSERT で並行の UNIQUE 違反 → 再取得で既存が見つかる
    dbMocks.getDiagnosisSubmissionByRequestId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeExistingSub({ id: 'sub-race' }));
    dbMocks.createDiagnosisSubmission.mockRejectedValueOnce(
      new Error('D1_ERROR: UNIQUE constraint failed: diagnosis_submissions.request_id'),
    );
    const res = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: answersWith(), requestId: 'req-1' },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { submissionId: string };
    expect(j.submissionId).toBe('sub-race');
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
  });
});

describe('POST submissions: 壊れた liffUrl での結果 push スキップ (fix4)', () => {
  test('sendResultMessage=true でも liffUrl から liffId 抽出不可なら push しない', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_alice');
    const brokenDef = { ...redentDef, share: { ...redentDef.share, liffUrl: '' } };
    dbMocks.getDiagnosisBySlug.mockResolvedValue(makeDiagRow({ definition: JSON.stringify(brokenDef) }));
    dbMocks.getFriendByLineUserId.mockResolvedValue(makeFriend());
    const res = await req('POST', '/api/liff/diagnoses/redent-cleanliness/submissions', {
      auth: 'idtoken',
      body: { answers: answersWith() },
    });
    expect(res.status).toBe(200);
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
  });
});

describe('GET /api/liff/diagnoses/submissions/:sid', () => {
  test('本人は result を取得', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_owner');
    dbMocks.getDiagnosisSubmissionById.mockResolvedValue({
      id: 's1',
      diagnosis_id: 'diag-1',
      friend_id: 'f1',
      line_user_id: 'U_owner',
      definition_version: 3,
      answers: '{}',
      result: JSON.stringify({ rank: 'B', totalScore: 46 }),
      share_token: 'tok1',
      created_at: '2026-07-01',
    });
    const res = await req('GET', '/api/liff/diagnoses/submissions/s1', { auth: 'idtoken' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { submissionId: string; result: { rank: string }; shareUrl: string };
    expect(json.result.rank).toBe('B');
    expect(json.shareUrl).toBe('https://worker.example.com/d/tok1');
  });

  test('本人以外は 403', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_other');
    dbMocks.getDiagnosisSubmissionById.mockResolvedValue({
      id: 's1',
      diagnosis_id: 'diag-1',
      friend_id: 'f1',
      line_user_id: 'U_owner',
      definition_version: 3,
      answers: '{}',
      result: '{}',
      share_token: 'tok1',
      created_at: '2026-07-01',
    });
    const res = await req('GET', '/api/liff/diagnoses/submissions/s1', { auth: 'idtoken' });
    expect(res.status).toBe(403);
  });

  test('未認証は 401', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue(null);
    const res = await req('GET', '/api/liff/diagnoses/submissions/s1');
    expect(res.status).toBe(401);
  });

  test('存在しない submission は 404', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U_owner');
    dbMocks.getDiagnosisSubmissionById.mockResolvedValue(null);
    const res = await req('GET', '/api/liff/diagnoses/submissions/missing', { auth: 'idtoken' });
    expect(res.status).toBe(404);
  });
});

// ── 公開シェアページ GET /d/:shareToken (07_share-og.md / D4・D7) ───────────────

describe('GET /d/:shareToken', () => {
  /** share_token で引く submission 行(result はスナップショット JSON)。 */
  function makeShareSubmission(result: unknown, overrides: Record<string, unknown> = {}) {
    return {
      id: 'sub-share',
      diagnosis_id: 'diag-1',
      friend_id: 'friend-1',
      line_user_id: 'U_alice',
      definition_version: 3,
      answers: '{}',
      result: typeof result === 'string' ? result : JSON.stringify(result),
      share_token: 'tok-share',
      created_at: '2026-07-16T00:00:00+09:00',
      ...overrides,
    };
  }

  /** share 設定を一部差し替えた diagnosis 行。 */
  function diagRowWithShare(
    shareOverrides: Record<string, unknown>,
    rowOverrides: Record<string, unknown> = {},
  ) {
    const def = { ...redentDef, share: { ...redentDef.share, ...shareOverrides } };
    return makeDiagRow({ definition: JSON.stringify(def), ...rowOverrides });
  }

  const GRADE_SYMBOL: Record<string, string> = { keep: '◎', almost: '○', warn: '△' };

  test('正常系: rank/rankTitle/totalScore/軸ラベル・グレードを含む 200', async () => {
    const result = runDiagnosis(redentDef, answersWith()); // 全問1 → S ランク
    dbMocks.getDiagnosisSubmissionByShareToken.mockResolvedValue(makeShareSubmission(result));
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow());
    const res = await req('GET', '/d/tok-share');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<div class="rank">${result.rank}</div>`);
    expect(html).toContain(result.rankTitle);
    expect(html).toContain(`スコア ${result.totalScore}点`);
    for (const ax of result.axisScores) {
      expect(html).toContain(ax.label);
      expect(html).toContain(GRADE_SYMBOL[ax.grade]);
    }
  });

  test('D7: 悩みタグ・カードタイトル・価格・axisMessages を出力しない', async () => {
    const result = runDiagnosis(redentDef, answersWith({ S1: 5, T1: 5 }));
    // フィクスチャ前提: カードとタグが立っていること(この前提が崩れたら検証が空振る)
    expect(result.cards.length).toBeGreaterThan(0);
    expect(result.tags.length).toBeGreaterThan(0);
    dbMocks.getDiagnosisSubmissionByShareToken.mockResolvedValue(makeShareSubmission(result));
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow());
    const res = await req('GET', '/d/tok-share');
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const card of result.cards) {
      expect(html).not.toContain(card.title);
      expect(html).not.toContain(String(card.priceInTax));
      expect(html).not.toContain(String(card.priceExTax));
    }
    for (const tag of result.tags) {
      expect(html).not.toContain(tag.tag);
    }
    for (const m of result.axisMessages) {
      if (m.message) expect(html).not.toContain(m.message);
    }
    // result JSON 丸ごと埋め込み禁止の証跡(スナップショット固有キーが露出しない)
    expect(html).not.toContain('cleanPoints');
    expect(html).not.toContain('axisMessages');
    expect(html).not.toContain('priceInTax');
  });

  test('存在しない shareToken は 404(簡素な HTML)', async () => {
    dbMocks.getDiagnosisSubmissionByShareToken.mockResolvedValue(null);
    const res = await req('GET', '/d/missing');
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('見つかりません');
  });

  test('is_active=1: 「自分も診断する」CTA を share.liffUrl で出力', async () => {
    const result = runDiagnosis(redentDef, answersWith());
    dbMocks.getDiagnosisSubmissionByShareToken.mockResolvedValue(makeShareSubmission(result));
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow());
    const res = await req('GET', '/d/tok-share');
    const html = await res.text();
    expect(html).toContain('自分も診断する');
    expect(html).toContain(redentDef.share.liffUrl);
  });

  test('is_active=0: 表示は継続するが CTA ボタンを出さない', async () => {
    const result = runDiagnosis(redentDef, answersWith());
    dbMocks.getDiagnosisSubmissionByShareToken.mockResolvedValue(makeShareSubmission(result));
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow({ is_active: 0 }));
    const res = await req('GET', '/d/tok-share');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('自分も診断する');
    expect(html).toContain(result.rankTitle); // 結果自体は見える
  });

  test('診断削除済み(定義が引けない)でも結果表示・CTA なし(snapshot のみで描画)', async () => {
    const result = runDiagnosis(redentDef, answersWith());
    dbMocks.getDiagnosisSubmissionByShareToken.mockResolvedValue(makeShareSubmission(result));
    dbMocks.getDiagnosisById.mockResolvedValue(null);
    const res = await req('GET', '/d/tok-share');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(result.rankTitle);
    expect(html).not.toContain('自分も診断する');
  });

  test('share.enabled=false は 404(共有機能無効の意思表示)', async () => {
    const result = runDiagnosis(redentDef, answersWith());
    dbMocks.getDiagnosisSubmissionByShareToken.mockResolvedValue(makeShareSubmission(result));
    dbMocks.getDiagnosisById.mockResolvedValue(diagRowWithShare({ enabled: false }));
    const res = await req('GET', '/d/tok-share');
    expect(res.status).toBe(404);
  });

  test('OG: ogImages[rank] 設定時に og:image を出力', async () => {
    const result = runDiagnosis(redentDef, answersWith()); // S
    dbMocks.getDiagnosisSubmissionByShareToken.mockResolvedValue(makeShareSubmission(result));
    dbMocks.getDiagnosisById.mockResolvedValue(
      diagRowWithShare({
        ogImages: { ...redentDef.share.ogImages, [result.rank]: 'https://cdn.example.com/og-s.png' },
      }),
    );
    const res = await req('GET', '/d/tok-share');
    const html = await res.text();
    expect(html).toContain('<meta property="og:image" content="https://cdn.example.com/og-s.png">');
  });

  test('OG: ogImages[rank] が空文字なら og:image を出力しない', async () => {
    const result = runDiagnosis(redentDef, answersWith());
    dbMocks.getDiagnosisSubmissionByShareToken.mockResolvedValue(makeShareSubmission(result));
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow()); // seed: 全ランク空文字
    const res = await req('GET', '/d/tok-share');
    const html = await res.text();
    expect(html).not.toContain('og:image');
  });

  test('OG: ogTitleTemplate の {score}/{rankTitle} を展開', async () => {
    const result = runDiagnosis(redentDef, answersWith());
    dbMocks.getDiagnosisSubmissionByShareToken.mockResolvedValue(makeShareSubmission(result));
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow());
    const res = await req('GET', '/d/tok-share');
    const html = await res.text();
    const expected = `清潔感スコア${result.totalScore}点・${result.rankTitle}だった!`;
    expect(html).toContain(`<meta property="og:title" content="${expected}">`);
  });

  test('HTML エスケープ: rankTitle の <script> を無害化', async () => {
    const evil = {
      rank: 'S',
      rankTitle: '<script>alert(1)</script>',
      totalScore: 88,
      axisScores: [{ axisId: 'body', label: '体毛', score: 5, grade: 'keep' }],
      cleanPoints: {},
      weakestAxes: [],
      rankSubcopy: '',
      rankBody: '',
      tags: [],
      cards: [],
      axisMessages: [],
      droppedCards: [],
      emptyState: true,
      diagnosisName: "Re'Dent 清潔感診断",
      minorNotice: '18歳未満の方のご契約には保護者の同意が必要です',
    };
    dbMocks.getDiagnosisSubmissionByShareToken.mockResolvedValue(makeShareSubmission(evil));
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow());
    const res = await req('GET', '/d/tok-share');
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('フッターに診断名(diagnosisName)と注意書き(minorNotice)を表示', async () => {
    const result = runDiagnosis(redentDef, answersWith());
    dbMocks.getDiagnosisSubmissionByShareToken.mockResolvedValue(makeShareSubmission(result));
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow());
    const res = await req('GET', '/d/tok-share');
    const html = await res.text();
    // diagnosisName は ' を含むため escape 後の部分文字列で検証
    expect(html).toContain('清潔感診断');
    expect(html).toContain(result.minorNotice as string);
  });

  test('Cache-Control: public, max-age=300 を付与', async () => {
    const result = runDiagnosis(redentDef, answersWith());
    dbMocks.getDiagnosisSubmissionByShareToken.mockResolvedValue(makeShareSubmission(result));
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow());
    const res = await req('GET', '/d/tok-share');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  // ── R6: ランク画像(snapshot.rankImageUrl 由来) ──────────────────────────────
  test('R6: rankImageUrl(https)があればヒーローに <img> を表示', async () => {
    const result = { ...runDiagnosis(redentDef, answersWith()), rankImageUrl: 'https://cdn.example.com/rank-s.png' };
    dbMocks.getDiagnosisSubmissionByShareToken.mockResolvedValue(makeShareSubmission(result));
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow());
    const res = await req('GET', '/d/tok-share');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="rank-img"');
    expect(html).toContain('src="https://cdn.example.com/rank-s.png"');
  });

  test('R6: rankImageUrl が無ければ <img> を表示しない(現行のランク文字ヒーロー)', async () => {
    const result = runDiagnosis(redentDef, answersWith());
    dbMocks.getDiagnosisSubmissionByShareToken.mockResolvedValue(makeShareSubmission(result));
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow());
    const res = await req('GET', '/d/tok-share');
    const html = await res.text();
    expect(html).not.toContain('class="rank-img"'); // CSS 定義(.rank-img{...})は常在するため img 要素で判定
    expect(html).toContain(`<div class="rank">${result.rank}</div>`); // 現行ヒーローは維持
  });

  test('R6: rankImageUrl が https:// でなければ表示しない(javascript: を弾く)', async () => {
    const result = { ...runDiagnosis(redentDef, answersWith()), rankImageUrl: 'javascript:alert(1)' };
    dbMocks.getDiagnosisSubmissionByShareToken.mockResolvedValue(makeShareSubmission(result));
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow());
    const res = await req('GET', '/d/tok-share');
    const html = await res.text();
    expect(html).not.toContain('class="rank-img"');
    expect(html).not.toContain('javascript:');
  });

  test('R6: rankImageUrl はエスケープされる(属性破壊を無害化)', async () => {
    const result = {
      ...runDiagnosis(redentDef, answersWith()),
      rankImageUrl: 'https://cdn.example.com/a.png"><script>alert(1)</script>',
    };
    dbMocks.getDiagnosisSubmissionByShareToken.mockResolvedValue(makeShareSubmission(result));
    dbMocks.getDiagnosisById.mockResolvedValue(makeDiagRow());
    const res = await req('GET', '/d/tok-share');
    const html = await res.text();
    expect(html).not.toContain('"><script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
