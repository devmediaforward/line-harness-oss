import { jstNow } from './utils.js';
// =============================================================================
// Diagnoses — 汎用診断システム (02_data-model.md)
// 行型はここでローカル定義する(forms と同じ方針)。定義JSON / 結果スナップショット
// のドメイン型は @line-crm/shared 側。
// =============================================================================

export interface Diagnosis {
  id: string;
  name: string;
  slug: string | null;
  definition: string; // JSON string of DiagnosisDefinition
  definition_version: number;
  is_active: number;
  submit_count: number;
  created_at: string;
  updated_at: string;
}

export interface DiagnosisSubmission {
  id: string;
  diagnosis_id: string;
  friend_id: string | null;
  line_user_id: string | null;
  definition_version: number;
  answers: string; // JSON string { questionId: value }
  result: string; // JSON string (結果スナップショット)
  share_token: string | null;
  created_at: string;
}

/** friend 表示名を join した submission 行(一覧・stats 用) */
export interface DiagnosisSubmissionWithFriend extends DiagnosisSubmission {
  friend_name: string | null;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function getDiagnoses(db: D1Database): Promise<Diagnosis[]> {
  const result = await db
    .prepare(`SELECT * FROM diagnoses ORDER BY created_at DESC`)
    .all<Diagnosis>();
  return result.results;
}

export async function getDiagnosisById(db: D1Database, id: string): Promise<Diagnosis | null> {
  return db.prepare(`SELECT * FROM diagnoses WHERE id = ?`).bind(id).first<Diagnosis>();
}

export async function getDiagnosisBySlug(db: D1Database, slug: string): Promise<Diagnosis | null> {
  return db.prepare(`SELECT * FROM diagnoses WHERE slug = ?`).bind(slug).first<Diagnosis>();
}

export interface CreateDiagnosisInput {
  name: string;
  slug?: string | null;
  definition: string; // JSON string
}

export async function createDiagnosis(
  db: D1Database,
  input: CreateDiagnosisInput,
): Promise<Diagnosis> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO diagnoses
         (id, name, slug, definition, definition_version, is_active, submit_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1, 0, ?, ?)`,
    )
    .bind(id, input.name, input.slug ?? null, input.definition, now, now)
    .run();

  return (await getDiagnosisById(db, id))!;
}

export interface UpdateDiagnosisInput {
  name?: string;
  slug?: string | null;
  definition?: string; // JSON string. 渡すたび definition_version を +1
  isActive?: boolean;
}

export async function updateDiagnosis(
  db: D1Database,
  id: string,
  input: UpdateDiagnosisInput,
): Promise<Diagnosis | null> {
  const existing = await getDiagnosisById(db, id);
  if (!existing) return null;

  const now = jstNow();
  const definitionProvided = input.definition !== undefined;
  const nextVersion = definitionProvided
    ? existing.definition_version + 1
    : existing.definition_version;

  await db
    .prepare(
      `UPDATE diagnoses
       SET name = ?,
           slug = ?,
           definition = ?,
           definition_version = ?,
           is_active = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.name ?? existing.name,
      'slug' in input ? (input.slug ?? null) : existing.slug,
      input.definition ?? existing.definition,
      nextVersion,
      'isActive' in input ? (input.isActive ? 1 : 0) : existing.is_active,
      now,
      id,
    )
    .run();

  return getDiagnosisById(db, id);
}

export async function deleteDiagnosis(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM diagnoses WHERE id = ?`).bind(id).run();
}

// ── Submissions ───────────────────────────────────────────────────────────────

export interface CreateDiagnosisSubmissionInput {
  diagnosisId: string;
  friendId?: string | null;
  lineUserId?: string | null;
  definitionVersion: number;
  answers: string; // JSON string
  result: string; // JSON string
  shareToken?: string | null;
}

export async function createDiagnosisSubmission(
  db: D1Database,
  input: CreateDiagnosisSubmissionInput,
): Promise<DiagnosisSubmission> {
  const id = crypto.randomUUID();
  const now = jstNow();

  // insert と submit_count 更新を 1 バッチで原子的に実行(途中失敗で submission
  // だけ残る不整合を防ぐ)。D1 の batch は暗黙トランザクション。
  await db.batch([
    db
      .prepare(
        `INSERT INTO diagnosis_submissions
           (id, diagnosis_id, friend_id, line_user_id, definition_version, answers, result, share_token, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.diagnosisId,
        input.friendId ?? null,
        input.lineUserId ?? null,
        input.definitionVersion,
        input.answers,
        input.result,
        input.shareToken ?? null,
        now,
      ),
    db
      .prepare(`UPDATE diagnoses SET submit_count = submit_count + 1, updated_at = ? WHERE id = ?`)
      .bind(now, input.diagnosisId),
  ]);

  return (await db
    .prepare(`SELECT * FROM diagnosis_submissions WHERE id = ?`)
    .bind(id)
    .first<DiagnosisSubmission>())!;
}

export async function getDiagnosisSubmissionById(
  db: D1Database,
  id: string,
): Promise<DiagnosisSubmission | null> {
  return db
    .prepare(`SELECT * FROM diagnosis_submissions WHERE id = ?`)
    .bind(id)
    .first<DiagnosisSubmission>();
}

export async function getDiagnosisSubmissionByShareToken(
  db: D1Database,
  shareToken: string,
): Promise<DiagnosisSubmission | null> {
  return db
    .prepare(`SELECT * FROM diagnosis_submissions WHERE share_token = ?`)
    .bind(shareToken)
    .first<DiagnosisSubmission>();
}

/** stats・管理画面用の submission 一覧(新しい順、friend 表示名を join、ページング付き) */
export async function getDiagnosisSubmissions(
  db: D1Database,
  diagnosisId: string,
  limit = 50,
  offset = 0,
): Promise<DiagnosisSubmissionWithFriend[]> {
  // NaN/Infinity は既定値へフォールバック(F8)。全順序化のため created_at と id で並べる(F7)。
  // offset は安全整数範囲を超える巨大な有限値も bind で落ちないよう 32bit 上限にクランプ。
  const safeLimit = Number.isFinite(limit) ? limit : 50;
  const safeOffsetRaw = Number.isFinite(offset) ? offset : 0;
  const cappedLimit = Math.min(Math.max(1, Math.trunc(safeLimit)), 200);
  const safeOffset = Math.min(Math.max(0, Math.trunc(safeOffsetRaw)), 2_147_483_647);
  const result = await db
    .prepare(
      `SELECT ds.*, f.display_name as friend_name FROM diagnosis_submissions ds
       LEFT JOIN friends f ON f.id = ds.friend_id
       WHERE ds.diagnosis_id = ? ORDER BY ds.created_at DESC, ds.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(diagnosisId, cappedLimit, safeOffset)
    .all<DiagnosisSubmissionWithFriend>();
  return result.results;
}

/** ページングAPI用の総件数 */
export async function countDiagnosisSubmissions(
  db: D1Database,
  diagnosisId: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as count FROM diagnosis_submissions WHERE diagnosis_id = ?`)
    .bind(diagnosisId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
