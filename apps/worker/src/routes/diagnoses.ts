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
  getDiagnosisSubmissionByShareToken,
  getDiagnosisSubmissionByRequestId,
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
  DiagnosisIntro,
  DiagnosisIntroRankPreview,
  DiagnosisResult,
} from '@line-crm/shared';
import { runDiagnosis } from '../services/diagnosis/engine.js';
import { validateDefinition } from '../services/diagnosis/validate.js';
import { buildResultFlex } from '../services/diagnosis/flex.js';
import { isHttpsUrl } from '../services/diagnosis/url.js';
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

/**
 * LIFF 定義API に返す intro を許可フィールドだけで再構築する。
 *
 * definition.intro をそのまま返すと、定義に未知キー(原価・配点 等)を入れた場合に
 * 無検査で公開されてしまう。バリデータは未知キーを拒否しないため、ここが
 * 「何を公開するか」の唯一の門になる。型が合わない値は落とす(エラーにしない)。
 */
function pickIntroForLiff(input: unknown): DiagnosisIntro | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const src = input as Record<string, unknown>;
  const intro: DiagnosisIntro = {};

  if (typeof src.catchCopy === 'string') intro.catchCopy = src.catchCopy;
  if (typeof src.subCopy === 'string') intro.subCopy = src.subCopy;
  if (Array.isArray(src.aboutLines)) {
    intro.aboutLines = src.aboutLines.filter((l): l is string => typeof l === 'string');
  }

  if (Array.isArray(src.rankPreview)) {
    const rows: DiagnosisIntroRankPreview[] = [];
    for (const rowRaw of src.rankPreview) {
      if (typeof rowRaw !== 'object' || rowRaw === null || Array.isArray(rowRaw)) continue;
      const r = rowRaw as Record<string, unknown>;
      if (typeof r.rank !== 'string' || typeof r.title !== 'string') continue;
      const row: DiagnosisIntroRankPreview = { rank: r.rank, title: r.title };
      if (typeof r.subcopy === 'string') row.subcopy = r.subcopy;
      if (typeof r.minScore === 'number' && Number.isFinite(r.minScore)) row.minScore = r.minScore;
      if (isHttpsUrl(r.imageUrl)) row.imageUrl = r.imageUrl;
      rows.push(row);
    }
    intro.rankPreview = rows;
  }

  if (typeof src.heroImages === 'object' && src.heroImages !== null && !Array.isArray(src.heroImages)) {
    const images: Record<string, string> = {};
    for (const [rank, url] of Object.entries(src.heroImages as Record<string, unknown>)) {
      if (isHttpsUrl(url)) images[rank] = url;
    }
    intro.heroImages = images;
  }

  return intro;
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

/** definition.share.liffUrl から liffId を抜き、結果ページ LIFF URL を組む。
 *  liffId が抽出できない(空文字・liff.line.me/{liffId} 形式でない)なら null を返し、
 *  呼び出し側は壊れた URL のメッセージ送信をスキップする。 */
function buildLiffResultUrl(shareLiffUrl: string, submissionId: string): string | null {
  // 先頭が https://liff.line.me/{liffId} の形のときだけ liffId を採る(validate.ts と統一)。
  const m = shareLiffUrl.match(/^https:\/\/liff\.line\.me\/([^/?#]+)/);
  if (!m || !m[1]) return null;
  return `https://liff.line.me/${m[1]}/diagnosis/result/${submissionId}`;
}

/** D1 の UNIQUE 制約違反かどうか(並行 INSERT の検出用)。 */
function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed/i.test(msg);
}

/** 保存済み submission を副作用なしでそのまま返す(冪等再送・並行 INSERT 用)。 */
function savedSubmissionResponse(c: Context<Env>, sub: DiagnosisSubmission) {
  const result = safeParse<Record<string, unknown>>(sub.result, {});
  const shareUrl = sub.share_token ? `${resolveShareBaseUrl(c)}/d/${sub.share_token}` : '';
  return c.json({ submissionId: sub.id, result, shareUrl });
}

// ── 公開シェアページ (07_share-og.md / 決定 D4・D7) ─────────────────────────────
// 表示は result スナップショットのみで行う(definition 非依存)。CTA 遷移先・有効
// 判定・OG 画像 URL/タイトルテンプレートだけを definition.share から読む(07 の
// 「definition 非依存」は表示内容の原則であり、CTA/OG メタは share 設定からしか
// 取得できないため)。D7: 公開ページに出すのは rank / rankTitle / totalScore /
// 軸の◎○△ のみ。悩みタグ・カード・価格・axisMessages・cleanPoints・answers は
// 一切出さない(result JSON の丸ごと埋め込みも禁止 — 必要フィールドだけを展開)。

/** HTML エスケープ(属性・テキスト文脈両対応)。全動的値に適用する。 */
function escapeShareHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncateShare(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * ランク別のヒーロー配色(D→S)。band は LIFF 結果ページ(diagnosis-theme の
 * RANK_BAND_COLORS)と同値で、ランク画像の下地と揃えて地続きに見せる。
 * 淡い地色では白文字が読めないため、text/chip/shadow もランクごとに持つ。
 */
const SHARE_RANK_THEME: Record<
  string,
  { band: string; text: string; chip: string; shadow: string }
> = {
  D: { band: '#BFC4CF', text: '#1f2430', chip: 'rgba(31,36,48,0.10)', shadow: 'rgba(0,0,0,0)' },
  C: { band: '#BED2D0', text: '#1f2430', chip: 'rgba(31,36,48,0.10)', shadow: 'rgba(0,0,0,0)' },
  B: { band: '#DFEECC', text: '#1f2430', chip: 'rgba(31,36,48,0.10)', shadow: 'rgba(0,0,0,0)' },
  A: { band: '#A7B6EC', text: '#1f2430', chip: 'rgba(31,36,48,0.10)', shadow: 'rgba(0,0,0,0)' },
  S: { band: '#53535A', text: '#ffffff', chip: 'rgba(255,255,255,0.22)', shadow: 'rgba(0,0,0,0.18)' },
};
const SHARE_DEFAULT_THEME = SHARE_RANK_THEME.D;

/** grade → 記号・ラベル・色(DiagnosisResultView / flex と同じ固定ビジュアル)。 */
const SHARE_GRADE_DISPLAY: Record<string, { symbol: string; label: string; color: string }> = {
  keep: { symbol: '◎', label: 'キープ', color: '#16a34a' },
  almost: { symbol: '○', label: 'あと少し', color: '#ca8a04' },
  warn: { symbol: '△', label: '要注意', color: '#dc2626' },
};

/** ogTitleTemplate の {score}/{rankTitle} を展開。置換は関数レプレーサで $ の特殊解釈を回避。 */
function expandShareTitle(template: string, score: number, rankTitle: string): string {
  return template
    .replace(/\{score\}/g, () => String(score))
    .replace(/\{rankTitle\}/g, () => rankTitle);
}

/** 公開ページに渡す最小ビュー(D7 で許可された値のみ)。result JSON は渡さない。 */
interface SharePageView {
  rank: string;
  rankTitle: string;
  totalScore: number;
  axes: Array<{ label: string; grade: string; score: number | null }>;
  diagnosisName: string | null;
  minorNotice: string | null;
  ogTitle: string; // 展開済み(未エスケープ)
  ogDescription: string | null;
  ogImage: string | null; // 空文字/未設定は null(og:image を出さない)
  ctaUrl: string | null; // null なら「自分も診断する」ボタン非表示
  rankImageUrl: string | null; // https:// のランク画像。null なら現行のランク文字ヒーロー
  pageUrl: string;
}

/** 公開シェアページの完全な HTML を組み立てる(スマホ縦画面前提・インライン CSS)。 */
function buildSharePageHtml(v: SharePageView): string {
  const theme = SHARE_RANK_THEME[v.rank] ?? SHARE_DEFAULT_THEME;
  const title = escapeShareHtml(truncateShare(v.ogTitle, 80));
  const rank = escapeShareHtml(v.rank);
  const rankTitle = escapeShareHtml(v.rankTitle);
  const url = escapeShareHtml(v.pageUrl);

  const ogDesc = v.ogDescription?.trim()
    ? escapeShareHtml(truncateShare(v.ogDescription.trim(), 200))
    : null;
  const ogImg = v.ogImage?.trim() ? escapeShareHtml(v.ogImage.trim()) : null;

  const metaLines: string[] = [
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${url}">`,
  ];
  if (ogDesc) {
    metaLines.push(`<meta property="og:description" content="${ogDesc}">`);
    metaLines.push(`<meta name="description" content="${ogDesc}">`);
  }
  if (ogImg) metaLines.push(`<meta property="og:image" content="${ogImg}">`);
  metaLines.push(`<meta name="twitter:card" content="summary_large_image">`);

  const axisRows = v.axes
    .map((a) => {
      const g = SHARE_GRADE_DISPLAY[a.grade] ?? { symbol: '', label: '', color: '#6b7280' };
      const scoreCell =
        a.score !== null
          ? `<span class="ax-score">${escapeShareHtml(a.score.toFixed(1))}</span>`
          : '';
      return `<li class="ax-row"><span class="ax-label">${escapeShareHtml(a.label)}</span><span class="ax-right"><span class="ax-grade" style="color:${g.color}">${g.symbol} ${escapeShareHtml(g.label)}</span>${scoreCell}</span></li>`;
    })
    .join('');

  // ランク画像(https:// のみ route 側で通過済み)。alt は診断非依存の汎用文言。
  const rankImg = v.rankImageUrl
    ? `<img class="rank-img" src="${escapeShareHtml(v.rankImageUrl)}" alt="ランク ${rank}" width="180" height="180">`
    : '';

  const ctaBlock = v.ctaUrl
    ? `<a class="cta" href="${escapeShareHtml(v.ctaUrl)}">自分も診断する</a>`
    : '';

  const footName = v.diagnosisName
    ? `<p class="foot-name">${escapeShareHtml(v.diagnosisName)}</p>`
    : '';
  const footNote = v.minorNotice
    ? `<p class="foot-note">${escapeShareHtml(v.minorNotice)}</p>`
    : '';
  const footBlock = footName || footNote ? `<footer class="foot">${footName}${footNote}</footer>` : '';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
${metaLines.join('\n')}
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Helvetica Neue',system-ui,sans-serif;background:#f5f7f5;color:#1f2937;min-height:100vh;padding:20px 16px}
.wrap{max-width:420px;margin:0 auto;display:flex;flex-direction:column;gap:20px}
.hero{border-radius:20px;padding:32px 24px;text-align:center;box-shadow:0 2px 20px rgba(0,0,0,0.08)}
.rank-img{display:block;width:180px;max-width:64%;height:auto;aspect-ratio:1/1;margin:0 auto 14px;border-radius:16px;object-fit:contain}
.rank{font-size:72px;font-weight:900;line-height:1;text-shadow:0 2px 8px var(--rank-shadow,rgba(0,0,0,0.18))}
.rank-title{margin-top:12px;font-size:18px;font-weight:700}
.score{margin-top:14px;display:inline-block;border-radius:999px;background:var(--chip,rgba(255,255,255,0.22));padding:6px 18px;font-size:14px;font-weight:600}
.axes{background:#fff;border-radius:16px;border:1px solid rgba(0,0,0,0.05);overflow:hidden}
.ax-list{list-style:none}
.ax-row{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #f1f3f4}
.ax-row:last-child{border-bottom:none}
.ax-label{font-size:14px;font-weight:500;color:#374151}
.ax-right{display:flex;align-items:center;gap:10px}
.ax-grade{font-size:14px;font-weight:700}
.ax-score{min-width:34px;text-align:right;font-size:14px;color:#6b7280;font-variant-numeric:tabular-nums}
.cta{display:block;width:100%;padding:16px;border-radius:12px;background:#06C755;color:#fff;font-size:16px;font-weight:700;text-align:center;text-decoration:none;box-shadow:0 2px 12px rgba(6,199,85,0.2)}
.foot{text-align:center;color:#9ca3af}
.foot-name{font-size:12px;font-weight:500}
.foot-note{margin-top:6px;font-size:11px;line-height:1.6}
</style>
</head>
<body>
<main class="wrap">
<section class="hero" style="background:${theme.band};color:${theme.text};--chip:${theme.chip};--rank-shadow:${theme.shadow}">
${rankImg}
<div class="rank">${rank}</div>
<div class="rank-title">${rankTitle}</div>
<div class="score">スコア ${v.totalScore}点</div>
</section>
<section class="axes"><ul class="ax-list">${axisRows}</ul></section>
${ctaBlock}
${footBlock}
</main>
</body>
</html>`;
}

/** 404・エラー時の簡素な HTML(内部情報を一切出さない)。 */
function buildShareNotFoundHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ページが見つかりません</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Hiragino Sans','Helvetica Neue',system-ui,sans-serif;background:#f5f7f5;color:#6b7280;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}p{font-size:15px;text-align:center}</style>
</head>
<body><p>お探しのページは見つかりませんでした</p></body>
</html>`;
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

  // 結果メッセージ(Flex)を本人に push。liffId が抽出できない liffUrl のときは
  // 壊れた結果ボタンを送らないよう push 自体をスキップする(他の副作用は継続)。
  if (se.sendResultMessage && friend.line_user_id) {
    try {
      const liffResultUrl = buildLiffResultUrl(definition.share?.liffUrl ?? '', submissionId);
      if (liffResultUrl) {
        // 予約導線は result.booking(スナップショット)を buildResultFlex が直接見る。
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
      }
    } catch {
      /* 副作用失敗は submission を失敗にしない */
    }
  }

  // 悩みタグを friend タグとして付与。タグ名を一括 SELECT(N+1 回避)→ 不足分のみ作成 → 付与。
  // 各タグは独立に処理し、1個の失敗(並行作成の UNIQUE 違反など)で他タグの付与は止めない。
  if (se.addTags && result.tags.length > 0) {
    const names = [...new Set(result.tags.map((t) => t.tag))];
    const idByName = new Map<string, string>();
    try {
      const placeholders = names.map(() => '?').join(', ');
      const existing = await db
        .prepare(`SELECT id, name FROM tags WHERE name IN (${placeholders})`)
        .bind(...names)
        .all<{ id: string; name: string }>();
      for (const r of existing.results ?? []) idByName.set(r.name, r.id);
    } catch {
      /* 一括 SELECT 失敗は握りつぶす(各タグを個別に作成/引き直す) */
    }
    for (const name of names) {
      try {
        let tagId = idByName.get(name);
        if (!tagId) {
          try {
            tagId = (await createTag(db, { name })).id;
          } catch {
            // 並行作成で UNIQUE 違反 → 既存を引き直して続行。引けなければこのタグはスキップ。
            const row = await db
              .prepare(`SELECT id FROM tags WHERE name = ? LIMIT 1`)
              .bind(name)
              .first<{ id: string }>();
            tagId = row?.id;
          }
        }
        if (tagId) await addTagToFriend(db, friend.id, tagId);
      } catch {
        /* このタグだけスキップし、残りのタグ処理は継続 */
      }
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
    // intro は診断前画面の表示専用ブロック。そのまま返さず許可フィールドのみ再構築する。
    const intro = definition.intro === undefined ? null : pickIntroForLiff(definition.intro);
    return c.json({
      meta: definition.meta,
      axes: definition.axes,
      answerScale: definition.answerScale,
      questions: definition.questions,
      ...(intro ? { intro } : {}),
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

    const body = await c.req
      .json<{ answers?: DiagnosisAnswers; requestId?: unknown }>()
      .catch(() => ({}) as { answers?: DiagnosisAnswers; requestId?: unknown });
    const answers = body.answers ?? {};

    // requestId: キー無し → 従来動作(冪等キーなし)。存在するが不正な値(空文字・
    // 65文字以上・非文字列)は 400(冪等性が静かに無効化されるのを防ぐ)。
    let requestId: string | null = null;
    if (body.requestId !== undefined) {
      if (
        typeof body.requestId !== 'string' ||
        body.requestId.length === 0 ||
        body.requestId.length > 64
      ) {
        return c.json({ error: 'invalid_request_id' }, 400);
      }
      requestId = body.requestId;
    }

    // 冪等: requestId 既存なら採点・保存・副作用を行わず保存済み結果を返す(再送対策)。
    // 本人不一致は 409(他人の requestId 再利用を弾く)。
    if (requestId) {
      const existing = await getDiagnosisSubmissionByRequestId(c.env.DB, diag.id, requestId);
      if (existing) {
        if (existing.line_user_id !== callerLineUserId) return c.json({ error: 'conflict' }, 409);
        return savedSubmissionResponse(c, existing);
      }
    }

    let result: DiagnosisResult;
    try {
      result = runDiagnosis(definition, answers);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }

    const friend = await getFriendByLineUserId(c.env.DB, callerLineUserId);
    const shareToken = crypto.randomUUID();
    let submission: DiagnosisSubmission;
    try {
      submission = await createDiagnosisSubmission(c.env.DB, {
        diagnosisId: diag.id,
        friendId: friend?.id ?? null,
        lineUserId: callerLineUserId,
        definitionVersion: diag.definition_version,
        answers: JSON.stringify(answers),
        result: JSON.stringify(result),
        shareToken,
        requestId,
      });
    } catch (e) {
      // 並行リクエストで UNIQUE(request_id) 違反 → 既存を引き直して副作用なしで返す。
      if (requestId && isUniqueViolation(e)) {
        const existing = await getDiagnosisSubmissionByRequestId(c.env.DB, diag.id, requestId);
        if (existing) {
          if (existing.line_user_id !== callerLineUserId) return c.json({ error: 'conflict' }, 409);
          return savedSubmissionResponse(c, existing);
        }
      }
      throw e;
    }

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

// ── 公開シェアページ(認証なし。/api/ 以外なので authMiddleware は skip される) ──

// GET /d/:shareToken — Worker が完結した HTML を返す(07_share-og.md)。
// 表示は result スナップショットのみ。CTA/OG メタだけ definition.share から読む。
// キャッシュ: 結果は不変なので public, max-age=300。
diagnoses.get('/d/:shareToken', async (c) => {
  try {
    const shareToken = c.req.param('shareToken');
    const submission = await getDiagnosisSubmissionByShareToken(c.env.DB, shareToken);
    if (!submission) return c.html(buildShareNotFoundHtml(), 404);

    const result = safeParse<DiagnosisResult | null>(submission.result, null);
    if (!result || typeof result.rank !== 'string') {
      return c.html(buildShareNotFoundHtml(), 404);
    }

    // CTA 遷移先・有効判定・OG 画像/タイトルテンプレートだけ definition から読む
    // (表示内容は snapshot のみ)。診断が削除済み等で引けなくても表示は継続する。
    const diagnosis = await getDiagnosisById(c.env.DB, submission.diagnosis_id);
    const definition = diagnosis
      ? safeParse<DiagnosisDefinition | null>(diagnosis.definition, null)
      : null;
    const share = definition?.share ?? null;

    // share.enabled === false は共有機能無効の意思表示 → 404(07 に明記なし・委譲解釈)。
    if (share && share.enabled === false) {
      return c.html(buildShareNotFoundHtml(), 404);
    }

    // is_active=0 は表示継続・CTA だけ非表示(07)。CTA 遷移先は share.liffUrl。
    const ctaUrl =
      diagnosis && diagnosis.is_active && share?.liffUrl?.trim() ? share.liffUrl.trim() : null;

    // OG 画像は該当ランクの URL。空文字/未設定なら og:image を出さない。
    const rawOgImage = share?.ogImages?.[result.rank];
    const ogImage =
      typeof rawOgImage === 'string' && rawOgImage.trim() ? rawOgImage.trim() : null;

    // R6: スナップショット由来のランク画像。https:// のみヒーローに表示(定義非依存)。
    const rawRankImage = typeof result.rankImageUrl === 'string' ? result.rankImageUrl.trim() : '';
    const rankImageUrl = rawRankImage.startsWith('https://') ? rawRankImage : null;

    const safeScore = typeof result.totalScore === 'number' ? result.totalScore : 0;
    const safeRankTitle = typeof result.rankTitle === 'string' ? result.rankTitle : '';
    const ogTitleTemplate = share?.ogTitleTemplate?.trim();
    const ogTitle = ogTitleTemplate
      ? expandShareTitle(ogTitleTemplate, safeScore, safeRankTitle)
      : `${safeRankTitle}・スコア${safeScore}点`;

    const view: SharePageView = {
      rank: result.rank,
      rankTitle: safeRankTitle,
      totalScore: safeScore,
      axes: (result.axisScores ?? []).map((a) => ({
        label: typeof a?.label === 'string' ? a.label : '',
        grade: typeof a?.grade === 'string' ? a.grade : '',
        score: typeof a?.score === 'number' ? a.score : null,
      })),
      diagnosisName: typeof result.diagnosisName === 'string' ? result.diagnosisName : null,
      minorNotice: typeof result.minorNotice === 'string' ? result.minorNotice : null,
      ogTitle,
      ogDescription: share?.ogDescription?.trim() ? share.ogDescription : null,
      ogImage,
      ctaUrl,
      rankImageUrl,
      pageUrl: `${resolveShareBaseUrl(c)}/d/${shareToken}`,
    };

    return c.html(buildSharePageHtml(view), 200, { 'Cache-Control': 'public, max-age=300' });
  } catch {
    // 公開エンドポイント: 内部情報(スタックトレース等)を出さず簡素な HTML を返す。
    return c.html(buildShareNotFoundHtml(), 500);
  }
});

export { diagnoses };
