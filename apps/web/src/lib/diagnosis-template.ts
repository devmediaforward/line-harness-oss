import type { DiagnosisDefinition } from '@line-crm/shared'

/**
 * バリデータ (apps/worker/src/services/diagnosis/validate.ts) を通過する
 * 最小構成の空 definition を生成する。1軸1問 + 最小 scoring/recommendation/resultPage。
 *
 * ここでシード JSON を丸ごと埋め込まないこと (要件)。あくまで「作成直後に管理画面の
 * フォーム/JSON エディタで肉付けする」ための出発点。
 */
export function emptyDiagnosisDefinition(name: string): DiagnosisDefinition {
  return {
    meta: { name, description: '' },
    axes: [{ id: 'axis1', label: '軸1' }],
    answerScale: {
      min: 1,
      max: 5,
      labels: [
        'まったく当てはまらない',
        'あまり当てはまらない',
        'どちらとも言えない',
        'やや当てはまる',
        'とても当てはまる',
      ],
    },
    questions: [
      {
        id: 'q1',
        axisId: 'axis1',
        text: '設問1の質問文を入力してください',
        direction: 'worry',
        worryTag: null,
      },
    ],
    scoring: {
      tagThreshold: 3,
      severityTags: [],
      tagMerges: {},
      axisGrades: {
        keep: { min: 4, label: '◎', meaning: 'キープ' },
        almost: { min: 3, label: '○', meaning: 'あと少し' },
        warn: { min: null, label: '△', meaning: '要注意' },
      },
      ranks: [
        { rank: 'D', min: 0, title: 'ランクD', subcopy: '', body: '' },
        { rank: 'C', min: 20, title: 'ランクC', subcopy: '', body: '' },
        { rank: 'B', min: 40, title: 'ランクB', subcopy: '', body: '' },
        { rank: 'A', min: 60, title: 'ランクA', subcopy: '', body: '' },
        { rank: 'S', min: 80, title: 'ランクS', subcopy: '', body: '' },
      ],
    },
    recommendation: {
      maxTotal: 1,
      maxPerAxis: 1,
      resolvers: {},
      noteRules: [],
    },
    resultPage: {
      taxRate: 0.1,
      weakPointHeading: '気になったところ',
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
    sideEffects: {
      sendResultMessage: false,
      addTags: false,
      enrollScenarioId: null,
      saveToMetadata: false,
    },
  }
}
