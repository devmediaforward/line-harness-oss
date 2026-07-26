import liff from '@line/liff';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  DiagnosisResult,
  DiagnosisResultAxisScore,
  DiagnosisResultBooking,
  DiagnosisResultCard,
  DiagnosisResultDiscount,
  DiagnosisResultWeakPoint,
  DiagnosisGradeKey,
} from '../lib/api.js';
import DiagnosisBandCurve from './DiagnosisBandCurve.js';
import { prefersReducedMotion } from '../lib/motion.js';
import { rankColor } from '../lib/diagnosis-theme.js';

// =============================================================================
// 診断 結果表示（画面3）— Diagnosis.tsx（回答直後）と DiagnosisResult.tsx（再表示）
// で共用する。描画は result スナップショットのみに依存する（definition を再取得
// しない）。スナップショットに含まれない表示文言（grade ラベル・見出し・emptyState
// 文言・ソフトCTA）は診断固有語を避けた汎用文言のコンポーネント定数として持つ。
// UI は dx-* スコープの「ランク色の帯 + 弧 + 紙面」。
// =============================================================================

// ── ◎○△ の表示（grade ラベルは definition 由来でスナップショットに無いため定数） ─
const GRADE_DISPLAY: Record<DiagnosisGradeKey, { symbol: string; label: string; color: string }> = {
  keep: { symbol: '◎', label: 'キープ', color: '#2F9E6B' },
  almost: { symbol: '○', label: 'あと少し', color: '#C08416' },
  warn: { symbol: '△', label: '要注意', color: '#D2483F' },
};

// ── 汎用見出し・文言（definition 由来でスナップショットに無いため定数） ─────────
const WEAK_POINT_HEADING = '今いちばん効くポイント';
const RECOMMEND_HEADING = 'あなたへのおすすめ';
const EMPTY_STATE_MESSAGE =
  '今のあなたに、特に必要なケアは見つかりませんでした。この調子をキープしていきましょう。';
const SOFT_CTA_TEXT = '気になるところがあれば、いつでも相談してくださいね。';
const SOFT_CTA_SUBTEXT = 'まずは気軽にメッセージからどうぞ。';
/** 予約ボタンの既定文言（定義側 label があればそちらを使う）。 */
const BOOKING_DEFAULT_LABEL = '予約する';

/** 総合スコアの満点（エンジンが 0..100 整数で出す前提）。 */
const SCORE_MAX = 100;

// R1: 紙吹雪の汎用配色（診断非依存・紙面で視認できる濃さ）。
const CONFETTI_COLORS = ['#D6A02A', '#4A78BE', '#8B74E0', '#C6864F', '#2F9E6B', '#D2483F'];

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

// ── SVG 自前レーダー（塗りつぶしなしの線描。軸数は axisScores.length に追従） ────
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
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="dx-radar"
      role="img"
      aria-label="軸別スコアのレーダーチャート"
    >
      {rings.map((level) => (
        <polygon key={level} points={ringPoints(level)} fill="none" stroke="#DCE0E7" strokeWidth={1} />
      ))}
      {axes.map((_, i) => {
        const p = polar(cx, cy, r, angleFor(i));
        return <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#DCE0E7" strokeWidth={1} />;
      })}
      <polygon points={dataPoints} fill="none" stroke={accent} strokeWidth={2.5} strokeLinejoin="round" />
      {axes.map((a, i) => {
        const p = polar(cx, cy, r * norm(a.score), angleFor(i));
        return <circle key={a.axisId} cx={p.x} cy={p.y} r={3.5} fill={accent} />;
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
            fill="#5B6472"
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
    <div
      ref={ref}
      className={animate ? `dx-reveal${shown ? ' dx-in' : ''}` : ''}
      style={animate ? { transitionDelay: `${index * 100}ms` } : undefined}
    >
      {children}
    </div>
  );
}

// ── R1: 紙吹雪（S/A のみ・約1.5秒・ループなし・角丸/発光なしの四角）。 ───────────
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

// ── I4: おすすめカードの価格表示 ──────────────────────────────────────────────
// discount と割引後価格が両方あるときだけ二重価格表示にする。旧スナップショット
// （discountedPriceInTax なし）は従来どおり税込価格1本で描画する（後方互換）。
// 割引率・バッジ文言・条件文言はすべてスナップショット由来（コードに書かない）。
function PriceBlock({
  card,
  discount,
}: {
  card: DiagnosisResultCard;
  discount: DiagnosisResultDiscount | undefined;
}) {
  const suffix = card.priceSuffix === '＋' ? '〜' : '';
  const discounted = typeof card.discountedPriceInTax === 'number' ? card.discountedPriceInTax : null;

  if (!discount || discounted === null) {
    return (
      <div className="dx-reco-price dx-tnum">
        ¥{card.priceInTax.toLocaleString()}
        <span className="dx-reco-tax">(税込){suffix}</span>
      </div>
    );
  }

  return (
    <div className="dx-price">
      <div className="dx-price-was">
        <span className="dx-price-strike dx-tnum">通常 ¥{card.priceInTax.toLocaleString()}</span>
        {discount.badgeLabel && <span className="dx-price-badge">{discount.badgeLabel}</span>}
      </div>
      <div className="dx-price-now dx-tnum">
        ¥{discounted.toLocaleString()}
        <span className="dx-price-tax">(税込){suffix}</span>
      </div>
      {/* 景表法（二重価格表示）: 割引条件を価格のすぐ直下にも明示する */}
      {discount.conditionLabel && <p className="dx-price-cond">{discount.conditionLabel}</p>}
    </div>
  );
}

// ── I5: 予約導線。LINE 内ブラウザではなく外部ブラウザで開く。 ────────────────────
function BookingBlock({ booking }: { booking: DiagnosisResultBooking }) {
  function openBooking() {
    try {
      liff.openWindow({ url: booking.url, external: true });
      return;
    } catch {
      // LIFF 外・未初期化などで使えない場合は通常の新規タブへフォールバック
    }
    try {
      window.open(booking.url, '_blank', 'noopener');
    } catch {
      // 開けない環境では何もしない
    }
  }

  return (
    <div className="dx-booking">
      {booking.subText && <p className="dx-booking-sub">{booking.subText}</p>}
      <button onClick={openBooking} className="dx-booking-btn">
        {booking.label || BOOKING_DEFAULT_LABEL}
      </button>
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
  const accent = rankColor(result.rank);

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
  const emptyStateTexts = result.emptyStateTexts ?? { message: EMPTY_STATE_MESSAGE };
  // I4/I5: 割引・予約はスナップショットに載っているときだけ描画する（汎用フォールバックなし）。
  const discount = result.discount;
  const booking =
    result.booking && typeof result.booking.url === 'string' && result.booking.url.startsWith('https://')
      ? result.booking
      : null;

  return (
    <div className="dx-result">
      {showConfetti && <Confetti />}

      {/* 1. ヒーロー: ランク色の帯 + キャラ画像 or ランク文字（R1/R2/R6） */}
      <header className="dx-band" style={{ background: accent }}>
        <div className="dx-band-inner">
          {result.diagnosisName && <p className="dx-band-eyebrow">{result.diagnosisName}</p>}
          <h1 className={`dx-band-title dx-band-title-xl${animate ? ' dx-anim' : ''}`}>{result.rankTitle}</h1>
          <p className="dx-band-rank">{result.rank}ランク</p>
          <p className="dx-band-score dx-tnum">
            {SCORE_MAX}点中 {shownScore}点
          </p>
        </div>
        {rankImageUrl ? (
          <div className="dx-figs dx-figs-solo">
            <div className={`dx-fig${animate ? ' dx-anim' : ''}`} style={{ height: 'var(--dx-fig-h)' }}>
              <span className="dx-fig-shadow" aria-hidden="true" />
              <img className="dx-fig-img" src={rankImageUrl} alt="" aria-hidden="true" />
            </div>
          </div>
        ) : (
          <div className={`dx-band-letter${animate ? ' dx-anim' : ''}`} aria-hidden="true">
            {result.rank}
          </div>
        )}
        <DiagnosisBandCurve />
      </header>

      <main className="dx-paper">
        {result.rankSubcopy && <p className="dx-lead">{result.rankSubcopy}</p>}

        {/* 2. 4軸の ◎○△ バッジ（2列グリッド） */}
        <section className="dx-sec">
          <ul className="dx-grid2">
            {result.axisScores.map((a) => {
              const g = GRADE_DISPLAY[a.grade];
              return (
                <li key={a.axisId} className="dx-gradecell">
                  <span className="dx-gradecircle" style={{ background: g.color }} aria-hidden="true">
                    {g.symbol}
                  </span>
                  <span className="dx-gradetexts">
                    <span className="dx-gradeaxis">{a.label}</span>
                    <span className="dx-gradename">{g.label}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        {/* 3. レーダーチャート + 軸別数値（R3） */}
        <section className="dx-sec">
          <div className="dx-panel">
            <RadarChart axes={result.axisScores} accent={accent} grow={radarGrow} />
            <ul className="dx-axisrows">
              {result.axisScores.map((a) => (
                <li key={a.axisId} className="dx-axisrow">
                  <span className="dx-axisrow-label">{a.label}</span>
                  <span className="dx-axisrow-score dx-tnum">{a.score.toFixed(1)}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* 4. ランク別の結果文章（R4） */}
        {result.rankBody && (
          <Reveal animate={animate}>
            <section className="dx-sec">
              <p className="dx-body-text">{result.rankBody}</p>
            </section>
          </Reveal>
        )}

        {/* 5. 今いちばん効くポイント（△ 軸を弱点順に列挙・R4） */}
        {weakPoints.length > 0 && (
          <Reveal animate={animate}>
            <section className="dx-sec">
              <h2 className="dx-sec-h">{weakPointHeading}</h2>
              <div className="dx-weaks">
                {weakPoints.map((w) => (
                  <div key={w.axisId} className="dx-weak">
                    <div className="dx-weak-head">
                      <span aria-hidden="true">{GRADE_DISPLAY.warn.symbol}</span>
                      {w.label}
                    </div>
                    {w.text && <p className="dx-weak-text">{w.text}</p>}
                  </div>
                ))}
              </div>
            </section>
          </Reveal>
        )}

        {/* 6. あなたへのおすすめ（cards / axisMessages / emptyState・R4） */}
        <section className="dx-sec">
          <h2 className="dx-sec-h">{RECOMMEND_HEADING}</h2>
          {discount?.notice && <p className="dx-discount-notice">{discount.notice}</p>}
          {result.emptyState ? (
            <div className="dx-panel dx-empty">
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
                    <PriceBlock card={card} discount={discount} />
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

        {/* 7. 予約導線（I5・スナップショットに booking があるときだけ） */}
        {booking && (
          <section className="dx-sec">
            <BookingBlock booking={booking} />
          </section>
        )}

        {/* 8. ソフトCTA（押し売り禁止） */}
        <section className="dx-sec">
          <div className="dx-softcta">
            <p className="dx-softcta-text">{softCta.text}</p>
            {softCta.subText && <p className="dx-softcta-sub">{softCta.subText}</p>}
          </div>
        </section>
      </main>

      {/* 9. R5: 固定フッターのシェアバー（常時表示） */}
      <div className="dx-sharebar">
        <button onClick={handleLineShare} className="dx-cta">
          結果をシェア
        </button>
        <button onClick={handleCopy} className="dx-cta dx-cta-ghost">
          リンクをコピー
        </button>
      </div>
      {notice && <div className="dx-notice">{notice}</div>}
    </div>
  );
}
