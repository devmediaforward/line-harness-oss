// =============================================================================
// 診断ページ共通のテーマ定数・レイアウト計算（診断前 / 診断中 / 結果）
//
// 定義JSON にはランク色フィールドが無いため、ランク色はここに持つ汎用パレット。
// 診断固有の語・色は書かない（ランク名でのマッピングは診断非依存）。
// =============================================================================

/** 中立の帯色。診断前・診断中はこれで通し、結果でだけランク色に切り替わる。 */
export const BAND_NAVY = '#262D40';

/** ランク名 -> 色（D→S の 5 段階を想定した汎用パレット）。 */
const RANK_COLORS: Record<string, string> = {
  D: '#8A929E',
  C: '#C6864F',
  B: '#4A78BE',
  A: '#8B74E0',
  S: '#D6A02A',
};

/** ランク名が未知のとき（ランク数が異なる等）に使う順送りパレット。 */
const FALLBACK_RANK_COLORS = ['#8A929E', '#C6864F', '#4A78BE', '#8B74E0', '#D6A02A'];

/**
 * ランク色を返す。既知のランク名なら固定色、未知なら index 順のフォールバック。
 * index は「下位から数えた位置」を渡す（0 が最下位）。
 */
export function rankColor(rank: string, index = 0): string {
  return RANK_COLORS[rank] ?? FALLBACK_RANK_COLORS[index % FALLBACK_RANK_COLORS.length];
}

/** 設問数からの所要時間概算（分）。1 問あたり 5 秒 + 端数切り上げ。 */
export function estimateMinutes(questionCount: number): number {
  return Math.max(1, Math.round((questionCount * 5) / 60));
}

/** 中央主役の左右対称配置の 1 要素。ring は中央からの距離（0 = 中央）。 */
export interface SymmetricSlot<T> {
  item: T;
  ring: number;
}

/**
 * 降順（先頭 = 最上位）の配列を「中央が先頭・外へ行くほど下位」に並べ替える。
 * 例: [S,A,B,C,D] -> [D,B,S,A,C]。要素数が 5 以外でも破綻しない。
 */
export function symmetricLayout<T>(items: T[]): Array<SymmetricSlot<T>> {
  if (items.length === 0) return [];
  const left: Array<SymmetricSlot<T>> = [];
  const right: Array<SymmetricSlot<T>> = [];
  for (let i = 1; i < items.length; i++) {
    const slot = { item: items[i], ring: Math.ceil(i / 2) };
    if (i % 2 === 1) right.push(slot);
    else left.push(slot);
  }
  left.reverse();
  return [...left, { item: items[0], ring: 0 }, ...right];
}

/** ring からの表示倍率（外側ほど小さい）。 */
export function ringScale(ring: number): number {
  return Math.max(0.36, 1 - 0.22 * ring);
}

/** ring からの明度（外側ほど暗い）。CSS filter: brightness() に渡す。 */
export function ringBrightness(ring: number): number {
  return Math.max(0.58, 1 - 0.13 * ring);
}

/**
 * 帯下端の弧に合わせた接地位置（px）。位置 u（-1..1）が中央のとき最も低い。
 * 弧の見た目（.dx-curve）と対応させた定数。
 */
export function groundOffset(index: number, count: number): number {
  if (count <= 1) return 12;
  const u = (index - (count - 1) / 2) / ((count - 1) / 2);
  return 12 + 10 * u * u;
}
