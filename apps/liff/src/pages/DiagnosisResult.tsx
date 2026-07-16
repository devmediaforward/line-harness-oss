import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type DiagnosisSubmissionResponse } from '../lib/api.js';
import DiagnosisResultView from '../components/DiagnosisResultView.js';

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; data: DiagnosisSubmissionResponse };

export default function DiagnosisResult() {
  const { submissionId } = useParams<{ submissionId: string }>();
  const [state, setState] = useState<State>({ phase: 'loading' });

  useEffect(() => {
    if (!submissionId) {
      setState({ phase: 'error', message: '結果が指定されていません' });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getDiagnosisSubmission(submissionId);
        if (!cancelled) setState({ phase: 'ready', data });
      } catch {
        // 403（本人以外）/ 404（存在しない）などはエラーメッセージのみ表示する。
        if (!cancelled) {
          setState({
            phase: 'error',
            message: 'この結果を表示できませんでした。結果が見つからないか、表示する権限がありません。',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [submissionId]);

  if (state.phase === 'loading') {
    return <div className="p-8 text-center text-gray-500">読み込み中...</div>;
  }

  if (state.phase === 'error') {
    return <div className="p-4 bg-red-50 text-red-700 rounded">{state.message}</div>;
  }

  return (
    <div className="max-w-md mx-auto p-4 pb-12 min-h-screen">
      <div className="af-fade-in">
        <DiagnosisResultView result={state.data.result} shareUrl={state.data.shareUrl} />
      </div>
    </div>
  );
}
