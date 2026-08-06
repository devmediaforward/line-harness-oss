// =============================================================================
// 診断定義JSON バリデータ
//
// 入力は unknown(パース済みJSON)。人間が読める日本語エラーメッセージの配列を返す。
// 空配列 = 妥当。zod 等の新規依存は追加しない(手書き)。
//
// 目的: 管理画面から任意JSONが入る前提で「バリデータ通過 = エンジンが型エラーで
// 落ちない」ことを保証する。03_definition-schema.md の必須検査8項目に加え、
// 構造(セクション存在・型・条件DSLの値型・リゾルバ/カード/ランクの形)を検査する。
// 集合シグネチャは signature.ts を engine.ts と共有する(重複定義禁止)。
// =============================================================================

import { keyTagSignature } from './signature.js';
import { isHttpsUrl } from './url.js';

type Obj = Record<string, unknown>;

/** keyTags 数の上限(2^12-1=4095 行。超過は網羅走査に入らず即エラー = DoS 対策) */
const KEYTAGS_MAX = 12;
/** 条件DSL の再帰深度上限(スタックオーバーフロー対策) */
const MAX_CONDITION_DEPTH = 10;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** 価格として妥当か(有限かつ非負)。負の価格は割引表示で破綻するため弾く。 */
function isNonNegativeFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

const KNOWN_CONDITION_KEYS = new Set([
  'hasTag',
  'hasAnyTag',
  'hasTagWithPoint',
  'spansGroups',
  'always',
  'and',
  'not',
  'cardsPresent',
]);

/**
 * カード(固定 card / cardByTag 値)の形を検査。
 * allowNull=true のときのみ null を許容(明示的なカード無し = 固定 card 用)。
 * cardByTag の値は null 不可(engine の toResultCard が TypeError になるため)。
 */
function validateCard(card: unknown, path: string, errors: string[], allowNull: boolean): void {
  if (card === null) {
    if (!allowNull) errors.push(`${path} は null にできません(カードが必要です)`);
    return;
  }
  if (!isObj(card)) {
    errors.push(`${path} は${allowNull ? ' null または' : ''}オブジェクトである必要があります`);
    return;
  }
  if (typeof card.title !== 'string') errors.push(`${path}.title は文字列である必要があります`);
  if (!isNonNegativeFinite(card.priceExTax)) {
    errors.push(`${path}.priceExTax は 0 以上の有限な数値である必要があります`);
  }
  if (typeof card.reason !== 'string') errors.push(`${path}.reason は文字列である必要があります`);
  if ('priceSuffix' in card && typeof card.priceSuffix !== 'string') {
    errors.push(`${path}.priceSuffix は文字列である必要があります`);
  }
}

/** 条件DSL: 未知キー検出 + 既知キーちょうど1個 + 各キーの値型 + 再帰深度上限 */
function walkCondition(cond: unknown, path: string, errors: string[], depth: number): void {
  if (depth > MAX_CONDITION_DEPTH) {
    errors.push(`条件のネストが深すぎます(${path})`);
    return;
  }
  if (!isObj(cond)) {
    errors.push(`条件が不正です(${path})`);
    return;
  }
  const keys = Object.keys(cond);
  for (const k of keys) {
    if (!KNOWN_CONDITION_KEYS.has(k)) errors.push(`未知の条件キーです: "${k}"(${path})`);
  }
  // エンジンは最初にマッチした1条件しか評価しないため、既知キーは「ちょうど1個」に強制。
  const knownPresent = keys.filter((k) => KNOWN_CONDITION_KEYS.has(k));
  if (knownPresent.length === 0) {
    errors.push(`条件に既知のキーがありません(${path})`);
  } else if (knownPresent.length > 1) {
    errors.push(`条件の既知キーは1つだけにしてください(${path}): ${knownPresent.join(', ')}`);
  }

  if ('hasTag' in cond && typeof cond.hasTag !== 'string') {
    errors.push(`hasTag は文字列である必要があります(${path})`);
  }
  if ('hasAnyTag' in cond && !isStringArray(cond.hasAnyTag)) {
    errors.push(`hasAnyTag は文字列配列である必要があります(${path})`);
  }
  if ('hasTagWithPoint' in cond) {
    const v = cond.hasTagWithPoint;
    if (!isObj(v) || typeof v.tag !== 'string' || !isInteger(v.point)) {
      errors.push(`hasTagWithPoint は {tag:文字列, point:整数} である必要があります(${path})`);
    }
  }
  if ('spansGroups' in cond) {
    const v = cond.spansGroups;
    if (!isObj(v) || !isStringArray(v.groupA) || !isStringArray(v.groupB) || typeof v.minTags !== 'number') {
      errors.push(
        `spansGroups は {groupA:文字列配列, groupB:文字列配列, minTags:数値} である必要があります(${path})`,
      );
    }
  }
  if ('always' in cond && cond.always !== true) {
    errors.push(`always は true である必要があります(${path})`);
  }
  if ('cardsPresent' in cond && !isStringArray(cond.cardsPresent)) {
    errors.push(`cardsPresent は文字列配列である必要があります(${path})`);
  }
  if ('and' in cond) {
    if (!Array.isArray(cond.and)) errors.push(`and は条件配列である必要があります(${path})`);
    else cond.and.forEach((sub, i) => walkCondition(sub, `${path}.and[${i}]`, errors, depth + 1));
  }
  if ('not' in cond) {
    walkCondition(cond.not, `${path}.not`, errors, depth + 1);
  }
}

/** lookup リゾルバ: 構造検査 + 検査2(網羅/部分集合/extras非交差)。keyTags を allKeyTags へ集約 */
function validateLookupResolver(
  axisId: string,
  resolver: Obj,
  errors: string[],
  allKeyTags: Set<string>,
): void {
  const keyTags = isStringArray(resolver.keyTags) ? resolver.keyTags : [];
  if (!isStringArray(resolver.keyTags)) {
    errors.push(`リゾルバ[${axisId}].keyTags が文字列配列ではありません`);
  }
  // keyTags 自体の重複
  const seenKeyTag = new Set<string>();
  for (const t of keyTags) {
    if (seenKeyTag.has(t)) errors.push(`リゾルバ[${axisId}].keyTags にタグ "${t}" が重複しています`);
    seenKeyTag.add(t);
    allKeyTags.add(t);
  }
  if (typeof resolver.reasonTemplate !== 'string') {
    errors.push(`リゾルバ[${axisId}].reasonTemplate は文字列である必要があります`);
  }
  if (typeof resolver.extrasTemplate !== 'string') {
    errors.push(`リゾルバ[${axisId}].extrasTemplate は文字列である必要があります`);
  }
  // reasonByTag: 各値が文字列
  if ('reasonByTag' in resolver) {
    if (!isObj(resolver.reasonByTag)) {
      errors.push(`リゾルバ[${axisId}].reasonByTag はオブジェクトである必要があります`);
    } else {
      for (const [tag, v] of Object.entries(resolver.reasonByTag)) {
        if (typeof v !== 'string') {
          errors.push(`リゾルバ[${axisId}].reasonByTag["${tag}"] は文字列である必要があります`);
        }
      }
    }
  }
  // specialTags: 各値が {mode:'appeal', appealText:文字列, soloMessage:文字列}
  if ('specialTags' in resolver) {
    if (!isObj(resolver.specialTags)) {
      errors.push(`リゾルバ[${axisId}].specialTags はオブジェクトである必要があります`);
    } else {
      for (const [tag, cfg] of Object.entries(resolver.specialTags)) {
        if (!isObj(cfg)) {
          errors.push(`リゾルバ[${axisId}].specialTags["${tag}"] がオブジェクトではありません`);
          continue;
        }
        if (cfg.mode !== 'appeal') {
          errors.push(`リゾルバ[${axisId}].specialTags["${tag}"].mode は "appeal" である必要があります`);
        }
        if (typeof cfg.appealText !== 'string') {
          errors.push(`リゾルバ[${axisId}].specialTags["${tag}"].appealText は文字列である必要があります`);
        }
        if (typeof cfg.soloMessage !== 'string') {
          errors.push(`リゾルバ[${axisId}].specialTags["${tag}"].soloMessage は文字列である必要があります`);
        }
      }
    }
  }

  if (!Array.isArray(resolver.table)) {
    errors.push(`リゾルバ[${axisId}].table が配列ではありません`);
    return;
  }
  const table = resolver.table;

  if (keyTags.length > KEYTAGS_MAX) {
    errors.push(`リゾルバ[${axisId}].keyTags が多すぎます(${keyTags.length} > ${KEYTAGS_MAX})`);
  }

  const keyTagSet = new Set(keyTags);
  const seen = new Map<string, { count: number; sample: string[] }>();

  for (const rowRaw of table) {
    if (!isObj(rowRaw)) {
      errors.push(`リゾルバ[${axisId}] の table に不正な行があります`);
      continue;
    }
    if (typeof rowRaw.title !== 'string') {
      errors.push(`リゾルバ[${axisId}] の table 行の title が文字列ではありません`);
    }
    if (!isNonNegativeFinite(rowRaw.priceExTax)) {
      errors.push(`リゾルバ[${axisId}] の table 行の priceExTax が 0 以上の有限な数値ではありません`);
    }
    if (!isStringArray(rowRaw.extras)) {
      errors.push(`リゾルバ[${axisId}] の table 行の extras が文字列配列ではありません`);
    }
    const key = isStringArray(rowRaw.key) ? rowRaw.key : [];
    const extras = isStringArray(rowRaw.extras) ? rowRaw.extras : [];
    if (!isStringArray(rowRaw.key) || key.length === 0) {
      errors.push(`リゾルバ[${axisId}] の table 行の key が空でない文字列配列ではありません`);
      continue;
    }
    const seenInKey = new Set<string>();
    for (const k of key) {
      if (seenInKey.has(k)) {
        errors.push(`リゾルバ[${axisId}] の table 行の key にタグ "${k}" が重複しています`);
      }
      seenInKey.add(k);
      if (!keyTagSet.has(k)) {
        errors.push(`リゾルバ[${axisId}] の table の key "${k}" が keyTags に含まれません`);
      }
    }
    for (const e of extras) {
      if (key.includes(e)) {
        errors.push(`リゾルバ[${axisId}] の table で extras と key が交差しています: "${e}"`);
      }
    }
    const sig = keyTagSignature(key, keyTags);
    const entry = seen.get(sig);
    if (entry) entry.count++;
    else seen.set(sig, { count: 1, sample: key });
  }

  // 全非空部分集合をちょうど1回ずつ網羅しているか(検査2)。keyTags が上限以内のときのみ走査。
  if (keyTags.length <= KEYTAGS_MAX) {
    const n = keyTags.length;
    const expected = Math.pow(2, n) - 1;
    const missing: string[] = [];
    for (let mask = 1; mask <= expected; mask++) {
      const subset = keyTags.filter((_t, i) => (mask >> i) & 1);
      const sig = keyTagSignature(subset, keyTags);
      if (!seen.has(sig)) missing.push(subset.join('+'));
    }
    if (missing.length > 0) {
      const shown = missing.slice(0, 5).join(', ');
      errors.push(
        `リゾルバ[${axisId}] の table が全組み合わせを網羅していません(不足 ${missing.length} 件: ${shown}${missing.length > 5 ? ' ほか' : ''})`,
      );
    }
  }
  for (const [, entry] of seen) {
    if (entry.count > 1) {
      errors.push(
        `リゾルバ[${axisId}] の table に重複する組み合わせがあります: "${entry.sample.join('+')}"(${entry.count}回)`,
      );
    }
  }
}

/** priorityRules リゾルバ: 構造検査 + 条件DSL検査 */
function validatePriorityRulesResolver(axisId: string, resolver: Obj, errors: string[]): void {
  if (!Array.isArray(resolver.rules)) {
    errors.push(`リゾルバ[${axisId}].rules が配列ではありません`);
    return;
  }
  resolver.rules.forEach((ruleRaw, ri) => {
    const base = `リゾルバ[${axisId}].rules[${ri}]`;
    if (!isObj(ruleRaw)) {
      errors.push(`${base} がオブジェクトではありません`);
      return;
    }
    if ('if' in ruleRaw) walkCondition(ruleRaw.if, `${base}.if`, errors, 0);
    else errors.push(`${base}.if がありません`);

    // 固定 card は null 許容、cardByTag の値は null 不可
    if ('card' in ruleRaw) validateCard(ruleRaw.card, `${base}.card`, errors, true);

    if ('cardByTag' in ruleRaw) {
      if (!isObj(ruleRaw.cardByTag)) {
        errors.push(`${base}.cardByTag はオブジェクトである必要があります`);
      } else {
        for (const [tag, c] of Object.entries(ruleRaw.cardByTag)) {
          validateCard(c, `${base}.cardByTag["${tag}"]`, errors, false);
        }
      }
    }

    if ('conditionalNotes' in ruleRaw) {
      if (!Array.isArray(ruleRaw.conditionalNotes)) {
        errors.push(`${base}.conditionalNotes は配列である必要があります`);
      } else {
        ruleRaw.conditionalNotes.forEach((cn, ci) => {
          if (!isObj(cn)) {
            errors.push(`${base}.conditionalNotes[${ci}] が不正です`);
            return;
          }
          if ('if' in cn) walkCondition(cn.if, `${base}.conditionalNotes[${ci}].if`, errors, 0);
          else errors.push(`${base}.conditionalNotes[${ci}].if がありません`);
          if (typeof cn.note !== 'string') {
            errors.push(`${base}.conditionalNotes[${ci}].note は文字列である必要があります`);
          }
        });
      }
    }

    if ('homecareAdvice' in ruleRaw) {
      if (!Array.isArray(ruleRaw.homecareAdvice)) {
        errors.push(`${base}.homecareAdvice は配列である必要があります`);
      } else {
        ruleRaw.homecareAdvice.forEach((ha, hi) => {
          if (!isObj(ha)) {
            errors.push(`${base}.homecareAdvice[${hi}] が不正です`);
            return;
          }
          if ('if' in ha) walkCondition(ha.if, `${base}.homecareAdvice[${hi}].if`, errors, 0);
          else errors.push(`${base}.homecareAdvice[${hi}].if がありません`);
          if (typeof ha.advice !== 'string') {
            errors.push(`${base}.homecareAdvice[${hi}].advice は文字列である必要があります`);
          }
        });
      }
    }
  });
}

/** 想定外例外に備えて try-catch で包む(fail-closed)。上限2つ(keyTags/深度)が本命の防御。 */
export function validateDefinition(input: unknown): string[] {
  try {
    return runValidation(input);
  } catch {
    return ['定義の検証中に内部エラーが発生しました'];
  }
}

function runValidation(input: unknown): string[] {
  const errors: string[] = [];

  if (!isObj(input)) {
    return ['定義が JSON オブジェクトではありません'];
  }
  const def = input;

  // ── 必須トップレベルセクションの存在 ──────────────────────────────────────
  const REQUIRED = ['meta', 'axes', 'answerScale', 'questions', 'scoring', 'recommendation', 'resultPage'];
  for (const key of REQUIRED) {
    if (!(key in def)) errors.push(`必須セクション "${key}" がありません`);
  }

  // ── meta ──────────────────────────────────────────────────────────────────
  if ('meta' in def && !isObj(def.meta)) errors.push('meta がオブジェクトではありません');

  // ── axes ────────────────────────────────────────────────────────────────
  const axisIds = new Set<string>();
  if ('axes' in def && !Array.isArray(def.axes)) {
    errors.push('axes が配列ではありません');
  } else if (Array.isArray(def.axes)) {
    if (def.axes.length === 0) errors.push('axes は空にできません');
    def.axes.forEach((ax, i) => {
      if (!isObj(ax)) {
        errors.push(`axes[${i}] がオブジェクトではありません`);
        return;
      }
      if (typeof ax.id !== 'string') errors.push(`axes[${i}].id が文字列ではありません`);
      else axisIds.add(ax.id);
      if (typeof ax.label !== 'string') errors.push(`axes[${i}].label が文字列ではありません`);
    });
  }

  // ── answerScale ──────────────────────────────────────────────────────────
  if ('answerScale' in def && !isObj(def.answerScale)) {
    errors.push('answerScale がオブジェクトではありません');
  } else if (isObj(def.answerScale)) {
    const asMin = def.answerScale.min;
    const asMax = def.answerScale.max;
    if (!isInteger(asMin)) errors.push('answerScale.min が整数ではありません');
    if (!isInteger(asMax)) errors.push('answerScale.max が整数ではありません');
    if (typeof asMin === 'number' && typeof asMax === 'number' && !(asMin < asMax)) {
      errors.push('answerScale: min は max より小さい必要があります');
    }
    if (!isStringArray(def.answerScale.labels)) errors.push('answerScale.labels が文字列配列ではありません');
  }

  // ── 検査1: questions(id重複 / axisId存在 / worryTag型 / direction / 非空) ──
  const worryTags = new Set<string>();
  const questions = Array.isArray(def.questions) ? def.questions : [];
  if ('questions' in def && !Array.isArray(def.questions)) errors.push('questions が配列ではありません');
  if (Array.isArray(def.questions) && def.questions.length === 0) errors.push('questions は空にできません');
  const seenQ = new Set<string>();
  for (const q of questions) {
    if (!isObj(q)) {
      errors.push('questions に不正な要素があります');
      continue;
    }
    const id = q.id;
    if (typeof id !== 'string') {
      errors.push('questions に id が文字列でない設問があります');
      continue;
    }
    if (seenQ.has(id)) errors.push(`questions.id が重複しています: "${id}"`);
    seenQ.add(id);
    if (typeof q.axisId !== 'string' || !axisIds.has(q.axisId)) {
      errors.push(`questions["${id}"].axisId が axes に存在しません: "${String(q.axisId)}"`);
    }
    if (!(q.worryTag === null || typeof q.worryTag === 'string')) {
      errors.push(`questions["${id}"].worryTag は null または文字列である必要があります`);
    }
    if (typeof q.worryTag === 'string') worryTags.add(q.worryTag);
    if (q.direction !== 'worry' && q.direction !== 'good') {
      errors.push(`questions["${id}"].direction は "worry" または "good" である必要があります`);
    }
  }

  // ── recommendation / resolvers ───────────────────────────────────────────
  const recommendation = isObj(def.recommendation) ? def.recommendation : {};
  if ('recommendation' in def && !isObj(def.recommendation)) {
    errors.push('recommendation がオブジェクトではありません');
  }
  if (
    !(typeof recommendation.maxTotal === 'number' &&
      Number.isInteger(recommendation.maxTotal) &&
      recommendation.maxTotal > 0)
  ) {
    errors.push('recommendation.maxTotal は正の整数である必要があります');
  }
  const resolvers = isObj(recommendation.resolvers) ? recommendation.resolvers : {};
  if (!isObj(recommendation.resolvers)) {
    errors.push('recommendation.resolvers がオブジェクトではありません');
  }
  const allKeyTags = new Set<string>();

  // ── 検査2 + リゾルバ構造検査 ──────────────────────────────────────────────
  for (const [axisId, resolverRaw] of Object.entries(resolvers)) {
    if (!isObj(resolverRaw)) {
      errors.push(`リゾルバ[${axisId}] がオブジェクトではありません`);
      continue;
    }
    if (resolverRaw.type === 'lookup') {
      validateLookupResolver(axisId, resolverRaw, errors, allKeyTags);
    } else if (resolverRaw.type === 'priorityRules') {
      validatePriorityRulesResolver(axisId, resolverRaw, errors);
    } else {
      errors.push(`リゾルバ[${axisId}].type は "lookup" または "priorityRules" である必要があります`);
    }
  }

  // ── 検査5: resolvers のキーが axes の id と一致(不足軸は許容 / 未知はエラー) ─
  for (const axisId of Object.keys(resolvers)) {
    if (!axisIds.has(axisId)) {
      errors.push(`recommendation.resolvers のキー "${axisId}" が axes に存在しません`);
    }
  }

  // ── noteRules ────────────────────────────────────────────────────────────
  if (!Array.isArray(recommendation.noteRules)) {
    errors.push('recommendation.noteRules が配列ではありません');
  } else {
    recommendation.noteRules.forEach((nr, ni) => {
      if (!isObj(nr)) {
        errors.push(`noteRules[${ni}] が不正です`);
        return;
      }
      if ('if' in nr) walkCondition(nr.if, `noteRules[${ni}].if`, errors, 0);
      else errors.push(`noteRules[${ni}].if がありません`);
      if (!isStringArray(nr.attachTo)) errors.push(`noteRules[${ni}].attachTo が文字列配列ではありません`);
      if (typeof nr.note !== 'string') errors.push(`noteRules[${ni}].note が文字列ではありません`);
    });
  }

  // ── scoring ──────────────────────────────────────────────────────────────
  const scoring = isObj(def.scoring) ? def.scoring : {};
  if ('scoring' in def && !isObj(def.scoring)) errors.push('scoring がオブジェクトではありません');

  if (typeof scoring.tagThreshold !== 'number') errors.push('scoring.tagThreshold が数値ではありません');
  if ('severityTags' in scoring && !isStringArray(scoring.severityTags)) {
    errors.push('scoring.severityTags が文字列配列ではありません');
  }
  if (!isObj(scoring.tagMerges)) errors.push('scoring.tagMerges がオブジェクトではありません');

  // 検査3: ranks(空でない配列 / 0始まりの昇順 / rank名重複なし / 要素の型)
  // 定義済みランク名は resultPage.rankImages のキー検査でも使うため関数スコープへ集約する。
  const definedRanks = new Set<string>();
  if (!Array.isArray(scoring.ranks) || scoring.ranks.length === 0) {
    errors.push('scoring.ranks が空でない配列ではありません');
  } else {
    const ranks = scoring.ranks;
    const first = ranks[0];
    if (!isObj(first) || first.min !== 0) {
      errors.push('ranks の最初の min は 0 である必要があります');
    }
    let prev = -Infinity;
    for (const r of ranks) {
      if (!isObj(r)) {
        errors.push('ranks に不正な要素があります');
        continue;
      }
      if (typeof r.min !== 'number') {
        errors.push('ranks に min が数値でない要素があります');
      } else {
        if (r.min <= prev) errors.push(`ranks の min が昇順ではありません: ${r.min}`);
        prev = r.min;
      }
      for (const field of ['rank', 'title', 'subcopy', 'body'] as const) {
        if (typeof r[field] !== 'string') {
          errors.push(`ranks の ${field} が文字列でない要素があります`);
        }
      }
      if (typeof r.rank === 'string') {
        if (definedRanks.has(r.rank)) errors.push(`ranks の rank 名が重複しています: "${r.rank}"`);
        definedRanks.add(r.rank);
      }
    }
  }

  // 検査4: axisGrades(keep/almost/warn の形 + keep.min > almost.min)
  const axisGrades = isObj(scoring.axisGrades) ? scoring.axisGrades : {};
  if (!isObj(scoring.axisGrades)) {
    errors.push('scoring.axisGrades がオブジェクトではありません');
  } else {
    for (const g of ['keep', 'almost', 'warn'] as const) {
      const grade = axisGrades[g];
      if (!isObj(grade)) {
        errors.push(`scoring.axisGrades.${g} がオブジェクトではありません`);
      } else if (!(grade.min === null || typeof grade.min === 'number')) {
        errors.push(`scoring.axisGrades.${g}.min は数値または null である必要があります`);
      }
    }
  }
  const keep = isObj(axisGrades.keep) ? axisGrades.keep : undefined;
  const almost = isObj(axisGrades.almost) ? axisGrades.almost : undefined;
  if (keep && almost && typeof keep.min === 'number' && typeof almost.min === 'number') {
    if (!(keep.min > almost.min)) {
      errors.push('axisGrades: keep.min は almost.min より大きい必要があります');
    }
  }

  // 検査6: severityTags が worryTag に存在
  const severityTags = Array.isArray(scoring.severityTags) ? scoring.severityTags : [];
  for (const t of severityTags) {
    if (typeof t !== 'string' || !worryTags.has(t)) {
      errors.push(`scoring.severityTags "${String(t)}" が questions の worryTag に存在しません`);
    }
  }

  // 検査7: tagMerges の値(target)が有効なタグ(keyTags/worryTag)
  const tagMerges = isObj(scoring.tagMerges) ? scoring.tagMerges : {};
  const validTags = new Set<string>([...allKeyTags, ...worryTags]);
  for (const [, target] of Object.entries(tagMerges)) {
    if (typeof target !== 'string' || !validTags.has(target)) {
      errors.push(`scoring.tagMerges の値 "${String(target)}" が有効なタグ(keyTags/worryTag)ではありません`);
    }
  }

  // ── resultPage ───────────────────────────────────────────────────────────
  // taxRate 以外は任意。存在する場合のみ型検査する(未指定はエラーにしない)。
  if ('resultPage' in def && !isObj(def.resultPage)) {
    errors.push('resultPage がオブジェクトではありません');
  } else if (isObj(def.resultPage)) {
    const rp = def.resultPage;
    // 税率は 0(非課税)〜1(100%)。範囲外は税込価格・割引後価格が破綻するため弾く。
    if (typeof rp.taxRate !== 'number' || !Number.isFinite(rp.taxRate) || rp.taxRate < 0 || rp.taxRate > 1) {
      errors.push('resultPage.taxRate は 0 以上 1 以下の有限な数値である必要があります');
    }
    if ('weakPointHeading' in rp && typeof rp.weakPointHeading !== 'string') {
      errors.push('resultPage.weakPointHeading は文字列である必要があります');
    }
    if ('weakPointTexts' in rp) {
      if (!isObj(rp.weakPointTexts)) {
        errors.push('resultPage.weakPointTexts はオブジェクトである必要があります');
      } else {
        for (const [axisId, v] of Object.entries(rp.weakPointTexts)) {
          if (typeof v !== 'string') {
            errors.push(`resultPage.weakPointTexts["${axisId}"] は文字列である必要があります`);
          }
        }
      }
    }
    if ('softCta' in rp) {
      if (!isObj(rp.softCta)) {
        errors.push('resultPage.softCta はオブジェクトである必要があります');
      } else {
        if (typeof rp.softCta.text !== 'string') {
          errors.push('resultPage.softCta.text は文字列である必要があります');
        }
        if ('subText' in rp.softCta && typeof rp.softCta.subText !== 'string') {
          errors.push('resultPage.softCta.subText は文字列である必要があります');
        }
      }
    }
    if ('minorNotice' in rp && typeof rp.minorNotice !== 'string') {
      errors.push('resultPage.minorNotice は文字列である必要があります');
    }
    if ('emptyState' in rp) {
      if (!isObj(rp.emptyState)) {
        errors.push('resultPage.emptyState はオブジェクトである必要があります');
      } else {
        if (typeof rp.emptyState.message !== 'string') {
          errors.push('resultPage.emptyState.message は文字列である必要があります');
        }
        if ('cta' in rp.emptyState && typeof rp.emptyState.cta !== 'string') {
          errors.push('resultPage.emptyState.cta は文字列である必要があります');
        }
        // 悩みが無い人向けの提案カード(任意)。通常カードと同じ経路に載るため同じ制約。
        if ('card' in rp.emptyState) {
          const ec = rp.emptyState.card;
          if (!isObj(ec)) {
            errors.push('resultPage.emptyState.card はオブジェクトである必要があります');
          } else {
            if (typeof ec.axisId !== 'string' || !axisIds.has(ec.axisId)) {
              errors.push('resultPage.emptyState.card.axisId は axes に存在する id である必要があります');
            }
            for (const field of ['title', 'reason'] as const) {
              if (typeof ec[field] !== 'string' || !ec[field]) {
                errors.push(`resultPage.emptyState.card.${field} は空でない文字列である必要があります`);
              }
            }
            if (!isNonNegativeFinite(ec.priceExTax)) {
              errors.push('resultPage.emptyState.card.priceExTax は 0 以上の有限な数値である必要があります');
            }
            if ('priceSuffix' in ec && typeof ec.priceSuffix !== 'string') {
              errors.push('resultPage.emptyState.card.priceSuffix は文字列である必要があります');
            }
            // 総合点は 0..100 に正規化されるため、それを超える下限は設定ミス。
            if (
              'minScore' in ec &&
              (!isNonNegativeFinite(ec.minScore) || (ec.minScore as number) > 100)
            ) {
              errors.push(
                'resultPage.emptyState.card.minScore は 0 以上 100 以下の数値である必要があります',
              );
            }
          }
        }
      }
    }
    // I4: discount(任意)。rate は 0 < rate < 1 の数値、ラベル類は文字列。
    if ('discount' in rp) {
      if (!isObj(rp.discount)) {
        errors.push('resultPage.discount はオブジェクトである必要があります');
      } else {
        const dc = rp.discount;
        if (typeof dc.rate !== 'number' || !(dc.rate > 0 && dc.rate < 1)) {
          errors.push('resultPage.discount.rate は 0 より大きく 1 より小さい数値である必要があります');
        }
        for (const field of ['badgeLabel', 'conditionLabel', 'notice'] as const) {
          if (field in dc && typeof dc[field] !== 'string') {
            errors.push(`resultPage.discount.${field} は文字列である必要があります`);
          }
        }
      }
    }
    // I5: booking(任意)。url は https:// のURL、ラベル類は文字列。
    if ('booking' in rp) {
      if (!isObj(rp.booking)) {
        errors.push('resultPage.booking はオブジェクトである必要があります');
      } else {
        const bk = rp.booking;
        if (!isHttpsUrl(bk.url)) {
          errors.push('resultPage.booking.url は https:// のURL(ホスト付き)である必要があります');
        }
        for (const field of ['label', 'subText'] as const) {
          if (field in bk && typeof bk[field] !== 'string') {
            errors.push(`resultPage.booking.${field} は文字列である必要があります`);
          }
        }
      }
    }
    // R6: rankImages(任意)。オブジェクトで、キーは定義済みランク・値は https:// URL。
    if ('rankImages' in rp) {
      if (!isObj(rp.rankImages)) {
        errors.push('resultPage.rankImages はオブジェクトである必要があります');
      } else {
        for (const [rank, url] of Object.entries(rp.rankImages)) {
          if (!definedRanks.has(rank)) {
            errors.push(`resultPage.rankImages のキー "${rank}" が scoring.ranks に存在しません`);
          }
          if (!isHttpsUrl(url)) {
            errors.push(`resultPage.rankImages["${rank}"] は https:// のURL(ホスト付き)である必要があります`);
          }
        }
      }
    }
  }

  // ── intro(任意) ─────────────────────────────────────────────────────────
  // 診断前画面の表示内容。LIFF 定義APIがそのまま返すブロックのため、価格・配点は
  // 持たない前提でキー単位に型検査する(未知キーは無視)。
  if ('intro' in def) {
    if (!isObj(def.intro)) {
      errors.push('intro はオブジェクトである必要があります');
    } else {
      const intro = def.intro;
      for (const field of ['catchCopy', 'subCopy'] as const) {
        if (field in intro && typeof intro[field] !== 'string') {
          errors.push(`intro.${field} は文字列である必要があります`);
        }
      }
      if ('aboutLines' in intro && !isStringArray(intro.aboutLines)) {
        errors.push('intro.aboutLines は文字列配列である必要があります');
      }
      if ('rankPreview' in intro) {
        if (!Array.isArray(intro.rankPreview)) {
          errors.push('intro.rankPreview は配列である必要があります');
        } else {
          intro.rankPreview.forEach((rowRaw, i) => {
            const base = `intro.rankPreview[${i}]`;
            if (!isObj(rowRaw)) {
              errors.push(`${base} がオブジェクトではありません`);
              return;
            }
            if (typeof rowRaw.rank !== 'string') {
              errors.push(`${base}.rank は文字列である必要があります`);
            } else if (!definedRanks.has(rowRaw.rank)) {
              errors.push(`${base}.rank "${rowRaw.rank}" が scoring.ranks に存在しません`);
            }
            if (typeof rowRaw.title !== 'string') {
              errors.push(`${base}.title は文字列である必要があります`);
            }
            if ('subcopy' in rowRaw && typeof rowRaw.subcopy !== 'string') {
              errors.push(`${base}.subcopy は文字列である必要があります`);
            }
            if ('minScore' in rowRaw && typeof rowRaw.minScore !== 'number') {
              errors.push(`${base}.minScore は数値である必要があります`);
            }
            if ('imageUrl' in rowRaw && !isHttpsUrl(rowRaw.imageUrl)) {
              errors.push(`${base}.imageUrl は https:// のURL(ホスト付き)である必要があります`);
            }
          });
        }
      }
      if ('heroImages' in intro) {
        if (!isObj(intro.heroImages)) {
          errors.push('intro.heroImages はオブジェクトである必要があります');
        } else {
          for (const [rank, url] of Object.entries(intro.heroImages)) {
            if (!definedRanks.has(rank)) {
              errors.push(`intro.heroImages のキー "${rank}" が scoring.ranks に存在しません`);
            }
            if (!isHttpsUrl(url)) {
              errors.push(`intro.heroImages["${rank}"] は https:// のURL(ホスト付き)である必要があります`);
            }
          }
        }
      }
    }
  }

  // ── 相関検査: sendResultMessage=true なら share.liffUrl から liffId が抽出できること ─
  // 結果メッセージの「結果を見る」ボタンは liff.line.me/{liffId}/... を組み立てるため、
  // liffId が取れない(未設定・空文字・liff.line.me 形式でない)と壊れた URL のボタンが
  // 送られてしまう。プレースホルダ(REPLACE_LIFF_ID 等)は形式上有効なので通す。
  const sideEffects = isObj(def.sideEffects) ? def.sideEffects : {};
  if (sideEffects.sendResultMessage === true) {
    const share = isObj(def.share) ? def.share : {};
    const liffUrl = typeof share.liffUrl === 'string' ? share.liffUrl : '';
    // route の buildLiffResultUrl と同一判定: 先頭が https://liff.line.me/{liffId} の形のみ有効。
    const m = liffUrl.match(/^https:\/\/liff\.line\.me\/([^/?#]+)/);
    if (!m || !m[1]) {
      errors.push(
        'sideEffects.sendResultMessage が有効な場合、share.liffUrl は liff.line.me/{liffId} 形式(liffId が抽出できる)である必要があります',
      );
    }
  }

  return errors;
}
