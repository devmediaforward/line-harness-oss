import liff from '@line/liff';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type DiagnosisDefinitionForLiff, type DiagnosisSubmissionResponse } from '../lib/api.js';
import DiagnosisResultView from '../components/DiagnosisResultView.js';

type Phase = 'loading' | 'error' | 'intro' | 'answering' | 'submitting' | 'submit_error' | 'result';
type FriendStatus = 'unknown' | 'friend' | 'not_friend';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function Diagnosis() {
  const { slug } = useParams<{ slug: string }>();

  const [phase, setPhase] = useState<Phase>('loading');
  const [def, setDef] = useState<DiagnosisDefinitionForLiff | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [friendStatus, setFriendStatus] = useState<FriendStatus>('unknown');
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [current, setCurrent] = useState(0);
  const [submission, setSubmission] = useState<DiagnosisSubmissionResponse | null>(null);
  // 回答フロー開始時に採番する再送冪等キー。送信失敗→再送でも同じ値を使い、
  // レスポンス消失後のリトライで回答が二重保存されないようにする。
  const [requestId, setRequestId] = useState<string | null>(null);
  const submittingRef = useRef(false);

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

  async function submit(finalAnswers: Record<string, number>) {
    if (!slug || submittingRef.current) return;
    submittingRef.current = true;
    setPhase('submitting');
    try {
      const res = await api.submitDiagnosis(slug, finalAnswers, requestId ?? undefined);
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
    if (!def) return;
    const q = def.questions[current];
    const next = { ...answers, [q.id]: value };
    setAnswers(next);
    if (current < def.questions.length - 1) {
      setCurrent(current + 1);
    } else {
      void submit(next);
    }
  }

  function back() {
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

  // ── イントロ ───────────────────────────────────────────────────────────
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

  // ── 送信中 ─────────────────────────────────────────────────────────────
  if (phase === 'submitting') {
    return (
      <div className={container}>
        <div className="af-fade-in flex flex-col items-center justify-center py-24 text-gray-500">
          <div className="af-spinner mb-3" />
          <span className="text-sm">結果を診断しています...</span>
        </div>
      </div>
    );
  }

  // ── 送信失敗 ───────────────────────────────────────────────────────────
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
      <div className={container}>
        <div className="af-fade-in">
          <DiagnosisResultView result={submission.result} shareUrl={submission.shareUrl} />
        </div>
      </div>
    );
  }

  // ── 回答フロー（1問1画面） ─────────────────────────────────────────────
  const total = def.questions.length;
  const q = def.questions[current];
  const scale = def.answerScale;
  const selected = answers[q.id];
  const axisLabel = def.axes.find((a) => a.id === q.axisId)?.label ?? '';
  const showAxisHeader = current === 0 || def.questions[current - 1].axisId !== q.axisId;
  const progressPct = Math.round(((current + 1) / total) * 100);

  return (
    <div className={container}>
      {/* 進捗バー */}
      <div className="pt-2">
        <div className="mb-1 flex items-center justify-between text-xs text-gray-500">
          <button onClick={back} className="font-medium text-gray-500">
            ← 戻る
          </button>
          <span className="tabular-nums">
            {current + 1} / {total}
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
          <div className="h-full rounded-full transition-all" style={{ width: `${progressPct}%`, backgroundColor: '#06c755' }} />
        </div>
      </div>

      <div key={q.id} className="af-fade-in pt-6">
        {showAxisHeader && axisLabel && (
          <div className="mb-2 text-xs font-bold tracking-wide text-gray-400">{axisLabel}</div>
        )}
        <h2 className="mb-6 text-lg font-bold leading-relaxed text-gray-900">{q.text}</h2>

        <div className="space-y-2">
          {scale.labels.map((label, i) => {
            const value = scale.min + i;
            const isSelected = selected === value;
            return (
              <button
                key={value}
                onClick={() => choose(value)}
                className={`w-full rounded-xl border px-4 py-3 text-left text-sm font-medium transition-colors ${
                  isSelected
                    ? 'border-transparent bg-[#06c755] text-white'
                    : 'border-gray-200 bg-white text-gray-800 active:bg-gray-50'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
