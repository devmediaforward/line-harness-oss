import { describe, expect, test } from 'vitest';
import { buildResultFlex } from './flex.js';
import type { DiagnosisResult } from '@line-crm/shared';

function makeResult(overrides: Partial<DiagnosisResult> = {}): DiagnosisResult {
  return {
    cleanPoints: {},
    axisScores: [
      { axisId: 'body', label: '体毛', score: 2.33, grade: 'warn' },
      { axisId: 'skin', label: '肌', score: 3.86, grade: 'almost' },
      { axisId: 'brow', label: '眉', score: 4.5, grade: 'keep' },
      { axisId: 'hair', label: '髪', score: 2.0, grade: 'warn' },
    ],
    weakestAxes: ['hair', 'body', 'skin', 'brow'],
    totalScore: 46,
    rank: 'B',
    rankTitle: '清潔感 一人前(Standard)',
    rankSubcopy: '好印象の合格ライン突破',
    rankBody: '清潔感の合格ライン突破。',
    tags: [],
    cards: [],
    axisMessages: [],
    droppedCards: [],
    emptyState: false,
    ...overrides,
  };
}

describe('buildResultFlex', () => {
  test('4軸: bubble スナップショット', () => {
    const flex = buildResultFlex({
      result: makeResult(),
      diagnosisName: '清潔感診断',
      liffResultUrl: 'https://liff.line.me/123-abc/diagnosis/result/sub-1',
      shareUrl: 'https://worker.example.com/d/token-1',
    });
    expect(flex).toMatchSnapshot();
  });

  test('5軸: 行が増えるだけで壊れない', () => {
    const flex = buildResultFlex({
      result: makeResult({
        axisScores: [
          { axisId: 'body', label: '体毛', score: 2.33, grade: 'warn' },
          { axisId: 'skin', label: '肌', score: 3.86, grade: 'almost' },
          { axisId: 'brow', label: '眉', score: 4.5, grade: 'keep' },
          { axisId: 'hair', label: '髪', score: 2.0, grade: 'warn' },
          { axisId: 'teeth', label: '歯', score: 3.0, grade: 'almost' },
        ],
      }),
      diagnosisName: '清潔感診断',
      liffResultUrl: 'https://liff.line.me/123-abc/diagnosis/result/sub-2',
      shareUrl: 'https://worker.example.com/d/token-2',
    });
    expect(flex).toMatchSnapshot();
    // header + 軸行を数える: body.contents[4] が軸行ボックス
    const bubble = flex.contents as {
      body: { contents: Array<{ contents?: unknown[] }> };
    };
    const axisBox = bubble.body.contents[4];
    expect(axisBox.contents).toHaveLength(5);
  });

  test('altText は {診断名}の結果: {点}点・{称号}', () => {
    const flex = buildResultFlex({
      result: makeResult(),
      diagnosisName: '清潔感診断',
      liffResultUrl: 'https://liff.line.me/x/diagnosis/result/s',
      shareUrl: 'https://worker.example.com/d/t',
    });
    expect(flex.altText).toBe('清潔感診断の結果: 46点・清潔感 一人前(Standard)');
  });

  test('shareUrl が空ならシェアボタンを省略(footer は primary 1つ)', () => {
    const flex = buildResultFlex({
      result: makeResult(),
      diagnosisName: '清潔感診断',
      liffResultUrl: 'https://liff.line.me/x/diagnosis/result/s',
      shareUrl: '',
    });
    const bubble = flex.contents as { footer: { contents: unknown[] } };
    expect(bubble.footer.contents).toHaveLength(1);
  });

  test('ランク色: S=ゴールド / 未知ランクは既定グレー', () => {
    const s = buildResultFlex({
      result: makeResult({ rank: 'S' }),
      diagnosisName: 'x',
      liffResultUrl: 'u',
      shareUrl: 's',
    });
    const sBubble = s.contents as { body: { contents: Array<{ color?: string }> } };
    expect(sBubble.body.contents[0].color).toBe('#E0A200');

    const unknown = buildResultFlex({
      result: makeResult({ rank: 'ZZ' }),
      diagnosisName: 'x',
      liffResultUrl: 'u',
      shareUrl: 's',
    });
    const uBubble = unknown.contents as { body: { contents: Array<{ color?: string }> } };
    expect(uBubble.body.contents[0].color).toBe('#9CA3AF');
  });

  test('I5: booking ありで footer 3ボタン・先頭が予約(緑 primary)', () => {
    const flex = buildResultFlex({
      result: makeResult({
        booking: { url: 'https://booking.example.com/reserve', label: 'このメニューを予約する' },
      }),
      diagnosisName: '清潔感診断',
      liffResultUrl: 'https://liff.line.me/x/diagnosis/result/s',
      shareUrl: 'https://worker.example.com/d/t',
    });
    const bubble = flex.contents as {
      footer: {
        contents: Array<{ style?: string; color?: string; action?: { label?: string; uri?: string } }>;
      };
    };
    expect(bubble.footer.contents).toHaveLength(3);
    expect(bubble.footer.contents[0].style).toBe('primary');
    expect(bubble.footer.contents[0].color).toBe('#06C755');
    expect(bubble.footer.contents[0].action?.label).toBe('このメニューを予約する');
    expect(bubble.footer.contents[0].action?.uri).toBe('https://booking.example.com/reserve');
    // 「結果をくわしく見る」は secondary の2番手へ
    expect(bubble.footer.contents[1].style).toBe('secondary');
    expect(bubble.footer.contents[1].action?.label).toBe('結果をくわしく見る');
    expect(bubble.footer.contents[2].action?.label).toBe('友だちにシェアする');
  });

  test('I5: booking の label 未指定なら汎用既定文言「予約する」', () => {
    const flex = buildResultFlex({
      result: makeResult({ booking: { url: 'https://booking.example.com/reserve' } }),
      diagnosisName: '清潔感診断',
      liffResultUrl: 'https://liff.line.me/x/diagnosis/result/s',
      shareUrl: '',
    });
    const bubble = flex.contents as { footer: { contents: Array<{ action?: { label?: string } }> } };
    expect(bubble.footer.contents).toHaveLength(2);
    expect(bubble.footer.contents[0].action?.label).toBe('予約する');
  });

  test('I5: booking.url が https 以外なら予約ボタンを出さない(多層防御)', () => {
    for (const url of [
      'javascript:alert(1)',
      'http://booking.example.com/reserve',
      'data:text/html,<script></script>',
      'https://',
      '',
    ]) {
      const flex = buildResultFlex({
        result: makeResult({ booking: { url } }),
        diagnosisName: '清潔感診断',
        liffResultUrl: 'https://liff.line.me/x/diagnosis/result/s',
        shareUrl: 'https://worker.example.com/d/t',
      });
      const bubble = flex.contents as {
        footer: { contents: Array<{ action?: { label?: string } }> };
      };
      // 従来どおりの2ボタン構成に戻り、予約ボタン自体が出ない
      expect(bubble.footer.contents).toHaveLength(2);
      expect(bubble.footer.contents[0].action?.label).toBe('結果をくわしく見る');
      expect(bubble.footer.contents[1].action?.label).toBe('友だちにシェアする');
      const serialized = JSON.stringify(flex);
      expect(serialized).not.toContain('javascript:');
      expect(serialized).not.toContain('data:');
      expect(serialized).not.toContain('booking.example.com');
    }
  });

  test('I5: booking なしなら従来どおり2ボタン(先頭は primary の結果ボタン)', () => {
    const flex = buildResultFlex({
      result: makeResult(),
      diagnosisName: '清潔感診断',
      liffResultUrl: 'https://liff.line.me/x/diagnosis/result/s',
      shareUrl: 'https://worker.example.com/d/t',
    });
    const bubble = flex.contents as {
      footer: {
        contents: Array<{ style?: string; color?: string; action?: { label?: string } }>;
      };
    };
    expect(bubble.footer.contents).toHaveLength(2);
    expect(bubble.footer.contents[0].style).toBe('primary');
    expect(bubble.footer.contents[0].color).toBe('#06C755');
    expect(bubble.footer.contents[0].action?.label).toBe('結果をくわしく見る');
    expect(bubble.footer.contents[1].action?.label).toBe('友だちにシェアする');
  });

  test('I5: booking があっても価格は Flex に載せない', () => {
    const flex = buildResultFlex({
      result: makeResult({
        cards: [
          {
            axisId: 'body',
            title: '上半身セット',
            priceExTax: 15000,
            priceInTax: 16500,
            priceSuffix: '',
            reason: 'r',
            extras: [],
            notes: [],
            discountedPriceInTax: 9900,
          },
        ],
        discount: { rate: 0.4, badgeLabel: '40%OFF' },
        booking: { url: 'https://booking.example.com/reserve' },
      }),
      diagnosisName: '清潔感診断',
      liffResultUrl: 'https://liff.line.me/x/diagnosis/result/s',
      shareUrl: 'https://worker.example.com/d/t',
    });
    const serialized = JSON.stringify(flex);
    expect(serialized).not.toContain('16500');
    expect(serialized).not.toContain('9900');
    expect(serialized).not.toContain('40%OFF');
  });

  test('メニュー・価格を載せない(cards があっても Flex に漏れない)', () => {
    const flex = buildResultFlex({
      result: makeResult({
        cards: [
          {
            axisId: 'body',
            title: '上半身セット',
            priceExTax: 15000,
            priceInTax: 16500,
            priceSuffix: '',
            reason: 'r',
            extras: [],
            notes: [],
          },
        ],
      }),
      diagnosisName: '清潔感診断',
      liffResultUrl: 'https://liff.line.me/x/diagnosis/result/s',
      shareUrl: 'https://worker.example.com/d/t',
    });
    const serialized = JSON.stringify(flex);
    expect(serialized).not.toContain('上半身セット');
    expect(serialized).not.toContain('16500');
    expect(serialized).not.toContain('15000');
  });
});
