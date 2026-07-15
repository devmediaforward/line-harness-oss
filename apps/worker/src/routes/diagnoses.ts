// =============================================================================
// 診断 (Diagnoses) API ルート (05_api-spec.md)
//
// 管理系: 既存 authMiddleware で保護(index.ts で /api/ 配下は自動的に認証必須)。
// LIFF 系: /api/liff/ 配下は authMiddleware をスキップし、idToken を
//          verifyCallerLineUserId で検証する(既存 events.ts / booking.ts と同方式)。
// 定義JSON は TEXT 列に格納し、serialize 時に parse して返す(forms の方式)。
// =============================================================================

import { Hono, type Context } from 'hono';
import {
  getDiagnoses,
  getDiagnosisById,
  getDiagnosisBySlug,
  createDiagnosis,
  updateDiagnosis,
  deleteDiagnosis,
  getDiagnosisSubmissions,
  countDiagnosisSubmissions,
  getDiagnosisSubmissionById,
  createDiagnosisSubmission,
  getFriendByLineUserId,
  getLineAccountById,
  addTagToFriend,
  enrollFriendInScenario,
  createTag,
  jstNow,
  type Diagnosis,
  type DiagnosisSubmission,
  type DiagnosisSubmissionWithFriend,
  type UpdateDiagnosisInput,
  type Friend,
} from '@line-crm/db';
import type {
  DiagnosisAnswers,
  DiagnosisDefinition,
  DiagnosisResult,
} from '@line-crm/shared';
import { runDiagnosis } from '../services/diagnosis/engine.js';
import { validateDefinition } from '../services/diagnosis/validate.js';
import { buildResultFlex } from '../services/diagnosis/flex.js';
import { verifyCallerLineUserId } from '../services/liff-auth.js';
import type { Env } from '../index.js';

const diagnoses = new Hono<Env>();

/** definition の D1 行サイズ安全圏。超過は 413。 */
const DEFINITION_MAX_BYTES = 512 * 1024;

// ── シリアライズ ───────────────────────────────────────────────────────────

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** 詳細(definition 含む)。GET /:id・作成・更新のレスポンス。 */
function serializeDiagnosisDetail(row: Diagnosis) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    definition: safeParse<unknown>(row.definition, {}),
    definitionVersion: row.definition_version,
    isActive: Boolean(row.is_active),
    submitCount: row.submit_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 一覧(definition なし + 直近回答日時)。GET /api/diagnoses。 */
function serializeDiagnosisListItem(row: Diagnosis, lastSubmittedAt: string | null) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    isActive: Boolean(row.is_active),
    submitCount: row.submit_count,
    updatedAt: row.updated_at,
    lastSubmittedAt,
  };
}

/** 回答一覧行(summary: rank/score のみ)。forms の submissions と同形式。 */
function serializeSubmissionSummary(row: DiagnosisSubmissionWithFriend) {
  const result = safeParse<{ rank?: string; totalScore?: number }>(row.result, {});
  return {
    id: row.id,
    diagnosisId: row.diagnosis_id,
    friendId: row.friend_id,
    friendName: row.friend_name ?? null,
    lineUserId: row.line_user_id,
    rank: result.rank ?? null,
    totalScore: result.totalScore ?? null,
    shareToken: row.share_token,
    createdAt: row.created_at,
  };
}

/** 回答詳細(answers + result スナップショット)。GET /:id/submissions/:sid。 */
function serializeSubmissionDetail(row: DiagnosisSubmission) {
  return {
    id: row.id,
    diagnosisId: row.diagnosis_id,
    friendId: row.friend_id,
    lineUserId: row.line_user_id,
    definitionVersion: row.definition_version,
    answers: safeParse<Record<string, number>>(row.answers, {}),
    result: safeParse<Record<string, unknown>>(row.result, {}),
    shareToken: row.share_token,
    createdAt: row.created_at,
  };
}

// ── URL 解決ヘルパー ───────────────────────────────────────────────────────

/** 共有ページ /d/:shareToken のベース URL(Worker 自身)。/d/ 専用の設定は無いため
 *  WORKER_URL(無ければリクエスト origin)を使う。末尾スラッシュは除去。 */
function resolveShareBaseUrl(c: Context<Env>): string {
  const base = c.env.WORKER_URL?.trim() || new URL(c.req.url).origin;
  return base.replace(/\/$/, '');
}

/** definition.share.liffUrl から liffId を抜き、結果ページ LIFF URL を組む。 */
function buildLiffResultUrl(shareLiffUrl: string, submissionId: string): string {
  const m = shareLiffUrl.match(/liff\.line\.me\/([^/?#]+)/);
  const liffId = m ? m[1] : '';
  return `https://liff.line.me/${liffId}/diagnosis/result/${submissionId}`;
}

// ── 統計集計(result スナップショット走査) ────────────────────────────────

function computeStats(def: DiagnosisDefinition, resultStrings: string[]) {
  const rankDistribution: Record<string, number> = {};
  for (const r of def.scoring?.ranks ?? []) rankDistribution[r.rank] = 0;

  const bucketLabels: string[] = [];
  for (let b = 0; b < 100; b += 10) bucketLabels.push(`${b}-${b + 9}`);
  bucketLabels.push('100');
  const bucketCounts = new Map<string, number>(bucketLabels.map((l) => [l, 0]));

  const axisAcc = new Map<string, { sum: number; count: number }>();
  for (const ax of def.axes ?? []) axisAcc.set(ax.id, { sum: 0, count: 0 });

  const tagCounts = new Map<string, number>();
  const cardCounts = new Map<string, number>();

  for (const s of resultStrings) {
    const result = safeParse<DiagnosisResult | null>(s, null);
    if (!result) continue;

    if (typeof result.rank === 'string') {
      rankDistribution[result.rank] = (rankDistribution[result.rank] ?? 0) + 1;
    }

    const score = typeof result.totalScore === 'number' ? result.totalScore : 0;
    const label = score >= 100 ? '100' : `${Math.floor(score / 10) * 10}-${Math.floor(score / 10) * 10 + 9}`;
    bucketCounts.set(label, (bucketCounts.get(label) ?? 0) + 1);

    for (const a of result.axisScores ?? []) {
      const acc = axisAcc.get(a.axisId);
      if (acc && typeof a.score === 'number') {
        acc.sum += a.score;
        acc.count++;
      }
    }
    for (const t of result.tags ?? []) {
      if (t && typeof t.tag === 'string') tagCounts.set(t.tag, (tagCounts.get(t.tag) ?? 0) + 1);
    }
    for (const cd of result.cards ?? []) {
      if (cd && typeof cd.title === 'string') cardCounts.set(cd.title, (cardCounts.get(cd.title) ?? 0) + 1);
    }
  }

  return {
    total: resultStrings.length,
    rankDistribution,
    scoreHistogram: bucketLabels.map((bucket) => ({ bucket, count: bucketCounts.get(bucket) ?? 0 })),
    axisAverages: [...axisAcc.entries()].map(([axisId, acc]) => ({
      axisId,
      avg: acc.count > 0 ? Math.round((acc.sum / acc.count) * 100) / 100 : 0,
    })),
    tagCounts: [...tagCounts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    cardCounts: [...cardCounts.entries()]
      .map(([title, count]) => ({ title, count }))
      .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)),
  };
}

// ── 副作用(definition.sideEffects、D2 決定) ──────────────────────────────
// forms の副作用実装を流用。失敗しても submission は成功扱い(各処理を try-catch で
// 握りつぶす)。ログ出力はしない(空 catch)。

/** タグ名 → tag_id 解決(既存名マッチ、無ければ自動作成)。 */
async function resolveTagIdByName(db: D1Database, name: string): Promise<string> {
  const existing = await db
    .prepare(`SELECT id FROM tags WHERE name = ? LIMIT 1`)
    .bind(name)
    .first<{ id: string }>();
  if (existing) return existing.id;
  const created = await createTag(db, { name });
  return created.id;
}

async function applyDiagnosisSideEffects(
  c: Context<Env>,
  definition: DiagnosisDefinition,
  result: DiagnosisResult,
  friend: Friend | null,
  submissionId: string,
  shareUrl: string,
): Promise<void> {
  const se = definition.sideEffects;
  if (!se || !friend) return;
  const db = c.env.DB;

  // 結果メッセージ(Flex)を本人に push
  if (se.sendResultMessage && friend.line_user_id) {
    try {
      const liffResultUrl = buildLiffResultUrl(definition.share?.liffUrl ?? '', submissionId);
      const flex = buildResultFlex({
        result,
        diagnosisName: definition.meta?.name ?? '',
        liffResultUrl,
        shareUrl,
      });
      const { LineClient } = await import('@line-crm/line-sdk');
      let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
      if (friend.line_account_id) {
        const account = await getLineAccountById(db, friend.line_account_id);
        if (account) accessToken = account.channel_access_token;
      }
      const lineClient = new LineClient(accessToken);
      await lineClient.pushMessage(friend.line_user_id, [flex]);
    } catch {
      /* 副作用失敗は submission を失敗にしない */
    }
  }

  // 悩みタグを friend タグとして付与(タグ自動作成 or 既存名マッチ)
  if (se.addTags) {
    try {
      for (const t of result.tags) {
        const tagId = await resolveTagIdByName(db, t.tag);
        if (tagId) await addTagToFriend(db, friend.id, tagId);
      }
    } catch {
      /* 副作用失敗は submission を失敗にしない */
    }
  }

  // シナリオ起動
  if (se.enrollScenarioId) {
    try {
      await enrollFriendInScenario(db, friend.id, se.enrollScenarioId);
    } catch {
      /* 副作用失敗は submission を失敗にしない */
    }
  }

  // friend メタデータに rank/score を保存
  if (se.saveToMetadata) {
    try {
      const existing = safeParse<Record<string, unknown>>(friend.metadata || '{}', {});
      const merged = { ...existing, diagnosis_rank: result.rank, diagnosis_score: result.totalScore };
      await db
        .prepare(`UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?`)
        .bind(JSON.stringify(merged), jstNow(), friend.id)
        .run();
    } catch {
      /* 副作用失敗は submission を失敗にしない */
    }
  }
}

// ── 管理系 API(既存 authMiddleware) ──────────────────────────────────────

// GET /api/diagnoses — 一覧(id, name, slug, is_active, submit_count, updated_at, 直近回答日時)
diagnoses.get('/api/diagnoses', async (c) => {
  try {
    const items = await getDiagnoses(c.env.DB);
    // 直近回答日時は 1 クエリで集約(N+1 回避)。
    const lastRows = await c.env.DB
      .prepare(
        `SELECT diagnosis_id, MAX(created_at) AS last_submitted_at
           FROM diagnosis_submissions GROUP BY diagnosis_id`,
      )
      .all<{ diagnosis_id: string; last_submitted_at: string | null }>();
    const lastMap = new Map(
      (lastRows.results ?? []).map((r) => [r.diagnosis_id, r.last_submitted_at]),
    );
    return c.json({
      success: true,
      data: items.map((row) => serializeDiagnosisListItem(row, lastMap.get(row.id) ?? null)),
    });
  } catch {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/diagnoses — 作成 { name, slug, definition }
diagnoses.post('/api/diagnoses', async (c) => {
  try {
    const body = await c.req
      .json<{ name?: string; slug?: string | null; definition?: unknown }>()
      .catch(() => ({}) as { name?: string; slug?: string | null; definition?: unknown });

    if (!body.name) {
      return c.json({ success: false, error: 'name is required' }, 400);
    }
    if (body.definition === undefined || body.definition === null) {
      return c.json({ success: false, error: 'definition is required' }, 400);
    }
    const definitionStr = JSON.stringify(body.definition);
    if (new TextEncoder().encode(definitionStr).length > DEFINITION_MAX_BYTES) {
      return c.json({ success: false, error: 'definition が大きすぎます(最大512KB)' }, 413);
    }
    const errors = validateDefinition(body.definition);
    if (errors.length > 0) {
      return c.json({ success: false, error: '定義が不正です', errors }, 400);
    }
    const created = await createDiagnosis(c.env.DB, {
      name: body.name,
      slug: body.slug ?? null,
      definition: definitionStr,
    });
    return c.json({ success: true, data: serializeDiagnosisDetail(created) }, 201);
  } catch {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/diagnoses/validate — 保存せず検証結果を返す(:id より先に登録)
diagnoses.post('/api/diagnoses/validate', async (c) => {
  try {
    const body = await c.req.json<{ definition?: unknown }>().catch(() => ({}) as { definition?: unknown });
    const errors = validateDefinition(body.definition);
    return c.json({ success: true, data: { valid: errors.length === 0, errors } });
  } catch {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/diagnoses/:id — 詳細(definition 含む)
diagnoses.get('/api/diagnoses/:id', async (c) => {
  try {
    const diag = await getDiagnosisById(c.env.DB, c.req.param('id'));
    if (!diag) return c.json({ success: false, error: 'Diagnosis not found' }, 404);
    return c.json({ success: true, data: serializeDiagnosisDetail(diag) });
  } catch {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/diagnoses/:id — 更新(definition 変更時は definition_version+1 = ヘルパー処理)
diagnoses.put('/api/diagnoses/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req
      .json<{ name?: string; slug?: string | null; isActive?: boolean; definition?: unknown }>()
      .catch(() => ({}) as { name?: string; slug?: string | null; isActive?: boolean; definition?: unknown });

    const updates: UpdateDiagnosisInput = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.slug !== undefined) updates.slug = body.slug;
    if (body.isActive !== undefined) updates.isActive = body.isActive;
    if (body.definition !== undefined) {
      const definitionStr = JSON.stringify(body.definition);
      if (new TextEncoder().encode(definitionStr).length > DEFINITION_MAX_BYTES) {
        return c.json({ success: false, error: 'definition が大きすぎます(最大512KB)' }, 413);
      }
      const errors = validateDefinition(body.definition);
      if (errors.length > 0) {
        return c.json({ success: false, error: '定義が不正です', errors }, 400);
      }
      updates.definition = definitionStr;
    }

    const updated = await updateDiagnosis(c.env.DB, id, updates);
    if (!updated) return c.json({ success: false, error: 'Diagnosis not found' }, 404);
    return c.json({ success: true, data: serializeDiagnosisDetail(updated) });
  } catch {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/diagnoses/:id — 削除(CASCADE で回答も消える)
diagnoses.delete('/api/diagnoses/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const diag = await getDiagnosisById(c.env.DB, id);
    if (!diag) return c.json({ success: false, error: 'Diagnosis not found' }, 404);
    await deleteDiagnosis(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/diagnoses/:id/preview — エンジン実行のみ(保存・副作用なし)
diagnoses.post('/api/diagnoses/:id/preview', async (c) => {
  try {
    const diag = await getDiagnosisById(c.env.DB, c.req.param('id'));
    if (!diag) return c.json({ success: false, error: 'Diagnosis not found' }, 404);
    const body = await c.req.json<{ answers?: DiagnosisAnswers }>().catch(() => ({}) as { answers?: DiagnosisAnswers });
    const definition = safeParse<DiagnosisDefinition | null>(diag.definition, null);
    if (!definition) return c.json({ success: false, error: '定義の読み込みに失敗しました' }, 500);
    let result: DiagnosisResult;
    try {
      result = runDiagnosis(definition, body.answers ?? {});
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message }, 400);
    }
    return c.json({ success: true, data: { result } });
  } catch {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/diagnoses/:id/submissions — 回答一覧(ページング, friend 名 JOIN)
diagnoses.get('/api/diagnoses/:id/submissions', async (c) => {
  try {
    const id = c.req.param('id');
    const diag = await getDiagnosisById(c.env.DB, id);
    if (!diag) return c.json({ success: false, error: 'Diagnosis not found' }, 404);

    const limitRaw = Number(c.req.query('limit'));
    const offsetRaw = Number(c.req.query('offset'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    const [items, total] = await Promise.all([
      getDiagnosisSubmissions(c.env.DB, id, limit, offset),
      countDiagnosisSubmissions(c.env.DB, id),
    ]);
    return c.json({
      success: true,
      data: items.map(serializeSubmissionSummary),
      pagination: { total, limit, offset },
    });
  } catch {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/diagnoses/:id/submissions/:sid — 回答詳細(answers + result)
diagnoses.get('/api/diagnoses/:id/submissions/:sid', async (c) => {
  try {
    const id = c.req.param('id');
    const sub = await getDiagnosisSubmissionById(c.env.DB, c.req.param('sid'));
    if (!sub || sub.diagnosis_id !== id) {
      return c.json({ success: false, error: 'Submission not found' }, 404);
    }
    return c.json({ success: true, data: serializeSubmissionDetail(sub) });
  } catch {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/diagnoses/:id/stats — result スナップショット走査で集計
diagnoses.get('/api/diagnoses/:id/stats', async (c) => {
  try {
    const id = c.req.param('id');
    const diag = await getDiagnosisById(c.env.DB, id);
    if (!diag) return c.json({ success: false, error: 'Diagnosis not found' }, 404);
    const definition = safeParse<DiagnosisDefinition | null>(diag.definition, null);
    if (!definition) return c.json({ success: false, error: '定義の読み込みに失敗しました' }, 500);
    const rows = await c.env.DB
      .prepare(`SELECT result FROM diagnosis_submissions WHERE diagnosis_id = ?`)
      .bind(id)
      .all<{ result: string }>();
    const stats = computeStats(definition, (rows.results ?? []).map((r) => r.result));
    return c.json({ success: true, data: stats });
  } catch {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── LIFF 系 API(idToken 検証。/api/liff/ は authMiddleware スキップ) ──────

// GET /api/liff/diagnoses/submissions/:sid — 本人のみ結果を返す(:slug より先に登録)
diagnoses.get('/api/liff/diagnoses/submissions/:sid', async (c) => {
  try {
    const callerLineUserId = await verifyCallerLineUserId(c.req.header('Authorization'), c.env);
    if (!callerLineUserId) return c.json({ error: 'unauthorized' }, 401);
    const sub = await getDiagnosisSubmissionById(c.env.DB, c.req.param('sid'));
    if (!sub) return c.json({ error: 'not_found' }, 404);
    if (sub.line_user_id !== callerLineUserId) return c.json({ error: 'forbidden' }, 403);
    const result = safeParse<Record<string, unknown>>(sub.result, {});
    const shareUrl = sub.share_token ? `${resolveShareBaseUrl(c)}/d/${sub.share_token}` : '';
    return c.json({ submissionId: sub.id, result, shareUrl });
  } catch {
    return c.json({ error: 'internal_error' }, 500);
  }
});

// GET /api/liff/diagnoses/:slug — 回答用定義(questions/axes/answerScale/meta のみ)
diagnoses.get('/api/liff/diagnoses/:slug', async (c) => {
  try {
    const diag = await getDiagnosisBySlug(c.env.DB, c.req.param('slug'));
    if (!diag || !diag.is_active) return c.json({ error: 'not_found' }, 404);
    const definition = safeParse<DiagnosisDefinition | null>(diag.definition, null);
    if (!definition) return c.json({ error: 'invalid_definition' }, 500);
    // scoring / recommendation / resultPage / share / sideEffects は返さない(価格戦略の秘匿)。
    return c.json({
      meta: definition.meta,
      axes: definition.axes,
      answerScale: definition.answerScale,
      questions: definition.questions,
    });
  } catch {
    return c.json({ error: 'internal_error' }, 500);
  }
});

// POST /api/liff/diagnoses/:slug/submissions — 採点・保存・副作用
diagnoses.post('/api/liff/diagnoses/:slug/submissions', async (c) => {
  try {
    const callerLineUserId = await verifyCallerLineUserId(c.req.header('Authorization'), c.env);
    if (!callerLineUserId) return c.json({ error: 'unauthorized' }, 401);

    const diag = await getDiagnosisBySlug(c.env.DB, c.req.param('slug'));
    if (!diag || !diag.is_active) return c.json({ error: 'not_found' }, 404);

    const definition = safeParse<DiagnosisDefinition | null>(diag.definition, null);
    if (!definition) return c.json({ error: 'invalid_definition' }, 500);

    const body = await c.req.json<{ answers?: DiagnosisAnswers }>().catch(() => ({}) as { answers?: DiagnosisAnswers });
    const answers = body.answers ?? {};

    let result: DiagnosisResult;
    try {
      result = runDiagnosis(definition, answers);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }

    const friend = await getFriendByLineUserId(c.env.DB, callerLineUserId);
    const shareToken = crypto.randomUUID();
    const submission = await createDiagnosisSubmission(c.env.DB, {
      diagnosisId: diag.id,
      friendId: friend?.id ?? null,
      lineUserId: callerLineUserId,
      definitionVersion: diag.definition_version,
      answers: JSON.stringify(answers),
      result: JSON.stringify(result),
      shareToken,
    });

    const shareUrl = `${resolveShareBaseUrl(c)}/d/${shareToken}`;

    // 副作用は失敗しても submission を成功扱いにする(spec: try-catch で握りつぶす)。
    try {
      await applyDiagnosisSideEffects(c, definition, result, friend, submission.id, shareUrl);
    } catch {
      /* 副作用失敗は無視 */
    }

    return c.json({ submissionId: submission.id, result, shareUrl });
  } catch {
    return c.json({ error: 'internal_error' }, 500);
  }
});

export { diagnoses };
