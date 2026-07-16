import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDiagnosisSubmission,
  getDiagnosisSubmissionByRequestId,
} from '../src/diagnoses.js';

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

function asD1(sqlite: Database.Database): D1Database {
  const wrap = (query: string, presetParams?: unknown[]) => {
    const run = (params: unknown[]) => {
      const stmt = sqlite.prepare(query);
      return {
        async run() {
          stmt.run(...params);
          return { results: [], success: true, meta: {} };
        },
        async first<T>() {
          return (stmt.get(...params) as T) ?? null;
        },
        async all<T>() {
          return { results: stmt.all(...params) as T[], success: true, meta: {} };
        },
      };
    };
    return {
      bind(...params: unknown[]) {
        return run(params);
      },
      ...run(presetParams ?? []),
    };
  };
  return {
    prepare(query: string) {
      return wrap(query);
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const out: unknown[] = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

function insertDiagnosis(sqlite: Database.Database, id: string): void {
  sqlite
    .prepare(
      `INSERT INTO diagnoses (id, name, slug, definition, definition_version, is_active, submit_count, created_at, updated_at)
       VALUES (?, ?, ?, '{}', 1, 1, 0, '2026-01-01T00:00:00.000+09:00', '2026-01-01T00:00:00.000+09:00')`,
    )
    .run(id, `diag ${id}`, `slug-${id}`);
}

function insertSubmission(
  sqlite: Database.Database,
  row: { id: string; diagnosisId: string; requestId: string | null; lineUserId?: string | null },
): void {
  sqlite
    .prepare(
      `INSERT INTO diagnosis_submissions
         (id, diagnosis_id, friend_id, line_user_id, definition_version, answers, result, share_token, request_id, created_at)
       VALUES (?, ?, NULL, ?, 1, '{}', '{}', NULL, ?, '2026-01-01T00:00:00.000+09:00')`,
    )
    .run(row.id, row.diagnosisId, row.lineUserId ?? null, row.requestId);
}

describe('051_diagnosis_request_id.sql migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
    insertDiagnosis(db, 'd1');
  });

  it('adds the request_id column to diagnosis_submissions', () => {
    const cols = db
      .prepare(`PRAGMA table_info(diagnosis_submissions)`)
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'request_id')).toBe(true);
  });

  it('rejects a second row with the same (diagnosis_id, request_id) (UNIQUE)', () => {
    insertSubmission(db, { id: 's1', diagnosisId: 'd1', requestId: 'req-dup' });
    expect(() =>
      insertSubmission(db, { id: 's2', diagnosisId: 'd1', requestId: 'req-dup' }),
    ).toThrow(/UNIQUE/i);
  });

  it('allows the same request_id under different diagnoses (composite scope)', () => {
    insertDiagnosis(db, 'd2');
    insertSubmission(db, { id: 's1', diagnosisId: 'd1', requestId: 'req-shared' });
    expect(() =>
      insertSubmission(db, { id: 's2', diagnosisId: 'd2', requestId: 'req-shared' }),
    ).not.toThrow();
    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM diagnosis_submissions WHERE request_id = 'req-shared'`)
      .get() as { c: number };
    expect(count.c).toBe(2);
  });

  it('allows multiple rows with NULL request_id (legacy clients)', () => {
    insertSubmission(db, { id: 's1', diagnosisId: 'd1', requestId: null });
    expect(() => insertSubmission(db, { id: 's2', diagnosisId: 'd1', requestId: null })).not.toThrow();
    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM diagnosis_submissions WHERE request_id IS NULL`)
      .get() as { c: number };
    expect(count.c).toBe(2);
  });
});

describe('createDiagnosisSubmission + getDiagnosisSubmissionByRequestId', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = setupDb();
    db = asD1(sqlite);
    insertDiagnosis(sqlite, 'd1');
  });

  it('persists request_id and looks it up within the diagnosis scope', async () => {
    const created = await createDiagnosisSubmission(db, {
      diagnosisId: 'd1',
      friendId: null,
      lineUserId: 'U_alice',
      definitionVersion: 1,
      answers: '{}',
      result: JSON.stringify({ rank: 'S' }),
      shareToken: 'tok-1',
      requestId: 'req-1',
    });
    expect(created.request_id).toBe('req-1');

    const found = await getDiagnosisSubmissionByRequestId(db, 'd1', 'req-1');
    expect(found?.id).toBe(created.id);
    expect(found?.line_user_id).toBe('U_alice');

    // 別診断スコープでは引けない
    const other = await getDiagnosisSubmissionByRequestId(db, 'd-other', 'req-1');
    expect(other).toBeNull();
  });

  it('re-inserting the same request_id under the same diagnosis throws a UNIQUE violation', async () => {
    await createDiagnosisSubmission(db, {
      diagnosisId: 'd1',
      lineUserId: 'U_alice',
      definitionVersion: 1,
      answers: '{}',
      result: '{}',
      shareToken: 'tok-a',
      requestId: 'req-same',
    });
    await expect(
      createDiagnosisSubmission(db, {
        diagnosisId: 'd1',
        lineUserId: 'U_alice',
        definitionVersion: 1,
        answers: '{}',
        result: '{}',
        shareToken: 'tok-b',
        requestId: 'req-same',
      }),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it('accepts the same request_id under a different diagnosis (composite scope)', async () => {
    insertDiagnosis(sqlite, 'd2');
    await createDiagnosisSubmission(db, {
      diagnosisId: 'd1',
      lineUserId: 'U_alice',
      definitionVersion: 1,
      answers: '{}',
      result: '{}',
      shareToken: 'tok-d1',
      requestId: 'req-cross',
    });
    const second = await createDiagnosisSubmission(db, {
      diagnosisId: 'd2',
      lineUserId: 'U_alice',
      definitionVersion: 1,
      answers: '{}',
      result: '{}',
      shareToken: 'tok-d2',
      requestId: 'req-cross',
    });
    expect(second.request_id).toBe('req-cross');
    expect(await getDiagnosisSubmissionByRequestId(db, 'd2', 'req-cross')).not.toBeNull();
  });
});
