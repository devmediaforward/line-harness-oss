import { describe, it, expect } from 'vitest';
import redentJson from '@line-crm/db/seeds/redent-diagnosis.json';
import { runDiagnosis } from './engine.js';
import { keyTagSignature } from './signature.js';
import type {
  DiagnosisAnswers,
  DiagnosisDefinition,
  LookupResolver,
  PriorityRulesResolver,
  ResolverCard,
} from '@line-crm/shared';

// シード定義(packages/db/seeds/redent-diagnosis.json)を読み込んでテストする。
const def = redentJson as unknown as DiagnosisDefinition;

// =============================================================================
// テストヘルパー
// =============================================================================

/** 全問デフォルト値(=1: 当てはまらない=悩みなし)+ 一部上書き */
function answersWith(overrides: Record<string, number> = {}): DiagnosisAnswers {
  const answers: DiagnosisAnswers = {};
  for (const q of def.questions) answers[q.id] = 1;
  return { ...answers, ...overrides };
}

/** 全問同一値 */
function uniformAnswers(value: number): DiagnosisAnswers {
  const answers: DiagnosisAnswers = {};
  for (const q of def.questions) answers[q.id] = value;
  return answers;
}

/** worryTag → その悩みを立てる設問id(answer=5 で clean_point=1 → タグ点灯) */
const TAG_QUESTION: Record<string, string> = {
  '顔(ヒゲ)': 'T1',
  胴体: 'T8',
  腕: 'T4',
  脇: 'T3',
  VIO: 'T7',
  脚: 'T5',
};

/** body の keyTags 集合をちょうど点灯させる回答 */
function bodyKeyAnswers(keys: string[]): DiagnosisAnswers {
  const overrides: Record<string, number> = {};
  for (const k of keys) overrides[TAG_QUESTION[k]] = 5;
  return answersWith(overrides);
}

function lookupResolver(axisId: string): LookupResolver {
  const r = def.recommendation.resolvers[axisId];
  if (r.type !== 'lookup') throw new Error(`resolver ${axisId} は lookup ではありません`);
  return r;
}

function priorityResolver(axisId: string): PriorityRulesResolver {
  const r = def.recommendation.resolvers[axisId];
  if (r.type !== 'priorityRules') throw new Error(`resolver ${axisId} は priorityRules ではありません`);
  return r;
}

function skinRuleCard(id: string): ResolverCard {
  const rule = priorityResolver('skin').rules.find((r) => r.id === id);
  if (!rule?.card) throw new Error(`skin rule ${id} の card が見つかりません`);
  return rule.card;
}

function skinSingleCard(tagRef: string): ResolverCard {
  const single = priorityResolver('skin').rules.find((r) => r.id === 'single');
  const card = single?.cardByTag?.[tagRef];
  if (!card) throw new Error(`skin single cardByTag[${tagRef}] が見つかりません`);
  return card;
}

// --- 総合点をピンポイントで作るための補助(軸ごとの clean_point 合計から回答を合成) ---

const AXIS_COUNTS = new Map<string, number>(
  def.axes.map((axis) => [axis.id, def.questions.filter((q) => q.axisId === axis.id).length]),
);

/** clean_point 合計 sum を n 問へ分配(各 1..max)。総合点は分配方法に依らず合計のみに依存 */
function distribute(sum: number, n: number): number[] {
  const { max } = def.answerScale;
  const cp = new Array<number>(n).fill(1);
  let remaining = sum - n;
  for (let i = 0; i < n && remaining > 0; i++) {
    const add = Math.min(max - 1, remaining);
    cp[i] += add;
    remaining -= add;
  }
  return cp;
}

/** 軸ごとの clean_point 合計から回答を合成(全問 worry 前提: answer = max+min-cp) */
function answersFromAxisSums(sums: Record<string, number>): DiagnosisAnswers {
  const { min, max } = def.answerScale;
  const answers: DiagnosisAnswers = {};
  for (const axis of def.axes) {
    const qs = def.questions.filter((q) => q.axisId === axis.id);
    const cp = distribute(sums[axis.id], qs.length);
    qs.forEach((q, i) => {
      answers[q.id] = q.direction === 'worry' ? max + min - cp[i] : cp[i];
    });
  }
  return answers;
}

/** エンジンと同一の式で raw 総合点(丸め前)を計算 */
function rawTotal(sums: Record<string, number>): number {
  const { min, max } = def.answerScale;
  let sigma = 0;
  for (const axis of def.axes) sigma += sums[axis.id] / (AXIS_COUNTS.get(axis.id) ?? 1);
  const m = sigma / def.axes.length;
  return ((m - min) / (max - min)) * 100;
}

/** round(raw)===target となる軸別 clean_point 合計を探索(境界値テスト用の入力生成) */
function sumsForTotal(target: number): Record<string, number> {
  const { max } = def.answerScale;
  const [b, s, br, h] = def.axes.map((a) => a.id);
  const cb = AXIS_COUNTS.get(b)!;
  const cs = AXIS_COUNTS.get(s)!;
  const cbr = AXIS_COUNTS.get(br)!;
  const ch = AXIS_COUNTS.get(h)!;
  for (let sb = cb; sb <= cb * max; sb++)
    for (let ss = cs; ss <= cs * max; ss++)
      for (let sbr = cbr; sbr <= cbr * max; sbr++)
        for (let sh = ch; sh <= ch * max; sh++) {
          const sums = { [b]: sb, [s]: ss, [br]: sbr, [h]: sh };
          if (Math.round(rawTotal(sums)) === target) return sums;
        }
  throw new Error(`総合点 ${target} を作る回答が見つかりません`);
}

// =============================================================================
// A. 採点基礎
// =============================================================================

describe('A. 採点基礎', () => {
  it('A1: worry 逆転 (answer=5 → cp=1, answer=1 → cp=5)', () => {
    const high = runDiagnosis(def, answersWith({ T1: 5 }));
    expect(high.cleanPoints.T1).toBe(1);
    const low = runDiagnosis(def, answersWith({ T1: 1 }));
    expect(low.cleanPoints.T1).toBe(5);
  });

  it('A2: 全問1(悩みなし) → 全軸5.0・総合100・S・タグ0・カード0・emptyState=true', () => {
    const res = runDiagnosis(def, answersWith());
    expect(res.axisScores.every((a) => a.score === 5.0)).toBe(true);
    expect(res.axisScores.every((a) => a.grade === 'keep')).toBe(true);
    expect(res.totalScore).toBe(100);
    expect(res.rank).toBe('S');
    expect(res.tags).toHaveLength(0);
    expect(res.cards).toHaveLength(0);
    expect(res.emptyState).toBe(true);
  });

  it('A3: 全問5(悩み最大) → 全軸1.0・総合0・D', () => {
    const res = runDiagnosis(def, uniformAnswers(5));
    expect(res.axisScores.every((a) => a.score === 1.0)).toBe(true);
    expect(res.totalScore).toBe(0);
    expect(res.rank).toBe('D');
  });

  it('A4: タグしきい値境界 (cp=2 でタグが立ち、cp=3 で立たない)', () => {
    // T3(脇, worry): answer=4 → cp=2 (立つ), answer=3 → cp=3 (立たない)
    const on = runDiagnosis(def, answersWith({ T3: 4 }));
    expect(on.tags.some((t) => t.tag === '脇')).toBe(true);
    const off = runDiagnosis(def, answersWith({ T3: 3 }));
    expect(off.tags.some((t) => t.tag === '脇')).toBe(false);
  });

  it('A5: ニキビ肌の重症度保持 (S1=5→point1, S1=4→point2)', () => {
    const p1 = runDiagnosis(def, answersWith({ S1: 5 }));
    expect(p1.tags.find((t) => t.tag === 'ニキビ肌')?.point).toBe(1);
    const p2 = runDiagnosis(def, answersWith({ S1: 4 }));
    expect(p2.tags.find((t) => t.tag === 'ニキビ肌')?.point).toBe(2);
    // 注: シードで ニキビ肌 を付与する設問は S1 のみ。複数設問由来の最悪値集約は
    //     エンジン実装(Math.min)で担保、seed では再現不可のためコメントに留める。
  });

  it('A6: 手・指→腕 の合算 (T9 のみ悩み → 腕タグとして脱毛判定)', () => {
    const res = runDiagnosis(def, answersWith({ T9: 5 }));
    expect(res.tags.some((t) => t.tag === '腕')).toBe(true);
    expect(res.tags.some((t) => t.tag === '手・指')).toBe(false);
    const card = res.cards.find((c) => c.axisId === 'body');
    expect(card?.title).toBe('腕');
    expect(card?.priceExTax).toBe(7000);
  });
});

// =============================================================================
// B. ランク・軸
// =============================================================================

describe('B. ランク・軸', () => {
  it('B1: ランク境界全点 0/19/20/39/40/59/60/79/80/100 → D/D/C/C/B/B/A/A/S/S', () => {
    const cases: Array<[number, string]> = [
      [0, 'D'],
      [19, 'D'],
      [20, 'C'],
      [39, 'C'],
      [40, 'B'],
      [59, 'B'],
      [60, 'A'],
      [79, 'A'],
      [80, 'S'],
      [100, 'S'],
    ];
    for (const [total, rank] of cases) {
      const sums = sumsForTotal(total);
      const res = runDiagnosis(def, answersFromAxisSums(sums));
      expect(res.totalScore, `total ${total}`).toBe(total);
      expect(res.rank, `total ${total} → rank`).toBe(rank);
    }
  });

  it('B2: 丸め — raw が [19.5,20) の値 → round=20 → C(丸め後判定)', () => {
    const sums = sumsForTotal(20);
    const raw = rawTotal(sums);
    // 20 は整数では到達不能(必ず丸めが発生する)。raw は 20 未満で切り上げられる。
    expect(raw).toBeGreaterThanOrEqual(19.5);
    expect(raw).toBeLessThan(20);
    const res = runDiagnosis(def, answersFromAxisSums(sums));
    expect(res.totalScore).toBe(20);
    expect(res.rank).toBe('C');
  });

  it('B3: ◎○△境界 (score=4.0→keep, <4.0→almost, 3.0→almost, <3.0→warn)', () => {
    // brow(B1/B2/B3) の clean_point を制御して境界を検証(>= 判定)
    const gradeOf = (overrides: Record<string, number>) =>
      runDiagnosis(def, answersWith(overrides)).axisScores.find((a) => a.axisId === 'brow')!;

    const keep = gradeOf({ B1: 2, B2: 2, B3: 2 }); // cp=4,4,4 → 4.0
    expect(keep.score).toBe(4.0);
    expect(keep.grade).toBe('keep');

    const almostHigh = gradeOf({ B1: 2, B2: 2, B3: 3 }); // cp=4,4,3 → 3.67 (<4.0)
    expect(almostHigh.grade).toBe('almost');

    const almostLow = gradeOf({ B1: 3, B2: 3, B3: 3 }); // cp=3,3,3 → 3.0
    expect(almostLow.score).toBe(3.0);
    expect(almostLow.grade).toBe('almost');

    const warn = gradeOf({ B1: 3, B2: 3, B3: 4 }); // cp=3,3,2 → 2.67 (<3.0)
    expect(warn.grade).toBe('warn');
  });

  it('B4: 弱点同点タイブレーク (全軸同点 → axes 順 [body,skin,brow,hair])', () => {
    const res = runDiagnosis(def, answersWith());
    expect(res.weakestAxes).toEqual(['body', 'skin', 'brow', 'hair']);
  });

  it('B5: 4軸均等 (設問数の多い体毛だけ悪化しても総合点が体毛に支配されない)', () => {
    // body 全問悪(mean1)・他軸全問良(mean5) → 均等平均 M=(1+5+5+5)/4=4.0 → 75点(A)
    const overrides: Record<string, number> = {};
    for (const q of def.questions) if (q.axisId === 'body') overrides[q.id] = 5;
    const res = runDiagnosis(def, answersWith(overrides));
    expect(res.totalScore).toBe(75);
    expect(res.rank).toBe('A');
    // 設問数重み付けなら (9*1+7*5+3*5+6*5)/25=3.56 → 64点相当。均等扱いで支配されないことを確認。
  });
});

// =============================================================================
// C. 脱毛ルックアップ(最重要)
// =============================================================================

describe('C. 脱毛ルックアップ', () => {
  const bodyTable = lookupResolver('body').table;

  it.each(bodyTable.map((row) => [row.key.join('+'), row] as const))(
    'C1: 63通り全件 — [%s] の key だけ点灯 → title/priceExTax/extras が行と一致',
    (_label, row) => {
      const res = runDiagnosis(def, bodyKeyAnswers(row.key));
      const card = res.cards.find((c) => c.axisId === 'body');
      expect(card).toBeDefined();
      expect(card!.title).toBe(row.title);
      expect(card!.priceExTax).toBe(row.priceExTax);
      expect(card!.extras).toEqual(row.extras);
    },
  );

  it('C1補: table は 63 行 = 2^6-1', () => {
    expect(bodyTable).toHaveLength(63);
  });

  it('C2: 胴体・腕 → 全身C ¥16,000', () => {
    const card = runDiagnosis(def, bodyKeyAnswers(['胴体', '腕'])).cards.find((c) => c.axisId === 'body');
    expect(card?.title).toBe('全身C');
    expect(card?.priceExTax).toBe(16000);
  });

  it('C3: 胴体・腕・脇 → 全身C ¥16,000', () => {
    const card = runDiagnosis(def, bodyKeyAnswers(['胴体', '腕', '脇'])).cards.find(
      (c) => c.axisId === 'body',
    );
    expect(card?.title).toBe('全身C');
    expect(card?.priceExTax).toBe(16000);
  });

  it('C4: ガードレール — 全行の extras に 顔(ヒゲ)/VIO が含まれない', () => {
    for (const row of bodyTable) {
      expect(row.extras).not.toContain('顔(ヒゲ)');
      expect(row.extras).not.toContain('VIO');
    }
  });

  it('C5: 自己処理トラブル + 部位あり → カードに appeal 文が付く', () => {
    const res = runDiagnosis(def, answersWith({ T6: 5, T1: 5 })); // 自己処理 + 顔
    const card = res.cards.find((c) => c.axisId === 'body');
    expect(card?.appeal).toBe(lookupResolver('body').specialTags!['自己処理トラブル'].appealText);
  });

  it('C6: 自己処理トラブル単独(部位0) → カード無し + axisMessages に soloMessage', () => {
    const res = runDiagnosis(def, answersWith({ T6: 5 }));
    expect(res.cards.some((c) => c.axisId === 'body')).toBe(false);
    const soloMessage = lookupResolver('body').specialTags!['自己処理トラブル'].soloMessage;
    expect(res.axisMessages).toContainEqual({ axisId: 'body', message: soloMessage });
  });

  it('C7: 顔(ヒゲ)を含む行(extrasなし)→ reason が reasonByTag の顔用文になる', () => {
    const res = runDiagnosis(def, bodyKeyAnswers(['顔(ヒゲ)']));
    const card = res.cards.find((c) => c.axisId === 'body');
    expect(card?.reason).toBe(lookupResolver('body').reasonByTag!['顔(ヒゲ)']);
  });
});

// =============================================================================
// D. 肌ルール(§7.2)
// =============================================================================

describe('D. 肌ルール', () => {
  const skinCardOf = (overrides: Record<string, number>) =>
    runDiagnosis(def, answersWith(overrides)).cards.find((c) => c.axisId === 'skin');

  it('D1: ニキビ肌@1 → 徹底改善コース ¥15,000 (他タグ併存でも)', () => {
    const card = skinCardOf({ S1: 5, S2: 5 }); // ニキビ肌@1 + 毛穴 併存
    expect(card?.title).toBe(skinRuleCard('acne-severe').title);
    expect(card?.priceExTax).toBe(15000);
  });

  it('D2: ニキビ肌@1 + 乾燥・敏感 → コース + 要カウンセリング注記', () => {
    const card = skinCardOf({ S1: 5, S4: 5 });
    expect(card?.priceExTax).toBe(15000);
    const note = priorityResolver('skin').rules.find((r) => r.id === 'acne-severe')!
      .conditionalNotes![0].note;
    expect(card?.notes).toContain(note);
  });

  it('D3: 乾燥・敏感(+毛穴併存) → 光フェイシャル＋保湿 (ピーリング系を出さない=B7)', () => {
    const card = skinCardOf({ S4: 5, S2: 5 });
    expect(card?.title).toBe(skinRuleCard('sensitive').title);
    expect(card?.priceExTax).toBe(7000);
    expect(card?.title).not.toBe('ピーリング');
  });

  it('D4: 毛穴・ザラつき + 脂性・テカリ → セット ¥12,000 (2グループまたぎ)', () => {
    const card = skinCardOf({ S2: 5, S3: 5 });
    expect(card?.title).toBe(skinRuleCard('combo').title);
    expect(card?.priceExTax).toBe(12000);
  });

  it('D5: ニキビ跡 + 他1タグ → 常にセット ¥12,000', () => {
    for (const other of ['S2', 'S3'] as const) {
      const card = skinCardOf({ S7: 5, [other]: 5 });
      expect(card?.priceExTax, `S7 + ${other}`).toBe(12000);
    }
    // ニキビ跡 + ニキビ肌@2
    const card = skinCardOf({ S7: 5, S1: 4 });
    expect(card?.priceExTax).toBe(12000);
  });

  it('D6: 単一タグ4種それぞれ → 変換表どおりの単一メニュー', () => {
    const kore = skinCardOf({ S2: 5 }); // 毛穴・ザラつき
    expect(kore?.title).toBe(skinSingleCard('毛穴・ザラつき').title);
    expect(kore?.priceExTax).toBe(7000);

    const tekari = skinCardOf({ S3: 5 }); // 脂性・テカリ
    expect(tekari?.title).toBe(skinSingleCard('脂性・テカリ').title);
    expect(tekari?.priceExTax).toBe(7000);

    const ato = skinCardOf({ S7: 5 }); // ニキビ跡
    expect(ato?.title).toBe(skinSingleCard('ニキビ跡').title);
    expect(ato?.priceExTax).toBe(12000);

    const nikibi2 = skinCardOf({ S1: 4 }); // ニキビ肌@2
    expect(nikibi2?.title).toBe(skinSingleCard('ニキビ肌@2').title);
    expect(nikibi2?.priceExTax).toBe(8000);
  });

  it('D7: ニキビ肌@2 単独 → 光フェイシャル+ ¥8,000', () => {
    const card = skinCardOf({ S1: 4 });
    expect(card?.title).toBe('光フェイシャル+');
    expect(card?.priceExTax).toBe(8000);
  });

  it('D8: 肌カードは常に1枚以下', () => {
    const combos: Record<string, number>[] = [
      { S1: 5, S2: 5, S3: 5, S4: 5, S7: 5 },
      { S2: 5, S3: 5, S7: 5 },
      { S4: 5 },
    ];
    for (const c of combos) {
      const skinCards = runDiagnosis(def, answersWith(c)).cards.filter((x) => x.axisId === 'skin');
      expect(skinCards.length).toBeLessThanOrEqual(1);
    }
  });
});

// =============================================================================
// E. 髪・眉
// =============================================================================

describe('E. 髪・眉', () => {
  const hairCardOf = (overrides: Record<string, number>) =>
    runDiagnosis(def, answersWith(overrides)).cards.find((c) => c.axisId === 'hair');

  it('E1: 頭皮トラブル(脂性)あり → ヘッドスパ + さっぱり系助言', () => {
    const card = hairCardOf({ H5: 5 });
    expect(card?.title).toBe('ヘッドスパ');
    expect(card?.reason).toContain('さっぱり');
  });

  it('E2: 頭皮トラブルのみ(H2悩み・H5非悩み) → ヘッドスパ + 保湿系助言', () => {
    const card = hairCardOf({ H2: 5 });
    expect(card?.title).toBe('ヘッドスパ');
    expect(card?.reason).toContain('保湿');
  });

  it('E3: 髪のダメージ単独 → カード無し(TBD挙動)。ただし軸スコアには反映(△になり得る)', () => {
    // H3/H4/H6 を悩み(cp1)、H1/H2/H5 は cp3(頭皮タグを立てない)→ hair mean 2.0 = warn
    const res = runDiagnosis(def, answersWith({ H1: 3, H2: 3, H3: 5, H4: 5, H5: 3, H6: 5 }));
    expect(res.cards.some((c) => c.axisId === 'hair')).toBe(false);
    expect(res.tags.some((t) => t.tag === '髪のダメージ')).toBe(true);
    expect(res.axisScores.find((a) => a.axisId === 'hair')!.grade).toBe('warn');
  });

  it('E4: 眉タグ → 美眉スタイリング(学生) ¥4,000', () => {
    const res = runDiagnosis(def, answersWith({ B1: 5 }));
    const card = res.cards.find((c) => c.axisId === 'brow');
    expect(card?.title).toBe('美眉スタイリング(学生)');
    expect(card?.priceExTax).toBe(4000);
  });
});

// =============================================================================
// F. 集約・注記・空状態
// =============================================================================

describe('F. 集約・注記・空状態', () => {
  it('F1: 4軸全部カード成立 → 3枚採用・並び body→skin→brow、droppedCards=[hair]', () => {
    const res = runDiagnosis(def, answersWith({ T1: 5, S2: 5, B1: 5, H1: 5 }));
    expect(res.cards.map((c) => c.axisId)).toEqual(['body', 'skin', 'brow']);
    expect(res.droppedCards).toEqual(['hair']);
  });

  it('F2: 3軸成立(髪含む)→ 髪も採用される(落ちるのは超過時のみ)', () => {
    const res = runDiagnosis(def, answersWith({ T1: 5, S2: 5, H1: 5 }));
    expect(res.cards.map((c) => c.axisId)).toEqual(['body', 'skin', 'hair']);
    expect(res.droppedCards).toEqual([]);
    expect(res.cards.some((c) => c.axisId === 'hair')).toBe(true);
  });

  it('F3: noteRule1 (毛穴+顔) → 肌カードに税込注記', () => {
    const res = runDiagnosis(def, answersWith({ S2: 5, T1: 5 }));
    const skinCard = res.cards.find((c) => c.axisId === 'skin');
    expect(skinCard?.notes).toContain(def.recommendation.noteRules[0].note);
  });

  it('F4: noteRule2 (眉+体毛カード最終採用) → 眉に注記。体毛カード不在なら注記されない', () => {
    const note = def.recommendation.noteRules[1].note;
    // 眉+体毛 両方成立
    const both = runDiagnosis(def, answersWith({ T1: 5, B1: 5 }));
    expect(both.cards.find((c) => c.axisId === 'brow')?.notes).toContain(note);
    // 眉のみ(体毛カード不在)→ cardsPresent[brow,body] を満たさず注記されない
    const browOnly = runDiagnosis(def, answersWith({ B1: 5 }));
    expect(browOnly.cards.find((c) => c.axisId === 'brow')?.notes).not.toContain(note);
    // 注: このシード(4軸・maxTotal=3)では眉は常に上位3枚に入り「3枚制限で落ちる」状況は
    //     構造上発生しない。負のケースは体毛カード不在で cardsPresent ゲートを検証している。
  });

  it('F5: タグ1〜2件 → その枚数だけ(3枚に増やさない)', () => {
    const one = runDiagnosis(def, answersWith({ T1: 5 }));
    expect(one.cards).toHaveLength(1);
    const two = runDiagnosis(def, answersWith({ T1: 5, S2: 5 }));
    expect(two.cards).toHaveLength(2);
  });

  it('F6: 税込計算 (15000→16500, 7000→7700, priceSuffix "＋" 保持)', () => {
    const course = runDiagnosis(def, answersWith({ S1: 5 })).cards.find((c) => c.axisId === 'skin');
    expect(course?.priceExTax).toBe(15000);
    expect(course?.priceInTax).toBe(16500);

    const sensitive = runDiagnosis(def, answersWith({ S4: 5 })).cards.find((c) => c.axisId === 'skin');
    expect(sensitive?.priceExTax).toBe(7000);
    expect(sensitive?.priceInTax).toBe(7700);
    expect(sensitive?.priceSuffix).toBe('＋');

    const kao = runDiagnosis(def, bodyKeyAnswers(['顔(ヒゲ)'])).cards.find((c) => c.axisId === 'body');
    expect(kao?.priceInTax).toBe(7700);
  });
});

// =============================================================================
// G. 表示スナップショット(definition 由来文言の焼き込み)
// =============================================================================

describe('G. 表示スナップショット', () => {
  it('G1: diagnosisName / weakPointHeading / softCta / minorNotice を definition から複写', () => {
    const res = runDiagnosis(def, answersWith({ T1: 5 }));
    expect(res.diagnosisName).toBe(def.meta.name);
    expect(res.weakPointHeading).toBe(def.resultPage.weakPointHeading);
    expect(res.softCta).toEqual({
      text: def.resultPage.softCta.text,
      subText: def.resultPage.softCta.subText,
    });
    expect(res.minorNotice).toBe(def.resultPage.minorNotice);
  });

  it('G2: weakPoints — 全軸warn時、weakestAxes 順で text は weakPointTexts と一致', () => {
    const res = runDiagnosis(def, uniformAnswers(5)); // 全軸 1.0 → 全 warn
    expect(res.axisScores.every((a) => a.grade === 'warn')).toBe(true);
    expect(res.weakPoints?.map((w) => w.axisId)).toEqual(res.weakestAxes);
    for (const w of res.weakPoints ?? []) {
      expect(w.label).toBe(def.axes.find((a) => a.id === w.axisId)!.label);
      expect(w.text).toBe(def.resultPage.weakPointTexts[w.axisId] ?? null);
    }
  });

  it('G3: weakPoints — warn 軸のみ抽出(hair のみ warn)', () => {
    const res = runDiagnosis(def, answersWith({ H1: 3, H2: 3, H3: 5, H4: 5, H5: 3, H6: 5 }));
    expect(res.axisScores.find((a) => a.axisId === 'hair')!.grade).toBe('warn');
    expect(res.weakPoints?.map((w) => w.axisId)).toEqual(['hair']);
    expect(res.weakPoints?.[0].text).toBe(def.resultPage.weakPointTexts.hair);
  });

  it('G4: emptyStateTexts — 空状態(A2)で resultPage.emptyState を複写・weakPoints は空', () => {
    const res = runDiagnosis(def, answersWith()); // 全軸 5.0 keep・タグ0
    expect(res.emptyState).toBe(true);
    expect(res.emptyStateTexts).toEqual({
      message: def.resultPage.emptyState.message,
      cta: def.resultPage.emptyState.cta,
    });
    expect(res.weakPoints).toEqual([]);
  });
});

// =============================================================================
// H. ランク画像の焼き込み(R6)
// =============================================================================

describe('H. ランク画像の焼き込み (R6)', () => {
  function defWithRankImages(images: Record<string, string>): DiagnosisDefinition {
    const cloned = JSON.parse(JSON.stringify(def)) as DiagnosisDefinition;
    (cloned.resultPage as { rankImages?: Record<string, string> }).rankImages = images;
    return cloned;
  }

  it('H1: 該当ランクの画像URLを result.rankImageUrl に焼き込む', () => {
    const d = defWithRankImages({ S: 'https://img.example.com/s.png', D: 'https://img.example.com/d.png' });
    const res = runDiagnosis(d, answersWith()); // 全問1 → S
    expect(res.rank).toBe('S');
    expect(res.rankImageUrl).toBe('https://img.example.com/s.png');
  });

  it('H2: rankImages 自体が無ければ rankImageUrl は付かない(後方互換)', () => {
    const res = runDiagnosis(def, answersWith());
    expect(res.rankImageUrl).toBeUndefined();
  });

  it('H3: 該当ランクのエントリが無ければ rankImageUrl は付かない', () => {
    const d = defWithRankImages({ D: 'https://img.example.com/d.png' }); // S は無い
    const res = runDiagnosis(d, answersWith()); // 全問1 → S
    expect(res.rank).toBe('S');
    expect(res.rankImageUrl).toBeUndefined();
  });
});

describe('I. 割引・予約の焼き込み (I4/I5)', () => {
  /** resultPage に discount / booking を差し込んだ定義を作る */
  function defWithResultPage(patch: Record<string, unknown>): DiagnosisDefinition {
    const cloned = JSON.parse(JSON.stringify(def)) as DiagnosisDefinition;
    Object.assign(cloned.resultPage as unknown as Record<string, unknown>, patch);
    return cloned;
  }

  const cardAnswers = bodyKeyAnswers(['胴体', '腕']); // body カードが必ず1枚出る回答

  it('I1: discountedPriceInTax = floor(priceInTax * (1 - rate))', () => {
    const d = defWithResultPage({ discount: { rate: 0.4 } });
    const res = runDiagnosis(d, cardAnswers);
    expect(res.cards.length).toBeGreaterThan(0);
    for (const card of res.cards) {
      expect(card.discountedPriceInTax).toBe(Math.floor(card.priceInTax * (1 - 0.4)));
    }
  });

  it('I2: 円未満は切り捨て(四捨五入しない)', () => {
    // floor と round が食い違う価格を作って切り捨てであることを確定させる。
    // priceExTax=10005 / taxRate=0.1 → priceInTax=round(11005.5)=11006
    // → 11006 * 0.6 = 6603.6 → floor=6603 / round=6604
    const d = defWithResultPage({ discount: { rate: 0.4 } });
    const bodyResolver = d.recommendation.resolvers.body;
    if (bodyResolver.type !== 'lookup') throw new Error('body resolver は lookup ではありません');
    const row = bodyResolver.table.find(
      (r) => r.key.length === 2 && r.key.includes('胴体') && r.key.includes('腕'),
    );
    expect(row).toBeDefined();
    row!.priceExTax = 10005;

    const card = runDiagnosis(d, cardAnswers).cards.find((c) => c.axisId === 'body');
    expect(card).toBeDefined();
    expect(card!.priceInTax).toBe(11006);
    expect(card!.discountedPriceInTax).toBe(6603); // floor。round なら 6604
  });

  it('I3: discount 未設定なら discountedPriceInTax も result.discount も付かない(後方互換)', () => {
    const res = runDiagnosis(def, cardAnswers);
    expect(res.cards.length).toBeGreaterThan(0);
    for (const card of res.cards) {
      expect(card.discountedPriceInTax).toBeUndefined();
    }
    expect(res.discount).toBeUndefined();
  });

  it('I4: result.discount にラベル類をスナップショット', () => {
    const d = defWithResultPage({
      discount: { rate: 0.4, badgeLabel: 'B', conditionLabel: 'C', notice: 'N' },
    });
    const res = runDiagnosis(d, cardAnswers);
    expect(res.discount).toEqual({ rate: 0.4, badgeLabel: 'B', conditionLabel: 'C', notice: 'N' });
  });

  it('I5: rate が範囲外(0 / 1 / 負)なら割引は焼き込まれない', () => {
    for (const rate of [0, 1, -0.2, 1.5]) {
      const res = runDiagnosis(defWithResultPage({ discount: { rate } }), cardAnswers);
      expect(res.discount).toBeUndefined();
      for (const card of res.cards) expect(card.discountedPriceInTax).toBeUndefined();
    }
  });

  it('I6: booking を result.booking へ焼き込む', () => {
    const d = defWithResultPage({
      booking: { url: 'https://booking.example.com/reserve', label: 'L', subText: 'S' },
    });
    const res = runDiagnosis(d, cardAnswers);
    expect(res.booking).toEqual({ url: 'https://booking.example.com/reserve', label: 'L', subText: 'S' });
  });

  it('I7: booking の label / subText は任意(url のみでも焼き込む)', () => {
    const d = defWithResultPage({ booking: { url: 'https://booking.example.com/reserve' } });
    const res = runDiagnosis(d, cardAnswers).booking;
    expect(res).toEqual({ url: 'https://booking.example.com/reserve' });
  });

  it('I8: booking 未設定なら result.booking は付かない(後方互換)', () => {
    expect(runDiagnosis(def, cardAnswers).booking).toBeUndefined();
  });

  it('I9: booking.url が https 以外なら焼き込まない(保存済み定義の実行時防御)', () => {
    for (const url of [
      'javascript:alert(1)',
      'http://booking.example.com/reserve',
      'data:text/html,x',
      'https://',
      '',
      123,
    ]) {
      const d = defWithResultPage({ booking: { url, label: 'L' } });
      expect(runDiagnosis(d, cardAnswers).booking).toBeUndefined();
    }
  });

  it('I10: 数学上の整数になる割引額が浮動小数点誤差で1円下振れしない', () => {
    // priceExTax=1173 / taxRate=0.1 → priceInTax=round(1290.3)=1290
    // 1290 * (1 - 0.3) は数学的に 903 ちょうどだが、IEEE754 では 902.9999999999999
    // となり素の Math.floor だと 902 に落ちる。イプシロン補正で 903 になること。
    expect(Math.floor(1290 * (1 - 0.3))).toBe(902); // 誤差が実在することの確認
    const d = defWithResultPage({ discount: { rate: 0.3 } });
    const bodyResolver = d.recommendation.resolvers.body;
    if (bodyResolver.type !== 'lookup') throw new Error('body resolver は lookup ではありません');
    const row = bodyResolver.table.find(
      (r) => r.key.length === 2 && r.key.includes('胴体') && r.key.includes('腕'),
    );
    expect(row).toBeDefined();
    row!.priceExTax = 1173;

    const card = runDiagnosis(d, cardAnswers).cards.find((c) => c.axisId === 'body');
    expect(card?.priceInTax).toBe(1290);
    expect(card?.discountedPriceInTax).toBe(903);
  });
});

// =============================================================================
// 入力検証(Step 1)
// =============================================================================

describe('入力検証', () => {
  it('回答不足はエラー', () => {
    const incomplete = answersWith();
    delete incomplete.T1;
    expect(() => runDiagnosis(def, incomplete)).toThrow();
  });

  it('範囲外の回答値はエラー', () => {
    expect(() => runDiagnosis(def, answersWith({ T1: 6 }))).toThrow();
  });

  it('未知の設問キーはエラー', () => {
    expect(() => runDiagnosis(def, answersWith({ ZZZ: 3 }))).toThrow();
  });
});

// =============================================================================
// F4: シグネチャ衝突回避(スペース入りタグ)— engine と validate が同じ関数を共有
// =============================================================================

/** keyTags ["a","b","a b"]: 名前をスペース連結すると {a,b} と {a b} が衝突する組 */
function spaceTagLookupDefinition(): DiagnosisDefinition {
  return {
    meta: { name: 'T', description: 'T' },
    axes: [{ id: 'x', label: 'X' }],
    answerScale: { min: 1, max: 5, labels: ['1', '2', '3', '4', '5'] },
    questions: [
      { id: 'qa', axisId: 'x', text: 'a', direction: 'worry', worryTag: 'a' },
      { id: 'qb', axisId: 'x', text: 'b', direction: 'worry', worryTag: 'b' },
      { id: 'qab', axisId: 'x', text: 'ab', direction: 'worry', worryTag: 'a b' },
    ],
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
          // "AB-single"(key=["a b"])を先に置く: 旧スペース連結だと {a,b} が誤ヒットする配置
          table: [
            { key: ['a b'], title: 'AB-single', priceExTax: 100, extras: [] },
            { key: ['a', 'b'], title: 'A-and-B', priceExTax: 200, extras: [] },
          ],
          reasonTemplate: 'r',
          extrasTemplate: 'e',
        },
      },
      noteRules: [],
    },
    resultPage: {
      taxRate: 0.1,
      weakPointHeading: '',
      weakPointTexts: {},
      softCta: { text: '', subText: '' },
      minorNotice: '',
      emptyState: { message: '', cta: '' },
    },
    share: {
      enabled: false,
      ogImages: {},
      ogTitleTemplate: '',
      ogDescription: '',
      addFriendUrl: '',
      liffUrl: '',
      shareText: '',
    },
    sideEffects: { sendResultMessage: false, addTags: false, enrollScenarioId: null, saveToMetadata: false },
  };
}

describe('F4: シグネチャ衝突回避', () => {
  it('keyTagSignature: {a,b} と {a b} が異なるシグネチャになる', () => {
    const keyTags = ['a', 'b', 'a b'];
    const sigAB = keyTagSignature(['a', 'b'], keyTags);
    const sigSpace = keyTagSignature(['a b'], keyTags);
    expect(sigAB).not.toBe(sigSpace);
    // 出力は数値インデックスのみ(スペース・NUL 等の制御文字を含まない)
    // 完全一致で固定 → スペース/NUL 等が混入しないことも同時に保証
    expect(sigAB).toBe('0,1');
    expect(sigSpace).toBe('2');
  });

  it('順不同でも同じ組は同じシグネチャ', () => {
    const keyTags = ['a', 'b', 'a b'];
    expect(keyTagSignature(['a', 'b'], keyTags)).toBe(keyTagSignature(['b', 'a'], keyTags));
  });

  it('エンジン: {a,b} 点灯 → A-and-B(AB-single に誤ヒットしない)', () => {
    const spaceDef = spaceTagLookupDefinition();
    const res = runDiagnosis(spaceDef, { qa: 5, qb: 5, qab: 1 });
    expect(res.cards.find((c) => c.axisId === 'x')?.title).toBe('A-and-B');
  });

  it('エンジン: {a b} 単独点灯 → AB-single', () => {
    const spaceDef = spaceTagLookupDefinition();
    const res = runDiagnosis(spaceDef, { qa: 1, qb: 1, qab: 5 });
    expect(res.cards.find((c) => c.axisId === 'x')?.title).toBe('AB-single');
  });
});
