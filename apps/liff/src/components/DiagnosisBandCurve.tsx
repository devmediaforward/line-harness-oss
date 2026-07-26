// 帯（カラーバンド）下端の緩やかな弧。塗りは紙面色（CSS の fill で指定）。
// 診断前 / 診断中ヘッダー / 結果の 3 画面で共有する。
export default function DiagnosisBandCurve() {
  return (
    <svg className="dx-curve" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path d="M0,6 L100,6 L100,1.2 C72,4.2 28,4.2 0,1.2 Z" />
    </svg>
  );
}
