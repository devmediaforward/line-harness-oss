// =============================================================================
// 診断定義の URL 検証ヘルパー
//
// 定義JSON 由来の URL は、保存時(validate)・スナップショット焼き込み時(engine)・
// 最終出力時(flex) の各段で同じ基準で弾く(多層防御)。保存済み定義は DB 直更新や
// 検証外経路で入りうるため、実行時にも必ず通す。
// =============================================================================

/** https スキームかつホスト付きの絶対URLか。javascript:/data: 等はここで落ちる。 */
export function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname !== '';
  } catch {
    return false;
  }
}
