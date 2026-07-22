import liff from '@line/liff';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  DiagnosisResult,
  DiagnosisResultAxisScore,
  DiagnosisResultWeakPoint,
  DiagnosisGradeKey,
} from '../lib/api.js';
import { prefersReducedMotion } from '../lib/motion.js';

// =============================================================================
// 診断 結果表示（画面3）— Diagnosis.tsx（回答直後）と DiagnosisResult.tsx（再表示）
// で共用する。描画は result スナップショットのみに依存する（definition を再取得
// しない）。スナップショットに含まれない表示文言（grade ラベル・見出し・emptyState
// 文言・ソフトCTA・未成年注記）は診断固有語を避けた汎用文言のコンポーネント定数
// として持つ。UI は dx-* スコープのダーク基調テーマ + 初回表示の演出（R1〜R6）。
// =============================================================================

// ── ランク別アクセント配色（D→S）。ヒーロー背景グラデ + レーダー配色に使う。 ──
interface RankTheme {
  gradient: string;
  accent: string;
}
const RANK_THEME: Record<string, RankTheme> = {
  D: { gradient: 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)', accent: '#9ca3af' },
  C: { gradient: 'linear-gradient(135deg, #d08a52 0%, #9a5a2c 100%)', accent: '#d9975f' },
  B: { gradient: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)', accent: '#60a5fa' },
  A: { gradient: 'linear-gradient(135deg, #a78bfa 0%, #6d28d9 100%)', accent: '#a78bfa' },
  S: { gradient: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', accent: '#fbbf24' },
};
const DEFAULT_THEME: RankTheme = RANK_THEME.D;

// ── ◎○△ の表示（grade ラベルは definition 由来でスナップショットに無いため定数） ─
//    ダーク背景で視認できる明るめの配色にする。
const GRADE_DISPLAY: Record<DiagnosisGradeKey, { symbol: string; label: string; color: string }> = {
  keep: { symbol: '◎', label: 'キープ', color: '#34d399' },
  almost: { symbol: '○', label: 'あと少し', color: '#fbbf24' },
  warn: { symbol: '△', label: '要注意', color: '#fb7185' },
};

// ── 汎用見出し・文言（definition 由来でスナップショットに無いため定数） ─────────
const WEAK_POINT_HEADING = '今いちばん効くポイント';
const RECOMMEND_HEADING = 'あなたへのおすすめ';
const EMPTY_STATE_MESSAGE =
  '今のあなたに、特に必要なケアは見つかりませんでした。この調子をキープしていきましょう。';
const SOFT_CTA_TEXT = '気になるところがあれば、いつでも相談してくださいね。';
const SOFT_CTA_SUBTEXT = 'まずは気軽にメッセージからどうぞ。';
const MINOR_NOTICE = '18歳未満の方のご契約には保護者の同意が必要です。';

// R1: 紙吹雪の汎用ビビッド配色（診断非依存）。
const CONFETTI_COLORS = ['#7c5cff', '#ec4899', '#f59e0b', '#22d3ee', '#34d399', '#f43f5e'];

// ── レーダー正規化ドメイン。軸ポイントは 1..5（shared の DiagnosisResult 準拠）。
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

// ── アニメーションフック ─────────────────────────────────────────────────────

/** requestAnimationFrame で 0→target をカウントアップ（R2）。animate=false は即 target。 */
function useCountUp(target: number, animate: boolean, duration = 800): number {
  const [val, setVal] = useState(animate ? 0 : target);
  useEffect(() => {
    if (!animate) {
      setVal(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, animate, duration]);
  return val;
}

/** 0→1 のイージング進捗（R3 レーダー展開に使用）。animate=false は即 1。 */
function useProgress(animate: boolean, duration = 600): number {
  const [p, setP] = useState(animate ? 0 : 1);
  useEffect(() => {
    if (!animate) {
      setP(1);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      setP(t < 1 ? 1 - Math.pow(1 - t, 3) : 1);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animate, duration]);
  return p;
}

// ── SVG 自前レーダー（軸数は axisScores.length に追従。grow で中心から展開） ─────
function RadarChart({
  axes,
  accent,
  grow,
}: {
  axes: DiagnosisResultAxisScore[];
  accent: string;
  grow: number;
}) {
  const size = 300;
  const cx = size / 2;
  const cy = size / 2;
  const r = 88;
  const n = axes.length;
  const angleFor = (i: number) => -90 + (360 / n) * i;
  const norm = (score: number) => clamp01((score - RADAR_MIN) / (RADAR_MAX - RADAR_MIN)) * grow;

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
        <polygon key={level} points={ringPoints(level)} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth={1} />
      ))}
      {axes.map((_, i) => {
        const p = polar(cx, cy, r, angleFor(i));
        return <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="rgba(255,255,255,0.14)" strokeWidth={1} />;
      })}
      <polygon points={dataPoints} fill={accent} fillOpacity={0.28} stroke={accent} strokeWidth={2} strokeLinejoin="round" />
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
            fontWeight={700}
            fill="#c7cdda"
          >
            {a.label}
          </text>
        );
      })}
    </svg>
  );
}

// ── R4: スクロール順次フェードイン。animate=false のときは常時可視で描画する。 ──
function Reveal({ animate, index = 0, children }: { animate: boolean; index?: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(!animate);
  useEffect(() => {
    if (!animate) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [animate]);
  return (
    <div ref={ref} className={animate ? `dx-reveal${shown ? ' dx-in' : ''}` : ''} style={animate ? { transitionDelay: `${index * 100}ms` } : undefined}>
      {children}
    </div>
  );
}

// ── R1: 紙吹雪（S/A のみ・約1.5秒・ループなし・自己撤去）。 ─────────────────────
function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 36 }, () => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.25,
        dur: 1.1 + Math.random() * 0.5,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        w: 6 + Math.random() * 6,
      })),
    [],
  );
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGone(true), 1700);
    return () => clearTimeout(t);
  }, []);
  if (gone) return null;
  return (
    <div className="dx-confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <span
          key={i}
          className="dx-confetti-piece"
          style={{
            left: `${p.left}%`,
            background: p.color,
            width: `${p.w}px`,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.dur}s`,
          }}
        />
      ))}
    </div>
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

/** シェア操作（shareTargetPicker / URL コピー）。機能は既存のまま。 */
function useShare(result: DiagnosisResult, shareUrl: string) {
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

  return { notice, handleLineShare, handleCopy };
}

export default function DiagnosisResultView({
  result,
  shareUrl,
  submissionId,
}: {
  result: DiagnosisResult;
  shareUrl: string;
  submissionId: string;
}) {
  const theme = RANK_THEME[result.rank] ?? DEFAULT_THEME;

  // 初回表示のみ演出する（同一 submission の再表示・reduced motion では静止表示）。
  const [animate] = useState(() => {
    if (prefersReducedMotion()) return false;
    try {
      const key = `dx-seen-${submissionId}`;
      if (sessionStorage.getItem(key)) return false;
      sessionStorage.setItem(key, '1');
      return true;
    } catch {
      return false;
    }
  });

  const shownScore = useCountUp(result.totalScore, animate);
  const radarGrow = useProgress(animate);
  const { notice, handleLineShare, handleCopy } = useShare(result, shareUrl);

  const rankImageUrl =
    typeof result.rankImageUrl === 'string' && result.rankImageUrl.startsWith('https://')
      ? result.rankImageUrl
      : null;
  const showConfetti = animate && (result.rank === 'S' || result.rank === 'A');

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
    <div className="dx-result">
      {showConfetti && <Confetti />}
      <div className="dx-wrap">
        {result.diagnosisName && <p className="dx-name">{result.diagnosisName}</p>}

        {/* 1. ヒーロー: キャラ画像 or ランク文字（R1/R6） */}
        <section className="dx-hero">
          <div className={`dx-hero-bg${animate ? ' dx-anim' : ''}`} style={{ background: theme.gradient }} />
          {rankImageUrl ? (
            <>
              <img className={`dx-hero-img${animate ? ' dx-anim' : ''}`} src={rankImageUrl} alt={`ランク ${result.rank}`} />
              <div className="dx-hero-rank" style={{ fontSize: '36px' }}>
                {result.rank}
              </div>
            </>
          ) : (
            <div className={`dx-hero-rank${animate ? ' dx-anim' : ''}`}>{result.rank}</div>
          )}
          <div className="dx-hero-title">{result.rankTitle}</div>
          <div className="dx-hero-score dx-tnum">あなたのスコアは {shownScore}点！</div>
          {result.rankSubcopy && <p className="dx-hero-sub">{result.rankSubcopy}</p>}

          {/* R5: ヒーロー直下のシェア導線 */}
          <div className="dx-hero-share">
            <button onClick={handleLineShare} className="dx-btn dx-btn-primary">
              結果をシェアする
            </button>
          </div>
        </section>

        {/* 2. レーダーチャート + ◎○△ 一覧（R3） */}
        <section className="dx-section">
          <div className="dx-card">
            <div className="dx-radar-wrap">
              <RadarChart axes={result.axisScores} accent={theme.accent} grow={radarGrow} />
            </div>
            <ul className="dx-grades">
              {result.axisScores.map((a) => {
                const g = GRADE_DISPLAY[a.grade];
                return (
                  <li key={a.axisId} className="dx-grade-row">
                    <span className="dx-grade-label">{a.label}</span>
                    <span className="dx-grade-right">
                      <span className="dx-grade-tag" style={{ color: g.color }}>
                        {g.symbol} {g.label}
                      </span>
                      <span className="dx-grade-score dx-tnum">{a.score.toFixed(1)}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>

        {/* 3. 今いちばん効くポイント（△ 軸を弱点順に列挙・R4） */}
        {weakPoints.length > 0 && (
          <Reveal animate={animate}>
            <section className="dx-section">
              <h2 className="dx-h2">{weakPointHeading}</h2>
              {weakPoints.map((w) => (
                <div key={w.axisId} className="dx-weak">
                  <div className="dx-weak-head">
                    <span style={{ color: GRADE_DISPLAY.warn.color }}>{GRADE_DISPLAY.warn.symbol}</span>
                    {w.label}
                  </div>
                  {w.text && <p className="dx-weak-text">{w.text}</p>}
                </div>
              ))}
            </section>
          </Reveal>
        )}

        {/* 4. ランク別の結果文章（R4） */}
        {result.rankBody && (
          <Reveal animate={animate}>
            <section className="dx-section">
              <p className="dx-body-text">{result.rankBody}</p>
            </section>
          </Reveal>
        )}

        {/* 5. あなたへのおすすめ（cards / axisMessages / emptyState・R4） */}
        <section className="dx-section">
          <h2 className="dx-h2">{RECOMMEND_HEADING}</h2>
          {result.emptyState ? (
            <div className="dx-empty">
              <p className="dx-empty-msg">{emptyStateTexts.message}</p>
              {emptyStateTexts.cta && <p className="dx-empty-cta">{emptyStateTexts.cta}</p>}
            </div>
          ) : (
            <div className="dx-reco-list">
              {result.cards.map((card, idx) => (
                <Reveal key={`${card.axisId}-${idx}`} animate={animate} index={idx}>
                  <div className="dx-reco">
                    <div className="dx-reco-head">
                      <h3 className="dx-reco-title">{card.title}</h3>
                      {card.extras.length > 0 && (
                        <span className="dx-reco-extra">{card.extras.join('・')}もまとめてケア</span>
                      )}
                    </div>
                    <div className="dx-reco-price dx-tnum">
                      ¥{card.priceInTax.toLocaleString()}(税込){card.priceSuffix === '＋' ? '〜' : ''}
                    </div>
                    {card.reason && <p className="dx-reco-reason">{card.reason}</p>}
                    {card.appeal && <p className="dx-reco-reason">{card.appeal}</p>}
                    {card.notes.length > 0 && (
                      <ul className="dx-reco-notes">
                        {card.notes.map((note, i) => (
                          <li key={i} className="dx-reco-note">
                            {note}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </Reveal>
              ))}
              {result.axisMessages.map((m) => (
                <div key={m.axisId} className="dx-msg">
                  {m.message}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 6. ソフトCTA（押し売り禁止） */}
        <section className="dx-section">
          <div className="dx-softcta">
            <p className="dx-softcta-text">{softCta.text}</p>
            {softCta.subText && <p className="dx-softcta-sub">{softCta.subText}</p>}
          </div>
        </section>

        {/* 7. 未成年向け注記 */}
        <p className="dx-minor">{minorNotice}</p>
      </div>

      {/* 8. R5: 固定フッターのシェアバー（常時表示） */}
      <div className="dx-sharebar">
        <div className="dx-sharebar-inner">
          <button onClick={handleLineShare} className="dx-btn dx-btn-primary">
            LINEでシェア
          </button>
          <button onClick={handleCopy} className="dx-btn dx-btn-ghost dx-share-copy">
            リンクをコピー
          </button>
        </div>
      </div>
      {notice && <div className="dx-notice">{notice}</div>}
    </div>
  );
}
