import { describe, expect, test, beforeEach, vi } from 'vitest';

// ── モック ─────────────────────────────────────────────────────────────────
// friends ルートが使う @line-crm/db ヘルパーをモックし、raw クエリだけ D1 モックで担う。
const dbMocks = {
  getFriends: vi.fn(),
  getFriendById: vi.fn(),
  getFriendCount: vi.fn(),
  addTagToFriend: vi.fn(),
  removeTagFromFriend: vi.fn(),
  getFriendTags: vi.fn(),
  getScenarios: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  resetFriendScenarioEnrollment: vi.fn(),
  jstNow: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const eventBusMocks = { fireEvent: vi.fn() };
vi.mock('../services/event-bus.js', () => eventBusMocks);

vi.mock('../services/step-delivery.js', () => ({ buildMessage: vi.fn() }));

const { friends } = await import('./friends.js');

// ── D1 モック ──────────────────────────────────────────────────────────────

interface Recorded {
  sql: string;
  binds: unknown[];
}

interface DbState {
  /** `SELECT id FROM friend_scenarios ...`(再 POST 経路)が返す既存登録行。 */
  anyEnrollment?: { id: string } | null;
  recorded: Recorded[];
}

function makeDb(state: DbState): D1Database {
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...params: unknown[]) {
          binds = params;
          return stmt;
        },
        async first<T>() {
          state.recorded.push({ sql, binds });
          if (sql.includes('FROM friend_scenarios')) {
            return (state.anyEnrollment ?? null) as T | null;
          }
          return null as T | null;
        },
        async all<T>() {
          state.recorded.push({ sql, binds });
          return { results: [] as T[] };
        },
        async run() {
          state.recorded.push({ sql, binds });
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function postTag(state: DbState, tagId = 'tag-1') {
  return friends.request(
    'https://worker.example.com/api/friends/friend-1/tags',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId }),
    },
    { DB: makeDb(state) },
    executionCtx,
  );
}

const tagAddedScenario = {
  id: 'scenario-1',
  trigger_type: 'tag_added',
  is_active: 1,
  trigger_tag_id: 'tag-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.addTagToFriend.mockResolvedValue({ added: true });
  dbMocks.getScenarios.mockResolvedValue([tagAddedScenario]);
  dbMocks.enrollFriendInScenario.mockResolvedValue(null);
  dbMocks.resetFriendScenarioEnrollment.mockResolvedValue(true);
  dbMocks.jstNow.mockReturnValue('2026-09-15T00:00:00+09:00');
  eventBusMocks.fireEvent.mockResolvedValue(undefined);
});

describe('POST /api/friends/:id/tags — tag_added シナリオの再トリガー', () => {
  test('新規付与 + 進行中の登録あり → UPDATE で起点リセット(enroll しない)', async () => {
    const state: DbState = { recorded: [] };
    const res = await postTag(state);

    expect(res.status).toBe(201);
    expect(dbMocks.resetFriendScenarioEnrollment).toHaveBeenCalledTimes(1);
    expect(dbMocks.resetFriendScenarioEnrollment).toHaveBeenCalledWith(
      expect.anything(),
      'friend-1',
      'scenario-1',
    );
    expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();
    // 事前 SELECT も DELETE もしない
    expect(state.recorded.some((r) => r.sql.includes('friend_scenarios'))).toBe(false);
  });

  test('新規付与 + UPDATE 0 件(登録なし/完了済みのみ/delivering) → 新規 enroll にフォールバック', async () => {
    dbMocks.resetFriendScenarioEnrollment.mockResolvedValue(false);
    const state: DbState = { recorded: [] };
    const res = await postTag(state);

    expect(res.status).toBe(201);
    expect(dbMocks.resetFriendScenarioEnrollment).toHaveBeenCalledTimes(1);
    expect(dbMocks.enrollFriendInScenario).toHaveBeenCalledTimes(1);
    expect(dbMocks.enrollFriendInScenario).toHaveBeenCalledWith(
      expect.anything(),
      'friend-1',
      'scenario-1',
    );
  });

  test('既に付いていたタグの再 POST + 登録行あり → 何もしない(起点を触らない)', async () => {
    dbMocks.addTagToFriend.mockResolvedValue({ added: false });
    const state: DbState = { anyEnrollment: { id: 'fs-1' }, recorded: [] };
    const res = await postTag(state);

    expect(res.status).toBe(201);
    expect(dbMocks.resetFriendScenarioEnrollment).not.toHaveBeenCalled();
    expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();
    // 再 POST 経路の SELECT は status を絞らない(completed も含めて「1 行でもあれば」判定)
    const select = state.recorded.find((r) => r.sql.includes('FROM friend_scenarios'));
    expect(select).toBeDefined();
    expect(select!.sql).not.toContain('status');
  });

  test('既に付いていたタグの再 POST + 登録行なし → 新規 enroll', async () => {
    dbMocks.addTagToFriend.mockResolvedValue({ added: false });
    const state: DbState = { anyEnrollment: null, recorded: [] };
    const res = await postTag(state);

    expect(res.status).toBe(201);
    expect(dbMocks.resetFriendScenarioEnrollment).not.toHaveBeenCalled();
    expect(dbMocks.enrollFriendInScenario).toHaveBeenCalledTimes(1);
  });

  test('トリガータグが一致しないシナリオは触らない', async () => {
    dbMocks.getScenarios.mockResolvedValue([{ ...tagAddedScenario, trigger_tag_id: 'tag-other' }]);
    const state: DbState = { recorded: [] };
    const res = await postTag(state);

    expect(res.status).toBe(201);
    expect(dbMocks.resetFriendScenarioEnrollment).not.toHaveBeenCalled();
    expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();
  });

  test('inactive なシナリオは触らない', async () => {
    dbMocks.getScenarios.mockResolvedValue([{ ...tagAddedScenario, is_active: 0 }]);
    const state: DbState = { recorded: [] };
    const res = await postTag(state);

    expect(res.status).toBe(201);
    expect(dbMocks.resetFriendScenarioEnrollment).not.toHaveBeenCalled();
    expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();
  });

  test('tag_change イベントは新規付与かどうかに関わらず毎回発火する', async () => {
    dbMocks.addTagToFriend.mockResolvedValue({ added: false });
    const state: DbState = { anyEnrollment: { id: 'fs-1' }, recorded: [] };
    await postTag(state);

    expect(eventBusMocks.fireEvent).toHaveBeenCalledWith(expect.anything(), 'tag_change', {
      friendId: 'friend-1',
      eventData: { tagId: 'tag-1', action: 'add' },
    });
  });
});
