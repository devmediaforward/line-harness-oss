import liff from '@line/liff';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useParams } from 'react-router-dom';
import { api, type DiagnosisDefinitionForLiff, type DiagnosisSubmissionResponse } from '../lib/api.js';
import DiagnosisResultView from '../components/DiagnosisResultView.js';
import { prefersReducedMotion, delay } from '../lib/motion.js';

type Phase = 'loading' | 'error' | 'intro' | 'answering' | 'submitting' | 'submit_error' | 'result';
type FriendStatus = 'unknown' | 'friend' | 'not_friend';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// A5: 採点中演出。4軸アイコンが順に点灯 → 応答が 3 秒を超えたら通常スピナーへ。
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
        <div className="dx-collect-axes">
          {lamps.map((ax, i) => (
            <div key={ax.id} className="dx-collect-axis" style={{ animationDelay: `${i * 0.18}s` }}>
              ●
            </div>
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

  const container = 'max-w-md mx-auto p-4 pb-12 min-h-screen';

  // ── イントロ（スコープ外: 既存の見た目を維持） ──────────────────────────
  if (phase === 'intro') {
    const botBasicId = (import.meta.env.VITE_BOT_BASIC_ID as string | undefined)?.trim();
    const showFriendGate = friendStatus === 'not_friend' && !!botBasicId;
    return (
      <div className={container}>
        <div className="af-fade-in space-y-5 pt-6">
          <div className="space-y-2 text-center">
            <h1 className="text-xl font-bold text-gray-900">{def.meta.name}</h1>
            {def.meta.description && (
              <p className="text-sm leading-relaxed text-gray-600">{def.meta.description}</p>
            )}
            <p className="text-xs font-medium text-gray-400">約2分・{def.questions.length}問</p>
          </div>
          {showFriendGate ? (
            <div className="space-y-2">
              <button
                onClick={() => liff.openWindow({ url: `https://line.me/R/ti/p/${botBasicId}`, external: true })}
                className="af-primary-btn"
              >
                友だち追加して診断をはじめる
              </button>
              <p className="text-center text-xs text-gray-500">追加後、この画面に戻ると診断をはじめられます</p>
            </div>
          ) : (
            <button onClick={startAnswering} className="af-primary-btn">
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
        <div className="dx-wrap">
          <CollectingScreen axes={def.axes} reduced={reduced} />
        </div>
      </div>
    );
  }

  // ── 送信失敗（エラー表示: 既存の見た目を維持） ────────────────────────
  if (phase === 'submit_error') {
    return (
      <div className={container}>
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

  // ── 回答フロー（1問1画面・A0/A1/A2/A4） ────────────────────────────────
  const total = def.questions.length;
  const q = def.questions[current];
  const scale = def.answerScale;
  const selected = answers[q.id];
  const axisLabel = def.axes.find((a) => a.id === q.axisId)?.label ?? '';
  const currentAxisIndex = def.axes.findIndex((a) => a.id === q.axisId);
  const showAxisHeader = current === 0 || def.questions[current - 1].axisId !== q.axisId;
  const progressPct = Math.round(((current + 1) / total) * 100);
  const remaining = total - current; // 現在の設問を含む残数
  const soon = remaining <= 5;

  return (
    <div className="dx-screen">
      <div className="dx-wrap">
        {/* A4: 常設ヘッダ（進捗バー + 軸ドット + 残数） */}
        <div className="dx-head">
          <div className="dx-head-top">
            <button onClick={back} className="dx-back">
              ← 戻る
            </button>
            <span className="dx-count">
              <b className="dx-tnum">{current + 1}</b> / {total}
            </span>
          </div>
          <div className="dx-axis-dots" aria-hidden="true">
            {def.axes.map((ax, j) => (
              <span
                key={ax.id}
                className={`dx-axis-dot${j < currentAxisIndex ? ' is-done' : j === currentAxisIndex ? ' is-active' : ''}`}
              />
            ))}
          </div>
          <div className="dx-bar">
            <div className={`dx-bar-fill${soon ? ' is-hot' : ''}`} style={{ width: `${progressPct}%` }} />
          </div>
          <div className="dx-remain">
            <span className="dx-tnum">あと {remaining} 問</span>
            {soon && <span className="dx-soon">もうすぐ結果！</span>}
          </div>
        </div>

        {/* A1: 設問スライド遷移（key 再マウントで enter アニメを再生） */}
        <div key={q.id} className={`dx-q ${direction === 'back' ? 'dx-q-enter-back' : 'dx-q-enter-fwd'}`}>
          {showAxisHeader && axisLabel && <div className="dx-axis-label">{axisLabel}</div>}
          <h2 className="dx-qtext">{q.text}</h2>

          {/* A2: 強度ビジュアル + 押下フィードバック */}
          <div className="dx-opts">
            {scale.labels.map((label, i) => {
              const value = scale.min + i;
              const isSelected = selected === value;
              return (
                <button
                  key={value}
                  onClick={() => choose(value)}
                  className={`dx-opt${isSelected ? ' is-selected' : ''}`}
                  style={optionStyle(i, scale.labels.length)}
                >
                  <span className="dx-opt-pip" aria-hidden="true" />
                  <span className="dx-opt-label">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* A3: 軸クリア演出（応援型・タップで即スキップ） */}
      {interstitial && (
        <div className="dx-inter" onClick={() => setInterstitial(null)} role="button" tabIndex={-1}>
          <div className="dx-inter-emoji">🔥</div>
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

// A2: 選択肢の強度カラー/サイズ。t=0(当てはまらない)→ 落ち着いた色・小、
// t=1(とても当てはまる)→ ビビッド・大。診断非依存の固定ランプ(index-based)。
function optionStyle(i: number, n: number): CSSProperties {
  const t = n > 1 ? i / (n - 1) : 0;
  const lo = [100, 116, 139]; // slate-500
  const hi = [244, 63, 94]; // rose-500
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  const r = mix(lo[0], hi[0]);
  const g = mix(lo[1], hi[1]);
  const b = mix(lo[2], hi[2]);
  return {
    ['--dx-opt-color']: `rgb(${r},${g},${b})`,
    ['--dx-opt-tint']: `rgba(${r},${g},${b},0.16)`,
    ['--dx-opt-size']: `${9 + Math.round(t * 11)}px`,
    ['--dx-opt-fs']: `${(14 + t * 2.5).toFixed(1)}px`,
  } as CSSProperties;
}
