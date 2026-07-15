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
