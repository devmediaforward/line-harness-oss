import { describe, expect, test, beforeEach, vi } from 'vitest';

const dbMocks = {
  getScenarios: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  jstNow: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const eventBusMocks = { fireEvent: vi.fn() };
vi.mock('./event-bus.js', () => eventBusMocks);

const { attachTagAndFireSideEffects } = await import('./friend-tag-attach.js');

interface Recorded {
  sql: string;
  binds: unknown[];
}

interface DbState {
  /** friend_tags への INSERT OR IGNORE が報告する changes(0 = 既に付与済み)。 */
  insertChanges?: number;
  /** `SELECT id FROM friend_scenarios ... status != 'completed'` が返す行。 */
  activeEnrollment?: { id: string } | null;
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
            return (state.activeEnrollment ?? null) as T | null;
          }
          return null as T | null;
        },
        async all<T>() {
          state.recorded.push({ sql, binds });
          return { results: [] as T[] };
        },
        async run() {
          state.recorded.push({ sql, binds });
          return { meta: { changes: state.insertChanges ?? 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

const tagAddedScenario = {
  id: 'scenario-1',
  trigger_type: 'tag_added',
  is_active: 1,
  trigger_tag_id: 'tag-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getScenarios.mockResolvedValue([tagAddedScenario]);
  dbMocks.enrollFriendInScenario.mockResolvedValue(null);
  dbMocks.jstNow.mockReturnValue('2026-09-15T00:00:00+09:00');
  eventBusMocks.fireEvent.mockResolvedValue(undefined);
});

describe('attachTagAndFireSideEffects — tag_added シナリオ enrollment', () => {
  test('完了済みの登録しか無い場合は再登録する(完了済み行は阻害しない)', async () => {
    const state: DbState = { activeEnrollment: null, recorded: [] };
    const result = await attachTagAndFireSideEffects(makeDb(state), 'friend-1', 'tag-1');

    expect(result).toEqual({ added: true });
    const select = state.recorded.find((r) => r.sql.includes('SELECT id FROM friend_scenarios'));
    expect(select).toBeDefined();
    expect(select!.sql).toContain("status != 'completed'");
    expect(dbMocks.enrollFriendInScenario).toHaveBeenCalledWith(
      expect.anything(),
      'friend-1',
      'scenario-1',
    );
  });

  test('進行中の登録があれば再登録しない(自動経路では起点リセットしない)', async () => {
    const state: DbState = { activeEnrollment: { id: 'fs-active' }, recorded: [] };
    const result = await attachTagAndFireSideEffects(makeDb(state), 'friend-1', 'tag-1');

    expect(result).toEqual({ added: true });
    expect(state.recorded.some((r) => r.sql.includes('DELETE FROM friend_scenarios'))).toBe(false);
    expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();
  });

  test('既に付与済み(changes=0)なら副作用は一切走らない', async () => {
    const state: DbState = { insertChanges: 0, activeEnrollment: null, recorded: [] };
    const result = await attachTagAndFireSideEffects(makeDb(state), 'friend-1', 'tag-1');

    expect(result).toEqual({ added: false });
    expect(dbMocks.getScenarios).not.toHaveBeenCalled();
    expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();
    expect(eventBusMocks.fireEvent).not.toHaveBeenCalled();
  });
});
