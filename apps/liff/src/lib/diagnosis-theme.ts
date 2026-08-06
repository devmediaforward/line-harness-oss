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

/**
 * ランク名 -> 帯の地色。ランク画像の下地と同じ色を置き、切り抜いたキャラが
 * 元の絵のまま立っているように見せる。線やバッジには細さ・小ささゆえの視認性が
 * 要るため RANK_COLORS を使い続け、面で使う地色だけをこちらに分けている。
 */
const RANK_BAND_COLORS: Record<string, string> = {
  D: '#BFC4CF',
  C: '#BED2D0',
  B: '#DFEECC',
  A: '#A7B6EC',
  S: '#53535A',
};

/** 帯の上に置く文字色。dim は控えめな行（ランク名・スコア添え字）用。 */
export interface OnBandColors {
  text: string;
  dim: string;
}
const ON_BAND_LIGHT: OnBandColors = { text: '#ffffff', dim: 'rgba(255, 255, 255, 0.72)' };
const ON_BAND_DARK: OnBandColors = { text: '#1f2430', dim: 'rgba(31, 36, 48, 0.8)' };

/** 帯の地色を返す。未知のランクは従来どおりランク色をそのまま地色にする。 */
export function rankBandColor(rank: string, index = 0): string {
  return RANK_BAND_COLORS[rank] ?? rankColor(rank, index);
}

/** #rgb / #rrggbb を 0..255 の三値へ。解釈できなければ null。 */
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const s = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

/** WCAG 2.x の相対輝度。 */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const ch = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

const WHITE_LUMINANCE = 1;
const DARK_LUMINANCE = relativeLuminance(parseHex(ON_BAND_DARK.text) ?? [0, 0, 0]);

/**
 * 帯色に対してコントラストが高い方の文字色を返す。淡い帯では白が読めず、
 * 濃い帯では濃色が読めないため、輝度の固定しきい値ではなく比較で決める。
 * 色を解釈できない場合は従来どおり白（帯色は濃色である前提の実装だったため）。
 */
export function onBandColors(bandColor: string): OnBandColors {
  const rgb = parseHex(bandColor);
  if (!rgb) return ON_BAND_LIGHT;
  const l = relativeLuminance(rgb);
  const ratio = (other: number): number =>
    (Math.max(l, other) + 0.05) / (Math.min(l, other) + 0.05);
  return ratio(WHITE_LUMINANCE) >= ratio(DARK_LUMINANCE) ? ON_BAND_LIGHT : ON_BAND_DARK;
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

/** ring からの表示倍率（外側ほど小さい）。落差を抑えて群像としてまとまるようにする。 */
export function ringScale(ring: number): number {
  return Math.max(0.42, 1 - 0.17 * ring);
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
