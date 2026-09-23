import { describe, expect, test, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getActiveStaffByEmail } from '../src/staff.js';

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

/** Minimal D1 adapter: getActiveStaffByEmail only uses prepare().bind().all(). */
function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all<T>() {
              return { results: sqlite.prepare(query).all(...params) as T[], success: true, meta: {} };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function seedStaff(
  sqlite: Database.Database,
  id: string,
  email: string | null,
  isActive = 1,
): void {
  sqlite
    .prepare(
      `INSERT INTO staff_members (id, name, email, role, api_key, is_active)
       VALUES (?, ?, ?, 'staff', ?, ?)`,
    )
    .run(id, id, email, `key-${id}`, isActive);
}

describe('getActiveStaffByEmail', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = setupDb();
    db = asD1(sqlite);
  });

  test('matches a stored mixed-case email with a lower-cased argument', async () => {
    seedStaff(sqlite, 's1', 'Alice@Example.COM');
    const rows = await getActiveStaffByEmail(db, 'alice@example.com');
    expect(rows.map((r) => r.id)).toEqual(['s1']);
  });

  test('ignores inactive staff', async () => {
    seedStaff(sqlite, 's1', 'alice@example.com', 0);
    expect(await getActiveStaffByEmail(db, 'alice@example.com')).toEqual([]);

    seedStaff(sqlite, 's2', 'alice@example.com', 1);
    const rows = await getActiveStaffByEmail(db, 'alice@example.com');
    expect(rows.map((r) => r.id)).toEqual(['s2']);
  });

  test('returns at most 2 rows so duplicates are detectable', async () => {
    seedStaff(sqlite, 's1', 'dup@example.com');
    seedStaff(sqlite, 's2', 'DUP@example.com');
    seedStaff(sqlite, 's3', 'dup@example.com');
    expect(await getActiveStaffByEmail(db, 'dup@example.com')).toHaveLength(2);
  });

  test('returns nothing for no match, a null email, or an injection attempt', async () => {
    seedStaff(sqlite, 's1', 'alice@example.com');
    seedStaff(sqlite, 's2', null);
    expect(await getActiveStaffByEmail(db, 'bob@example.com')).toEqual([]);
    expect(await getActiveStaffByEmail(db, '')).toEqual([]);
    expect(await getActiveStaffByEmail(db, "' OR '1'='1")).toEqual([]);
  });
});
