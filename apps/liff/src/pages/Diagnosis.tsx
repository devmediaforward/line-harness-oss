import liff from '@line/liff';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useParams } from 'react-router-dom';
import {
  api,
  type DiagnosisDefinitionForLiff,
  type DiagnosisIntro,
  type DiagnosisIntroRankPreview,
  type DiagnosisSubmissionResponse,
} from '../lib/api.js';
import DiagnosisResultView from '../components/DiagnosisResultView.js';
import DiagnosisBandCurve from '../components/DiagnosisBandCurve.js';
import { prefersReducedMotion, delay } from '../lib/motion.js';
import {
  BAND_NAVY,
  estimateMinutes,
  groundOffset,
  rankColor,
  ringBrightness,
  ringScale,
  symmetricLayout,
} from '../lib/diagnosis-theme.js';

type Phase = 'loading' | 'error' | 'intro' | 'answering' | 'submitting' | 'submit_error' | 'result';
type FriendStatus = 'unknown' | 'friend' | 'not_friend';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isHttpsUrl(v: string | undefined): v is string {
  return typeof v === 'string' && v.startsWith('https://');
}

/**
 * ランク紹介を降順（上位が先頭）に整える。minScore が全件あればそれで降順、
 * 無ければ定義の記述順（下位→上位）を反転する。
 */
function orderedRankPreview(intro: DiagnosisIntro | undefined): DiagnosisIntroRankPreview[] {
  const rows = intro?.rankPreview ?? [];
  if (rows.length === 0) return [];
  if (rows.every((r) => typeof r.minScore === 'number')) {
    return [...rows].sort((a, b) => (b.minScore as number) - (a.minScore as number));
  }
  return [...rows].reverse();
}

/** ヒーローに立たせるキャラ（降順・https のみ）。heroImages 優先、無ければ行画像。 */
function heroFigures(intro: DiagnosisIntro | undefined): Array<{ rank: string; url: string }> {
  if (!intro) return [];
  const hero = intro.heroImages;
  const ordered = orderedRankPreview(intro);
  const rows =
    ordered.length > 0
      ? ordered.map((r) => ({ rank: r.rank, url: hero?.[r.rank] ?? r.imageUrl }))
      : Object.entries(hero ?? {})
          .reverse()
          .map(([rank, url]) => ({ rank, url }));
  return rows.filter((r): r is { rank: string; url: string } => isHttpsUrl(r.url));
}

// A5: 採点中演出。4軸のマークが順に点灯 → 応答が 3 秒を超えたら通常スピナーへ。
// 表示の最低時間(800ms)と結果への遷移は submit() 側で制御する(演出はここでは純表示)。
function CollectingScreen({
  axes,
  reduced,
}: {
  axes: DiagnosisDefinitionForLiff['axes'];
  reduced: boolean;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (reduced) return;
    const t = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(t);
  }, [reduced]);

  const showLamps = !reduced && !slow;
  const lamps = axes.slice(0, 4);

  return (
    <div className="dx-collect">
      {showLamps ? (
        <div className="dx-collect-axes" aria-hidden="true">
          {lamps.map((ax, i) => (
            <span key={ax.id} className="dx-collect-axis" style={{ animationDelay: `${i * 0.18}s` }} />
          ))}
        </div>
      ) : (
        <div className="dx-spinner" />
      )}
      <div className="dx-collect-title">結果を集計中…</div>
      <div className="dx-collect-sub">あなたの診断結果をつくっています</div>
    </div>
  );
}

export default function Diagnosis() {
  const { slug } = useParams<{ slug: string }>();

  const [phase, setPhase] = useState<Phase>('loading');
  const [def, setDef] = useState<DiagnosisDefinitionForLiff | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [friendStatus, setFriendStatus] = useState<FriendStatus>('unknown');
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [current, setCurrent] = useState(0);
  const [direction, setDirection] = useState<'fwd' | 'back'>('fwd');
  // A3: 軸クリア演出。表示中は { label, doneCount } を持つ。
  const [interstitial, setInterstitial] = useState<{ label: string; doneCount: number } | null>(null);
  const [submission, setSubmission] = useState<DiagnosisSubmissionResponse | null>(null);
  // 回答フロー開始時に採番する再送冪等キー。送信失敗→再送でも同じ値を使い、
  // レスポンス消失後のリトライで回答が二重保存されないようにする。
  const [requestId, setRequestId] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const [reduced] = useState(prefersReducedMotion);

  function startAnswering() {
    setRequestId(crypto.randomUUID());
    setPhase('answering');
  }

  // 定義ロード + 友だち判定（互いに独立。友だち判定は best-effort）。
  useEffect(() => {
    if (!slug) {
      setErrorMsg('診断が指定されていません');
      setPhase('error');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const d = await api.getDiagnosis(slug);
        if (cancelled) return;
        setDef(d);
        setPhase('intro');
      } catch (e) {
        if (!cancelled) {
          setErrorMsg(errText(e));
          setPhase('error');
        }
      }
    })();
    (async () => {
      try {
        const { friendFlag } = await liff.getFriendship();
        if (!cancelled) setFriendStatus(friendFlag ? 'friend' : 'not_friend');
      } catch {
        if (!cancelled) setFriendStatus('unknown');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // 友だち追加後に戻ってきたら再判定して通常開始できるようにする。
  useEffect(() => {
    if (phase !== 'intro' || friendStatus !== 'not_friend') return;
    const onVisible = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const { friendFlag } = await liff.getFriendship();
        if (friendFlag) setFriendStatus('friend');
      } catch {
        // ignore
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [phase, friendStatus]);

  // A3: 軸クリア演出は約1秒で自動的に閉じる(タップでも即スキップ可)。
  useEffect(() => {
    if (!interstitial) return;
    const t = setTimeout(() => setInterstitial(null), 1000);
    return () => clearTimeout(t);
  }, [interstitial]);

  async function submit(finalAnswers: Record<string, number>) {
    if (!slug || submittingRef.current) return;
    submittingRef.current = true;
    setPhase('submitting');
    const startedAt = Date.now();
    try {
      const res = await api.submitDiagnosis(slug, finalAnswers, requestId ?? undefined);
      // A5: 応答が早く返っても最低 800ms は演出を見せる(reduced motion では待たない)。
      const hold = reduced ? 0 : 800;
      const elapsed = Date.now() - startedAt;
      if (elapsed < hold) await delay(hold - elapsed);
      setSubmission(res);
      setPhase('result');
    } catch (e) {
      setErrorMsg(errText(e));
      setPhase('submit_error');
    } finally {
      submittingRef.current = false;
    }
  }

  function choose(value: number) {
    if (!def || interstitial) return;
    const q = def.questions[current];
    const next = { ...answers, [q.id]: value };
    setAnswers(next);
    if (current >= def.questions.length - 1) {
      void submit(next);
      return;
    }
    setDirection('fwd');
    const nextQ = def.questions[current + 1];
    setCurrent(current + 1);
    // A3: 軸をまたぐタイミングで応援演出を挟む(reduced motion では出さない)。
    if (nextQ.axisId !== q.axisId && !reduced) {
      const doneCount = def.axes.findIndex((a) => a.id === q.axisId) + 1;
      setInterstitial({ label: def.axes.find((a) => a.id === q.axisId)?.label ?? '', doneCount });
    }
  }

  function back() {
    if (interstitial) return;
    setDirection('back');
    if (current > 0) setCurrent(current - 1);
    else setPhase('intro');
  }

  if (phase === 'loading') {
    return <div className="p-8 text-center text-gray-500">読み込み中...</div>;
  }

  if (phase === 'error') {
    return <div className="p-4 bg-red-50 text-red-700 rounded">{errorMsg}</div>;
  }

  if (!def) return null;

  // ── 診断前（濃紺の帯 + 弧 + 紙面 + 下部固定CTA） ────────────────────────
  if (phase === 'intro') {
    const botBasicId = (import.meta.env.VITE_BOT_BASIC_ID as string | undefined)?.trim();
    const showFriendGate = friendStatus === 'not_friend' && !!botBasicId;
    const intro = def.intro;
    const catchCopy = intro?.catchCopy?.trim() || def.meta.name;
    const subCopy = intro?.subCopy?.trim() || def.meta.description;
    const aboutLines =
      intro?.aboutLines && intro.aboutLines.length > 0
        ? intro.aboutLines
        : def.meta.description
          ? [def.meta.description]
          : [];
    const previews = orderedRankPreview(intro);
    const figures = symmetricLayout(heroFigures(intro));

    return (
      <div className="dx-intro">
        <header className="dx-band" style={{ background: BAND_NAVY }}>
          <div className="dx-band-inner">
            <h1 className="dx-band-title">{catchCopy}</h1>
            {subCopy && <p className="dx-band-sub">{subCopy}</p>}
            <ul className="dx-facts">
              <li className="dx-fact dx-tnum">全{def.questions.length}問</li>
              <li className="dx-fact dx-tnum">約{estimateMinutes(def.questions.length)}分</li>
              {/* 未友だちには友だち追加が必須なので「登録不要」は出さない（矛盾するため） */}
              {!showFriendGate && <li className="dx-fact">登録不要</li>}
            </ul>
          </div>
          {figures.length > 0 && (
            <div className="dx-figs">
              {figures.map((slot, i) => (
                <div
                  key={slot.item.rank}
                  className="dx-fig"
                  style={{
                    height: `calc(var(--dx-fig-h) * ${ringScale(slot.ring)})`,
                    marginBottom: `${groundOffset(i, figures.length)}px`,
                    zIndex: figures.length - slot.ring,
                  }}
                >
                  <span className="dx-fig-shadow" aria-hidden="true" />
                  <img
                    className="dx-fig-img"
                    src={slot.item.url}
                    alt=""
                    aria-hidden="true"
                    style={{ filter: `brightness(${ringBrightness(slot.ring)})` }}
                  />
                </div>
              ))}
            </div>
          )}
          <DiagnosisBandCurve />
        </header>

        <main className="dx-paper">
          {aboutLines.length > 0 && (
            <section className="dx-sec">
              <h2 className="dx-sec-h">この診断について</h2>
              <div className="dx-panel">
                {aboutLines.map((line, i) => (
                  <p key={i} className="dx-about-line">
                    {line}
                  </p>
                ))}
              </div>
            </section>
          )}

          {previews.length > 0 && (
            <section className="dx-sec">
              <h2 className="dx-sec-h">{previews.length}つのランク</h2>
              <ul className="dx-ranks">
                {previews.map((r, i) => {
                  const img = intro?.heroImages?.[r.rank] ?? r.imageUrl;
                  return (
                    <li key={r.rank} className="dx-rank">
                      {isHttpsUrl(img) && (
                        <img className="dx-rank-img" src={img} alt="" aria-hidden="true" loading="lazy" />
                      )}
                      <div className="dx-rank-body">
                        <div className="dx-rank-head">
                          <span
                            className="dx-rank-badge"
                            style={{ background: rankColor(r.rank, previews.length - 1 - i) }}
                          >
                            {r.rank}
                          </span>
                          <span className="dx-rank-title">{r.title}</span>
                        </div>
                        {typeof r.minScore === 'number' && (
                          <div className="dx-rank-score dx-tnum">{r.minScore}点以上</div>
                        )}
                        {r.subcopy && <p className="dx-rank-sub">{r.subcopy}</p>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </main>

        <div className="dx-ctabar">
          {showFriendGate ? (
            <>
              <button
                onClick={() => liff.openWindow({ url: `https://line.me/R/ti/p/${botBasicId}`, external: true })}
                className="dx-cta"
              >
                友だち追加して診断をはじめる
              </button>
              <p className="dx-ctabar-note">追加後、この画面に戻ると診断をはじめられます</p>
            </>
          ) : (
            <button onClick={startAnswering} className="dx-cta">
              診断をはじめる
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── 送信中（A5 採点中演出） ───────────────────────────────────────────
  if (phase === 'submitting') {
    return (
      <div className="dx-screen">
        <CollectingScreen axes={def.axes} reduced={reduced} />
      </div>
    );
  }

  // ── 送信失敗（エラー表示: 既存の見た目を維持） ────────────────────────
  if (phase === 'submit_error') {
    return (
      <div className="max-w-md mx-auto p-4 pb-12 min-h-screen">
        <div className="space-y-3 pt-8">
          <div className="rounded bg-red-50 p-3 text-sm text-red-700">{errorMsg}</div>
          <button onClick={() => void submit(answers)} className="af-primary-btn">
            もう一度送信する
          </button>
          <button onClick={() => setPhase('answering')} className="af-secondary-btn">
            回答を修正する
          </button>
        </div>
      </div>
    );
  }

  // ── 結果 ───────────────────────────────────────────────────────────────
  if (phase === 'result' && submission) {
    return (
      <DiagnosisResultView
        result={submission.result}
        shareUrl={submission.shareUrl}
        submissionId={submission.submissionId}
      />
    );
  }

  // ── 診断中（濃紺ヘッダー + 紙面・1問1画面） ─────────────────────────────
  const total = def.questions.length;
  const q = def.questions[current];
  const scale = def.answerScale;
  const selected = answers[q.id];
  const currentAxisIndex = def.axes.findIndex((a) => a.id === q.axisId);
  const remaining = total - current; // 現在の設問を含む残数
  const soon = remaining <= 5;

  return (
    <div className="dx-screen">
      <header className="dx-band dx-band-sticky" style={{ background: BAND_NAVY }}>
        <div className="dx-band-inner">
          <div className="dx-head-top">
            <button onClick={back} className="dx-back">
              ← 戻る
            </button>
            <span className="dx-count dx-tnum">
              <b>{current + 1}</b> / {total}
            </span>
          </div>
          {/* 設問数ぶんの刻み。回答済みが白く埋まる。 */}
          <div className="dx-ticks" aria-hidden="true">
            {def.questions.map((item, j) => (
              <span key={item.id} className={`dx-tick${j <= current ? ' is-on' : ''}`} />
            ))}
          </div>
          <div className="dx-axisnav">
            {def.axes.map((ax, j) => (
              <span key={ax.id} className={`dx-axisnav-item${j === currentAxisIndex ? ' is-current' : ''}`}>
                {ax.shortLabel ?? ax.label}
              </span>
            ))}
          </div>
          <div className="dx-remain">
            <span className="dx-tnum">あと {remaining} 問</span>
            {soon && <span className="dx-soon">もうすぐ結果！</span>}
          </div>
        </div>
        <DiagnosisBandCurve />
      </header>

      {/* A1: 設問スライド遷移（key 再マウントで enter アニメを再生） */}
      <main className="dx-paper">
        <div key={q.id} className={`dx-q ${direction === 'back' ? 'dx-q-enter-back' : 'dx-q-enter-fwd'}`}>
          <h2 className="dx-qtext">{q.text}</h2>
          {/* A2: 強度は左の円の大きさで表す（色のグラデーションは使わない） */}
          <div className="dx-opts">
            {scale.labels.map((label, i) => {
              const value = scale.min + i;
              const isSelected = selected === value;
              return (
                <button
                  key={value}
                  onClick={() => choose(value)}
                  className={`dx-opt${isSelected ? ' is-selected' : ''}`}
                  style={pipStyle(i, scale.labels.length)}
                >
                  <span className="dx-opt-pip" aria-hidden="true" />
                  <span className="dx-opt-label">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </main>

      {/* A3: 軸クリア演出（応援型・タップで即スキップ） */}
      {interstitial && (
        <div className="dx-inter" onClick={() => setInterstitial(null)} role="button" tabIndex={-1}>
          <div className="dx-inter-emoji" aria-hidden="true">
            🔥
          </div>
          <div className="dx-inter-hi">いい調子！</div>
          <div className="dx-inter-sub">{interstitial.label} 完了</div>
          <div className="dx-inter-dots" aria-hidden="true">
            {def.axes.map((ax, j) => (
              <span key={ax.id} className={`dx-inter-dot${j < interstitial.doneCount ? ' is-done' : ''}`} />
            ))}
          </div>
          <div className="dx-inter-go">この調子で次へ</div>
        </div>
      )}
    </div>
  );
}

// A2: 選択肢の強度は左の円の直径だけで表現する（診断非依存の index ベース）。
function pipStyle(i: number, n: number): CSSProperties {
  const t = n > 1 ? i / (n - 1) : 0;
  return { ['--dx-pip']: `${10 + Math.round(t * 14)}px` } as CSSProperties;
}
