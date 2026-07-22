// =============================================================================
// 診断 採点・推奨エンジン (04_engine-spec.md)
//
// 副作用のない純関数。runDiagnosis(definition, answers) => DiagnosisResult。
// definition と answers 以外を参照しない(DB・時刻・乱数禁止)。
// 診断固有の語(Re'Dent・脱毛 等)はコードに書かない。すべて定義JSON由来。
// =============================================================================

import type {
  AxisGradeKey,
  DiagnosisAnswers,
  DiagnosisAxisGrades,
  DiagnosisCondition,
  DiagnosisDefinition,
  DiagnosisResult,
  DiagnosisResultPage,
  LookupResolver,
  PriorityRulesResolver,
  ResolverCard,
  ResultAxisMessage,
  ResultAxisScore,
  ResultCard,
  ResultSoftCta,
  ResultTag,
  ResultWeakPoint,
  ResultEmptyStateTexts,
} from '@line-crm/shared';
import { keyTagSignature } from './signature.js';

/** エンジン内部の立ちタグ表現 */
interface StandingTag {
  tag: string;
  axisId: string;
  /** 重症度保持タグのみ(最も悪い=小さい clean_point) */
  point?: number;
}

interface EvalCtx {
  /** 条件評価対象の立ちタグ集合(リゾルバ=軸内 / noteRules=全軸) */
  tags: StandingTag[];
  /** 最終採用カードの軸集合(cardsPresent 用) */
  cardsPresent?: Set<string>;
}

// -----------------------------------------------------------------------------
// 小さなユーティリティ
// -----------------------------------------------------------------------------

/** 表示用スコア: 小数第2位まで */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** "X@2"(重症度保持タグ)を base と point に分解。@ 無しは point=null */
function parseTagRef(ref: string): { base: string; point: number | null } {
  const at = ref.lastIndexOf('@');
  if (at > 0) {
    const p = Number(ref.slice(at + 1));
    if (Number.isInteger(p)) return { base: ref.slice(0, at), point: p };
  }
  return { base: ref, point: null };
}

/** タグ参照(plain または "X@2")が立っているか */
function tagRefStanding(tags: StandingTag[], ref: string): boolean {
  const { base, point } = parseTagRef(ref);
  return tags.some((t) => t.tag === base && (point === null || t.point === point));
}

/** グループ(タグ参照配列)に属する立ちタグがあるか */
function groupContains(group: string[], tags: StandingTag[]): boolean {
  return group.some((ref) => tagRefStanding(tags, ref));
}

/** {parts}=指定部位 / {extras}=おまけ部位 を差し込む */
function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? `{${k}}`);
}

// -----------------------------------------------------------------------------
// 条件DSL 評価
// -----------------------------------------------------------------------------

function evalCondition(cond: DiagnosisCondition, ctx: EvalCtx): boolean {
  if ('hasTag' in cond) return tagRefStanding(ctx.tags, cond.hasTag);
  if ('hasAnyTag' in cond) return cond.hasAnyTag.some((t) => tagRefStanding(ctx.tags, t));
  if ('hasTagWithPoint' in cond) {
    const { tag, point } = cond.hasTagWithPoint;
    return ctx.tags.some((t) => t.tag === tag && t.point === point);
  }
  if ('spansGroups' in cond) {
    const { groupA, groupB, minTags } = cond.spansGroups;
    if (ctx.tags.length < minTags) return false;
    return groupContains(groupA, ctx.tags) && groupContains(groupB, ctx.tags);
  }
  if ('always' in cond) return cond.always === true;
  if ('and' in cond) return cond.and.every((c) => evalCondition(c, ctx));
  if ('not' in cond) return !evalCondition(cond.not, ctx);
  if ('cardsPresent' in cond) {
    const present = ctx.cardsPresent ?? new Set<string>();
    return cond.cardsPresent.every((ax) => present.has(ax));
  }
  return false;
}

// -----------------------------------------------------------------------------
// リゾルバ
// -----------------------------------------------------------------------------

function toResultCard(card: ResolverCard, axisId: string): ResultCard {
  return {
    axisId,
    title: card.title,
    priceExTax: card.priceExTax,
    priceInTax: 0,
    priceSuffix: card.priceSuffix ?? '',
    reason: card.reason,
    extras: [],
    notes: [],
  };
}

/** lookup リゾルバ(体毛用)。カード 0 or 1 枚。solo は axisMessages へ副次追加。 */
function resolveLookup(
  resolver: LookupResolver,
  axisId: string,
  tags: StandingTag[],
  axisMessages: ResultAxisMessage[],
): ResultCard | null {
  const keyTagSet = new Set(resolver.keyTags);
  const standingKeys = tags.filter((t) => keyTagSet.has(t.tag)).map((t) => t.tag);
  const specials = resolver.specialTags ?? {};

  // K が空: solo special メッセージのみ。カード無し。
  if (standingKeys.length === 0) {
    for (const [specialTag, cfg] of Object.entries(specials)) {
      if (tags.some((t) => t.tag === specialTag)) {
        axisMessages.push({ axisId, message: cfg.soloMessage });
      }
    }
    return null;
  }

  // K が非空: table から集合一致する行を引く(網羅はバリデータ保証)。
  const sig = keyTagSignature(standingKeys, resolver.keyTags);
  const row = resolver.table.find((r) => keyTagSignature(r.key, resolver.keyTags) === sig);
  if (!row) return null;

  // 理由文: reasonByTag を記述順に探し最初に該当した文を優先、無ければ reasonTemplate。
  let reason = resolver.reasonTemplate;
  if (resolver.reasonByTag) {
    for (const [tagName, text] of Object.entries(resolver.reasonByTag)) {
      if (row.key.includes(tagName)) {
        reason = text;
        break;
      }
    }
  }
  // extras 非空なら価値訴求を理由文に含める。
  if (row.extras.length > 0) {
    reason += fillTemplate(resolver.extrasTemplate, {
      parts: row.key.join('・'),
      extras: row.extras.join('・'),
    });
  }

  const card: ResultCard = {
    axisId,
    title: row.title,
    priceExTax: row.priceExTax,
    priceInTax: 0,
    priceSuffix: '',
    reason,
    extras: [...row.extras],
    notes: [],
  };

  // appeal 対象タグが立っていれば訴求文を添える。
  for (const [specialTag, cfg] of Object.entries(specials)) {
    if (cfg.mode === 'appeal' && tags.some((t) => t.tag === specialTag)) {
      card.appeal = cfg.appealText;
    }
  }

  return card;
}

/** priorityRules リゾルバ(肌・髪用)。最初にマッチした 1 ルールで決定。 */
function resolvePriorityRules(
  resolver: PriorityRulesResolver,
  axisId: string,
  tags: StandingTag[],
): ResultCard | null {
  const ctx: EvalCtx = { tags };
  for (const rule of resolver.rules) {
    if (!evalCondition(rule.if, ctx)) continue;

    // マッチしたルールを採用。card / cardByTag / card:null を解決。
    let card: ResultCard | null = null;
    if (rule.cardByTag) {
      // 立っているタグに対応するエントリを記述順で探し最初の 1 つ。
      for (const [tagRef, c] of Object.entries(rule.cardByTag)) {
        if (tagRefStanding(tags, tagRef)) {
          card = toResultCard(c, axisId);
          break;
        }
      }
    } else if (rule.card !== undefined && rule.card !== null) {
      card = toResultCard(rule.card, axisId);
    }

    if (card) {
      if (rule.conditionalNotes) {
        for (const cn of rule.conditionalNotes) {
          if (evalCondition(cn.if, ctx)) card.notes.push(cn.note);
        }
      }
      if (rule.homecareAdvice) {
        for (const ha of rule.homecareAdvice) {
          if (evalCondition(ha.if, ctx)) {
            card.reason += ha.advice;
            break;
          }
        }
      }
    }

    // 最初にマッチしたルールで確定(card が null でもフォールスルーしない)。
    return card;
  }
  return null;
}

// -----------------------------------------------------------------------------
// 採点・ランク
// -----------------------------------------------------------------------------

function gradeFor(score: number, grades: DiagnosisAxisGrades): AxisGradeKey {
  if (grades.keep.min !== null && score >= grades.keep.min) return 'keep';
  if (grades.almost.min !== null && score >= grades.almost.min) return 'almost';
  return 'warn';
}

// -----------------------------------------------------------------------------
// メイン
// -----------------------------------------------------------------------------

export function runDiagnosis(
  definition: DiagnosisDefinition,
  answers: DiagnosisAnswers,
): DiagnosisResult {
  const { answerScale } = definition;
  const { min, max } = answerScale;

  // Step 1: 入力検証
  const questionIds = new Set(definition.questions.map((q) => q.id));
  for (const q of definition.questions) {
    const v = answers[q.id];
    if (v === undefined) throw new Error(`回答が不足しています: ${q.id}`);
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new Error(`回答値が不正です(${min}〜${max}の整数): ${q.id}=${String(v)}`);
    }
  }
  for (const key of Object.keys(answers)) {
    if (!questionIds.has(key)) throw new Error(`未知の設問への回答です: ${key}`);
  }

  // Step 2: 清潔感ポイント変換
  const cleanPoints: Record<string, number> = {};
  for (const q of definition.questions) {
    const a = answers[q.id];
    cleanPoints[q.id] = q.direction === 'worry' ? max + min - a : a;
  }

  // Step 3: 悩みタグ収集
  const severitySet = new Set(definition.scoring.severityTags);
  const tagMap = new Map<string, StandingTag>();
  for (const q of definition.questions) {
    if (q.worryTag == null) continue;
    const cp = cleanPoints[q.id];
    if (cp <= definition.scoring.tagThreshold) {
      const existing = tagMap.get(q.worryTag);
      if (existing) {
        if (severitySet.has(q.worryTag)) {
          existing.point = Math.min(existing.point ?? cp, cp);
        }
      } else {
        const st: StandingTag = { tag: q.worryTag, axisId: q.axisId };
        if (severitySet.has(q.worryTag)) st.point = cp;
        tagMap.set(q.worryTag, st);
      }
    }
  }

  // Step 6.1: tagMerges 前処理(マージ元を消し、マージ先を立てる)。結果 tags も合算後。
  for (const [source, target] of Object.entries(definition.scoring.tagMerges)) {
    const src = tagMap.get(source);
    if (!src) continue;
    if (!tagMap.has(target)) {
      const merged: StandingTag = { tag: target, axisId: src.axisId };
      if (severitySet.has(target) && src.point !== undefined) merged.point = src.point;
      tagMap.set(target, merged);
    }
    tagMap.delete(source);
  }

  // 立ちタグを axes 順に整列(同軸内は挿入順=設問順を安定保持)。
  const axisIndex = new Map(definition.axes.map((ax, i) => [ax.id, i] as const));
  const standingTags = [...tagMap.values()].sort(
    (a, b) => (axisIndex.get(a.axisId) ?? 999) - (axisIndex.get(b.axisId) ?? 999),
  );
  const tags: ResultTag[] = standingTags.map((st) =>
    st.point !== undefined
      ? { tag: st.tag, axisId: st.axisId, point: st.point }
      : { tag: st.tag, axisId: st.axisId },
  );

  // Step 4: 軸スコアと◎○△(raw は丸めず grade / 弱点 / 総合点に使用)
  const axisRaw = definition.axes.map((axis) => {
    const qs = definition.questions.filter((q) => q.axisId === axis.id);
    const sum = qs.reduce((acc, q) => acc + cleanPoints[q.id], 0);
    const raw = qs.length > 0 ? sum / qs.length : 0;
    return { axisId: axis.id, label: axis.label, raw, grade: gradeFor(raw, definition.scoring.axisGrades) };
  });
  const axisScores: ResultAxisScore[] = axisRaw.map((a) => ({
    axisId: a.axisId,
    label: a.label,
    score: round2(a.raw),
    grade: a.grade,
  }));
  // 弱点ランキング: raw 昇順の安定ソート(同点は axes 順)
  const weakestAxes = [...axisRaw].sort((a, b) => a.raw - b.raw).map((a) => a.axisId);

  // Step 5: 総合点とランク(丸めはランク判定の前)
  const M = axisRaw.reduce((acc, a) => acc + a.raw, 0) / axisRaw.length;
  const totalScore = Math.round(((M - min) / (max - min)) * 100);
  let chosenRank = definition.scoring.ranks[0];
  for (const r of definition.scoring.ranks) {
    if (r.min <= totalScore) chosenRank = r;
  }

  // Step 6.2: 軸ごとにリゾルバ実行(各軸 0 or 1 枚)
  const axisMessages: ResultAxisMessage[] = [];
  const candidates: ResultCard[] = [];
  for (const axis of definition.axes) {
    const resolver = definition.recommendation.resolvers[axis.id];
    if (!resolver) continue;
    const axisTags = standingTags.filter((t) => t.axisId === axis.id);
    const card =
      resolver.type === 'lookup'
        ? resolveLookup(resolver, axis.id, axisTags, axisMessages)
        : resolvePriorityRules(resolver, axis.id, axisTags);
    if (card) candidates.push(card);
  }

  // Step 6.3: グローバル集約(axes 順で maxTotal 枚。超過は末尾の軸から落ちる)
  const maxTotal = definition.recommendation.maxTotal;
  const cards = candidates.slice(0, maxTotal);
  const droppedCards = candidates.slice(maxTotal).map((c) => c.axisId);

  // Step 7: 税込計算(最終カードのみ)
  const taxRate = definition.resultPage.taxRate;
  for (const card of cards) {
    card.priceInTax = Math.round(card.priceExTax * (1 + taxRate));
  }

  // Step 6.3.3: noteRules を最終採用カード集合に対して評価
  const cardByAxis = new Map(cards.map((c) => [c.axisId, c] as const));
  const presentAxes = new Set(cards.map((c) => c.axisId));
  const noteCtx: EvalCtx = { tags: standingTags, cardsPresent: presentAxes };
  for (const rule of definition.recommendation.noteRules) {
    if (!evalCondition(rule.if, noteCtx)) continue;
    for (const ax of rule.attachTo) {
      const card = cardByAxis.get(ax);
      if (card) {
        card.notes.push(rule.note);
        break;
      }
    }
  }

  // Step 6.4: 空状態(立ちタグ 0 件)
  const emptyState = standingTags.length === 0;

  // Step 8: 表示用スナップショット(02 データモデル: definition を再参照せず結果を
  // 再構成できるよう、表示に必要な definition 由来文言を焼き込む)。validator は
  // taxRate 以外を必須にしていないため、実行時は欠けうる。欠けていれば省略する。
  const rp = definition.resultPage as Partial<DiagnosisResultPage>;
  const axisById = new Map(axisScores.map((a) => [a.axisId, a] as const));
  const weakPoints: ResultWeakPoint[] = weakestAxes
    .map((id) => axisById.get(id))
    .filter((a): a is ResultAxisScore => !!a && a.grade === 'warn')
    .map((a) => ({ axisId: a.axisId, label: a.label, text: rp.weakPointTexts?.[a.axisId] ?? null }));

  const result: DiagnosisResult = {
    cleanPoints,
    axisScores,
    weakestAxes,
    totalScore,
    rank: chosenRank.rank,
    rankTitle: chosenRank.title,
    rankSubcopy: chosenRank.subcopy,
    rankBody: chosenRank.body,
    tags,
    cards,
    axisMessages,
    droppedCards,
    emptyState,
    weakPoints,
  };

  if (typeof definition.meta?.name === 'string') result.diagnosisName = definition.meta.name;
  if (typeof rp.weakPointHeading === 'string') result.weakPointHeading = rp.weakPointHeading;
  if (typeof rp.minorNotice === 'string') result.minorNotice = rp.minorNotice;
  if (rp.softCta && typeof rp.softCta.text === 'string') {
    const softCta: ResultSoftCta = { text: rp.softCta.text };
    if (typeof rp.softCta.subText === 'string') softCta.subText = rp.softCta.subText;
    result.softCta = softCta;
  }
  if (rp.emptyState && typeof rp.emptyState.message === 'string') {
    const emptyStateTexts: ResultEmptyStateTexts = { message: rp.emptyState.message };
    if (typeof rp.emptyState.cta === 'string') emptyStateTexts.cta = rp.emptyState.cta;
    result.emptyStateTexts = emptyStateTexts;
  }
  // R6: 該当ランクのキャラクター画像URLを焼き込む(該当エントリが無ければ付けない)。
  if (rp.rankImages) {
    const url = rp.rankImages[chosenRank.rank];
    if (typeof url === 'string') result.rankImageUrl = url;
  }

  return result;
}
