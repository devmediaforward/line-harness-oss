import { describe, expect, test, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addTagToFriend } from '../src/tags.js';

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

/** meta.changes を返す D1 アダプタ(addTagToFriend が added 判定に使う)。 */
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
      };
    },
  } as unknown as D1Database;
}

const OLD = '2020-01-01T00:00:00.000+09:00';

describe('addTagToFriend', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = setupDb();
    db = asD1(sqlite);
    sqlite
      .prepare(
        `INSERT INTO friends (id, line_user_id, display_name, created_at, updated_at)
         VALUES ('friend-1', 'U_1', 'Test User', ?, ?)`,
      )
      .run(OLD, OLD);
    sqlite
      .prepare(`INSERT INTO tags (id, name, created_at) VALUES ('tag-1', '【来店】', ?)`)
      .run(OLD);
  });

  test('初回付与は added=true', async () => {
    const result = await addTagToFriend(db, 'friend-1', 'tag-1');
    expect(result).toEqual({ added: true });
  });

  test('既に付いているタグの再付与は added=false(行も増えない)', async () => {
    await addTagToFriend(db, 'friend-1', 'tag-1');
    const second = await addTagToFriend(db, 'friend-1', 'tag-1');

    expect(second).toEqual({ added: false });
    const count = (
      sqlite
        .prepare(`SELECT COUNT(*) AS n FROM friend_tags WHERE friend_id = 'friend-1'`)
        .get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });
});
