import { describe, it, expect } from 'vitest';
import redentJson from '@line-crm/db/seeds/redent-diagnosis.json';
import { validateDefinition } from './validate.js';

/** シードのディープコピー(破壊的変異でケースを作る) */
function clone(): any {
  return JSON.parse(JSON.stringify(redentJson));
}

describe('validateDefinition — 正常系', () => {
  it('シード定義(Re\'Dent)はエラー0件', () => {
    expect(validateDefinition(redentJson)).toEqual([]);
  });
});

describe('validateDefinition — 異常系(日本語エラー)', () => {
  it('検査2: lookup table の網羅欠け → 網羅エラー', () => {
    const def = clone();
    def.recommendation.resolvers.body.table.pop(); // 1行削る
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('網羅'))).toBe(true);
  });

  it('検査2: lookup table の重複 → 重複エラー', () => {
    const def = clone();
    const table = def.recommendation.resolvers.body.table;
    table.push(JSON.parse(JSON.stringify(table[0]))); // 先頭行を複製
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('重複'))).toBe(true);
  });

  it('検査2: extras と key が交差 → 交差エラー', () => {
    const def = clone();
    def.recommendation.resolvers.body.table[0].extras = [
      def.recommendation.resolvers.body.table[0].key[0],
    ];
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('交差'))).toBe(true);
  });

  it('検査3: ranks の min 逆順 → 昇順エラー', () => {
    const def = clone();
    def.scoring.ranks[2].min = 10; // 0,20,10,... で降順
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('昇順'))).toBe(true);
  });

  it('検査3: ranks の先頭が0でない → エラー', () => {
    const def = clone();
    def.scoring.ranks[0].min = 5;
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('0'))).toBe(true);
  });

  it('検査4: axisGrades keep.min <= almost.min → エラー', () => {
    const def = clone();
    def.scoring.axisGrades.keep.min = 2.0; // almost=3.0 より小さい
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('keep.min'))).toBe(true);
  });

  it('検査1: questions.id 重複 → 重複エラー', () => {
    const def = clone();
    def.questions[1].id = def.questions[0].id;
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('重複'))).toBe(true);
  });

  it('検査1: axisId が axes に無い → エラー', () => {
    const def = clone();
    def.questions[0].axisId = 'zzz';
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('axes に存在しません'))).toBe(true);
  });

  it('検査6: severityTags が worryTag に無い → エラー', () => {
    const def = clone();
    def.scoring.severityTags = ['存在しないタグ'];
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('severityTags'))).toBe(true);
  });

  it('検査7: tagMerges の target が無効 → エラー', () => {
    const def = clone();
    def.scoring.tagMerges = { '手・指': 'ZZZ存在しない' };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('tagMerges'))).toBe(true);
  });

  it('検査8: 未知の条件キー(タイポ)→ エラー', () => {
    const def = clone();
    def.recommendation.resolvers.skin.rules[0].if = { hasTagg: 'ニキビ肌' };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('未知の条件キー'))).toBe(true);
  });

  it('検査8: noteRules 内のネストした未知条件キー → エラー', () => {
    const def = clone();
    def.recommendation.noteRules[0].if = { and: [{ hasTag: '毛穴・ザラつき' }, { wrongKey: 'x' }] };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('未知の条件キー'))).toBe(true);
  });

  it('オブジェクトでない入力 → エラー', () => {
    expect(validateDefinition(null).length).toBeGreaterThan(0);
    expect(validateDefinition('x').length).toBeGreaterThan(0);
  });
});

describe('validateDefinition — 構造検査(型崩れ)', () => {
  it('必須セクション欠落(scoring 削除)→ エラー', () => {
    const def = clone();
    delete def.scoring;
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('必須セクション') && e.includes('scoring'))).toBe(true);
  });

  it('条件DSL: hasAnyTag が配列でない → エラー', () => {
    const def = clone();
    def.recommendation.resolvers.hair.rules[0].if = { hasAnyTag: 'not-an-array' };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('hasAnyTag は文字列配列'))).toBe(true);
  });

  it('条件DSL: hasTagWithPoint の point が整数でない → エラー', () => {
    const def = clone();
    def.recommendation.resolvers.skin.rules[0].if = { hasTagWithPoint: { tag: 'ニキビ肌', point: 'x' } };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('hasTagWithPoint'))).toBe(true);
  });

  it('answerScale: min >= max → エラー', () => {
    const def = clone();
    def.answerScale.min = 5;
    def.answerScale.max = 5;
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('min は max より小さい'))).toBe(true);
  });

  it('answerScale.labels が文字列配列でない → エラー', () => {
    const def = clone();
    def.answerScale.labels = 'nope';
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('labels'))).toBe(true);
  });

  it('questions.direction が不正 → エラー', () => {
    const def = clone();
    def.questions[0].direction = 'sideways';
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('direction'))).toBe(true);
  });

  it('priorityRules の card.priceExTax が数値でない → エラー', () => {
    const def = clone();
    def.recommendation.resolvers.skin.rules[0].card.priceExTax = 'free';
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('priceExTax'))).toBe(true);
  });

  it('lookup table 行の priceExTax が数値でない → エラー', () => {
    const def = clone();
    def.recommendation.resolvers.body.table[0].priceExTax = 'free';
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('priceExTax'))).toBe(true);
  });

  it('recommendation.maxTotal が正の整数でない → エラー', () => {
    const def = clone();
    def.recommendation.maxTotal = 0;
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('maxTotal'))).toBe(true);
  });

  it('resultPage.taxRate が数値でない → エラー', () => {
    const def = clone();
    def.resultPage.taxRate = '10%';
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('taxRate'))).toBe(true);
  });

  it('resultPage.weakPointTexts の値が数値 → エラー', () => {
    const def = clone();
    def.resultPage.weakPointTexts.body = 123;
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('weakPointTexts'))).toBe(true);
  });

  it('resultPage.softCta.text が文字列でない → エラー', () => {
    const def = clone();
    def.resultPage.softCta.text = 5;
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('softCta'))).toBe(true);
  });

  it('resultPage.minorNotice が文字列でない → エラー', () => {
    const def = clone();
    def.resultPage.minorNotice = 42;
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('minorNotice'))).toBe(true);
  });

  it('resultPage.emptyState.message が文字列でない → エラー', () => {
    const def = clone();
    def.resultPage.emptyState.message = 1;
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('emptyState'))).toBe(true);
  });

  it('resultPage.emptyState.card が妥当なら通る', () => {
    const def = clone();
    def.resultPage.emptyState.card = {
      axisId: 'skin',
      title: '美肌極みコース',
      priceExTax: 20000,
      reason: 'さらに上へ',
    };
    expect(validateDefinition(def)).toEqual([]);
  });

  it('resultPage.emptyState.card.axisId が axes に無い → エラー', () => {
    const def = clone();
    def.resultPage.emptyState.card = {
      axisId: 'nope',
      title: '美肌極みコース',
      priceExTax: 20000,
      reason: 'さらに上へ',
    };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('emptyState.card.axisId'))).toBe(true);
  });

  it('resultPage.emptyState.card.priceExTax が数値でない → エラー', () => {
    const def = clone();
    def.resultPage.emptyState.card = {
      axisId: 'skin',
      title: '美肌極みコース',
      priceExTax: '20000',
      reason: 'さらに上へ',
    };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('emptyState.card.priceExTax'))).toBe(true);
  });

  it('resultPage.emptyState.card.priceExTax を省略しても通る(価格未定のメニュー)', () => {
    const def = clone();
    def.resultPage.emptyState.card = {
      axisId: 'skin',
      title: '美肌極みコース',
      reason: 'さらに上へ',
    };
    expect(validateDefinition(def)).toEqual([]);
  });

  it('resultPage.emptyState.card.priceExTax が null → エラー(省略とは区別する)', () => {
    const def = clone();
    def.resultPage.emptyState.card = {
      axisId: 'skin',
      title: '美肌極みコース',
      priceExTax: null,
      reason: 'さらに上へ',
    };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('emptyState.card.priceExTax'))).toBe(true);
  });

  it('resultPage.emptyState.card.minScore が 100 を超える → エラー', () => {
    const def = clone();
    def.resultPage.emptyState.card = {
      axisId: 'skin',
      title: '美肌極みコース',
      priceExTax: 20000,
      reason: 'さらに上へ',
      minScore: 101,
    };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('emptyState.card.minScore'))).toBe(true);
  });

  it('resultPage.emptyState.card.minScore が 0..100 なら通る', () => {
    const def = clone();
    def.resultPage.emptyState.card = {
      axisId: 'skin',
      title: '美肌極みコース',
      priceExTax: 20000,
      reason: 'さらに上へ',
      minScore: 100,
    };
    expect(validateDefinition(def)).toEqual([]);
  });

  it('resultPage は taxRate のみでも(任意フィールド未指定)エラーにしない', () => {
    const def = clone();
    def.resultPage = { taxRate: 0.1 };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('resultPage'))).toBe(false);
  });

  it('resolver.type が不正 → エラー', () => {
    const def = clone();
    def.recommendation.resolvers.brow.type = 'unknownType';
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('type は'))).toBe(true);
  });

  it('ranks 要素の title が文字列でない → エラー', () => {
    const def = clone();
    def.scoring.ranks[1].title = 123;
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('title'))).toBe(true);
  });
});

describe('validateDefinition — F1〜F6 追加検査', () => {
  it('F1: cardByTag の値が null → エラー', () => {
    const def = clone();
    def.recommendation.resolvers.skin.rules[3].cardByTag['ニキビ跡'] = null;
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('null にできません'))).toBe(true);
  });

  it('F1: card の reason が文字列でない → エラー', () => {
    const def = clone();
    def.recommendation.resolvers.skin.rules[0].card.reason = 123;
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('reason'))).toBe(true);
  });

  it('F2: specialTags の値が null → エラー', () => {
    const def = clone();
    def.recommendation.resolvers.body.specialTags['自己処理トラブル'] = null;
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('specialTags'))).toBe(true);
  });

  it('F2: specialTags の mode が不正 → エラー', () => {
    const def = clone();
    def.recommendation.resolvers.body.specialTags['自己処理トラブル'].mode = 'wrong';
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('mode'))).toBe(true);
  });

  it('F2: reasonByTag の値が文字列でない → エラー', () => {
    const def = clone();
    def.recommendation.resolvers.body.reasonByTag['顔(ヒゲ)'] = 42;
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('reasonByTag'))).toBe(true);
  });

  it('F3: keyTags が13個 → 多すぎエラー(網羅走査に入らない)', () => {
    const def = clone();
    def.recommendation.resolvers.body.keyTags = [
      'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    ];
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('多すぎ'))).toBe(true);
  });

  it('F3: 条件DSL の深いネスト → エラー(スタックオーバーフローしない)', () => {
    const def = clone();
    let cond: unknown = { hasTag: 'ニキビ肌' };
    for (let i = 0; i < 15; i++) cond = { and: [cond] };
    def.recommendation.resolvers.skin.rules[0].if = cond;
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('ネスト'))).toBe(true);
  });

  it('F5: 空条件 {} → エラー', () => {
    const def = clone();
    def.recommendation.resolvers.skin.rules[0].if = {};
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('既知のキーがありません'))).toBe(true);
  });

  it('F5: 既知キー2個の複合条件 → エラー', () => {
    const def = clone();
    def.recommendation.resolvers.skin.rules[0].if = { hasTag: 'ニキビ肌', always: true };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('1つだけ'))).toBe(true);
  });

  it('F6: axes 空配列 → エラー', () => {
    const def = clone();
    def.axes = [];
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('axes は空にできません'))).toBe(true);
  });

  it('F6: questions 空配列 → エラー', () => {
    const def = clone();
    def.questions = [];
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('questions は空にできません'))).toBe(true);
  });

  it('相関: sendResultMessage=true + liffUrl 空文字 → エラー', () => {
    const def = clone();
    def.sideEffects.sendResultMessage = true;
    def.share.liffUrl = '';
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('liff.line.me'))).toBe(true);
  });

  it('相関: sendResultMessage=true + liff.line.me 形式でない URL → エラー', () => {
    const def = clone();
    def.sideEffects.sendResultMessage = true;
    def.share.liffUrl = 'https://example.com/diagnosis';
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('liff.line.me'))).toBe(true);
  });

  it('相関(先頭アンカー): liff.line.me が先頭でない URL → エラー', () => {
    // 途中に liff.line.me を含むだけの偽装 URL は弾く(先頭アンカーのみ許可)。
    const def = clone();
    def.sideEffects.sendResultMessage = true;
    def.share.liffUrl = 'https://evil.example.com/liff.line.me/ABCD/x';
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('liff.line.me'))).toBe(true);
  });

  it('相関: sendResultMessage=true + プレースホルダ liffUrl(REPLACE_LIFF_ID)は通る', () => {
    // シード既定は sendResultMessage=true かつ REPLACE_LIFF_ID プレースホルダ → エラー0件のまま
    const def = clone();
    expect(def.sideEffects.sendResultMessage).toBe(true);
    expect(validateDefinition(def).some((e: string) => e.includes('liff.line.me'))).toBe(false);
  });

  it('相関: sendResultMessage=false なら liffUrl 空でも liffUrl エラーは出さない', () => {
    const def = clone();
    def.sideEffects.sendResultMessage = false;
    def.share.liffUrl = '';
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('liff.line.me'))).toBe(false);
  });

  it('R6: rankImages 正常系(定義済みランクキー + https URL)→ エラーなし', () => {
    const def = clone();
    def.resultPage.rankImages = {
      S: 'https://cdn.example.com/s.png',
      D: 'https://cdn.example.com/d.png',
    };
    expect(validateDefinition(def)).toEqual([]);
  });

  it('R6: rankImages の値が https:// でない(http)→ エラー', () => {
    const def = clone();
    def.resultPage.rankImages = { S: 'http://cdn.example.com/s.png' };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('rankImages') && e.includes('https://'))).toBe(true);
  });

  it('R6: rankImages の値が https:// 単体(ホスト無し)→ エラー', () => {
    const def = clone();
    def.resultPage.rankImages = { S: 'https://' };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('rankImages') && e.includes('https://'))).toBe(true);
  });

  it('R6: rankImages の値が文字列でない → エラー', () => {
    const def = clone();
    def.resultPage.rankImages = { S: 123 };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('rankImages') && e.includes('https://'))).toBe(true);
  });

  it('R6: rankImages のキーが未知ランク → エラー', () => {
    const def = clone();
    def.resultPage.rankImages = { Z: 'https://cdn.example.com/z.png' };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('rankImages') && e.includes('存在しません'))).toBe(true);
  });

  it('R6: rankImages がオブジェクトでない → エラー', () => {
    const def = clone();
    def.resultPage.rankImages = 'nope';
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('rankImages'))).toBe(true);
  });

  it('価格: lookup table の priceExTax が負 / 非有限 → エラー', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const def = clone();
      def.recommendation.resolvers.body.table[0].priceExTax = bad;
      const errors = validateDefinition(def);
      expect(errors.some((e: string) => e.includes('priceExTax'))).toBe(true);
    }
  });

  it('価格: priorityRules の card.priceExTax が負 → エラー', () => {
    const def = clone();
    const rules = def.recommendation.resolvers.skin.rules;
    const target = rules.find((r: any) => r.card) ?? rules[0];
    target.card = { title: 'T', priceExTax: -100, reason: 'r' };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('priceExTax'))).toBe(true);
  });

  it('税率: taxRate が負 / 1超 / 非有限 → エラー', () => {
    for (const bad of [-0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const def = clone();
      def.resultPage.taxRate = bad;
      const errors = validateDefinition(def);
      expect(errors.some((e: string) => e.includes('taxRate'))).toBe(true);
    }
  });

  it('税率: 境界値 0 と 1 は許容', () => {
    for (const ok of [0, 1]) {
      const def = clone();
      def.resultPage.taxRate = ok;
      expect(validateDefinition(def).some((e: string) => e.includes('taxRate'))).toBe(false);
    }
  });

  it('価格: 0 円は許容(無料メニュー)', () => {
    const def = clone();
    def.recommendation.resolvers.body.table[0].priceExTax = 0;
    expect(validateDefinition(def).some((e: string) => e.includes('priceExTax'))).toBe(false);
  });

  it('I4: discount 正常系(rate + ラベル類)→ エラーなし', () => {
    const def = clone();
    def.resultPage.discount = { rate: 0.4, badgeLabel: 'B', conditionLabel: 'C', notice: 'N' };
    expect(validateDefinition(def)).toEqual([]);
  });

  it('I4: discount.rate が範囲外(0 / 1 / 負 / 1超)→ エラー', () => {
    for (const rate of [0, 1, -0.1, 1.2]) {
      const def = clone();
      def.resultPage.discount = { rate };
      const errors = validateDefinition(def);
      expect(errors.some((e: string) => e.includes('discount.rate'))).toBe(true);
    }
  });

  it('I4: discount.rate が数値でない → エラー', () => {
    const def = clone();
    def.resultPage.discount = { rate: '0.4' };
    expect(validateDefinition(def).some((e: string) => e.includes('discount.rate'))).toBe(true);
  });

  it('I4: discount のラベル類が文字列でない → エラー', () => {
    const def = clone();
    def.resultPage.discount = { rate: 0.4, badgeLabel: 1, conditionLabel: 2, notice: 3 };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('discount.badgeLabel'))).toBe(true);
    expect(errors.some((e: string) => e.includes('discount.conditionLabel'))).toBe(true);
    expect(errors.some((e: string) => e.includes('discount.notice'))).toBe(true);
  });

  it('I4: discount がオブジェクトでない → エラー', () => {
    const def = clone();
    def.resultPage.discount = 0.4;
    expect(validateDefinition(def).some((e: string) => e.includes('resultPage.discount'))).toBe(true);
  });

  it('I5: booking 正常系(https URL + ラベル類)→ エラーなし', () => {
    const def = clone();
    def.resultPage.booking = { url: 'https://booking.example.com/x', label: 'L', subText: 'S' };
    expect(validateDefinition(def)).toEqual([]);
  });

  it('I5: booking.url が https:// でない → エラー', () => {
    const def = clone();
    def.resultPage.booking = { url: 'http://booking.example.com/x' };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('booking.url') && e.includes('https://'))).toBe(true);
  });

  it('I5: booking.url が欠落 → エラー', () => {
    const def = clone();
    def.resultPage.booking = { label: 'L' };
    expect(validateDefinition(def).some((e: string) => e.includes('booking.url'))).toBe(true);
  });

  it('I5: booking の label / subText が文字列でない → エラー', () => {
    const def = clone();
    def.resultPage.booking = { url: 'https://booking.example.com/x', label: 1, subText: 2 };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('booking.label'))).toBe(true);
    expect(errors.some((e: string) => e.includes('booking.subText'))).toBe(true);
  });

  it('I5: booking がオブジェクトでない → エラー', () => {
    const def = clone();
    def.resultPage.booking = 'https://booking.example.com/x';
    expect(validateDefinition(def).some((e: string) => e.includes('resultPage.booking'))).toBe(true);
  });

  it('intro 正常系(全フィールド)→ エラーなし', () => {
    const def = clone();
    def.intro = {
      catchCopy: 'コピー',
      subCopy: 'サブ',
      aboutLines: ['行1', '行2'],
      rankPreview: [
        { rank: 'D', title: 'T-D', subcopy: 'S-D', minScore: 0, imageUrl: 'https://cdn.example.com/d.webp' },
        { rank: 'S', title: 'T-S', minScore: 80 },
      ],
      heroImages: { D: 'https://cdn.example.com/d.webp', S: 'https://cdn.example.com/s.webp' },
    };
    expect(validateDefinition(def)).toEqual([]);
  });

  it('intro 未指定 → エラーなし(任意ブロック)', () => {
    const def = clone();
    delete def.intro;
    expect(validateDefinition(def)).toEqual([]);
  });

  it('intro がオブジェクトでない → エラー', () => {
    const def = clone();
    def.intro = 'nope';
    expect(validateDefinition(def).some((e: string) => e.includes('intro'))).toBe(true);
  });

  it('intro.aboutLines が文字列配列でない → エラー', () => {
    const def = clone();
    def.intro = { aboutLines: ['ok', 3] };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('intro.aboutLines'))).toBe(true);
  });

  it('intro.catchCopy が文字列でない → エラー', () => {
    const def = clone();
    def.intro = { catchCopy: 1 };
    expect(validateDefinition(def).some((e: string) => e.includes('intro.catchCopy'))).toBe(true);
  });

  it('intro.rankPreview が配列でない → エラー', () => {
    const def = clone();
    def.intro = { rankPreview: {} };
    expect(validateDefinition(def).some((e: string) => e.includes('intro.rankPreview'))).toBe(true);
  });

  it('intro.rankPreview の rank が未知ランク → エラー', () => {
    const def = clone();
    def.intro = { rankPreview: [{ rank: 'Z', title: 'T' }] };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('rankPreview[0].rank') && e.includes('存在しません'))).toBe(true);
  });

  it('intro.rankPreview の title 欠落 / minScore 型不正 → エラー', () => {
    const def = clone();
    def.intro = { rankPreview: [{ rank: 'S', minScore: '80' }] };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('rankPreview[0].title'))).toBe(true);
    expect(errors.some((e: string) => e.includes('rankPreview[0].minScore'))).toBe(true);
  });

  it('intro.rankPreview の imageUrl が https:// でない → エラー', () => {
    const def = clone();
    def.intro = { rankPreview: [{ rank: 'S', title: 'T', imageUrl: 'http://cdn.example.com/s.webp' }] };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('rankPreview[0].imageUrl') && e.includes('https://'))).toBe(true);
  });

  it('intro.heroImages のキーが未知ランク → エラー', () => {
    const def = clone();
    def.intro = { heroImages: { Z: 'https://cdn.example.com/z.webp' } };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('intro.heroImages') && e.includes('存在しません'))).toBe(true);
  });

  it('intro.heroImages の値が https:// でない → エラー', () => {
    const def = clone();
    def.intro = { heroImages: { S: 'ftp://cdn.example.com/s.webp' } };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('intro.heroImages') && e.includes('https://'))).toBe(true);
  });

  it('intro.heroImages がオブジェクトでない → エラー', () => {
    const def = clone();
    def.intro = { heroImages: [] };
    expect(validateDefinition(def).some((e: string) => e.includes('intro.heroImages'))).toBe(true);
  });

  it('F4: スペース入りタグの lookup で誤った重複検出が起きない', () => {
    // keyTags ["a","b","a b"]。名前連結方式だと {a,b} と {a b} が衝突するが
    // インデックス連結では別物。重複エラーが出ないことを確認(網羅不足エラーは別途出る)。
    const def: any = {
      meta: { name: 'T', description: 'T' },
      axes: [{ id: 'x', label: 'X' }],
      answerScale: { min: 1, max: 5, labels: ['1', '2', '3', '4', '5'] },
      questions: [{ id: 'q', axisId: 'x', text: 't', direction: 'worry', worryTag: 'a' }],
      scoring: {
        tagThreshold: 2,
        severityTags: [],
        tagMerges: {},
        axisGrades: {
          keep: { min: 4, label: '', meaning: '' },
          almost: { min: 3, label: '', meaning: '' },
          warn: { min: null, label: '', meaning: '' },
        },
        ranks: [{ rank: 'D', min: 0, title: '', subcopy: '', body: '' }],
      },
      recommendation: {
        maxTotal: 3,
        maxPerAxis: 1,
        resolvers: {
          x: {
            type: 'lookup',
            keyTags: ['a', 'b', 'a b'],
            table: [
              { key: ['a b'], title: 'AB', priceExTax: 1, extras: [] },
              { key: ['a', 'b'], title: 'A-B', priceExTax: 2, extras: [] },
            ],
            reasonTemplate: 'r',
            extrasTemplate: 'e',
          },
        },
        noteRules: [],
      },
      resultPage: { taxRate: 0.1 },
    };
    const errors = validateDefinition(def);
    expect(errors.some((e: string) => e.includes('重複する組み合わせ'))).toBe(false);
  });
});
