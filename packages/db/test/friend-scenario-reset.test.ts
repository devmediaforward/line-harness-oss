import { describe, expect, test, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resetFriendScenarioEnrollment } from '../src/scenarios.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');

const BENIGN = /duplicate column name|already exists/i;

function execSafe(db: Database.Database, sql: string): void {
  for (const stmt of sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!BENIGN.test(msg)) throw err;
    }
  }
}

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  execSafe(db, readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of migrationFiles) {
    execSafe(db, readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return db;
}

/** meta.changes を返す D1 アダプタ(resetFriendScenarioEnrollment が戻り値判定に使う)。 */
function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          const stmt = sqlite.prepare(query);
          return {
            async run() {
              const info = stmt.run(...params);
              return { results: [], success: true, meta: { changes: info.changes } };
            },
            async first<T>() {
              return (stmt.get(...params) as T) ?? null;
            },
            async all<T>() {
              return { results: stmt.all(...params) as T[], success: true, meta: {} };
            },
          };
        },
        async run() {
          const info = sqlite.prepare(query).run();
          return { results: [], success: true, meta: { changes: info.changes } };
        },
        async first<T>() {
          return (sqlite.prepare(query).get() as T) ?? null;
        },
        async all<T>() {
          return { results: sqlite.prepare(query).all() as T[], success: true, meta: {} };
        },
      };
    },
  } as unknown as D1Database;
}

const OLD = '2020-01-01T00:00:00.000+09:00';

function seedScenario(sqlite: Database.Database, id: string, withStep: boolean) {
  sqlite
    .prepare(
      `INSERT INTO scenarios (id, name, trigger_type, is_active, created_at, updated_at)
       VALUES (?, 'visit', 'tag_added', 1, ?, ?)`,
    )
    .run(id, OLD, OLD);
  if (withStep) {
    sqlite
      .prepare(
        `INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, created_at)
         VALUES (?, ?, 0, 20160, 'text', 'hello', ?)`,
      )
      .run(`${id}-step-0`, id, OLD);
  }
}

function seedFriend(sqlite: Database.Database, id: string) {
  sqlite
    .prepare(
      `INSERT INTO friends (id, line_user_id, display_name, created_at, updated_at)
       VALUES (?, ?, 'Test User', ?, ?)`,
    )
    .run(id, `U_${id}`, OLD, OLD);
}

function seedEnrollment(
  sqlite: Database.Database,
  id: string,
  friendId: string,
  scenarioId: string,
  status: string,
) {
  sqlite
    .prepare(
      `INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at, next_delivery_at, updated_at)
       VALUES (?, ?, ?, 3, ?, ?, ?, ?)`,
    )
    .run(id, friendId, scenarioId, status, OLD, OLD, OLD);
}

function readEnrollment(sqlite: Database.Database, id: string) {
  return sqlite.prepare(`SELECT * FROM friend_scenarios WHERE id = ?`).get(id) as {
    current_step_order: number;
    status: string;
    started_at: string;
    next_delivery_at: string | null;
  };
}

function countEnrollments(sqlite: Database.Database, friendId: string, scenarioId: string): number {
  return (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`,
      )
      .get(friendId, scenarioId) as { n: number }
  ).n;
}

describe('resetFriendScenarioEnrollment', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = setupDb();
    db = asD1(sqlite);
    seedFriend(sqlite, 'friend-1');
    seedScenario(sqlite, 'scenario-1', true);
  });

  test('active の行を enroll 直後と同じ状態へ巻き戻す', async () => {
    seedEnrollment(sqlite, 'fs-1', 'friend-1', 'scenario-1', 'active');

    const ok = await resetFriendScenarioEnrollment(db, 'friend-1', 'scenario-1');

    expect(ok).toBe(true);
    const row = readEnrollment(sqlite, 'fs-1');
    expect(row.current_step_order).toBe(-1);
    expect(row.status).toBe('active');
    // 起点も次回配信も書き換わっている
    expect(row.started_at).not.toBe(OLD);
    expect(row.next_delivery_at).not.toBe(OLD);
    expect(new Date(row.next_delivery_at!).getTime()).toBeGreaterThan(Date.now());
    // 行は増やさない(in-place UPDATE)
    expect(countEnrollments(sqlite, 'friend-1', 'scenario-1')).toBe(1);
  });

  test('paused の行も active に戻して巻き戻す', async () => {
    seedEnrollment(sqlite, 'fs-2', 'friend-1', 'scenario-1', 'paused');

    const ok = await resetFriendScenarioEnrollment(db, 'friend-1', 'scenario-1');

    expect(ok).toBe(true);
    expect(readEnrollment(sqlite, 'fs-2').status).toBe('active');
  });

  test('delivering の行は触らず false を返す(cron の送信中)', async () => {
    seedEnrollment(sqlite, 'fs-3', 'friend-1', 'scenario-1', 'delivering');

    const ok = await resetFriendScenarioEnrollment(db, 'friend-1', 'scenario-1');

    expect(ok).toBe(false);
    const row = readEnrollment(sqlite, 'fs-3');
    expect(row.status).toBe('delivering');
    expect(row.current_step_order).toBe(3);
    expect(row.started_at).toBe(OLD);
  });

  test('completed の行しか無ければ触らず false を返す', async () => {
    seedEnrollment(sqlite, 'fs-4', 'friend-1', 'scenario-1', 'completed');

    const ok = await resetFriendScenarioEnrollment(db, 'friend-1', 'scenario-1');

    expect(ok).toBe(false);
    expect(readEnrollment(sqlite, 'fs-4').status).toBe('completed');
  });

  test('完了済み行が併存していても進行中行だけを巻き戻す', async () => {
    seedEnrollment(sqlite, 'fs-done', 'friend-1', 'scenario-1', 'completed');
    seedEnrollment(sqlite, 'fs-live', 'friend-1', 'scenario-1', 'active');

    const ok = await resetFriendScenarioEnrollment(db, 'friend-1', 'scenario-1');

    expect(ok).toBe(true);
    expect(readEnrollment(sqlite, 'fs-live').current_step_order).toBe(-1);
    // 完了済み行は不変
    const done = readEnrollment(sqlite, 'fs-done');
    expect(done.status).toBe('completed');
    expect(done.current_step_order).toBe(3);
    expect(countEnrollments(sqlite, 'friend-1', 'scenario-1')).toBe(2);
  });

  test('ステップ 0 本のシナリオは進行中行を completed にする(孤児行を作らない)', async () => {
    seedScenario(sqlite, 'scenario-empty', false);
    seedEnrollment(sqlite, 'fs-5', 'friend-1', 'scenario-empty', 'active');

    const ok = await resetFriendScenarioEnrollment(db, 'friend-1', 'scenario-empty');

    expect(ok).toBe(true);
    const row = readEnrollment(sqlite, 'fs-5');
    expect(row.status).toBe('completed');
    expect(row.next_delivery_at).toBeNull();
    // 行数は増えない = 呼び出し側の enroll フォールバックが走らず孤児行も生まれない
    expect(countEnrollments(sqlite, 'friend-1', 'scenario-empty')).toBe(1);
  });

  test('ステップ 0 本 + 進行中行なし → false', async () => {
    seedScenario(sqlite, 'scenario-empty2', false);
    seedEnrollment(sqlite, 'fs-6', 'friend-1', 'scenario-empty2', 'completed');

    const ok = await resetFriendScenarioEnrollment(db, 'friend-1', 'scenario-empty2');

    expect(ok).toBe(false);
    expect(countEnrollments(sqlite, 'friend-1', 'scenario-empty2')).toBe(1);
  });

  test('登録行が無ければ false', async () => {
    const ok = await resetFriendScenarioEnrollment(db, 'friend-1', 'scenario-1');
    expect(ok).toBe(false);
  });

  test('存在しないシナリオは false', async () => {
    const ok = await resetFriendScenarioEnrollment(db, 'friend-1', 'scenario-missing');
    expect(ok).toBe(false);
  });

  test('他 friend の進行中行は巻き込まない', async () => {
    seedFriend(sqlite, 'friend-2');
    seedEnrollment(sqlite, 'fs-other', 'friend-2', 'scenario-1', 'active');
    seedEnrollment(sqlite, 'fs-mine', 'friend-1', 'scenario-1', 'active');

    const ok = await resetFriendScenarioEnrollment(db, 'friend-1', 'scenario-1');

    expect(ok).toBe(true);
    expect(readEnrollment(sqlite, 'fs-mine').current_step_order).toBe(-1);
    const other = readEnrollment(sqlite, 'fs-other');
    expect(other.current_step_order).toBe(3);
    expect(other.started_at).toBe(OLD);
  });
});
