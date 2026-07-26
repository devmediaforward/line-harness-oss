// =============================================================================
// 診断結果 Flex メッセージ組み立て (09_line-message.md)
//
// 副作用のない純関数。result スナップショット + 診断名 + LIFF/共有 URL のみを
// 入力とする(テスト可能・診断内容非依存)。診断固有の語はコードに書かない
// (すべて result 由来)。メニュー・価格は Flex に載せない(通知面での押し売り
// 回避、元要件§9のトーン)。軸が増えても行が増えるだけで壊れないこと。
// =============================================================================

import type { DiagnosisResult } from '@line-crm/shared';
import type { FlexBubble, FlexComponent, FlexMessage } from '@line-crm/line-sdk';
import { isHttpsUrl } from './url.js';

/** ランク文字色。慣例的なランクレター基準(未知ランクは既定=グレー)。実装側で調整可。 */
const RANK_COLORS: Record<string, string> = {
  D: '#9CA3AF', // グレー
  C: '#B08D57', // ブロンズ
  B: '#2563EB', // ブルー
  A: '#7C3AED', // パープル
  S: '#E0A200', // ゴールド
};
const DEFAULT_RANK_COLOR = '#9CA3AF';

/** grade キー → 記号。3キーの固定ビジュアル表現(診断固有の文言ではない)。 */
const GRADE_SYMBOL: Record<string, string> = {
  keep: '◎',
  almost: '○',
  warn: '△',
};

/** grade キー → 記号色(可読性のための汎用エンコード)。 */
const GRADE_COLOR: Record<string, string> = {
  keep: '#16A34A',
  almost: '#D97706',
  warn: '#DC2626',
};

/** 予約ボタンの既定文言(診断非依存の汎用語。定義側 label があればそちらを使う)。 */
const BOOKING_DEFAULT_LABEL = '予約する';
/** 予約ボタンの色(LINE 緑)。 */
const BOOKING_COLOR = '#06C755';

export interface BuildResultFlexInput {
  /** 保存済み結果スナップショット */
  result: DiagnosisResult;
  /** 診断名(definition.meta.name)。header と altText に使用 */
  diagnosisName: string;
  /** 「結果をくわしく見る」ボタンの遷移先 LIFF URL */
  liffResultUrl: string;
  /** 「友だちにシェアする」secondary ボタンの共有 URL。空文字なら省略 */
  shareUrl: string;
}

/** 結果 Flex メッセージ(bubble 1通)を組み立てる。 */
export function buildResultFlex(input: BuildResultFlexInput): FlexMessage {
  const { result, diagnosisName, liffResultUrl, shareUrl } = input;
  // 予約導線はスナップショット(result.booking)を唯一の出所とする。呼び出し側から
  // 別経路で渡せるようにすると、結果ページと Flex の遷移先が食い違いうるため。
  // 最終出力の境界としてここでも https を要求する(多層防御)。
  const booking = result.booking && isHttpsUrl(result.booking.url) ? result.booking : null;
  const rankColor = RANK_COLORS[result.rank] ?? DEFAULT_RANK_COLOR;

  // 軸ごとの grade 行(axes 順・軸数可変)。ラベル + grade 記号のみ。
  // grade の意味文(「今いちばん効く」等)は result スナップショットに含まれない
  // ため出さない(ハードコードは診断内容非依存の原則に反する)。
  const axisRows: FlexComponent[] = result.axisScores.map((axis): FlexComponent => ({
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'text', text: axis.label, size: 'sm', color: '#555555', flex: 4, wrap: true },
      {
        type: 'text',
        text: GRADE_SYMBOL[axis.grade] ?? '',
        size: 'lg',
        weight: 'bold',
        color: GRADE_COLOR[axis.grade] ?? '#555555',
        align: 'end',
        flex: 1,
      },
    ],
  }));

  // 予約ボタン(I5)。booking があるときだけ footer 先頭に primary で入り、
  // 「結果をくわしく見る」は secondary の2番手に下がる。booking が無ければ
  // 従来と完全に同じ構成(primary の「結果をくわしく見る」+ シェア)。
  const footerContents: FlexComponent[] = [];
  if (booking) {
    footerContents.push({
      type: 'button',
      style: 'primary',
      color: BOOKING_COLOR,
      action: { type: 'uri', label: booking.label || BOOKING_DEFAULT_LABEL, uri: booking.url },
    });
    footerContents.push({
      type: 'button',
      style: 'secondary',
      action: { type: 'uri', label: '結果をくわしく見る', uri: liffResultUrl },
    });
  } else {
    footerContents.push({
      type: 'button',
      style: 'primary',
      color: BOOKING_COLOR,
      action: { type: 'uri', label: '結果をくわしく見る', uri: liffResultUrl },
    });
  }
  // シェアボタンは任意(shareUrl があるときだけ表示)。
  if (shareUrl) {
    footerContents.push({
      type: 'button',
      style: 'secondary',
      action: { type: 'uri', label: '友だちにシェアする', uri: shareUrl },
    });
  }

  const bubble: FlexBubble = {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [{ type: 'text', text: `${diagnosisName} 結果`, size: 'sm', color: '#888888' }],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        { type: 'text', text: result.rank, size: '5xl', weight: 'bold', color: rankColor, align: 'center' },
        {
          type: 'text',
          text: result.rankTitle,
          size: 'md',
          weight: 'bold',
          color: '#333333',
          align: 'center',
          wrap: true,
        },
        { type: 'text', text: `スコア ${result.totalScore}点`, size: 'sm', color: '#888888', align: 'center' },
        { type: 'separator', margin: 'lg' },
        { type: 'box', layout: 'vertical', spacing: 'sm', margin: 'lg', contents: axisRows },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: footerContents,
    },
  };

  return {
    type: 'flex',
    altText: `${diagnosisName}の結果: ${result.totalScore}点・${result.rankTitle}`,
    contents: bubble,
  };
}
