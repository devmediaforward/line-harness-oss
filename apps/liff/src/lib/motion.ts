// 診断ページの演出制御ユーティリティ(C6: prefers-reduced-motion 対応)。
// Diagnosis.tsx / DiagnosisResultView.tsx で共有する。追加依存なし。

/** ユーザーがアニメーション低減を希望しているか(未対応環境では false)。 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** setTimeout ベースの待機(A5 の最低表示時間などに使用)。 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
