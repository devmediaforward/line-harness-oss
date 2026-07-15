import liff from '@line/liff';
import { useState } from 'react';
import type {
  DiagnosisResult,
  DiagnosisResultAxisScore,
  DiagnosisResultWeakPoint,
  DiagnosisGradeKey,
} from '../lib/api.js';

// =============================================================================
// 診断 結果表示（画面3）— Diagnosis.tsx（回答直後）と DiagnosisResult.tsx（再表示）
// で共用する。描画は result スナップショットのみに依存する（definition を再取得
// しない）。スナップショットに含まれない表示文言（grade ラベル・見出し・emptyState
// 文言・ソフトCTA・未成年注記）は診断固有語を避けた汎用文言のコンポーネント定数
// として持つ。
// =============================================================================

// ── ランク別アクセント配色（D→S）。MBTI風にシェアしたくなる見た目優先。 ──────
interface RankTheme {
  gradient: string;
  accent: string;
}
const RANK_THEME: Record<string, RankTheme> = {
  D: { gradient: 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)', accent: '#6b7280' },
  C: { gradient: 'linear-gradient(135deg, #d08a52 0%, #9a5a2c 100%)', accent: '#a15c2f' },
  B: { gradient: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)', accent: '#2563eb' },
  A: { gradient: 'linear-gradient(135deg, #a78bfa 0%, #6d28d9 100%)', accent: '#7c3aed' },
  S: { gradient: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', accent: '#c2760a' },
};
const DEFAULT_THEME: RankTheme = RANK_THEME.D;

// ── ◎○△ の表示（grade ラベルは definition 由来でスナップショットに無いため定数） ─
const GRADE_DISPLAY: Record<DiagnosisGradeKey, { symbol: string; label: string; color: string }> = {
  keep: { symbol: '◎', label: 'キープ', color: '#16a34a' },
  almost: { symbol: '○', label: 'あと少し', color: '#ca8a04' },
  warn: { symbol: '△', label: '要注意', color: '#dc2626' },
};

// ── 汎用見出し・文言（definition 由来でスナップショットに無いため定数） ─────────
const WEAK_POINT_HEADING = '今いちばん効くポイント';
const RECOMMEND_HEADING = 'あなたへのおすすめ';
const EMPTY_STATE_MESSAGE =
  '今のあなたに、特に必要なケアは見つかりませんでした。この調子をキープしていきましょう。';
const SOFT_CTA_TEXT = '気になるところがあれば、いつでも相談してくださいね。';
const SOFT_CTA_SUBTEXT = 'まずは気軽にメッセージからどうぞ。';
const MINOR_NOTICE = '18歳未満の方のご契約には保護者の同意が必要です。';

// ── レーダー正規化ドメイン。清潔感ポイントは 1..5（shared の DiagnosisResult 準拠）。
//    スナップショットに answerScale が無いためこの定数で正規化する。 ───────────
const RADAR_MIN = 1;
const RADAR_MAX = 5;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function polar(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  const a = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

// ── SVG 自前レーダー（軸数は axisScores.length に追従。追加依存なし） ───────────
function RadarChart({ axes, accent }: { axes: DiagnosisResultAxisScore[]; accent: string }) {
  const size = 300;
  const cx = size / 2;
  const cy = size / 2;
  const r = 88;
  const n = axes.length;
  const angleFor = (i: number) => -90 + (360 / n) * i;
  const norm = (score: number) => clamp01((score - RADAR_MIN) / (RADAR_MAX - RADAR_MIN));

  const rings = [0.25, 0.5, 0.75, 1];
  const ringPoints = (level: number) =>
    axes
      .map((_, i) => {
        const p = polar(cx, cy, r * level, angleFor(i));
        return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      })
      .join(' ');

  const dataPoints = axes
    .map((a, i) => {
      const p = polar(cx, cy, r * norm(a.score), angleFor(i));
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="w-full max-w-[300px] mx-auto block" role="img" aria-label="軸別スコアのレーダーチャート">
      {rings.map((level) => (
        <polygon key={level} points={ringPoints(level)} fill="none" stroke="#e5e7eb" strokeWidth={1} />
      ))}
      {axes.map((_, i) => {
        const p = polar(cx, cy, r, angleFor(i));
        return <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#e5e7eb" strokeWidth={1} />;
      })}
      <polygon points={dataPoints} fill={accent} fillOpacity={0.22} stroke={accent} strokeWidth={2} strokeLinejoin="round" />
      {axes.map((a, i) => {
        const p = polar(cx, cy, r * norm(a.score), angleFor(i));
        return <circle key={a.axisId} cx={p.x} cy={p.y} r={3} fill={accent} />;
      })}
      {axes.map((a, i) => {
        const p = polar(cx, cy, r + 20, angleFor(i));
        const c = Math.cos((angleFor(i) * Math.PI) / 180);
        const anchor = Math.abs(c) < 0.3 ? 'middle' : c > 0 ? 'start' : 'end';
        return (
          <text
            key={a.axisId}
            x={p.x}
            y={p.y}
            textAnchor={anchor}
            dominantBaseline="middle"
            fontSize={12}
            fontWeight={600}
            fill="#374151"
          >
            {a.label}
          </text>
        );
      })}
    </svg>
  );
}

// ── クリップボードコピー（LIFF WebView 向けフォールバック付き） ─────────────────
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return true;
  } catch {
    // fall through
  }
  return false;
}

function ShareButtons({ result, shareUrl }: { result: DiagnosisResult; shareUrl: string }) {
  const [notice, setNotice] = useState<string | null>(null);
  const shareMessage = `診断結果は「${result.rankTitle}」（${result.rank}ランク・${result.totalScore}点）でした！`;

  function flash(msg: string) {
    setNotice(msg);
    setTimeout(() => setNotice(null), 2000);
  }

  async function handleLineShare() {
    try {
      if (liff.isApiAvailable('shareTargetPicker')) {
        await liff.shareTargetPicker([{ type: 'text', text: `${shareMessage}\n${shareUrl}` }]);
        return;
      }
    } catch {
      // 非対応・キャンセル時は URL コピーにフォールバック
    }
    const ok = await copyText(shareUrl);
    flash(ok ? 'リンクをコピーしました' : 'コピーできませんでした');
  }

  async function handleCopy() {
    const ok = await copyText(shareUrl);
    flash(ok ? 'リンクをコピーしました' : 'コピーできませんでした');
  }

  return (
    <div className="space-y-2">
      <button onClick={handleLineShare} className="af-primary-btn">
        LINEでシェア
      </button>
      <button onClick={handleCopy} className="af-secondary-btn">
        リンクをコピー
      </button>
      {notice && <p className="text-center text-xs text-gray-500">{notice}</p>}
    </div>
  );
}

export default function DiagnosisResultView({
  result,
  shareUrl,
}: {
  result: DiagnosisResult;
  shareUrl: string;
}) {
  const theme = RANK_THEME[result.rank] ?? DEFAULT_THEME;

  // 表示文言はスナップショット（definition 由来を焼き込み済み）を優先し、
  // 無い場合（旧スナップショット等）のみ汎用定数へフォールバックする。
  const weakPoints: DiagnosisResultWeakPoint[] =
    result.weakPoints ??
    result.weakestAxes
      .map((id) => result.axisScores.find((a) => a.axisId === id))
      .filter((a): a is DiagnosisResultAxisScore => !!a && a.grade === 'warn')
      .map((a) => ({ axisId: a.axisId, label: a.label, text: null }));

  const weakPointHeading = result.weakPointHeading ?? WEAK_POINT_HEADING;
  const softCta = result.softCta ?? { text: SOFT_CTA_TEXT, subText: SOFT_CTA_SUBTEXT };
  const minorNotice = result.minorNotice ?? MINOR_NOTICE;
  const emptyStateTexts = result.emptyStateTexts ?? { message: EMPTY_STATE_MESSAGE };

  return (
    <div className="space-y-6">
      {result.diagnosisName && (
        <p className="text-center text-xs font-medium text-gray-400">{result.diagnosisName}</p>
      )}

      {/* 1. ヒーロー: 総合ランク */}
      <section className="rounded-2xl px-6 py-7 text-center text-white" style={{ background: theme.gradient }}>
        <div className="text-7xl font-black leading-none" style={{ textShadow: '0 2px 8px rgba(0,0,0,0.18)' }}>
          {result.rank}
        </div>
        <div className="mt-3 text-lg font-bold">{result.rankTitle}</div>
        <div className="mt-3 inline-block rounded-full bg-white/20 px-4 py-1 text-sm font-semibold">
          あなたのスコアは {result.totalScore}点！
        </div>
        {result.rankSubcopy && (
          <p className="mt-3 text-sm leading-relaxed opacity-95 whitespace-pre-wrap">{result.rankSubcopy}</p>
        )}
      </section>

      {/* 2. レーダーチャート + ◎○△ 一覧 */}
      <section className="space-y-3">
        <RadarChart axes={result.axisScores} accent={theme.accent} />
        <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100">
          {result.axisScores.map((a) => {
            const g = GRADE_DISPLAY[a.grade];
            return (
              <li key={a.axisId} className="flex items-center justify-between px-4 py-2.5">
                <span className="text-sm font-medium text-gray-800">{a.label}</span>
                <span className="flex items-center gap-2">
                  <span className="text-sm font-bold" style={{ color: g.color }}>
                    {g.symbol} {g.label}
                  </span>
                  <span className="w-10 text-right text-sm tabular-nums text-gray-500">{a.score.toFixed(1)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {/* 3. 今いちばん効くポイント（△ 軸を弱点順に列挙） */}
      {weakPoints.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-base font-bold text-gray-900">{weakPointHeading}</h2>
          <ul className="space-y-2">
            {weakPoints.map((w) => (
              <li key={w.axisId} className="rounded-xl bg-red-50 px-4 py-3 text-sm text-gray-800">
                <div className="flex items-center gap-2 font-medium">
                  <span className="font-bold" style={{ color: GRADE_DISPLAY.warn.color }}>
                    {GRADE_DISPLAY.warn.symbol}
                  </span>
                  {w.label}
                </div>
                {w.text && <p className="mt-1 text-xs leading-relaxed text-gray-600">{w.text}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 4. ランク別の結果文章 */}
      {result.rankBody && (
        <section>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{result.rankBody}</p>
        </section>
      )}

      {/* 5. あなたへのおすすめ（cards / axisMessages / emptyState） */}
      <section className="space-y-3">
        <h2 className="text-base font-bold text-gray-900">{RECOMMEND_HEADING}</h2>
        {result.emptyState ? (
          <div className="rounded-xl bg-gray-50 px-4 py-5 text-center">
            <p className="text-sm leading-relaxed text-gray-700">{emptyStateTexts.message}</p>
            {emptyStateTexts.cta && <p className="mt-2 text-xs text-gray-500">{emptyStateTexts.cta}</p>}
          </div>
        ) : (
          <>
            {result.cards.map((card, idx) => (
              <div key={`${card.axisId}-${idx}`} className="af-card space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-base font-bold text-gray-900">{card.title}</h3>
                  {card.extras.length > 0 && (
                    <span
                      className="af-badge shrink-0"
                      style={{ background: '#ecfdf5', color: '#06c755' }}
                    >
                      {card.extras.join('・')}もまとめてケア
                    </span>
                  )}
                </div>
                <div className="text-lg font-black text-gray-900">
                  ¥{card.priceInTax.toLocaleString()}(税込){card.priceSuffix === '＋' ? '〜' : ''}
                </div>
                {card.reason && <p className="text-sm leading-relaxed text-gray-700">{card.reason}</p>}
                {card.appeal && <p className="text-sm leading-relaxed text-gray-700">{card.appeal}</p>}
                {card.notes.length > 0 && (
                  <ul className="space-y-0.5">
                    {card.notes.map((note, i) => (
                      <li key={i} className="text-xs leading-relaxed text-gray-400">
                        {note}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {result.axisMessages.map((m) => (
              <div key={m.axisId} className="rounded-xl border border-gray-100 px-4 py-3 text-sm leading-relaxed text-gray-700">
                {m.message}
              </div>
            ))}
          </>
        )}
      </section>

      {/* 6. ソフトCTA（押し売り禁止） */}
      <section className="rounded-xl bg-gray-50 px-4 py-4 text-center">
        <p className="text-sm font-semibold text-gray-800">{softCta.text}</p>
        {softCta.subText && <p className="mt-1 text-xs text-gray-500">{softCta.subText}</p>}
      </section>

      {/* 7. 未成年向け注記 */}
      <p className="text-center text-xs leading-relaxed text-gray-400">{minorNotice}</p>

      {/* 8. シェア */}
      <ShareButtons result={result} shareUrl={shareUrl} />
    </div>
  );
}
