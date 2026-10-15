import { describe, expect, test, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSegmentQuery } from './segment-query.js';
import type { SegmentCondition } from './segment-query.js';

// worker には SQLite の依存が無いので、packages/db が持つ better-sqlite3 を借りて本物の SQL を流す。
const here = dirname(fileURLToPath(import.meta.url));
const dbPkg = join(here, '..', '..', '..', '..', 'packages', 'db');
const require = createRequire(join(dbPkg, 'package.json'));

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
}
const Database = require('better-sqlite3') as new (path: string) => SqliteDb;

const BENIGN = /duplicate column name|already exists/i;
function execSafe(db: SqliteDb, sql: string): void {
  for (const stmt of sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    try {
      db.exec(stmt);
    } catch (err) {
      if (!BENIGN.test(err instanceof Error ? err.message : String(err))) throw err;
    }
  }
}

let sqlite: SqliteDb;

beforeEach(() => {
  sqlite = new Database(':memory:');
  execSafe(sqlite, readFileSync(join(dbPkg, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(dbPkg, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    execSafe(sqlite, readFileSync(join(dbPkg, 'migrations', file), 'utf8'));
  }
  const T = '2026-10-16T00:00:00.000+09:00';
  sqlite.prepare(`INSERT INTO tags (id, name, created_at) VALUES ('tag-a', 'A', ?), ('tag-b', 'B', ?)`).run(T, T);
  const friend = (id: string, following: number, account: string | null) =>
    sqlite
      .prepare(
        `INSERT INTO friends (id, line_user_id, is_following, line_account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, `U_${id}`, following, account, T, T);
  sqlite
    .prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at) VALUES ('acc-1', 'c', 'n', 't', 's', ?, ?)`,
    )
    .run(T, T);
  friend('following-a', 1, 'acc-1');
  friend('following-b', 1, 'acc-1');
  friend('notfollowing-a', 0, 'acc-1'); // 外部システムの同期が作る「友だちでない」記録
  friend('following-none', 1, null);
  const tag = (f: string, t: string) =>
    sqlite.prepare(`INSERT INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)`).run(f, t, T);
  tag('following-a', 'tag-a');
  tag('notfollowing-a', 'tag-a');
  tag('following-b', 'tag-b');
  tag('notfollowing-a', 'tag-b');
});

function ids(condition: SegmentCondition, accountId: string | null = null): string[] {
  // services/broadcast.ts・services/segment-send.ts と同じ組み立て(アカウントで絞る場合の WHERE 差し込み)
  const { sql, bindings } = buildSegmentQuery(condition);
  let finalSql = sql;
  const finalBindings = [...bindings];
  if (accountId) {
    finalSql = sql.replace('WHERE', 'WHERE f.line_account_id = ? AND');
    finalBindings.unshift(accountId);
  }
  return (sqlite.prepare(finalSql).all(...finalBindings) as Array<{ id: string }>).map((r) => r.id).sort();
}

describe('buildSegmentQuery — is_following の既定', () => {
  test('500 人超のタグ配信が変換されるセグメント(tag_exists 1 つ)は、友だちでない記録を含めない', () => {
    // routes/broadcasts.ts の tagMarker と同じ形
    const marker: SegmentCondition = { operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-a' }] };
    expect(ids(marker)).toEqual(['following-a']);
    expect(ids(marker, 'acc-1')).toEqual(['following-a']);
  });

  test('OR でも、全体に is_following = 1 が掛かる(括弧で包んでいる)', () => {
    const cond: SegmentCondition = {
      operator: 'OR',
      rules: [
        { type: 'tag_exists', value: 'tag-a' },
        { type: 'tag_exists', value: 'tag-b' },
      ],
    };
    expect(ids(cond)).toEqual(['following-a', 'following-b']);
    // アカウントの絞り込みを WHERE の直後に差し込んでも、OR の優先順位が崩れない
    expect(ids(cond, 'acc-1')).toEqual(['following-a', 'following-b']);
  });

  test('ルールが空でも、友だち(is_following = 1)だけ', () => {
    expect(ids({ operator: 'AND', rules: [] })).toEqual(['following-a', 'following-b', 'following-none']);
  });

  test('tag_not_exists など他のルールでも、友だちでない記録は入らない', () => {
    expect(ids({ operator: 'AND', rules: [{ type: 'tag_not_exists', value: 'tag-b' }] })).toEqual([
      'following-a',
      'following-none',
    ]);
  });

  test('is_following のルールがあるときは、その指定を尊重する(既定を足さない)', () => {
    expect(ids({ operator: 'AND', rules: [{ type: 'is_following', value: false }] })).toEqual(['notfollowing-a']);
    expect(
      ids({
        operator: 'AND',
        rules: [
          { type: 'tag_exists', value: 'tag-a' },
          { type: 'is_following', value: true },
        ],
      }),
    ).toEqual(['following-a']);
  });

  test('SQL に is_following の既定が入っている(ルール無しのとき)', () => {
    const { sql } = buildSegmentQuery({ operator: 'AND', rules: [{ type: 'tag_exists', value: 'x' }] });
    expect(sql).toContain('f.is_following = 1');
    const explicit = buildSegmentQuery({ operator: 'AND', rules: [{ type: 'is_following', value: false }] });
    expect(explicit.sql).not.toContain('AND f.is_following = 1');
  });
});
